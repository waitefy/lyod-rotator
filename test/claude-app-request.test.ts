import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchClaudeMessage } from "../src/providers/claude-app/request.js";

it("honors short Retry-After with bounded backoff and returns the successful stream untouched", async () => {
  const waits: number[] = [];
  let calls = 0;
  const success = new Response("stream");
  const result = await fetchClaudeMessage("http://localhost/messages", { body: "{}" }, async () => {
    calls++;
    return calls < 3 ? new Response("rate limit", { status: 429, headers: { "retry-after": calls === 1 ? "0" : "3" } }) : success;
  }, async (ms) => { waits.push(ms); });
  assert.equal(result, success);
  assert.equal(await result.text(), "stream");
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(calls, 3);
});

it("does not retry quota windows, unknown resets, authentication errors or a started successful answer", async () => {
  for (const [status, retry] of [[429, "600"], [429, ""], [429, "NaN"], [429, "-1"], [401, "0"], [200, "0"]] as const) {
    let calls = 0;
    const response = new Response("body", { status, headers: retry ? { "retry-after": retry } : {} });
    assert.equal(await fetchClaudeMessage("http://localhost/messages", { body: "{}" }, async () => {
      calls++; return response;
    }, async () => { assert.fail("Unexpected retry"); }), response);
    assert.equal(calls, 1);
  }
});

it("stops after two retries and respects cancellation during backoff", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("rate limit", { status: 429, headers: { "retry-after": "1" } }); };
  const result = await fetchClaudeMessage("http://localhost/messages", { body: "{}" }, fetchImpl, async () => {});
  assert.equal(result.status, 429);
  assert.equal(calls, 3);
  calls = 0;
  const controller = new AbortController();
  await assert.rejects(fetchClaudeMessage("http://localhost/messages", { body: "{}", signal: controller.signal }, fetchImpl,
    async () => { controller.abort(); }), /abort/i);
  assert.equal(calls, 1);
});
