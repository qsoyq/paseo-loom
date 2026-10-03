import { randomUUID } from "node:crypto";
import type { PaseoAgentTimelineSubscription } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginHookWorkspace,
  PluginServerContext,
} from "@getpaseo/plugin/server";

const environmentKeys = {
  provider: "PASEO_LOOM_PROVIDER",
  model: "PASEO_LOOM_MODEL",
  modeId: "PASEO_LOOM_MODE_ID",
  prompt: "PASEO_LOOM_PROMPT",
} as const;

type LoomConfiguration = {
  provider: string;
  model: string;
  modeId: string;
  prompt: string;
};

type AgentInvocation = {
  agentId: string;
  workspace: PluginHookWorkspace;
  configuration: LoomConfiguration;
  sourceAgentId?: string;
  sourceTask?: string;
  sourceTaskReady?: boolean;
  sourceSubscription?: PaseoAgentTimelineSubscription;
  archiveRequested?: boolean;
  archived?: boolean;
  abort: AbortController;
  phase: "waiting" | "requested" | "started" | "unknown" | "finished";
};

function log(event: string, details: Record<string, unknown>, failed = false) {
  const message = JSON.stringify({
    plugin: "paseo-loom",
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
  if (failed) {
    console.error(message);
  } else {
    console.log(message);
  }
}

function readConfiguration(workspaceId: string) {
  const provider = process.env[environmentKeys.provider]?.trim();
  const model = process.env[environmentKeys.model]?.trim();
  const modeId = process.env[environmentKeys.modeId]?.trim();
  const prompt = process.env[environmentKeys.prompt];

  if (!provider || !model || !modeId || !prompt?.trim()) {
    const missingKeys = Object.values(environmentKeys).filter(
      (key) => !process.env[key]?.trim(),
    );
    log("workspace_skipped", {
      workspaceId,
      reason: "configuration_missing",
      missingKeys,
    });
    return null;
  }

  return { provider, model, modeId, prompt };
}

function renderPrompt(template: string, invocation: AgentInvocation) {
  const values: Record<string, string> = {
    workspace_id: invocation.workspace.id,
    cwd: invocation.workspace.cwd,
    workspace_title: invocation.workspace.name ?? "",
    source_agent_id: invocation.sourceAgentId ?? "",
    task_prompt: invocation.sourceTask ?? "",
  };
  return template.replace(
    /\{\{(workspace_id|cwd|workspace_title|source_agent_id|task_prompt)\}\}/g,
    (_token, key: string) => values[key],
  );
}

function needsSourceTask(configuration: LoomConfiguration) {
  return configuration.prompt.includes("{{source_agent_id}}") ||
    configuration.prompt.includes("{{task_prompt}}");
}

export default function contribute(server: PluginServerContext) {
  const invocations = new Map<string, AgentInvocation>();
  let stopped = false;

  function invocationFor(agent: PluginHookAgent) {
    if (stopped || !agent.workspaceId) {
      return null;
    }
    const invocation = invocations.get(agent.workspaceId);
    return invocation?.agentId === agent.id ? invocation : null;
  }

  function stopWatchingSource(invocation: AgentInvocation) {
    const subscription = invocation.sourceSubscription;
    invocation.sourceSubscription = undefined;
    if (subscription) {
      void subscription.release().catch(() => {
        log("source_subscription_cleanup_failed", {
          workspaceId: invocation.workspace.id,
        }, true);
      });
    }
  }

  function selectSource(invocation: AgentInvocation, agent: PluginHookAgent) {
    if (
      invocation.phase !== "waiting" ||
      agent.id === invocation.agentId ||
      agent.parentAgentId ||
      agent.workspaceId !== invocation.workspace.id
    ) {
      return false;
    }
    if (invocation.sourceAgentId && invocation.sourceAgentId !== agent.id) {
      invocation.phase = "finished";
      invocation.abort.abort();
      stopWatchingSource(invocation);
      log("source_ambiguous", { workspaceId: invocation.workspace.id });
      return false;
    }
    if (!invocation.sourceAgentId) {
      invocation.sourceAgentId = agent.id;
      log("source_agent_selected", {
        workspaceId: invocation.workspace.id,
        sourceAgentId: agent.id,
      });
    }
    return true;
  }

  function hasFinished(invocation: AgentInvocation) {
    return invocation.phase === "finished";
  }

  async function prepareSource(invocation: AgentInvocation, context: PluginHookContext) {
    if (needsSourceTask(invocation.configuration)) {
      await watchSource(invocation, context);
    } else {
      await startAgent(invocation, context);
    }
  }

  async function archiveFinishedAgent(
    invocation: AgentInvocation,
    context: PluginHookContext,
  ) {
    if (
      stopped || context.signal.aborted || invocation.abort.signal.aborted ||
      invocation.archiveRequested || invocation.archived ||
      invocations.get(invocation.workspace.id) !== invocation
    ) {
      return;
    }
    invocation.archiveRequested = true;
    try {
      await context.paseo.agents.ref(invocation.agentId).archive();
      invocation.archived = true;
      log("agent_archive_completed", {
        workspaceId: invocation.workspace.id,
        agentId: invocation.agentId,
      });
    } catch (error) {
      log("agent_archive_failed", {
        workspaceId: invocation.workspace.id,
        agentId: invocation.agentId,
        error: error instanceof Error ? error.message : String(error),
      }, true);
    }
  }

  async function sourceTaskAvailable(
    invocation: AgentInvocation,
    sourceAgentId: string,
    task: string,
    context: PluginHookContext,
    via: "live" | "readback" | "turn_end",
  ) {
    if (
      !task.trim() ||
      invocation.phase !== "waiting" ||
      invocation.sourceTaskReady ||
      invocation.sourceAgentId !== sourceAgentId ||
      invocation.abort.signal.aborted ||
      invocations.get(invocation.workspace.id) !== invocation
    ) {
      return;
    }
    invocation.sourceTaskReady = true;
    if (invocation.configuration.prompt.includes("{{task_prompt}}")) {
      invocation.sourceTask = task;
    }
    stopWatchingSource(invocation);
    log("source_task_available", {
      workspaceId: invocation.workspace.id,
      sourceAgentId,
      via,
    });
    await startAgent(invocation, context);
  }

  async function watchSource(invocation: AgentInvocation, context: PluginHookContext) {
    const sourceAgentId = invocation.sourceAgentId;
    if (
      !sourceAgentId ||
      invocation.sourceSubscription ||
      invocation.phase !== "waiting" ||
      invocation.abort.signal.aborted
    ) {
      return;
    }

    try {
      const agent = context.paseo.agents.ref(sourceAgentId);
      const liveContext = {
        paseo: context.paseo,
        signal: invocation.abort.signal,
      };
      const readSourceTimeline = async () => {
        if (invocation.phase !== "waiting" || invocation.abort.signal.aborted) {
          return;
        }
        const timeline = await agent.timeline.refetch({ direction: "tail", limit: 100 });
        if (timeline.error) {
          throw new Error(timeline.error);
        }
        const firstTask = timeline.entries.find(
          (entry) => entry.item.type === "user_message" && entry.item.text.trim(),
        );
        if (firstTask?.item.type === "user_message") {
          await sourceTaskAvailable(
            invocation, sourceAgentId, firstTask.item.text, liveContext, "readback",
          );
        }
      };
      const subscription = agent.timeline.subscribe((event) => {
        if (event.agentId === sourceAgentId && event.event.type === "subscription_restored") {
          void readSourceTimeline().catch(() => {
            log("source_observation_failed", {
              workspaceId: invocation.workspace.id,
              sourceAgentId,
            }, true);
          });
          return;
        }
        if (event.agentId === sourceAgentId && event.event.type === "error") {
          stopWatchingSource(invocation);
          if (invocation.phase === "waiting" && !invocation.abort.signal.aborted) {
            log("source_observation_failed", {
              workspaceId: invocation.workspace.id,
              sourceAgentId,
            }, true);
          }
          return;
        }
        if (
          event.agentId === sourceAgentId &&
          event.event.type === "timeline" &&
          event.event.item.type === "user_message"
        ) {
          void sourceTaskAvailable(
            invocation, sourceAgentId, event.event.item.text, liveContext, "live",
          );
        }
      });
      invocation.sourceSubscription = subscription;
      if (invocation.phase !== "waiting") {
        stopWatchingSource(invocation);
        return;
      }
      await subscription.ready;
      if (invocation.phase !== "waiting") {
        return;
      }
      await readSourceTimeline();
    } catch (error) {
      stopWatchingSource(invocation);
      if (invocation.phase === "waiting" && !invocation.abort.signal.aborted) {
        log("source_observation_failed", {
          workspaceId: invocation.workspace.id,
          sourceAgentId,
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
    }
  }

  async function startAgent(invocation: AgentInvocation, context: PluginHookContext) {
    const workspace = invocation.workspace;
    if (
      stopped ||
      context.signal.aborted ||
      invocation.abort.signal.aborted ||
      invocation.phase !== "waiting" ||
      invocations.get(workspace.id) !== invocation
    ) {
      return;
    }
    if (!invocation.sourceAgentId ||
      (needsSourceTask(invocation.configuration) && !invocation.sourceTaskReady)) {
      return;
    }
    const prompt = renderPrompt(invocation.configuration.prompt, invocation);
    if (!prompt.trim()) {
      invocation.phase = "finished";
      log("workspace_skipped", {
        workspaceId: workspace.id,
        reason: "prompt_empty_after_render",
      });
      return;
    }

    invocation.phase = "requested";
    const details = {
      workspaceId: workspace.id,
      agentId: invocation.agentId,
    };
    log("agent_request_started", details);

    try {
      await context.paseo.workspaces.ref(workspace.id).agents.create({
        agentId: invocation.agentId,
        parent: invocation.sourceAgentId,
        autoArchive: true,
        config: {
          provider: `${invocation.configuration.provider}/${invocation.configuration.model}`,
          modeId: invocation.configuration.modeId,
        },
        prompt,
        labels: { "paseo-loom.role": "workspace-handler" },
      });
      if (
        stopped ||
        context.signal.aborted ||
        invocations.get(workspace.id) !== invocation
      ) {
        log("agent_request_detached", details);
        return;
      }
      if (invocation.phase === "requested") {
        invocation.phase = "started";
      }
      log("agent_request_completed", {
        ...details,
        phase: invocation.phase,
      });
    } catch (error) {
      if (!hasFinished(invocation)) {
        invocation.phase = "unknown";
      }
      log(
        "agent_request_failed",
        {
          ...details,
          phase: invocation.phase,
          error: error instanceof Error ? error.message : String(error),
          automaticRetry: false,
        },
        true,
      );
    }
  }

  const removeWorkspaceCreated = server.on(
    "workspace.created",
    async (event, context) => {
      const workspace = event.workspace;
      if (stopped || context.signal.aborted) {
        return;
      }
      if (workspace.archivedAt) {
        log("workspace_skipped", {
          workspaceId: workspace.id,
          reason: "workspace_archived",
        });
        return;
      }
      if (invocations.has(workspace.id)) {
        log("duplicate_workspace_ignored", { workspaceId: workspace.id });
        return;
      }
      const configuration = readConfiguration(workspace.id);
      if (!configuration) {
        return;
      }

      const invocation: AgentInvocation = {
        agentId: randomUUID(),
        workspace,
        configuration,
        abort: new AbortController(),
        phase: "waiting",
      };
      invocations.set(workspace.id, invocation);
      log("waiting_for_source", { workspaceId: workspace.id });
    },
  );

  const removeAgentCreated = server.on("agent.created", async (event, context) => {
    if (invocationFor(event.agent)) {
      log("agent_created", {
        workspaceId: event.agent.workspaceId,
        agentId: event.agent.id,
      });
      return;
    }
    const workspaceId = event.agent.workspaceId;
    const invocation = workspaceId ? invocations.get(workspaceId) : null;
    if (invocation && selectSource(invocation, event.agent)) {
      await prepareSource(invocation, context);
    }
  });

  const removeTurnStarted = server.on("agent.turn_started", async (event, context) => {
    const workspaceId = event.agent.workspaceId;
    const invocation = workspaceId ? invocations.get(workspaceId) : null;
    if (invocation && selectSource(invocation, event.agent)) {
      await prepareSource(invocation, context);
    }
  });

  const removeTurnEnded = server.on("agent.turn_ended", async (event, context) => {
    const invocation = invocationFor(event.agent);
    if (!invocation) {
      const workspaceId = event.agent.workspaceId;
      const pending = workspaceId ? invocations.get(workspaceId) : null;
      if (!pending || !selectSource(pending, event.agent)) {
        return;
      }
      if (!needsSourceTask(pending.configuration)) {
        await startAgent(pending, context);
        return;
      }
      const task = event.timeline.find(
        (item) => item.type === "user_message" && item.text.trim(),
      );
      if (!task || task.type !== "user_message") {
        log("source_task_unavailable", { workspaceId });
        return;
      }
      await sourceTaskAvailable(pending, event.agent.id, task.text, context, "turn_end");
      return;
    }
    if (invocation.phase === "finished") {
      return;
    }
    invocation.phase = "finished";
    const failed = event.outcome.kind !== "completed";
    log(
      failed ? "agent_turn_failed" : "agent_turn_completed",
      {
        workspaceId: event.agent.workspaceId,
        agentId: event.agent.id,
        outcome: event.outcome,
      },
      failed,
    );
    await archiveFinishedAgent(invocation, context);
  });

  const removePermissionRequested = server.on(
    "agent.permission_requested",
    (event) => {
      const invocation = invocationFor(event.agent);
      if (invocation && invocation.phase !== "finished") {
        log("agent_permission_requested", {
          workspaceId: event.agent.workspaceId,
          agentId: event.agent.id,
          kind: event.request.kind,
        });
      }
    },
  );

  const removeAgentArchived = server.on("agent.archived", (event) => {
    const invocation = invocationFor(event.agent);
    if (invocation) {
      invocation.phase = "finished";
      invocation.archived = true;
      log("agent_archived", {
        workspaceId: event.agent.workspaceId,
        agentId: event.agent.id,
      });
      return;
    }
    const workspaceId = event.agent.workspaceId;
    const pending = workspaceId ? invocations.get(workspaceId) : null;
    if (pending?.phase === "waiting" && pending.sourceAgentId === event.agent.id) {
      pending.phase = "finished";
      pending.abort.abort();
      stopWatchingSource(pending);
      log("source_archived", { workspaceId, sourceAgentId: event.agent.id });
    }
  });

  const removeWorkspaceArchived = server.on("workspace.archived", (event) => {
    const invocation = invocations.get(event.workspace.id);
    if (invocation) {
      invocation.abort.abort();
      stopWatchingSource(invocation);
    }
    invocations.delete(event.workspace.id);
  });

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    removeWorkspaceCreated();
    removeAgentCreated();
    removeTurnStarted();
    removeTurnEnded();
    removePermissionRequested();
    removeAgentArchived();
    removeWorkspaceArchived();
    for (const invocation of invocations.values()) {
      invocation.abort.abort();
      stopWatchingSource(invocation);
    }
    invocations.clear();
  };
}
