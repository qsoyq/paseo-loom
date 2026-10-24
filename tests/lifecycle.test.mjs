import assert from "node:assert/strict";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { loomSettings, defaultLoomSettings } from "../shared/settings.ts";

const workspace = {
  id: "workspace-1", projectId: "project-1", cwd: "/fixture",
  name: "Original title", archivedAt: null,
};
const source = {
  id: "source-1", workspaceId: workspace.id, parentAgentId: null,
  provider: "codex", cwd: workspace.cwd, title: "User task",
};
const taskItem = (text = "Original user task") => ({ type: "user_message", text });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const multilineTask = "/tmp/CuaDriver.md\n\n如何检查 CuaDriver 授权或解除授权？\n\n[User] is literal data\n```text\n{{workspace_id}} $&\n```\n";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    PASEO_LOOM_PROVIDER: "configured-provider",
    PASEO_LOOM_MODEL: "configured-model",
    PASEO_LOOM_MODE_ID: "configured-mode",
    PASEO_LOOM_PROMPT: options.prompt ?? "Rename {{workspace_id}}",
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
  t.mock.method(console, "error", (line) => logs.push(JSON.parse(line)));
  const listeners = new Map();
  const timelineListeners = new Map();
  const subscriptions = [];
  const creations = [];
  const archives = [];
  const refetches = [];
  const released = [];
  const history = [...(options.history ?? [])];
  const abort = new AbortController();
  let settingsListener;
  let settingsValues = options.settings ?? {
    provider: "",
    model: "",
    modeId: "",
    prompt: "",
    useEnvironmentFallback: true,
    environmentKeys: {
      provider: "PASEO_LOOM_PROVIDER",
      model: "PASEO_LOOM_MODEL",
      modeId: "PASEO_LOOM_MODE_ID",
      prompt: "PASEO_LOOM_PROMPT",
    },
  };
  let settingsRevision = "settings-1";
  let h;
  const paseo = {
    workspaces: {
      ref(id) {
        assert.equal(id, workspace.id);
        return { agents: { async create(input) {
          creations.push(input);
          await options.onCreate?.(input, h);
          if (options.createError) throw options.createError;
          return { id: input.agentId };
        } } };
      },
    },
    agents: {
      ref(id) {
        return {
          async archive() {
            archives.push(id);
            if (options.archiveError) throw options.archiveError;
            await h.emit("agent.archived", {
              agent: h.child(), archivedAt: "2026-10-03T00:00:00Z",
            });
            return { archivedAt: "2026-10-03T00:00:00Z" };
          },
          timeline: {
            subscribe(listener) {
              timelineListeners.set(id, listener);
              const subscription = {
                id, listener,
                ready: options.subscriptionError
                  ? Promise.reject(options.subscriptionError) : Promise.resolve(),
                async release() {
                  released.push(id);
                  if (timelineListeners.get(id) === listener) timelineListeners.delete(id);
                },
              };
              subscriptions.push(subscription);
              options.onSubscribe?.(subscription);
              return subscription;
            },
            async refetch(query) {
              refetches.push({ id, query });
              if (options.onRefetch) return options.onRefetch(query, h);
              return { entries: history.map((item) => ({ item })), hasOlder: false };
            },
          },
        };
      },
    },
  };
  const cleanup = contribute({
    registerSettings() {
      return {
        async read() {
          if (options.readSettings) return options.readSettings();
          return { status: "ready", revision: settingsRevision, values: settingsValues };
        },
        subscribe(listener) {
          settingsListener = listener;
          return () => {
            if (settingsListener === listener) settingsListener = undefined;
          };
        },
      };
    },
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  });
  t.after(cleanup);
  h = {
    creations, archives, refetches, logs, released, subscriptions, abort, cleanup,
    async updateSettings(values) {
      settingsValues = values;
      settingsRevision = `settings-${Date.now()}`;
      await settingsListener?.({
        status: "ready",
        revision: settingsRevision,
        values,
      });
    },
    async emit(name, payload) {
      await listeners.get(name)?.(payload, { paseo, signal: abort.signal });
    },
    async open() { await h.emit("workspace.created", { workspace }); },
    child() {
      assert.equal(creations.length, 1);
      return { ...source, id: creations[0].agentId, parentAgentId: source.id };
    },
    async finish(outcome = { kind: "completed" }, agent = h.child()) {
      await h.emit("agent.turn_ended", { agent, outcome, timeline: [] });
    },
    async message(item = taskItem(), agentId = source.id) {
      if (agentId === source.id) history.push(item);
      timelineListeners.get(agentId)?.({
        agentId, event: { type: "timeline", item },
      });
      await flush();
    },
  };
  return h;
}

