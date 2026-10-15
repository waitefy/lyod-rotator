import assert from "node:assert/strict";
import { test } from "node:test";
import register from "./omp-gemini-web.js";

test("Argon uses supported tools and restores the previous tool set and thinking on model switch", async () => {
  const handlers = new Map();
  let active = ["read", "bash", "edit", "write", "glob", "grep", "task"];
  let thinking = "high";
  const original = [...active];
  register({
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => [...active],
    setActiveTools: async (tools) => { active = [...tools]; },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level) => { thinking = level; },
  });
  const context = (id, provider = "tuxevil-rotator") => ({ model: { id, provider } });
  await handlers.get("session_start")({}, context("gemini-3.8-flash-high"));
  assert.deepEqual(active, original);
  for (const suffix of ["low", "medium", "high"]) {
    await handlers.get("before_agent_start")({}, context(`gemini-4-argon-web-${suffix}`));
    assert.deepEqual(active, ["read", "edit", "write", "glob", "grep"]);
    assert.equal(thinking, "off");
    await handlers.get("turn_start")({}, context(`gemini-4-argon-web-${suffix}`));
  }
  await handlers.get("before_agent_start")({}, context("gemini-3.8-flash-high"));
  assert.deepEqual(active, original);
  assert.equal(thinking, "high");
  await handlers.get("before_agent_start")({}, context("gemini-4-argon-web-high", "another-provider"));
  assert.deepEqual(active, original);
  // Explicit read-only/no-tools sessions remain restricted by the caller.
  for (const tools of [["read"], []]) {
    active = [...tools];
    await handlers.get("before_agent_start")({}, context("gemini-4-argon-web"));
    assert.deepEqual(active, tools);
    await handlers.get("before_agent_start")({}, context("other"));
    assert.deepEqual(active, tools);
  }
});
