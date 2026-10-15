import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { getProviderProxyUrl } from "../credential-helpers.js";
import { getWebThinkingLevel, GEMINI_WEB_PROVIDER, GEMINI_WEB_MAX_PROMPT_BYTES, getCookiesFile } from "./credentials.js";
import { createToolBridge, isToolDeclaration, toolDeclarations, type ToolBridge } from "./tool-bridge.js";

const WORKER = fileURLToPath(new URL("./worker.py", import.meta.url));
const ENDPOINT = "https://gemini.google.com/app";
const MAX_PROMPT_BYTES = GEMINI_WEB_MAX_PROMPT_BYTES;
const WORKER_TIMEOUT_MS = 480000;

export class WebRequestError extends Error {}

/** Check original API payloads before generic translators can discard unsupported fields. */
export function webCapabilityError(value: unknown): string | undefined {
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : [];
  const supportedTools = tools.length > 0 && tools.every((tool) =>
    isRecord(tool) && tool.type === "function" && isToolDeclaration(tool.function)) &&
    new Set(tools.map((tool) => tool.function.name)).size === tools.length;
  const names = new Set(supportedTools ? tools.map((tool) => tool.function.name) : []);
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const entry of item) pending.push(entry); continue; }
    if (!isRecord(item)) continue;
    if ((Array.isArray(item.tools) && item.tools.length && !supportedTools) ||
        (item.tool_calls && (!supportedTools || !Array.isArray(item.tool_calls) || item.tool_calls.some((call) =>
          !isRecord(call) || call.type !== "function" || !isRecord(call.function) || !names.has(call.function.name)))) ||
        ((item.tool_call_id || item.role === "tool") && !supportedTools) || item.function_call || item.functions ||
        (item.tool_choice !== undefined && item.tool_choice !== "none" && !(supportedTools && item.tool_choice === "auto")) ||
        (typeof item.type === "string" && !["text", "input_text", "output_text", "message"].includes(item.type)) ||
        item.image_url || item.inlineData || item.fileData || item.input_audio || item.audio ||
        (Array.isArray(item.modalities) && item.modalities.some((mode) => mode !== "text"))) {
      return "Gemini Web supports text chat and experimental read, glob, grep, edit, write and bash tools only; other tools, files, audio and structured output are unavailable";
    }
    for (const [key, entry] of Object.entries(item)) {
      if (supportedTools && ["tools", "tool_calls"].includes(key)) continue;
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
  let declarations: Record<string, unknown>[];
  try { declarations = toolDeclarations(request); }
  catch { throw new WebRequestError("Gemini Web supports only experimental read, glob, grep, edit, write and bash API tools"); }
  if (request.cachedContent || (request.toolConfig && (!declarations.length || !isRecord(request.toolConfig) ||
      !isRecord(request.toolConfig.functionCallingConfig) ||
      !["AUTO", "NONE"].includes(String(request.toolConfig.functionCallingConfig.mode))))) {
    throw new WebRequestError("Unsupported Gemini Web tool configuration or cached content");
  }
  const generation = isRecord(request.generationConfig) ? request.generationConfig : {};
  const names = new Set(declarations.map((tool) => tool.name));
  if (generation.responseSchema || generation.responseJsonSchema ||
      (generation.responseMimeType && generation.responseMimeType !== "text/plain") ||
      (typeof generation.candidateCount === "number" && generation.candidateCount !== 1)) {
    throw new WebRequestError("Gemini Web supports one plain-text answer only");
  }
  const partsText = (value: unknown): string => {
    if (!Array.isArray(value) || !value.length) throw new WebRequestError("Expected text parts");
    return value.map((part: unknown) => {
      if (declarations.length && isRecord(part) && Object.keys(part).length === 1) {
        if (isRecord(part.functionCall) && names.has(part.functionCall.name)) {
          return `Client tool call (data): ${JSON.stringify(part.functionCall)}`;
        }
        if (isRecord(part.functionResponse) && names.has(part.functionResponse.name)) {
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
  payload: Record<string, unknown>, signal?: AbortSignal, bridge?: ToolBridge,
): Promise<ForwardedResponse & { retryToolCall?: boolean }> {
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
    const startResponse = (): void => {
      settled = true;
      resolve({ endpoint: ENDPOINT, response: new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": "text/event-stream", "X-Rotator-Usage": "unavailable", "X-Rotator-Provider-Mode": "limited-web" },
      }) });
    };
    const fail = (status: number, message: string, retryToolCall = false): void => {
      if (done) return;
      done = true;
      cleanup();
      stop();
      if (settled) output.destroy(new Error(message));
      else { settled = true; output.destroy(); resolve({ ...failure(status, message), retryToolCall }); }
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
          // Tool output is already buffered: validate it before committing HTTP 200.
          if (!bridge) startResponse();
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
            if (event.truncated) { fail(502, "Gemini Web tool response exceeded the output limit"); return; }
            let part: Record<string, unknown>;
            try { part = bridge.parse(buffered); }
            catch { fail(502, "Gemini Web generated an invalid tool call", true); return; }
            startResponse();
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
  let bridge: ToolBridge | undefined;
  try {
    prompt = buildWebPrompt(body);
    if (isRecord(body.request)) {
      const declarations = toolDeclarations(body.request);
      const config = isRecord(body.request.toolConfig) ? body.request.toolConfig.functionCallingConfig : undefined;
      if (declarations.length && !(isRecord(config) && config.mode === "NONE")) {
        bridge = createToolBridge(declarations);
        prompt += `\n\n${bridge.instruction}`;
        if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new WebRequestError(`Gemini Web text context is limited to ${MAX_PROMPT_BYTES} UTF-8 bytes`);
      }
    }
  }
  catch (error) { return failure(400, error instanceof WebRequestError ? error.message : "Invalid Gemini Web request"); }
  const payload = {
    mode: "generate", prompt, thinkingLevel: getWebThinkingLevel(body.model), cookiesFile: getCookiesFile(account.config),
    proxy: getProviderProxyUrl(account.config, GEMINI_WEB_PROVIDER),
  };
  const result = await runWebWorker(payload, signal, bridge);
  if (!result.retryToolCall || !bridge) return result;
  // No tool has reached the client, so retrying cannot repeat a local action.
  const correctedPrompt = prompt + "\n\nYour previous response was rejected before executing any tools. Return exactly ONE tool call using the marker above and a valid JSON object matching its declared schema. Include all required arguments. Do not add markdown, explanations or a second call. Wait for the client result before continuing.";
  if (Buffer.byteLength(correctedPrompt) > MAX_PROMPT_BYTES) return result;
  await result.response.body?.cancel();
  return runWebWorker({ ...payload, prompt: correctedPrompt }, signal, bridge);
}