test("an empty mode ID omits mode for providers with no selectable modes", async (t) => {
  const h = harness(t, {
    settings: {
      provider: "pi",
      model: "magpie/group/auto",
      modeId: "",
      prompt: "Rename {{workspace_id}}",
      useEnvironmentFallback: false,
      environmentKeys: {
        provider: "PASEO_LOOM_PROVIDER",
        model: "PASEO_LOOM_MODEL",
        modeId: "PASEO_LOOM_MODE_ID",
        prompt: "PASEO_LOOM_PROMPT",
      },
    },
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.deepEqual(h.creations[0].config, { provider: "pi/magpie/group/auto" });
});

test("an explicit mode ID remains in the child configuration", async (t) => {
  const h = harness(t, {
    settings: {
      provider: "codex",
      model: "configured-model",
      modeId: "full-access",
      prompt: "Rename {{workspace_id}}",
      useEnvironmentFallback: false,
      environmentKeys: {
        provider: "PASEO_LOOM_PROVIDER",
        model: "PASEO_LOOM_MODEL",
        modeId: "PASEO_LOOM_MODE_ID",
        prompt: "PASEO_LOOM_PROMPT",
      },
    },
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.deepEqual(h.creations[0].config, {
    provider: "codex/configured-model",
    modeId: "full-access",
  });
});

test("settings values take precedence over environment fallback", async (t) => {
  const h = harness(t, {
    settings: {
      provider: "settings-provider",
      model: "",
      modeId: "settings-mode",
      prompt: "Settings {{workspace_id}}",
      useEnvironmentFallback: true,
      environmentKeys: {
        provider: "CUSTOM_PROVIDER",
        model: "CUSTOM_MODEL",
        modeId: "CUSTOM_MODE",
        prompt: "CUSTOM_PROMPT",
      },
    },
  });
  process.env.CUSTOM_MODEL = "custom-model";
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.deepEqual(h.creations[0].config, {
    provider: "settings-provider/custom-model",
    modeId: "settings-mode",
  });
  assert.equal(h.creations[0].prompt, "Settings workspace-1");
});

test("disabling environment fallback requires complete Settings values", async (t) => {
  const h = harness(t, {
    settings: {
      provider: "settings-provider",
      model: "",
      modeId: "settings-mode",
      prompt: "Settings prompt",
      useEnvironmentFallback: false,
      environmentKeys: {
        provider: "PASEO_LOOM_PROVIDER",
        model: "PASEO_LOOM_MODEL",
        modeId: "PASEO_LOOM_MODE_ID",
        prompt: "PASEO_LOOM_PROMPT",
      },
    },
  });
  await h.open();
  assert.equal(h.creations.length, 0);
  assert.equal(h.logs.at(-1).reason, "configuration_missing");
});

test("live Settings changes affect subsequent workspaces without reload", async (t) => {
  const h = harness(t);
  await h.updateSettings({
    provider: "live-provider",
    model: "live-model",
    modeId: "live-mode",
    prompt: "Live prompt",
    useEnvironmentFallback: false,
    environmentKeys: {
      provider: "PASEO_LOOM_PROVIDER",
      model: "PASEO_LOOM_MODEL",
      modeId: "PASEO_LOOM_MODE_ID",
      prompt: "PASEO_LOOM_PROMPT",
    },
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations[0].config.provider, "live-provider/live-model");
});

test("pending workspace keeps its configuration after a Settings change", async (t) => {
  const h = harness(t);
  await h.open();
  await h.updateSettings({ ...defaultLoomSettings, prompt: "New rule" });
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations[0].prompt, "Rename workspace-1");
});

test("invalid saved settings skip work instead of enabling legacy fallback", async (t) => {
  const h = harness(t, { readSettings: async () => ({ status: "invalid", error: "invalid" }) });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 0);
  assert.equal(h.logs.at(-1).reason, "settings_unavailable");
});

test("failed Settings read skips work instead of enabling legacy fallback", async (t) => {
  const h = harness(t, { readSettings: async () => { throw new Error("unavailable"); } });
  await h.open();
  assert.equal(h.logs.at(-1).reason, "settings_unavailable");
});

for (const stop of ["cleanup", "workspace.archived", "duplicate"]) {
  test(`${stop} while Settings load does not create duplicate or archived work`, async (t) => {
    const read = deferred();
    const h = harness(t, { readSettings: () => read.promise });
    const opened = h.open();
    await flush();
    if (stop === "cleanup") h.cleanup();
    if (stop === "workspace.archived") await h.emit(stop, { workspace });
    if (stop === "duplicate") await h.open();
    read.resolve({ status: "ready", values: defaultLoomSettings, revision: "1" });
    await opened;
    await h.emit("agent.created", { agent: source });
    assert.equal(h.creations.length, stop === "duplicate" ? 1 : 0);
  });
}

test("Settings defaults preserve legacy names and reject invalid variable names", () => {
  assert.deepEqual(loomSettings.schema.parse({}), defaultLoomSettings);
  for (const name of ["", "1KEY", "KEY-NAME", "KEY NAME", "NAME\n"]) {
    assert.equal(loomSettings.schema.safeParse({
      ...defaultLoomSettings, environmentKeys: { ...defaultLoomSettings.environmentKeys, prompt: name },
    }).success, false);
  }
});

test("plain prompt waits for the root and creates one child without changing configuration", async (t) => {
  const h = harness(t, { prompt: "  Rename {{workspace_id}} / {{cwd}}  " });
  await h.open();
  assert.equal(h.creations.length, 0);
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 1);
  const created = h.creations[0];
  assert.equal(created.parent, source.id);
  assert.equal(created.autoArchive, false);
  assert.deepEqual(created.config, {
    provider: "configured-provider/configured-model", modeId: "configured-mode",
  });
  assert.equal(created.prompt, "  Rename workspace-1 / /fixture  ");
  assert.deepEqual(created.labels, { "paseo-loom.role": "workspace-handler" });
  assert.equal(h.refetches.length, 0);
});

test("other workspaces and delegated agents cannot become sources or cause ambiguity", async (t) => {
  const h = harness(t, { prompt: "Read {{source_agent_id}}" });
  await h.open();
  await h.emit("agent.created", { agent: { ...source, workspaceId: "workspace-2" } });
  await h.emit("agent.created", { agent: { ...source, id: "other-child", parentAgentId: "other-root" } });
  assert.equal(h.creations.length, 0);
  assert.equal(h.refetches.length, 0);
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.turn_started", { agent: { ...source, id: "another-child", parentAgentId: source.id } });
  await h.message();
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0].parent, source.id);
  assert.equal(h.logs.some((entry) => entry.event === "source_ambiguous"), false);
});

