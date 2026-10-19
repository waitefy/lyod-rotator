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

it("keeps a lone thinking fragment recoverable until a tool or visible answer arrives", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]}}],"usageMetadata":{}}}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(awaitAntigravityStreamStart(response, undefined, 10), AntigravityStreamStartError);
  assert.equal(cancelled, true);
});

it("allows continued thinking beyond the initial deadline and preserves it before a tool call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const encoder = new TextEncoder();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let committed = false;
  const thinking = 'data: {"candidates":[{"content":{"parts":[{"text":"thought","thought":true}]}}]}\n\n';
  const tool = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{}}}]}}]}\n\n';
  const pending = awaitAntigravityStreamStart(new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; controller.enqueue(encoder.encode(thinking)); },
  }), { headers: { "Content-Type": "text/event-stream" } }), undefined, 10)
    .then((response) => { committed = true; return response; });
  await setImmediate();
  t.mock.timers.tick(9);
  source.enqueue(encoder.encode(thinking));
  await setImmediate();
  t.mock.timers.tick(9);
  await setImmediate();
  assert.equal(committed, false);
  source.enqueue(encoder.encode(tool));
  source.close();
  assert.equal(await (await pending).text(), thinking + thinking + tool);
});

it("does not let usage heartbeats prolong stalled thinking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const pending = awaitAntigravityStreamStart(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"thought","thought":true}]}}]}\n\n'));
    },
  }), { headers: { "Content-Type": "text/event-stream" } }), undefined, 10);
  const rejected = assert.rejects(pending, AntigravityStreamStartError);
  await setImmediate();
  t.mock.timers.tick(9);
  source.enqueue(new TextEncoder().encode(': heartbeat\n\ndata: {"usageMetadata":{}}\n\n'));
  await setImmediate();
  t.mock.timers.tick(2);
  await rejected;
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

// Virtual time: no model calls and no ten-minute wall-clock wait.
it("keeps a silent generation alive beyond two minutes, up to the trial ten-minute gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const pending = awaitAntigravityStreamStart(new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(pending, /no model event/);
  await setImmediate();
  t.mock.timers.tick(599_999);
  await setImmediate();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(settled, true);
  assert.ok(source);
});
