import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { getProviderProxyUrl } from "../credential-helpers.js";
import { getWebThinkingLevel, GEMINI_WEB_PROVIDER, getCookiesFile } from "./credentials.js";
import { createReadBridge, isReadDeclaration, readDeclaration, type ReadBridge } from "./read-tool.js";

const WORKER = fileURLToPath(new URL("./worker.py", import.meta.url));
const ENDPOINT = "https://gemini.google.com/app";
const MAX_PROMPT_BYTES = 48000;
const WORKER_TIMEOUT_MS = 480000;

export class WebRequestError extends Error {}

/** Check original API payloads before generic translators can discard unsupported fields. */
export function webCapabilityError(value: unknown): string | undefined {
  const readTools = isRecord(value) && Array.isArray(value.tools) && value.tools.length === 1 &&
    isRecord(value.tools[0]) && value.tools[0].type === "function" && isReadDeclaration(value.tools[0].function);
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const entry of item) pending.push(entry); continue; }
    if (!isRecord(item)) continue;
    if ((Array.isArray(item.tools) && item.tools.length && !readTools) ||
        (item.tool_calls && (!readTools || !Array.isArray(item.tool_calls) || item.tool_calls.some((call) =>
          !isRecord(call) || call.type !== "function" || !isRecord(call.function) || call.function.name !== "read"))) ||
        ((item.tool_call_id || item.role === "tool") && !readTools) || item.function_call || item.functions ||
        (item.tool_choice !== undefined && item.tool_choice !== "none" && !(readTools && item.tool_choice === "auto")) ||
        (typeof item.type === "string" && !["text", "input_text", "output_text", "message"].includes(item.type)) ||
        item.image_url || item.inlineData || item.fileData || item.input_audio || item.audio ||
        (Array.isArray(item.modalities) && item.modalities.some((mode) => mode !== "text"))) {
      return "Gemini Web supports text chat and the experimental read tool only; other tools, files, audio and structured output are unavailable";
    }
    for (const [key, entry] of Object.entries(item)) {
      if (readTools && ["tools", "tool_calls"].includes(key)) continue;
      if (entry !== null && typeof entry === "object") pending.push(entry);
    }
  }
  return undefined;
}

/** Flatten a Gemini-shaped, text-only conversation. No native system role is promised. */
export function buildWebPrompt(body: RequestBody): string {
  if (getWebThinkingLevel(body.model) === undefined) throw new WebRequestError("Unknown Gemini Web model");
  if (!isRecord(body.request)) throw new WebRequestError("Expected a text conversation");
  const request = body.request;
  let declaration: Record<string, unknown> | undefined;
  try { declaration = readDeclaration(request); }
  catch { throw new WebRequestError("Gemini Web supports only the experimental read API tool"); }
  if (request.cachedContent || (request.toolConfig && (!declaration || !isRecord(request.toolConfig) ||
      !isRecord(request.toolConfig.functionCallingConfig) ||
      !["AUTO", "NONE"].includes(String(request.toolConfig.functionCallingConfig.mode))))) {
    throw new WebRequestError("Unsupported Gemini Web tool configuration or cached content");
  }
  const generation = isRecord(request.generationConfig) ? request.generationConfig : {};
  if (generation.responseSchema || generation.responseJsonSchema ||
      (generation.responseMimeType && generation.responseMimeType !== "text/plain") ||
      (typeof generation.candidateCount === "number" && generation.candidateCount !== 1)) {
    throw new WebRequestError("Gemini Web supports one plain-text answer only");
  }
  const partsText = (value: unknown): string => {
    if (!Array.isArray(value) || !value.length) throw new WebRequestError("Expected text parts");
    return value.map((part: unknown) => {
      if (declaration && isRecord(part) && Object.keys(part).length === 1) {
        if (isRecord(part.functionCall) && part.functionCall.name === "read") {
          return `Client tool call (data): ${JSON.stringify(part.functionCall)}`;
        }
        if (isRecord(part.functionResponse) && part.functionResponse.name === "read") {
          return `Client tool result (data): ${JSON.stringify(part.functionResponse.response)}`;
        }
      }
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
  payload: Record<string, unknown>, signal?: AbortSignal, bridge?: ReadBridge,
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
    let buffered = "";
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
          if (bridge) {
            buffered += event.text;
            if (buffered.length > 128000) throw new Error("output limit");
            return;
          }
          const data = { candidates: [{ content: { role: "model", parts: [{ text: event.text }] } }] };
          if (!output.write(`data: ${JSON.stringify(data)}\n\n`)) {
            child.stdout.pause();
            output.once("drain", () => child.stdout.resume());
          }
        } else if (event.type === "done" && ready) {
          if (bridge) {
            if (event.truncated) throw new Error("Incomplete tool response");
            const part = bridge.parse(buffered);
            output.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] } }] })}\n\n`);
          }
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
  let bridge: ReadBridge | undefined;
  try {
    prompt = buildWebPrompt(body);
    if (isRecord(body.request)) {
      const declaration = readDeclaration(body.request);
      const config = isRecord(body.request.toolConfig) ? body.request.toolConfig.functionCallingConfig : undefined;
      if (declaration && !(isRecord(config) && config.mode === "NONE")) {
        bridge = createReadBridge(declaration);
        prompt += `\n\n${bridge.instruction}`;
        if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new WebRequestError("Gemini Web text context is limited to 48000 UTF-8 bytes");
      }
    }
  }
  catch (error) { return failure(400, error instanceof WebRequestError ? error.message : "Invalid Gemini Web request"); }
  return runWebWorker({
    mode: "generate", prompt, thinkingLevel: getWebThinkingLevel(body.model), cookiesFile: getCookiesFile(account.config),
    proxy: getProviderProxyUrl(account.config, GEMINI_WEB_PROVIDER),
  }, signal, bridge);
}