for (const via of ["live", "readback", "turn_end"]) {
  test(`${via} preserves the entire multiline task without recursive interpolation`, async (t) => {
    const h = harness(t, {
      prompt: "<source_task>\n{{task_prompt}}\n</source_task>",
      history: via === "live" ? [] : [taskItem(multilineTask)],
    });
    await h.open();
    if (via === "turn_end") await h.finish({ kind: "completed" }, source);
    else {
      await h.emit("agent.created", { agent: source });
      if (via === "live") await h.message(taskItem(multilineTask));
    }
    assert.equal(h.creations.length, 1);
    assert.equal(h.creations[0].prompt, `<source_task>\n${multilineTask}\n</source_task>`);
    assert.equal(h.logs.some((entry) => entry.event === "source_task_available" && entry.via === via), true);
    assert.equal(JSON.stringify(h.logs).includes("CuaDriver"), false);
  });
}

for (const via of ["readback", "turn_end", "live"]) {
  test(`${via} pages beyond 100 entries before choosing the original task`, async (t) => {
    let ready = via !== "live";
    const h = harness(t, {
      prompt: "{{task_prompt}}",
      onRefetch(query) {
        if (!ready) return { entries: [], hasOlder: false };
        if (query.direction === "tail") return {
          entries: [taskItem("Later user task"), ...Array.from({ length: 99 }, () => ({ type: "assistant_message", text: "output" }))].map((item) => ({ item })),
          hasOlder: true, startCursor: { epoch: "epoch-1", seq: 100 },
        };
        assert.deepEqual(query.cursor, { epoch: "epoch-1", seq: 100 });
        return { entries: [{ item: taskItem(multilineTask) }], hasOlder: false, startCursor: { epoch: "epoch-1", seq: 0 } };
      },
    });
    await h.open();
    if (via === "turn_end") await h.finish({ kind: "completed" }, source);
    else {
      await h.emit("agent.created", { agent: source });
      if (via === "live") {
        ready = true;
        await h.message(taskItem("Newest user task"));
      }
    }
    assert.equal(h.creations[0].prompt, multilineTask);
  });
}

