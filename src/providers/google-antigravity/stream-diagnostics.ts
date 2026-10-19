import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";

const streamLogger = logger.child("antigravity-stream");
const MAX_EVENT_CHARS = 64 * 1024;
type Outcome = "eof" | "cancel" | "read_error";

/** Observe transport boundaries, never log payloads, tool names or credentials. */
export function observeAntigravityStream(
  response: Response,
  report: (summary: Record<string, unknown>) => void = (summary) => streamLogger.info(JSON.stringify(summary)),
  context: { account: string; model: string; endpoint: string; headersMs: number } | undefined = undefined,
): Response {
  if (!response.ok || !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")) return response;

  const id = randomUUID();
  const started = Date.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let chunks = 0;
  let bytes = 0;
  let events = 0;
  let textEvents = 0;
  let thinkingEvents = 0;
  let toolEvents = 0;
  let usageEvents = 0;
  let malformedEvents = 0;
  let oversizedEvents = 0;
  let sawFinish = false;
  let sawDone = false;
  let sawError = false;
  let firstChunkMs: number | null = null;
  let lastChunkMs: number | null = null;
  let lastEventMs: number | null = null;
  let firstModelEventMs: number | null = null;
  let firstOutputEventMs: number | null = null;
  let lastModelEventMs: number | null = null;
  let maxChunkGapMs = 0;
  let maxModelGapMs = 0;
  let waitTimers: ReturnType<typeof setTimeout>[] = [];
  let lastKinds: string[] = [];
  let tail = "";
  let data = "";
  let oversized = false;
  let lineOversized = false;
  let ended = false;

  const emit = (summary: Record<string, unknown>): void => {
    // Logging must never change transport behaviour.
    try { report({ ...context, id, ...summary }); } catch { /* diagnostic sink unavailable */ }
  };
  const resetWaitNotices = (): void => {
    for (const timer of waitTimers) clearTimeout(timer);
    waitTimers = [30_000, 120_000].map((afterMs) => {
      const timer = setTimeout(() => emit({ phase: "waiting", afterMs,
        elapsedMs: Date.now() - started, sinceModelProgressMs: Date.now() - started - (lastModelEventMs ?? 0),
        action: "keep_waiting", retry: false }), afterMs);
      timer.unref?.();
      return timer;
    });
  };
  const modelProgress = (output = false): void => {
    const now = Date.now() - started;
    maxModelGapMs = Math.max(maxModelGapMs, now - (lastModelEventMs ?? 0));
    firstModelEventMs ??= now;
    if (output) firstOutputEventMs ??= now;
    lastModelEventMs = now;
    resetWaitNotices();
  };
  const finish = (outcome: Outcome, reason?: unknown): void => {
    if (ended) return;
    ended = true;
    for (const timer of waitTimers) clearTimeout(timer);
    const elapsedMs = Date.now() - started;
    emit({ phase: "end", outcome, elapsedMs, firstChunkMs, lastChunkMs,
      cancellationReason: outcome !== "cancel" ? null :
        reason instanceof Error && reason.name === "AntigravityStreamSilenceTimeoutError"
          ? "silence_timeout" : reason instanceof Error && reason.name === "AbortError"
            ? "aborted" : "other",
      firstModelEventMs, firstOutputEventMs, lastModelEventMs,
      maxChunkGapMs: Math.max(maxChunkGapMs, elapsedMs - (lastChunkMs ?? 0)),
      maxModelGapMs: Math.max(maxModelGapMs, elapsedMs - (lastModelEventMs ?? 0)),
      idleMs: lastChunkMs === null ? elapsedMs : elapsedMs - lastChunkMs,
      lastEventMs, chunks, bytes, events, textEvents, thinkingEvents, toolEvents,
      usageEvents, malformedEvents, oversizedEvents, sawFinish, sawDone, sawError, lastKinds });
  };
  const event = (): void => {
    if (oversized) { oversizedEvents++; oversized = false; data = ""; return; }
    if (!data.trim()) return;
    events++;
    lastEventMs = Date.now() - started;
    lastKinds = [];
    if (data.trim() === "[DONE]") { sawDone = true; lastKinds.push("done"); modelProgress(); data = ""; return; }
    try {
      const parsed = JSON.parse(data);
      const body = parsed?.response ?? parsed;
      if (body?.error) { sawError = true; lastKinds.push("error"); }
      if (body?.promptFeedback?.blockReason) lastKinds.push("blocked");
      if (body?.usageMetadata || body?.usage) { usageEvents++; lastKinds.push("usage"); }
      let text = false, thinking = false, tool = false, media = false;
      for (const candidate of Array.isArray(body?.candidates) ? body.candidates : []) {
        if (candidate?.finishReason) { sawFinish = true; lastKinds.push("finish"); }
        for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
          if (typeof part?.text === "string" && part.text.length) {
            if (part.thought) thinking = true; else text = true;
          }
          if (part?.functionCall || part?.functionResponse) tool = true;
          if (part?.inlineData || part?.fileData || part?.executableCode || part?.codeExecutionResult) media = true;
        }
      }
      if (text) { textEvents++; lastKinds.push("text"); }
      if (thinking) { thinkingEvents++; lastKinds.push("thinking"); }
      if (tool) { toolEvents++; lastKinds.push("tool"); }
      if (media) lastKinds.push("media");
      if (text || thinking || tool || media || lastKinds.some((kind) => ["finish", "error", "blocked"].includes(kind))) {
        modelProgress(text || tool || media);
      }
    } catch { malformedEvents++; lastKinds.push("malformed"); }
    data = "";
  };
  const line = (value: string): void => {
    if (!value) { event(); return; }
    if (value.startsWith("data:")) {
      if (data.length + value.length > MAX_EVENT_CHARS) oversized = true;
      if (!oversized) data += value.slice(5).trimStart() + "\n";
    }
  };
  const observe = (value: Uint8Array): void => {
    chunks++;
    bytes += value.byteLength;
    const now = Date.now() - started;
    maxChunkGapMs = Math.max(maxChunkGapMs, now - (lastChunkMs ?? 0));
    lastChunkMs = now;
    firstChunkMs ??= lastChunkMs;
    // Parse incrementally with bounded storage, including a huge single line.
    const decoded = decoder.decode(value, { stream: true });
    let offset = 0;
    for (;;) {
      const end = decoded.indexOf("\n", offset);
      const segment = decoded.slice(offset, end < 0 ? undefined : end);
      if (tail.length + segment.length > MAX_EVENT_CHARS) {
        oversized = true;
        lineOversized = true;
        tail = "";
      }
      if (!lineOversized) tail += segment;
      if (end < 0) break;
      const complete = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
      // An oversized line must not be mistaken for the event boundary.
      if (!lineOversized) line(complete);
      tail = "";
      lineOversized = false;
      offset = end + 1;
    }
  };

  emit({ phase: "headers", status: response.status });
  resetWaitNotices();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (ended) return;
        if (chunk.done) {
          if (tail) line(tail);
          event();
          finish("eof");
          reader.releaseLock();
          controller.close();
        } else {
          observe(chunk.value);
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        if (ended) return;
        finish("read_error");
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish("cancel", reason);
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
