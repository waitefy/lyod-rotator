import assert from "node:assert/strict";
import { it } from "node:test";
import { fromBridgeResponse, toBridgeRequest } from "../src/providers/claude-app/wire.js";
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

it("uses the native Messages request and preserves system instructions and limits", () => {
  assert.deepEqual(toBridgeRequest({ model: "default", messages: [
    { role: "system", content: "system" }, { role: "user", content: "question" }, { role: "system", content: "tools" },
  ], max_completion_tokens: 123, stop: "STOP", stream: true }), {
    model: "default", system: "system\n\ntools", messages: [{ role: "user", content: "question" }],
    max_tokens: 123, stop_sequences: ["STOP"], stream: true,
  });
});

it("maps explicit native completion and token usage without claiming the Auto model's identity", async () => {
  const result = await fromBridgeResponse(Response.json({ id: "msg-fixture", type: "message", model: "upstream-default-label",
    content: [{ type: "text", text: "hello" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 5 } }), "auto", false);
  const data = await result.json();
  assert.equal(data.model, "auto"); assert.equal(data.choices[0].finish_reason, "length");
  assert.equal(data.choices[0].message.content, "hello"); assert.equal(data.usage.total_tokens, 15);
});

it("retains native stop events lost by ClewdR's OpenAI route", async () => {
  const raw = sse({ type: "content_block_delta", delta: { type: "text_delta", text: "HELLO" } })
    + sse({ type: "message_delta", delta: { stop_reason: "max_tokens" } }) + sse({ type: "message_stop" });
  const result = await fromBridgeResponse(new Response(raw), "auto", true);
  const output = await result.text();
  assert.match(output, /HELLO/); assert.match(output, /"finish_reason":"length"/); assert.match(output, /\[DONE\]/);
});

it("rejects EOF without a native message_stop and redacts native error events", async () => {
  for (const raw of [sse({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }),
    sse({ type: "error", error: { message: "private-credential" } })]) {
    const result = await fromBridgeResponse(new Response(raw), "auto", true);
    await assert.rejects(result.text(), (error: Error) => /invalid or interrupted/.test(error.message) && !error.message.includes("private-credential"));
  }
});