for (const fault of ["missing_cursor", "repeated_cursor", "changed_epoch", "error"]) {
  test(`${fault} cannot promote a later message to the original task`, async (t) => {
    const h = harness(t, {
      prompt: "{{task_prompt}}",
      onRefetch(query) {
        return {
          entries: [{ item: taskItem("Not the original task") }],
          hasOlder: true,
          startCursor: fault === "missing_cursor" ? null : {
            epoch: fault === "changed_epoch" && query.cursor ? "epoch-2" : "epoch-1",
            seq: 100,
          },
          ...(fault === "error" ? { error: "History unavailable" } : {}),
        };
      },
    });
    await h.open();
    await h.emit("agent.created", { agent: source });
    await h.message();
    assert.equal(h.creations.length, 0);
    assert.equal(h.logs.some((entry) => entry.event === "source_observation_failed"), true);
  });
}

test("a subsequent live event can recover after history becomes readable", async (t) => {
  let readable = false;
  const h = harness(t, {
    prompt: "{{task_prompt}}",
    onRefetch() {
      if (!readable) throw new Error("History unavailable");
      return { entries: [{ item: taskItem(multilineTask) }], hasOlder: false };
    },
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 0);
  readable = true;
  await h.message(taskItem("Later follow-up"));
  assert.equal(h.creations[0].prompt, multilineTask);
});

test("an older page without user messages retains the earliest task already found", async (t) => {
  const h = harness(t, {
    prompt: "{{task_prompt}}",
    onRefetch(query) {
      return query.cursor
        ? { entries: [], hasOlder: false, startCursor: null }
        : { entries: [{ item: taskItem(multilineTask) }], hasOlder: true, startCursor: { epoch: "epoch-1", seq: 100 } };
    },
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations[0].prompt, multilineTask);
  assert.equal(h.refetches.length, 2);
});

test("a live follow-up cannot outrun the initial history read", async (t) => {
  const read = deferred();
  const h = harness(t, { prompt: "{{task_prompt}}", onRefetch: () => read.promise });
  await h.open();
  const hook = h.emit("agent.created", { agent: source });
  await flush();
  await h.message(taskItem("Later follow-up"));
  assert.equal(h.creations.length, 0);
  read.resolve({ entries: [{ item: taskItem(multilineTask) }], hasOlder: false });
  await hook;
  await flush();
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0].prompt, multilineTask);
});

