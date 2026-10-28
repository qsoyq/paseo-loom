import { randomUUID } from "node:crypto";
import { loomSettings, type LoomSettings } from "./shared/settings.ts";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginHookWorkspace,
  PluginServerContext,
} from "@getpaseo/plugin/server";

type PaseoAgentTimelineSubscription = ReturnType<
  ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>["timeline"]["subscribe"]
>;

type SourceTimelinePage = Awaited<ReturnType<
  ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>["timeline"]["refetch"]
>>;
type SourceTaskCursor = NonNullable<SourceTimelinePage["startCursor"]>;
type SourceSummary = {
  turnId?: string | null;
  ended: boolean;
  ready: boolean;
  ambiguousTurn: boolean;
  text: string;
};

type LoomConfiguration = {
  provider: string;
  model: string;
  modeId?: string;
  prompt: string;
};

type SourceObservation = {
  subscription?: PaseoAgentTimelineSubscription;
};

type AgentInvocation = {
  agentId: string;
  workspace: PluginHookWorkspace;
  configuration: LoomConfiguration;
  sourceAgentId?: string;
  sourceTask?: string;
  sourceTaskReady?: boolean;
  sourceTaskCursor?: SourceTaskCursor;
  sourceSummary?: SourceSummary;
  sourceObservation?: SourceObservation;
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

function readEnvironmentConfiguration(keys: LoomSettings["environmentKeys"]) {
  return {
    provider: process.env[keys.provider]?.trim() ?? "",
    model: process.env[keys.model]?.trim() ?? "",
    modeId: process.env[keys.modeId]?.trim() ?? "",
    prompt: process.env[keys.prompt] ?? "",
  };
}

function readConfiguration(
  workspaceId: string,
  settings: LoomSettings,
): LoomConfiguration | null {
  const environment = settings.useEnvironmentFallback
    ? readEnvironmentConfiguration(settings.environmentKeys)
    : { provider: "", model: "", modeId: "", prompt: "" };
  const provider = settings.provider.trim() || environment.provider;
  const model = settings.model.trim() || environment.model;
  const modeId = settings.modeId.trim() || environment.modeId || undefined;
  const prompt = settings.prompt.trim() ? settings.prompt : environment.prompt;

  if (!provider || !model || !prompt.trim()) {
    const missingKeys = [
      !provider && "provider",
      !model && "model",
      !prompt.trim() && "prompt",
    ].filter((key): key is string => Boolean(key));
    log("workspace_skipped", {
      workspaceId,
      reason: "configuration_missing",
      missingKeys,
      source: settings.useEnvironmentFallback ? "settings_and_environment" : "settings",
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
    source_summary: invocation.sourceSummary?.text ?? "",
  };
  return template.replace(
    /\{\{(workspace_id|cwd|workspace_title|source_agent_id|task_prompt|source_summary)\}\}/g,
    (_token, key: string) => values[key],
  );
}

function needsSourceTask(configuration: LoomConfiguration) {
  return configuration.prompt.includes("{{source_agent_id}}") ||
    configuration.prompt.includes("{{task_prompt}}") ||
    configuration.prompt.includes("{{source_summary}}");
}

// Only the first user-message interval may supply context. A provider turn ID
// alone is insufficient: it can be absent or reused after reopening a session.
function firstTurnReply(
  entries: SourceTimelinePage["entries"],
  firstUser: number,
  turnId: string | null,
  summary: SourceSummary,
) {
  const nextUser = entries.findIndex((entry, index) =>
    index > firstUser && entry.item.type === "user_message",
  );
  if (summary.ambiguousTurn) return "";
  if (turnId === null && (summary.turnId !== null || nextUser !== -1)) return "";
  if (turnId !== null && nextUser !== -1 &&
    entries.slice(nextUser).some((entry) => entry.turnId === turnId)) return "";
  const interval = entries.slice(firstUser + 1, nextUser === -1 ? undefined : nextUser);
  if (turnId !== null && interval.some((entry) =>
    entry.turnId !== undefined && entry.turnId !== turnId,
  )) return "";

  const chunks: string[] = [];
  let messageId: string | undefined;
  for (let index = interval.length - 1; index >= 0; index--) {
    const entry = interval[index];
    if (entry.item.type === "notification" || entry.item.type === "todo") {
      if (chunks.length) break;
      continue;
    }
    if (entry.item.type !== "assistant_message") break;
    if (turnId !== null && entry.turnId !== turnId) return "";
    if (chunks.length && messageId && entry.item.messageId !== messageId) break;
    messageId ??= entry.item.messageId;
    chunks.push(entry.item.text);
  }
  // Canonical assistant chunks are text deltas, not separate paragraphs.
  const text = chunks.reverse().join("");
  return text.trim() ? text : "";
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(loomSettings);
  let currentSettings: LoomSettings | null = null;
  let settingsChanged = false;
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    currentSettings = state.status === "ready" ? state.values : null;
    if (state.status === "invalid") {
      log("settings_invalid", { reason: "saved_configuration_invalid" }, true);
    }
  };
  const removeSettingsSubscription = settings.subscribe((state) => {
    settingsChanged = true;
    applySettings(state);
  });
  const settingsReady = settings.read().then((state) => {
    if (!settingsChanged) applySettings(state);
  }, () => {
    log("settings_read_failed", { reason: "configuration_unavailable" }, true);
  });
  const pendingWorkspaces = new Map<string, AbortController>();

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
    const subscription = invocation.sourceObservation?.subscription;
    invocation.sourceObservation = undefined;
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
    if (invocation.sourceSummary?.ended || invocation.sourceTaskReady) return;
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
    cursor?: SourceTaskCursor,
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
    invocation.sourceTaskCursor = cursor;
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

  async function readSourcePages(
    invocation: AgentInvocation,
    context: PluginHookContext,
    isCurrent: () => boolean,
    visit: (page: SourceTimelinePage) => void | Promise<void>,
    canonical = false,
  ) {
    if (!invocation.sourceAgentId) return;
    const timeline = context.paseo.agents.ref(invocation.sourceAgentId).timeline;
    let cursor: SourceTaskCursor | undefined;
    let epoch: string | undefined;
    const seen = new Set<string>();
    while (isCurrent() && !context.signal.aborted) {
      const page = await timeline.refetch({
        direction: cursor ? "before" : "tail", limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(canonical ? { projection: "canonical" as const } : {}),
      });
      if (!isCurrent() || context.signal.aborted) return;
      if (page.error) throw new Error("Source timeline read failed");
      if (page.reset || page.staleCursor || page.gap ||
        (epoch !== undefined && page.epoch !== epoch) ||
        (cursor && page.startCursor && page.startCursor.epoch !== cursor.epoch)) {
        throw new Error("Source timeline changed during pagination");
      }
      epoch = page.epoch;
      await visit(page);
      if (!page.hasOlder) return;
      const next = page.startCursor;
      if (!next || seen.has(JSON.stringify(next)) ||
        (cursor && next.seq >= cursor.seq)) {
        throw new Error("Source timeline pagination did not advance");
      }
      seen.add(JSON.stringify(next));
      cursor = next;
    }
  }

  async function readSourceTask(
    invocation: AgentInvocation,
    context: PluginHookContext,
    via: "live" | "readback" | "turn_end",
    isCurrent: () => boolean,
  ) {
    const sourceAgentId = invocation.sourceAgentId;
    if (!sourceAgentId) return;
    let task: string | undefined;
    let cursor: SourceTaskCursor | undefined;
    await readSourcePages(invocation, context, isCurrent, async (page) => {
      const first = page.entries.find(
        (entry) => entry.item.type === "user_message" && entry.item.text.trim(),
      );
      if (first?.item.type === "user_message") {
        task = first.item.text;
        cursor = page.epoch && Number.isInteger(first.seqStart)
          ? { epoch: page.epoch, seq: first.seqStart } : undefined;
      }
      if (!page.hasOlder && isCurrent() && !context.signal.aborted) {
        if (task !== undefined) {
          await sourceTaskAvailable(invocation, sourceAgentId, task, context, via, cursor);
        } else if (via === "turn_end") {
          log("source_task_unavailable", { workspaceId: invocation.workspace.id });
        }
      }
    });
  }

  async function finishSourceSummary(
    invocation: AgentInvocation,
    turnId: string | null,
    outcome: "completed" | "failed" | "canceled",
    context: PluginHookContext,
  ) {
    const summary = invocation.sourceSummary;
    if (!summary || summary.ended || stopped || context.signal.aborted) return;
    // Claim this terminal event before any await; stale live reads lose ownership.
    summary.ended = true;
    stopWatchingSource(invocation);
    const skip = (reason: string) => {
      invocation.phase = "finished";
      invocation.abort.abort();
      log("workspace_skipped", { workspaceId: invocation.workspace.id, reason });
    };
    if (summary.turnId != null && turnId !== summary.turnId) {
      skip("source_turn_mismatch");
      return;
    }
    if (outcome !== "completed") {
      skip(`source_turn_${outcome}`);
      return;
    }
    const isCurrent = () => !stopped && !context.signal.aborted &&
      !invocation.abort.signal.aborted && invocation.phase === "waiting" &&
      invocations.get(invocation.workspace.id) === invocation;
    let reason = "empty_or_ambiguous";
    try {
      const pages: SourceTimelinePage[] = [];
      await readSourcePages(invocation, context, isCurrent, (page) => {
        pages.push(page);
      }, true);
      if (!isCurrent()) return;
      if (!pages.length || pages.at(-1)!.hasOlder) throw new Error("Incomplete history");
      const entries = pages.reverse().flatMap((page) => page.entries);
      const firstUser = entries.findIndex((entry) =>
        entry.item.type === "user_message" && entry.item.text.trim(),
      );
      const first = entries[firstUser];
      const epoch = pages[0].epoch;
      const cursor = first && epoch && Number.isInteger(first.seqStart)
        ? { epoch, seq: first.seqStart } : undefined;
      const original = invocation.sourceTaskCursor;
      const sameTask = !invocation.sourceTaskReady || (original && cursor &&
        original.epoch === cursor.epoch && original.seq === cursor.seq);
      // Require stable ordered entries, not just a matching turn ID. The first
      // fetched tail freezes the upper bound while older pages are read.
      const ordered = cursor && entries.every((entry, index) =>
        Number.isInteger(entry.seqStart) && Number.isInteger(entry.seqEnd) &&
        entry.seqEnd >= entry.seqStart &&
        (index === 0 || entry.seqStart > entries[index - 1].seqEnd),
      );
      if (first?.item.type === "user_message" && sameTask && ordered) {
        await sourceTaskAvailable(invocation, invocation.sourceAgentId!,
          first.item.text, context, "turn_end", cursor);
        if (!isCurrent()) return;
        summary.text = firstTurnReply(entries, firstUser, turnId, summary);
      }
    } catch {
      // Provider errors can contain conversation text; log only a stable reason.
      reason = "read_failed";
    }
    if (!isCurrent()) return;
    summary.ready = true;
    log(summary.text ? "source_summary_available" : "source_summary_unavailable", {
      workspaceId: invocation.workspace.id,
      sourceAgentId: invocation.sourceAgentId,
      ...(summary.text ? {} : { reason }),
    });
    if (!invocation.sourceTaskReady) {
      skip("source_context_unavailable");
      return;
    }
    await startAgent(invocation, context);
  }

  async function watchSource(invocation: AgentInvocation, context: PluginHookContext) {
    const sourceAgentId = invocation.sourceAgentId;
    if (
      !sourceAgentId ||
      invocation.sourceObservation ||
      invocation.phase !== "waiting" ||
      invocation.abort.signal.aborted
    ) {
      return;
    }

    // Reserve ownership before subscribing: the SDK may deliver callbacks synchronously.
    const observation: SourceObservation = {};
    invocation.sourceObservation = observation;
    const isCurrent = () =>
      !stopped &&
      invocation.phase === "waiting" &&
      !invocation.abort.signal.aborted &&
      invocations.get(invocation.workspace.id) === invocation &&
      invocation.sourceObservation === observation;
    const logObservationFailure = (error?: unknown) => {
      log("source_observation_failed", {
        workspaceId: invocation.workspace.id,
        sourceAgentId,
        ...(error === undefined ? {} : {
          error: error instanceof Error ? error.message : String(error),
        }),
      }, true);
    };
    const readbackFailed = (error: unknown) => {
      if (isCurrent()) {
        logObservationFailure(error);
      }
    };
    const observationFailed = (error?: unknown) => {
      if (!isCurrent()) {
        return;
      }
      stopWatchingSource(invocation);
      logObservationFailure(error);
    };

    try {
      const agent = context.paseo.agents.ref(sourceAgentId);
      const liveContext = {
        paseo: context.paseo,
        signal: invocation.abort.signal,
      };
      const readSourceTimeline = (via: "live" | "readback" = "readback") =>
        readSourceTask(invocation, liveContext, via, isCurrent);
      const subscription = agent.timeline.subscribe((event) => {
        if (!isCurrent()) {
          return;
        }
        if (event.agentId === sourceAgentId && event.event.type === "subscription_restored") {
          void readSourceTimeline().catch(readbackFailed);
          return;
        }
        if (event.agentId === sourceAgentId && event.event.type === "error") {
          observationFailed();
          return;
        }
        if (
          event.agentId === sourceAgentId &&
          event.event.type === "timeline" &&
          event.event.item.type === "user_message"
        ) {
          // Live delivery can race history or follow a reconnect. Confirm the
          // earliest message from structured history before selecting a task.
          void readSourceTimeline("live").catch(readbackFailed);
        }
      });
      observation.subscription = subscription;
      // A synchronous callback may already have ended this observation. Release
      // only its handle, and consume acknowledgement failures even after release.
      if (!isCurrent()) {
        void subscription.release().catch(() => {
          log("source_subscription_cleanup_failed", {
            workspaceId: invocation.workspace.id,
          }, true);
        });
      }
      await subscription.ready;
      if (!isCurrent()) {
        return;
      }
      await readSourceTimeline().catch(readbackFailed);
    } catch (error) {
      observationFailed(error);
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
      (needsSourceTask(invocation.configuration) && !invocation.sourceTaskReady) ||
      (invocation.sourceSummary && !invocation.sourceSummary.ready)) {
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
        // The terminal hook is the sole archive owner, including fast completions.
        autoArchive: false,
        config: {
          provider: `${invocation.configuration.provider}/${invocation.configuration.model}`,
          ...(invocation.configuration.modeId
            ? { modeId: invocation.configuration.modeId }
            : {}),
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
      if (invocations.has(workspace.id) || pendingWorkspaces.has(workspace.id)) {
        log("duplicate_workspace_ignored", { workspaceId: workspace.id });
        return;
      }
      const pending = new AbortController();
      pendingWorkspaces.set(workspace.id, pending);
      await settingsReady;
      pendingWorkspaces.delete(workspace.id);
      if (stopped || context.signal.aborted || pending.signal.aborted) return;
      if (!currentSettings) {
        log("workspace_skipped", {
          workspaceId: workspace.id,
          reason: "settings_unavailable",
        });
        return;
      }
      const configuration = readConfiguration(workspace.id, currentSettings);
      if (!configuration) return;

      const invocation: AgentInvocation = {
        agentId: randomUUID(),
        workspace,
        configuration,
        ...(configuration.prompt.includes("{{source_summary}}") ? {
          sourceSummary: { ended: false, ready: false, ambiguousTurn: false, text: "" },
        } : {}),
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
      const summary = invocation.sourceSummary;
      if (summary) {
        if (summary.turnId === undefined && !summary.ended) {
          summary.turnId = event.turnId ?? null;
        } else if (!event.turnId || !summary.turnId || event.turnId === summary.turnId) {
          summary.ambiguousTurn = true;
        }
      }
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
      if (pending.sourceSummary) {
        await finishSourceSummary(pending, event.turnId ?? null, event.outcome.kind, context);
        return;
      }
      if (!needsSourceTask(pending.configuration)) {
        await startAgent(pending, context);
        return;
      }
      try {
        await readSourceTask(pending, context, "turn_end", () =>
          !stopped && pending.phase === "waiting" &&
          !pending.abort.signal.aborted &&
          invocations.get(pending.workspace.id) === pending,
        );
      } catch (error) {
        log("source_observation_failed", {
          workspaceId, sourceAgentId: event.agent.id,
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
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
    pendingWorkspaces.get(event.workspace.id)?.abort();
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
    removeSettingsSubscription();
    for (const pending of pendingWorkspaces.values()) pending.abort();
    pendingWorkspaces.clear();
    for (const invocation of invocations.values()) {
      invocation.abort.abort();
      stopWatchingSource(invocation);
    }
    invocations.clear();
  };
}
