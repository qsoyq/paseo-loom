import { randomUUID } from "node:crypto";
import type {
  PluginHookAgent,
  PluginHookWorkspace,
  PluginServerContext,
} from "@getpaseo/plugin/server";

const environmentKeys = {
  provider: "PASEO_LOOM_PROVIDER",
  model: "PASEO_LOOM_MODEL",
  prompt: "PASEO_LOOM_PROMPT",
} as const;

type AgentInvocation = {
  agentId: string;
  phase: "requested" | "started" | "unknown" | "finished";
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
  const prompt = process.env[environmentKeys.prompt];

  if (!provider || !model || !prompt?.trim()) {
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

  return { provider, model, prompt };
}

function renderPrompt(template: string, workspace: PluginHookWorkspace) {
  const values: Record<string, string> = {
    workspace_id: workspace.id,
    cwd: workspace.cwd,
    workspace_title: workspace.name ?? "",
  };
  return template.replace(
    /\{\{(workspace_id|cwd|workspace_title)\}\}/g,
    (_token, key: string) => values[key],
  );
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
      const prompt = renderPrompt(configuration.prompt, workspace);
      if (!prompt.trim()) {
        log("workspace_skipped", {
          workspaceId: workspace.id,
          reason: "prompt_empty_after_render",
        });
        return;
      }

      const invocation: AgentInvocation = {
        agentId: randomUUID(),
        phase: "requested",
      };
      invocations.set(workspace.id, invocation);
      const details = {
        workspaceId: workspace.id,
        agentId: invocation.agentId,
      };
      log("agent_request_started", details);

      try {
        await context.paseo.workspaces.ref(workspace.id).agents.create({
          agentId: invocation.agentId,
          config: {
            provider: `${configuration.provider}/${configuration.model}`,
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
        if (invocation.phase !== "finished") {
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
    },
  );

  const removeAgentCreated = server.on("agent.created", (event) => {
    if (invocationFor(event.agent)) {
      log("agent_created", {
        workspaceId: event.agent.workspaceId,
        agentId: event.agent.id,
      });
    }
  });

  const removeTurnEnded = server.on("agent.turn_ended", (event) => {
    const invocation = invocationFor(event.agent);
    if (!invocation || invocation.phase === "finished") {
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
      log("agent_archived", {
        workspaceId: event.agent.workspaceId,
        agentId: event.agent.id,
      });
    }
  });

  const removeWorkspaceArchived = server.on("workspace.archived", (event) => {
    invocations.delete(event.workspace.id);
  });

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    removeWorkspaceCreated();
    removeAgentCreated();
    removeTurnEnded();
    removePermissionRequested();
    removeAgentArchived();
    removeWorkspaceArchived();
    invocations.clear();
  };
}
