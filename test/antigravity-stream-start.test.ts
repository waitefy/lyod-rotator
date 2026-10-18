import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import { forwardRequest } from "../src/providers/google-antigravity/forward.js";
import type { AccountRuntime } from "../src/types.js";
import { awaitAntigravityStreamStart, AntigravityStreamStartError } from "../src/providers/google-antigravity/stream-start.js";

it("does not commit an Antigravity response that has only headers and usage", async (t) => {
  const encoder = new TextEncoder();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(encoder.encode(': keepalive\n\ndata: {"response":{"usageMetadata":{"promptTokenCount":100}}}\n\n'));
    },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(upstream, {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const account = {
    config: { email: "stream-test@example.invalid", projectId: "test-project" },
    accessToken: "test-token",
  } as AccountRuntime;
  let committed = false;
  const pending = forwardRequest(account, {
    project: "test-project", model: "gemini-3.8-flash-high", request: {},
  }, {}).then((response) => {
    committed = true;
    return response;
  });
  try {
    await setImmediate();
    assert.equal(committed, false, "HTTP 200 without model output must remain recoverable");
  } finally {
    source.enqueue(encoder.encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\n'));
    source.close();
    const result = await pending;
    assert.match(await result.response.text(), /hello/);
  }
});

it("times out usage-only streams and cancels the old reader", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(awaitAntigravityStreamStart(response, undefined, 10), AntigravityStreamStartError);
  assert.equal(cancelled, true);
});

it("does not mistake empty model placeholders for actual generation", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":""}]}}]}\n\n'));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(awaitAntigravityStreamStart(response, undefined, 10), AntigravityStreamStartError);
});

it("bounds startup buffering even if the upstream keeps sending comments", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(':' + 'x'.repeat(300_000)));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(awaitAntigravityStreamStart(response), /buffer limit/);
});

it("preserves split UTF-8, thinking, tools and all subsequent bytes", async () => {
  const wire = ': heartbeat\r\n\r\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"мысль","thought":true}]}}]}}\r\n\r\n' +
    'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{}}}]}}]}}\n\n';
  const bytes = new TextEncoder().encode(wire);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const guarded = await awaitAntigravityStreamStart(response, undefined, 1000);
  assert.equal(await guarded.text(), wire);
});

it("honours caller cancellation without waiting for the startup deadline", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const controller = new AbortController();
  const pending = awaitAntigravityStreamStart(response, controller.signal, 60_000);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

it("passes Google terminal errors and safety responses to normal classification", async () => {
  for (const payload of [
    { error: { code: 429, message: "quota" } },
    { response: { promptFeedback: { blockReason: "SAFETY" } } },
    { response: { candidates: [{ finishReason: "STOP" }] } },
  ]) {
    const wire = `data: ${JSON.stringify(payload)}\n\n`;
    const guarded = await awaitAntigravityStreamStart(new Response(wire, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    assert.equal(await guarded.text(), wire);
  }
  const denied = new Response("denied", { status: 403 });
  assert.equal(await awaitAntigravityStreamStart(denied), denied);
});

it("treats premature EOF as recoverable, but never replays an established stream", async () => {
  await assert.rejects(awaitAntigravityStreamStart(new Response(': heartbeat\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  })), AntigravityStreamStartError);
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"start"}]}}]}\n\n'));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const guarded = await awaitAntigravityStreamStart(response);
  source.error(new Error("failure after generation started"));
  await assert.rejects(guarded.text(), /failure after generation started/);
});
