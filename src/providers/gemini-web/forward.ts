import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { getProviderProxyUrl } from "../credential-helpers.js";
import { GEMINI_WEB_MODEL, GEMINI_WEB_PROVIDER, getCookiesFile } from "./credentials.js";

const WORKER = fileURLToPath(new URL("./worker.py", import.meta.url));
const ENDPOINT = "https://gemini.google.com/app";
const MAX_PROMPT_BYTES = 48000;
const WORKER_TIMEOUT_MS = 480000;

export class WebRequestError extends Error {}

/** Check original API payloads before generic translators can discard unsupported fields. */
export function webCapabilityError(value: unknown): string | undefined {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const entry of item) pending.push(entry); continue; }
    if (!isRecord(item)) continue;
    if ((Array.isArray(item.tools) && item.tools.length) || item.tool_calls || item.tool_call_id ||
        item.role === "tool" || item.function_call || item.functions ||
        (item.tool_choice !== undefined && item.tool_choice !== "none") ||
        (typeof item.type === "string" && !["text", "input_text", "output_text", "message"].includes(item.type)) ||
        item.image_url || item.inlineData || item.fileData || item.input_audio || item.audio ||
        (Array.isArray(item.modalities) && item.modalities.some((mode) => mode !== "text"))) {
      return "Gemini Web supports text chat only; API tools, files, audio and structured output are unavailable";
    }
    for (const entry of Object.values(item)) {
      if (entry !== null && typeof entry === "object") pending.push(entry);
    }
  }
  return undefined;
}

/** Flatten a Gemini-shaped, text-only conversation. No native system role is promised. */
export function buildWebPrompt(body: RequestBody): string {
  if (body.model !== GEMINI_WEB_MODEL) throw new WebRequestError("Unknown Gemini Web model");
  if (!isRecord(body.request)) throw new WebRequestError("Expected a text conversation");
  const request = body.request;
  if (Array.isArray(request.tools) && request.tools.length) throw new WebRequestError("Gemini Web does not support API tools");
  if (request.toolConfig || request.cachedContent) throw new WebRequestError("Gemini Web does not support tool configuration or cached content");
  const generation = isRecord(request.generationConfig) ? request.generationConfig : {};
  if (generation.responseSchema || generation.responseJsonSchema ||
      (generation.responseMimeType && generation.responseMimeType !== "text/plain") ||
      (typeof generation.candidateCount === "number" && generation.candidateCount !== 1)) {
    throw new WebRequestError("Gemini Web supports one plain-text answer only");
  }
  const partsText = (value: unknown): string => {
    if (!Array.isArray(value) || !value.length) throw new WebRequestError("Expected text parts");
    return value.map((part: unknown) => {
      if (!isRecord(part) || typeof part.text !== "string" || Object.keys(part).some((key) => key !== "text")) {
        throw new WebRequestError("Gemini Web supports text only; files, tool calls and tool results are unavailable");
      }
      return part.text;
    }).join("\n");
  };
  const turns: string[] = [];
  if (request.systemInstruction) {
    if (!isRecord(request.systemInstruction)) throw new WebRequestError("Invalid system instruction");
    turns.push("Instructions (included as conversation text):\n" + partsText(request.systemInstruction.parts));
  }
  if (!Array.isArray(request.contents) || !request.contents.length) throw new WebRequestError("A text message is required");
  for (const content of request.contents) {
    if (!isRecord(content) || (content.role !== "user" && content.role !== "model")) throw new WebRequestError("Unsupported conversation role");
    turns.push(`${content.role === "user" ? "User" : "Assistant"}:\n${partsText(content.parts)}`);
  }
  const prompt = turns.join("\n\n");
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new WebRequestError(`Gemini Web text context is limited to ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  return prompt;
}

function failure(status: number, message: string): ForwardedResponse {
  return {
    endpoint: ENDPOINT,
    response: new Response(JSON.stringify({ error: { message, code: "gemini_web_error" } }), {
      status, headers: { "Content-Type": "application/json", ...(status === 429 ? { "Retry-After": "60" } : {}) },
    }),
  };
}

/** Private stdio protocol; credentials and prompts never appear in argv or stderr. */
export function runWebWorker(
  payload: Record<string, unknown>, signal?: AbortSignal,
): Promise<ForwardedResponse> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON || "python3", [WORKER], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output = new PassThrough();
    // Output errors can arrive before a downstream consumer attaches.
    output.on("error", () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let ready = false;
    let done = false;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const stop = (): void => {
      if (child.exitCode === null) child.kill("SIGTERM");
    };
    const fail = (status: number, message: string): void => {
      if (done) return;
      done = true;
      cleanup();
      stop();
      if (ready) output.destroy(new Error(message));
      else if (!settled) { settled = true; resolve(failure(status, message)); }
    };
    const abort = (): void => {
      if (done) return;
      done = true;
      cleanup();
      stop();
      const error = new Error("Gemini Web request cancelled");
      output.destroy(error);
      if (!settled) { settled = true; reject(error); }
    };
    const timeout = setTimeout(() => fail(504, "Gemini Web request timed out"), WORKER_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    // A cancelled Response body must terminate the upstream worker too.
    output.on("close", () => { if (!done) abort(); });
    child.on("error", () => fail(503, "Gemini Web Python worker unavailable; install its dependencies"));
    child.stdin.on("error", () => fail(502, "Gemini Web worker stopped before receiving the request"));
    lines.on("line", (line) => {
      if (done) return;
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new Error("protocol");
        if (event.type === "error") {
          const status = typeof event.status === "number" && [400, 401, 403, 404, 409, 429, 502, 503, 504].includes(event.status) ? event.status : 502;
          // Only our worker's fixed, non-secret messages cross this boundary.
          fail(status, typeof event.message === "string" ? event.message : "Gemini Web request failed");
        } else if (event.type === "ready" && !ready) {
          ready = true;
          settled = true;
          resolve({ endpoint: ENDPOINT, response: new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
            headers: { "Content-Type": "text/event-stream", "X-Rotator-Usage": "unavailable", "X-Rotator-Provider-Mode": "limited-web" },
          }) });
        } else if (event.type === "delta" && ready && typeof event.text === "string") {
          const data = { candidates: [{ content: { role: "model", parts: [{ text: event.text }] } }] };
          if (!output.write(`data: ${JSON.stringify(data)}\n\n`)) {
            child.stdout.pause();
            output.once("drain", () => child.stdout.resume());
          }
        } else if (event.type === "done" && ready) {
          done = true;
          cleanup();
          output.end(`data: ${JSON.stringify({ candidates: [{ finishReason: event.truncated ? "MAX_TOKENS" : "STOP" }] })}\n\n`);
        } else throw new Error("protocol");
      } catch { fail(502, "Invalid Gemini Web worker response"); }
    });
    child.once("close", () => {
      if (!done) fail(502, "Gemini Web worker ended without completing the response");
      lines.close();
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function forwardRequest(
  account: AccountRuntime, body: RequestBody, _headers: Record<string, string>, signal?: AbortSignal,
): Promise<ForwardedResponse> {
  let prompt: string;
  try { prompt = buildWebPrompt(body); }
  catch (error) { return failure(400, error instanceof WebRequestError ? error.message : "Invalid Gemini Web request"); }
  return runWebWorker({
    mode: "generate", prompt, cookiesFile: getCookiesFile(account.config),
    proxy: getProviderProxyUrl(account.config, GEMINI_WEB_PROVIDER),
  }, signal);
}