test("source ID prompt waits for a live user message and does not copy user text", async (t) => {
  const h = harness(t, { prompt: "Read {{source_agent_id}}" });
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.message(taskItem("   "));
  assert.equal(h.creations.length, 0);
  await h.message(taskItem(multilineTask));
  assert.equal(h.creations[0].prompt, "Read source-1");
  assert.equal(h.creations[0].parent, source.id);
  assert.deepEqual(h.released, [source.id]);
  assert.equal(h.logs.some((entry) => entry.event === "source_task_available" && entry.via === "live"), true);
});

test("task text is injected only when requested, with a single substitution pass", async (t) => {
  const h = harness(t, {
    prompt: "{{workspace_title}}: {{task_prompt}}",
    history: [taskItem("  "), taskItem("Literal {{workspace_id}} $&"), taskItem("Later task")],
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations[0].prompt, "Original title: Literal {{workspace_id}} $&");
  assert.equal(h.logs.some((entry) => entry.event === "source_task_available" && entry.via === "readback"), true);
});

test("duplicate workspace and source events cannot create multiple children", async (t) => {
  const h = harness(t);
  await Promise.all([h.open(), h.open()]);
  await Promise.all([
    h.emit("agent.created", { agent: source }),
    h.emit("agent.turn_started", { agent: source }),
  ]);
  await h.emit("agent.created", { agent: h.child() });
  await h.finish();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 1);
});

for (const outcome of [
  { kind: "completed" },
  { kind: "failed", error: { message: "Provider failure" } },
  { kind: "canceled", reason: "Stopped" },
]) {
  test(`${outcome.kind} archives only the child and ignores duplicate terminal events`, async (t) => {
    const h = harness(t);
    await h.open();
    await h.emit("agent.created", { agent: source });
    await Promise.all([h.finish(outcome), h.finish(outcome)]);
    assert.deepEqual(h.archives, [h.child().id]);
    assert.equal(h.archives.includes(source.id), false);
  });
}

test("a child finishing before create returns is archived without losing its terminal phase", async (t) => {
  const h = harness(t, { async onCreate(_input, fixture) {
    await fixture.finish();
  } });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.deepEqual(h.archives, [h.child().id]);
  assert.equal(h.logs.find((entry) => entry.event === "agent_request_completed").phase, "finished");
});

test("external archive and terminal hooks in either order never duplicate plugin archive", async (t) => {
  for (const archiveFirst of [true, false]) {
    const h = harness(t);
    await h.open();
    await h.emit("agent.created", { agent: source });
    assert.equal(h.creations[0].autoArchive, false);
    if (!archiveFirst) await h.finish();
    await h.emit("agent.archived", { agent: h.child(), archivedAt: "2026-10-03T00:00:00Z" });
    await h.finish();
    assert.equal(h.archives.length, archiveFirst ? 0 : 1);
  }
});

test("archive failure is logged without rerunning the task or archiving the source", async (t) => {
  const h = harness(t, { archiveError: new Error("Archive unavailable") });
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.finish();
  await h.finish();
  assert.equal(h.creations.length, 1);
  assert.deepEqual(h.archives, [h.child().id]);
  assert.equal(h.logs.some((entry) => entry.event === "agent_archive_failed"), true);
});

test("an uncertain creation failure is not retried", async (t) => {
  const h = harness(t, { createError: new Error("Response lost") });
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.turn_started", { agent: source });
  await h.open();
  assert.equal(h.creations.length, 1);
  assert.equal(h.logs.find((entry) => entry.event === "agent_request_failed").automaticRetry, false);
});

