// Keep a silent HTTP 200 recoverable by the rotator until generation starts.
export const ANTIGRAVITY_STREAM_START_TIMEOUT_MS = 60_000;
const MAX_PREFLIGHT_BYTES = 256 * 1024;

export class AntigravityStreamStartError extends Error {
  // The rotation layer treats this as transport failure, not invalid credentials.
  readonly code = "ETIMEDOUT";
  override name = "AntigravityStreamStartError";
}

function hasModelEvent(data: string): boolean {
  if (data.trim() === "[DONE]") return true;
  try {
    const parsed = JSON.parse(data);
    const response = parsed?.response ?? parsed;
    return Boolean(response?.error || response?.promptFeedback?.blockReason ||
      response?.candidates?.some((candidate: {
        finishReason?: string; content?: { parts?: Record<string, unknown>[] };
      }) => candidate.finishReason || candidate.content?.parts?.some((part) =>
        (typeof part.text === "string" && part.text.length > 0) ||
        part.functionCall || part.functionResponse || part.inlineData ||
        part.fileData || part.executableCode || part.codeExecutionResult)));
  } catch {
    // Let the normal parser handle malformed nonempty data; startup recovery
    // must not hide protocol errors by treating them as silence.
    return Boolean(data.trim());
  }
}

/** Buffer only startup events; preserve every byte and normal streaming after it. */
export async function awaitAntigravityStreamStart(
  response: Response,
  signal?: AbortSignal,
  timeoutMs = ANTIGRAVITY_STREAM_START_TIMEOUT_MS,
): Promise<Response> {
  if (!response.ok || !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")) return response;

  const reader = response.body.getReader();
  const buffered: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let bytes = 0;
  let tail = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AntigravityStreamStartError(
      `Antigravity produced no model event within ${timeoutMs}ms`,
    )), timeoutMs);
    onAbort = () => reject(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

  try {
    let ready = false;
    while (!ready) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) {
        // Tolerate a final data line without the optional trailing blank line,
        // just as the downstream compatibility parser does.
        if (tail.split(/\r?\n/).some((line) => line.startsWith("data:") && hasModelEvent(line.slice(5)))) break;
        throw new AntigravityStreamStartError("Antigravity stream ended before a model event");
      }
      buffered.push(chunk.value);
      bytes += chunk.value.byteLength;
      tail += decoder.decode(chunk.value, { stream: true });
      // SSE data may span multiple lines and network chunks.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(tail))) {
        const event = tail.slice(0, boundary.index);
        tail = tail.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (hasModelEvent(data)) ready = true;
      }
      if (!ready && bytes > MAX_PREFLIGHT_BYTES) {
        throw new AntigravityStreamStartError("Antigravity startup events exceeded the buffer limit");
      }
    }
  } catch (error) {
    // Cancel the old request before another account is allowed to retry it.
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
