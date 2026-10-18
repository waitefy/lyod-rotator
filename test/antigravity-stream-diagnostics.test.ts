import assert from "node:assert/strict";
import { it } from "node:test";
import { observeAntigravityStream } from "../src/providers/google-antigravity/stream-diagnostics.js";
import { awaitAntigravityStreamStart } from "../src/providers/google-antigravity/stream-start.js";

const encoder = new TextEncoder();
const headers = { "Content-Type": "text/event-stream" };

it("preserves split UTF-8 bytes while reporting only safe event metadata", async () => {
  const wire = ': heartbeat\r\n\r\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"секрет","thought":true}]}}]}}\r\n\r\n' +
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"private reply"},{"functionCall":{"name":"secret_tool","args":{"token":"sensitive"}}}]},"finishReason":"STOP"}],"usageMetadata":{}}}\n\n' +
    'data: [DONE]\n\n';
  const summaries: Record<string, unknown>[] = [];
  const response = observeAntigravityStream(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoder.encode(wire)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers }), (summary) => summaries.push(summary));
  assert.equal(await response.text(), wire);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[1], {
    ...summaries[1], phase: "end", outcome: "eof", events: 3,
    textEvents: 1, thinkingEvents: 1, toolEvents: 1, usageEvents: 1,
    sawFinish: true, sawDone: true, sawError: false, lastKinds: ["done"],
    malformedEvents: 0, oversizedEvents: 0,
  });
  assert.doesNotMatch(JSON.stringify(summaries), /секрет|private reply|secret_tool|sensitive|STOP/);
});

it("records a terminal marker even if the upstream stays open until cancelled", async () => {
  let cancelled = false;
  const summaries: Record<string, unknown>[] = [];
  const response = observeAntigravityStream(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }), { headers }), (summary) => summaries.push(summary));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel(new Error("private cancellation message"));
  assert.equal(cancelled, true);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1].outcome, "cancel");
  assert.equal(summaries[1].sawFinish, true);
  assert.equal(summaries[1].sawDone, false);
  assert.doesNotMatch(JSON.stringify(summaries), /private cancellation/);
});

it("retains diagnostic cancellation through the startup guard", async () => {
  const summaries: Record<string, unknown>[] = [];
  const response = observeAntigravityStream(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: {"usageMetadata":{}}\n\n')); },
  }), { headers }), (summary) => summaries.push(summary));
  await assert.rejects(awaitAntigravityStreamStart(response, undefined, 10), /no model event/);
  assert.equal(summaries[1].outcome, "cancel");
  assert.equal(summaries[1].usageEvents, 1);
  assert.equal(summaries[1].sawFinish, false);
});

it("bounds huge diagnostic events without changing bytes or losing later markers", async () => {
  const summaries: Record<string, unknown>[] = [];
  const wire = 'data: {"text":"' + 'x'.repeat(100_000) + '"}\n\ndata: [DONE]\n\n';
  const bytes = encoder.encode(wire);
  const response = observeAntigravityStream(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 70_000));
      controller.enqueue(bytes.slice(70_000));
      controller.close();
    },
  }), { headers }), (summary) => summaries.push(summary));
  assert.equal(await response.text(), wire);
  assert.equal(summaries[1].oversizedEvents, 1);
  assert.equal(summaries[1].sawDone, true);
  assert.equal(summaries[1].malformedEvents, 0);
});

it("reports read failure once without logging the upstream error message", async () => {
  const summaries: Record<string, unknown>[] = [];
  const response = observeAntigravityStream(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("private upstream error")); },
  }), { headers }), (summary) => summaries.push(summary));
  await assert.rejects(response.text(), /private upstream error/);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1].outcome, "read_error");
  assert.doesNotMatch(JSON.stringify(summaries), /private upstream error/);
});

it("diagnostic sink failures never affect delivery and non-SSE is untouched", async () => {
  const response = observeAntigravityStream(new Response('data: [DONE]\n\n', { headers }), () => { throw new Error("sink"); });
  assert.equal(await response.text(), 'data: [DONE]\n\n');
  const json = new Response('{}', { headers: { "Content-Type": "application/json" } });
  assert.equal(observeAntigravityStream(json), json);
});