test("source turn end recovers a missed source-created event for a plain prompt", async (t) => {
  const h = harness(t);
  await h.open();
  await h.finish({ kind: "completed" }, source);
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0].parent, source.id);
  assert.deepEqual(h.archives, []);
});

test("source turn end supplies requested context when timeline observation failed", async (t) => {
  const h = harness(t, {
    prompt: "{{task_prompt}}", subscriptionError: new Error("Subscription unavailable"),
    history: [taskItem()],
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 0);
  await h.finish({ kind: "completed" }, source);
  assert.equal(h.creations[0].prompt, "Original user task");
});

for (const event of ["agent.archived", "workspace.archived"]) {
  test(`${event} cancels a source waiting for task context`, async (t) => {
    const h = harness(t, { prompt: "{{source_agent_id}}" });
    await h.open();
    await h.emit("agent.created", { agent: source });
    await h.emit(event, { agent: source, workspace, archivedAt: "2026-10-03T00:00:00Z" });
    await h.message();
    await h.finish({ kind: "completed" }, source);
    assert.equal(h.creations.length, 0);
    assert.deepEqual(h.released, [source.id]);
  });
}

test("multiple root candidates while waiting stop the invocation", async (t) => {
  const h = harness(t, { prompt: "{{source_agent_id}}" });
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.created", { agent: { ...source, id: "source-2" } });
  await h.message();
  assert.equal(h.creations.length, 0);
  assert.equal(h.logs.some((entry) => entry.event === "source_ambiguous"), true);
});

test("permission waiting is logged without finishing, archiving, or approving", async (t) => {
  const h = harness(t);
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.permission_requested", { agent: h.child(), request: { id: "permission-1", kind: "mcp" } });
  assert.deepEqual(h.archives, []);
  assert.equal(h.logs.some((entry) => entry.event === "agent_permission_requested"), true);
  await h.finish();
  assert.deepEqual(h.archives, [h.child().id]);
});

test("cleanup removes listeners and releases pending observation", async (t) => {
  const h = harness(t, { prompt: "{{task_prompt}}" });
  await h.open();
  await h.emit("agent.created", { agent: source });
  h.cleanup();
  h.cleanup();
  await h.message();
  await h.open();
  assert.equal(h.creations.length, 0);
  assert.deepEqual(h.released, [source.id]);
});

test("a late failure from a replaced subscription cannot release the new observation", async (t) => {
  const ready = deferred();
  const h = harness(t, {
    prompt: "{{source_agent_id}}",
    onSubscribe(subscription) {
      if (subscription.id === source.id && h.subscriptions.length === 1) {
        subscription.ready = ready.promise;
      }
    },
  });
  await h.open();
  const firstHook = h.emit("agent.created", { agent: source });
  const first = h.subscriptions[0];
  first.listener({ agentId: source.id, event: { type: "error", error: "Disconnected" } });
  await h.emit("agent.turn_started", { agent: source });
  assert.equal(h.subscriptions.length, 2);
  ready.reject(new Error("Old acknowledgement failed"));
  await firstHook;
  await h.message();
  assert.equal(h.creations.length, 1);
  assert.equal(h.creations[0].parent, source.id);
  assert.equal(h.logs.filter((entry) => entry.event === "source_observation_failed").length, 1);
});

test("readback from a released observation cannot supply a stale task", async (t) => {
  const readback = deferred();
  const h = harness(t, {
    prompt: "{{task_prompt}}",
    onRefetch(_query, fixture) {
      return fixture.refetches.length === 1 ? readback.promise : {
        entries: fixture.refetches.length === 2 ? [] : [{ item: taskItem("Current task") }],
      };
    },
  });
  await h.open();
  const firstHook = h.emit("agent.created", { agent: source });
  await flush();
  h.subscriptions[0].listener({ agentId: source.id, event: { type: "error", error: "Disconnected" } });
  await h.emit("agent.turn_started", { agent: source });
  readback.resolve({ entries: [{ item: taskItem("Stale task") }] });
  await firstHook;
  assert.equal(h.creations.length, 0);
  await h.message(taskItem("Current task"));
  assert.equal(h.creations[0].prompt, "Current task");
});

for (const type of ["error", "subscription_restored", "timeline"]) {
  test(`a released subscription ignores a late ${type} callback`, async (t) => {
    const h = harness(t, { prompt: "{{task_prompt}}" });
    await h.open();
    await h.emit("agent.created", { agent: source });
    const first = h.subscriptions[0];
    first.listener({ agentId: source.id, event: { type: "error", error: "Disconnected" } });
    await h.emit("agent.turn_started", { agent: source });
    first.listener({ agentId: source.id, event: { type, item: taskItem("Stale task") } });
    await flush();
    assert.equal(h.creations.length, 0);
    assert.equal(h.refetches.length, 2);
    await h.message(taskItem("Current task"));
    assert.equal(h.creations[0].prompt, "Current task");
    assert.equal(h.logs.filter((entry) => entry.event === "source_observation_failed").length, 1);
  });
}

for (const type of ["error", "timeline"]) {
  test(`a synchronous ${type} callback releases its handle and consumes ready rejection`, async (t) => {
    const h = harness(t, {
      prompt: "{{task_prompt}}",
      history: [taskItem()],
      onSubscribe(subscription) {
        subscription.ready = Promise.reject(new Error("Acknowledgement failed"));
        subscription.listener({ agentId: source.id, event: { type, item: taskItem() } });
      },
    });
    await h.open();
    await h.emit("agent.created", { agent: source });
    await flush();
    assert.deepEqual(h.released, [source.id]);
    assert.equal(h.creations.length, type === "timeline" ? 1 : 0);
    assert.equal(h.logs.filter((entry) => entry.event === "source_observation_failed").length,
      type === "error" ? 1 : 0);
  });
}

for (const via of ["initial", "restored"]) {
  test(`a failed ${via} readback preserves observation but cannot select a later live task`, async (t) => {
    const h = harness(t, {
      prompt: "{{task_prompt}}",
      onRefetch() { throw new Error("History unavailable"); },
    });
    await h.open();
    await h.emit("agent.created", { agent: source });
    if (via === "restored") {
      h.subscriptions[0].listener({ agentId: source.id, event: { type: "subscription_restored" } });
      await flush();
    }
    assert.deepEqual(h.released, []);
    await h.message();
    assert.equal(h.creations.length, 0);
    assert.equal(h.logs.some((entry) => entry.event === "source_observation_failed"), true);
  });
}

for (const stop of ["cleanup", "workspace.archived", "agent.archived"]) {
  test(`${stop} invalidates pending source readback`, async (t) => {
    const readback = deferred();
    const h = harness(t, { prompt: "{{task_prompt}}", onRefetch: () => readback.promise });
    await h.open();
    const hook = h.emit("agent.created", { agent: source });
    await flush();
    if (stop === "cleanup") h.cleanup();
    else await h.emit(stop, { agent: source, workspace, archivedAt: "2026-10-03T00:00:00Z" });
    readback.resolve({ entries: [{ item: taskItem() }] });
    await hook;
    assert.equal(h.creations.length, 0);
    assert.deepEqual(h.released, [source.id]);
  });
}

test("source pause, cancellation and archive after launch leave the child running", async (t) => {
  const h = harness(t);
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.permission_requested", { agent: source, request: { kind: "question" } });
  await h.finish({ kind: "canceled", reason: "Stopped" }, source);
  await h.emit("agent.archived", { agent: source, archivedAt: "2026-10-03T00:00:00Z" });
  assert.equal(h.creations.length, 1);
  assert.deepEqual(h.archives, []);
  await h.finish();
  assert.deepEqual(h.archives, [h.child().id]);
});
