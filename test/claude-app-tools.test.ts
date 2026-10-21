import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareRequest, translateResponse } from "../src/providers/claude-app/tools.js";

const tool = { type: "function", function: { name: "read", parameters: {
  type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
} } };
const request = { messages: [{ role: "user", content: "Read example.txt" }], tools: [tool] };
const encoder = new TextEncoder();
const sse = (content: string, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ?? null }] })}\n\n`;

it("rejects unsupported attachments, structured output and invalid declarations before network access", () => {
  assert.throws(() => prepareRequest({ ...request, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///private" } }] }] }), /attachments/);
  assert.throws(() => prepareRequest({ ...request, reasoning_effort: "invalid" }), /effort/);
  assert.throws(() => prepareRequest({ ...request, reasoning_effort: ["high"] }), /effort/);
  assert.throws(() => prepareRequest({ ...request, thinking: { type: "disabled" } }), /adaptive/);
  assert.throws(() => prepareRequest({ ...request, response_format: { type: "json_schema" } }), /structured/);
  assert.throws(() => prepareRequest({ ...request, tools: [tool, tool] }), /duplicate/);
  assert.throws(() => prepareRequest({ ...request, tool_choice: { type: "function", function: { name: "unknown" } } }), /Unknown required tool/);
});

it("validates actual generated tool arguments rather than forwarding malformed calls", async () => {
  const { bridge } = prepareRequest({ ...request, tool_choice: "required" });
  const marker = bridge!.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/i)![0];
  const response = (content: string) => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  await assert.rejects(translateResponse(response(marker + JSON.stringify({ name: "read", arguments: { path: 42 } })), bridge, "auto", false), /Invalid tool arguments/);
  await assert.rejects(translateResponse(response("I read the file"), bridge, "auto", false), /tool call is required/);
  const result = await translateResponse(response(marker + JSON.stringify({ name: "read", arguments: { path: "example.txt" } })), bridge, "auto", false);
  const choice = (await result.json()).choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { path: "example.txt" });
});

it("streams ordinary text before completion even when tools are enabled", async () => {
  const { bridge } = prepareRequest(request);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const raw = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(encoder.encode(sse("Hello"))); } });
  const result = await translateResponse(new Response(raw), bridge, "auto", true);
  const reader = result.body!.getReader();
  try {
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /Hello/);
    upstream.enqueue(encoder.encode(sse(" world", "length") + "data: [DONE]\n\n")); upstream.close();
    let rest = "";
    while (true) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    assert.match(rest, /world/); assert.match(rest, /"finish_reason":"length"/);
  } finally { await reader.cancel(); }
});

it("holds partial tool markers and emits a validated tool call instead of marker text", async () => {
  const { bridge } = prepareRequest(request);
  const marker = bridge!.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/i)![0];
  const output = marker + JSON.stringify({ name: "read", arguments: { path: "example.txt" } });
  const raw = sse(output.slice(0, 6)) + sse(output.slice(6), "stop") + "data: [DONE]\n\n";
  const result = await translateResponse(new Response(raw), bridge, "auto", true);
  const text = await result.text();
  assert.match(text, /tool_calls/); assert.match(text, /example.txt/); assert.doesNotMatch(text, /ROTATOR_TOOL/);
});

it("rejects interrupted streams and propagates downstream cancellation", async () => {
  const { bridge } = prepareRequest(request);
  const broken = await translateResponse(new Response(sse("Partial")), bridge, "auto", true);
  await assert.rejects(broken.text(), /invalid or interrupted/);
  let cancelled = false;
  const raw = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const result = await translateResponse(new Response(raw), bridge, "auto", true);
  await result.body!.cancel();
  assert.equal(cancelled, true);
});

it("distinguishes missing calls, malformed JSON and invalid arguments without exposing response text", async () => {
  const { bridge } = prepareRequest({ ...request, tool_choice: "required" });
  const marker = bridge!.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/i)![0];
  for (const [content, reason] of [
    ["PRIVATE_RESPONSE", "required_tool_missing"],
    [marker + '{"secret":"PRIVATE_RESPONSE"', "invalid_tool_json"],
    [marker + JSON.stringify({ name: "read", arguments: { path: 42 } }), "invalid_tool_arguments"],
  ]) {
    const result = await translateResponse(new Response(sse(content, "stop") + "data: [DONE]\n\n"), bridge, "auto", true);
    await assert.rejects(result.text(), (error: Error) => {
      assert.match(error.message, new RegExp(reason!));
      assert.doesNotMatch(error.message, /PRIVATE_RESPONSE|ROTATOR_TOOL/);
      return true;
    });
  }
});

it("classifies upstream read failures without forwarding arbitrary error messages", async () => {
  const { bridge } = prepareRequest(request);
  const raw = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("PRIVATE_UPSTREAM")); } });
  const result = await translateResponse(new Response(raw), bridge, "auto", true);
  await assert.rejects(result.text(), (error: Error) => {
    assert.match(error.message, /upstream_read/);
    assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM/);
    return true;
  });
});
