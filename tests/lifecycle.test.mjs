import assert from "node:assert/strict";
import { test } from "node:test";
import contribute from "../index.server.ts";

const workspace = {
  id: "workspace-1", projectId: "project-1", cwd: "/fixture",
  name: "Original title", archivedAt: null,
};
const source = {
  id: "source-1", workspaceId: workspace.id, parentAgentId: null,
  provider: "codex", cwd: workspace.cwd, title: "User task",
};
const taskItem = (text = "Original user task") => ({ type: "user_message", text });

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
  const creations = [];
  const archives = [];
  const refetches = [];
  const released = [];
  const abort = new AbortController();
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
              return {
                ready: options.subscriptionError
                  ? Promise.reject(options.subscriptionError) : Promise.resolve(),
                async release() {
                  released.push(id);
                  timelineListeners.delete(id);
                },
              };
            },
            async refetch(query) {
              refetches.push({ id, query });
              return { entries: (options.history ?? []).map((item) => ({ item })) };
            },
          },
        };
      },
    },
  };
  const cleanup = contribute({
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  });
  t.after(cleanup);
  h = {
    creations, archives, refetches, logs, released, abort, cleanup,
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
      timelineListeners.get(agentId)?.({
        agentId, event: { type: "timeline", item },
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return h;
}

test("plain prompt waits for the root and creates one child without changing configuration", async (t) => {
  const h = harness(t, { prompt: "  Rename {{workspace_id}} / {{cwd}}  " });
  await h.open();
  assert.equal(h.creations.length, 0);
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 1);
  const created = h.creations[0];
  assert.equal(created.parent, source.id);
  assert.equal(created.autoArchive, true);
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

test("source ID prompt waits for a live user message and does not copy user text", async (t) => {
  const h = harness(t, { prompt: "Read {{source_agent_id}}" });
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.message(taskItem("   "));
  assert.equal(h.creations.length, 0);
  await h.message();
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

test("daemon auto-archive before the terminal hook does not trigger another archive", async (t) => {
  const h = harness(t);
  await h.open();
  await h.emit("agent.created", { agent: source });
  await h.emit("agent.archived", { agent: h.child(), archivedAt: "2026-10-03T00:00:00Z" });
  await h.finish();
  assert.deepEqual(h.archives, []);
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
  });
  await h.open();
  await h.emit("agent.created", { agent: source });
  assert.equal(h.creations.length, 0);
  await h.emit("agent.turn_ended", { agent: source, outcome: { kind: "completed" }, timeline: [taskItem()] });
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
