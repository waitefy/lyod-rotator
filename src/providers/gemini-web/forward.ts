import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AccountRuntime } from "../../types.js";
import { logger } from "../../logger.js";
import { workerTelemetry } from "./telemetry.js";
import type { ForwardedResponse, RequestBody } from "../../proxy.js";
import { isRecord } from "../../compat/schema-sanitizer.js";
import { getProviderProxyUrl } from "../credential-helpers.js";
import { getWebThinkingLevel, GEMINI_WEB_PROVIDER, GEMINI_WEB_MAX_PROMPT_BYTES, getCookiesFile } from "./credentials.js";
import { createToolBridge, toolDeclarationError, toolDeclarations, type ToolBridge } from "./tool-bridge.js";
import { matchesToolSchema } from "./tool-schema.js";
import { apiWebAttachment, checkWebAttachmentTotals, validateWebAttachment, type WebAttachment } from "./attachments.js";
import { MAX_IMAGE_EVENT_BYTES, validateGeneratedWebImage, webGeminiImageMode, webResponsesImageMode, type GeneratedWebImage } from "./image-output.js";

const WORKER = fileURLToPath(new URL("./worker.py", import.meta.url));
const ENDPOINT = "https://gemini.google.com/app";
const MAX_PROMPT_BYTES = GEMINI_WEB_MAX_PROMPT_BYTES;
const WORKER_TIMEOUT_MS = 480000;

export function webEngineBackend(): "python" | "go" {
  const value = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND || "python";
  if (value !== "python" && value !== "go") throw new Error("Invalid Gemini Web backend; use python or go");
  return value;
}

export class WebRequestError extends Error {}

/** Check original API payloads before generic translators can discard unsupported fields. */
export function webCapabilityError(value: unknown, format: "chat" | "responses" | "anthropic" = "chat"): string | undefined {
  if (!isRecord(value)) return "Expected an API request object";
  if (format === "responses") {
    try {
      if (webResponsesImageMode(value)) value = { ...value, tools: [], tool_choice: "none" };
    } catch (error) { return error instanceof Error ? error.message : "Invalid image generation tool"; }
  }
  if (!isRecord(value)) return "Expected an API request object";
  const unsupported = "Gemini Web supports text, inline images/documents and client-defined function tools with supported JSON Schemas; invalid tools, audio and structured output are unavailable";
  if (value.tools !== undefined && !Array.isArray(value.tools)) return unsupported;
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isRecord(tool)) return unsupported;
    const declaration = format === "anthropic"
      ? { name: tool.name, description: tool.description, parameters: tool.input_schema }
      : tool.type === "function" ? (format === "responses" && tool.name !== undefined ? tool : tool.function) : undefined;
    if (format === "anthropic" && tool.type !== undefined && tool.type !== "custom") return unsupported;
    const error = toolDeclarationError(declaration);
    if (error) return error;
    const name = (declaration as Record<string, unknown>).name as string;
    if (names.has(name)) return "Duplicate tool declaration";
    names.add(name);
  }
  let choice = value.tool_choice;
  if (format === "anthropic" && isRecord(choice)) {
    choice = choice.type === "tool" ? { type: "function", function: { name: choice.name } }
      : choice.type === "any" ? "required" : choice.type === "auto" || choice.type === "none" ? choice.type : choice;
  }
  if (choice !== undefined && choice !== "none" && choice !== "auto") {
    const named = isRecord(choice) && choice.type === "function"
      ? (isRecord(choice.function) ? choice.function.name : format === "responses" ? choice.name : undefined) : undefined;
    if (!names.size || (choice !== "required" && !names.has(named as string))) return "Invalid Gemini Web tool choice";
  }
  const pending: unknown[] = [value];
  const attachments: WebAttachment[] = [];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const entry of item) pending.push(entry); continue; }
    if (!isRecord(item)) continue;
    if (typeof item.role === "string" && !["user", "tool"].includes(item.role) && Array.isArray(item.content) &&
        item.content.some((part) => isRecord(part) && ["image_url", "input_image", "image", "document", "file", "input_file"].includes(String(part.type)))) {
      return "Gemini Web attachments are supported only in user messages and tool results";
    }
    if (item === value && [item.system, item.instructions].some((content) => Array.isArray(content) &&
        content.some((part) => !isRecord(part) || !["text", "input_text"].includes(String(part.type))))) return unsupported;
    try {
      const attachment = apiWebAttachment(item);
      if (attachment) {
        attachments.push(attachment);
        checkWebAttachmentTotals(attachments);
        continue;
      }
    } catch (error) { return error instanceof Error ? error.message : "Invalid Gemini Web attachment"; }
    const skip = new Set<string>(item === value ? ["tools", "tool_choice"] : []);
    if (item.tool_calls !== undefined) {
      if (!names.size || !Array.isArray(item.tool_calls) || item.tool_calls.some((call) =>
        !isRecord(call) || call.type !== "function" || !isRecord(call.function) || !names.has(call.function.name as string))) return unsupported;
      skip.add("tool_calls");
    }
    if (format === "responses" && item.type === "function_call") {
      if (!names.has(item.name as string) || typeof item.call_id !== "string" || typeof item.arguments !== "string") return unsupported;
      skip.add("arguments");
    } else if (format === "responses" && item.type === "function_call_output") {
      if (!names.size || typeof item.call_id !== "string" || (typeof item.output !== "string" && !Array.isArray(item.output))) return unsupported;
    } else if (format === "anthropic" && item.type === "tool_use") {
      if (!names.has(item.name as string) || typeof item.id !== "string" || !isRecord(item.input)) return unsupported;
      skip.add("input"); // Arguments are opaque data, not API content blocks.
    } else if (format === "anthropic" && item.type === "tool_result") {
      if (!names.size || typeof item.tool_use_id !== "string") return unsupported;
    } else if (typeof item.type === "string" && !["text", "input_text", "output_text", "message"].includes(item.type)) return unsupported;
    if (((item.tool_call_id || item.role === "tool") && !names.size) || item.function_call || item.functions ||
        item.image_url || item.inlineData || item.fileData || item.input_audio || item.audio ||
        (Array.isArray(item.modalities) && item.modalities.some((mode) => mode !== "text"))) return unsupported;
    for (const [key, entry] of Object.entries(item)) {
      if (!skip.has(key) && entry !== null && typeof entry === "object") pending.push(entry);
    }
  }
  return undefined;
}

/** Flatten the conversation and retain uploads in the same order as their markers. */
export function buildWebInput(body: RequestBody): { prompt: string; attachments: WebAttachment[] } {
  if (getWebThinkingLevel(body.model) === undefined) throw new WebRequestError("Unknown Gemini Web model");
  if (!isRecord(body.request)) throw new WebRequestError("Expected a text conversation");
  const request = body.request;
  try { webGeminiImageMode(request); }
  catch (error) { throw new WebRequestError(error instanceof Error ? error.message : "Invalid output modalities"); }
  let declarations: Record<string, unknown>[];
  try { declarations = toolDeclarations(request); }
  catch (error) { throw new WebRequestError(`Invalid Gemini Web API tool declaration: ${error instanceof Error ? error.message : "unsupported schema"}`); }
  if (request.cachedContent || (request.toolConfig && (!isRecord(request.toolConfig) ||
      !isRecord(request.toolConfig.functionCallingConfig) ||
      !["AUTO", "NONE", "ANY"].includes(String(request.toolConfig.functionCallingConfig.mode))))) {
    throw new WebRequestError("Unsupported Gemini Web tool configuration or cached content");
  }
  const config = isRecord(request.toolConfig) && isRecord(request.toolConfig.functionCallingConfig)
    ? request.toolConfig.functionCallingConfig : undefined;
  if (config?.mode === "ANY" && !declarations.length) throw new WebRequestError("A required tool must be declared");
  if (config?.allowedFunctionNames !== undefined && (config.mode !== "ANY" || !Array.isArray(config.allowedFunctionNames) ||
      !config.allowedFunctionNames.length || config.allowedFunctionNames.some((name) => !declarations.some((tool) => tool.name === name)))) {
    throw new WebRequestError("Invalid Gemini Web allowed function names");
  }
  const generation = isRecord(request.generationConfig) ? request.generationConfig : {};
  const attachments: WebAttachment[] = [];
  const names = new Set(declarations.map((tool) => tool.name));
  if (generation.responseSchema || generation.responseJsonSchema ||
      (generation.responseMimeType && generation.responseMimeType !== "text/plain") ||
      (typeof generation.candidateCount === "number" && generation.candidateCount !== 1)) {
    throw new WebRequestError("Gemini Web supports one plain-text answer only");
  }
  const partsText = (value: unknown, allowAttachments = false): string => {
    if (!Array.isArray(value) || !value.length) throw new WebRequestError("Expected text parts");
    return value.map((part: unknown) => {
      if (isRecord(part) && part.inlineData !== undefined) {
        if (!allowAttachments || Object.keys(part).some((key) => key !== "inlineData")) {
          throw new WebRequestError("Gemini Web attachments are supported only in user messages and tool results");
        }
        try {
          const attachment = validateWebAttachment(part.inlineData);
          attachments.push(attachment);
          checkWebAttachmentTotals(attachments);
          return `[Attached file ${attachments.length}: ${attachment.mimeType}]`;
        } catch (error) { throw new WebRequestError(error instanceof Error ? error.message : "Invalid Gemini Web attachment"); }
      }
      if (declarations.length && isRecord(part) && Object.keys(part).length === 1) {
        if (isRecord(part.functionCall) && names.has(part.functionCall.name)) {
          return `Client tool call (data): ${JSON.stringify(part.functionCall)}`;
        }
        if (isRecord(part.functionResponse) && names.has(part.functionResponse.name)) {
          return `Client tool result (data): ${JSON.stringify(part.functionResponse)}`;
        }
      }
      if (!isRecord(part) || typeof part.text !== "string" || Object.keys(part).some((key) => key !== "text")) {
        throw new WebRequestError("Unsupported Gemini Web content part; expected text, inline data or a declared tool call/result");
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
    turns.push(`${content.role === "user" ? "User" : "Assistant"}:\n${partsText(content.parts, content.role === "user")}`);
  }
  const prompt = turns.join("\n\n");
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new WebRequestError(`Gemini Web text context is limited to ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  return { prompt, attachments };
}

export function buildWebPrompt(body: RequestBody): string {
  return buildWebInput(body).prompt;
}

function failure(status: number, message: string, retryAfterSeconds = 60): ForwardedResponse {
  return {
    endpoint: ENDPOINT,
    response: new Response(JSON.stringify({ error: { message, code: "gemini_web_error" } }), {
      status, headers: { "Content-Type": "application/json", ...(status === 429 ? { "Retry-After": String(retryAfterSeconds) } : {}) },
    }),
  };
}

/** Private stdio protocol; credentials and prompts never appear in argv or stderr. */
export function runWebWorker(
  payload: Record<string, unknown>, signal?: AbortSignal, bridge?: ToolBridge,
): Promise<ForwardedResponse & { retryToolCall?: boolean }> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  let goEngine: boolean;
  try { goEngine = webEngineBackend() === "go"; }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const diagnosticId = randomUUID();
    let telemetry: Record<string, unknown> = {};
    let readyMs: number | undefined;
    const logCompletion = (outcome: "done" | "error" | "cancelled", status: number): void => {
      logger.log(outcome === "error" ? "warn" : "info", "gemini-web", JSON.stringify({
        diagnosticId, backend: goEngine ? "go" : "python", operation: payload.mode === "probe" ? "probe" : payload.output === "image" || payload.output === "image-or-text" ? "image" : "text",
        outcome, status, workerMs: Math.round(performance.now() - startedAt), readyMs, ...telemetry,
      }));
    };
    const command = goEngine ? process.env.TUXEVIL_ROTATOR_GEMINI_WEB_ENGINE || "/usr/local/bin/rotator-gemini-engine"
      : process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON || "python3";
    const child = spawn(command, goEngine ? [] : [WORKER], {
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
    let streamedText = false;
    let engineTools: Record<string, unknown>[] | undefined;
    const imageMode = payload.output === "image" || payload.output === "image-or-text";
    let image: GeneratedWebImage | undefined;
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
    const writeText = (text: string): void => {
      const data = { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
      if (!output.write(`data: ${JSON.stringify(data)}\n\n`)) {
        child.stdout.pause();
        output.once("drain", () => child.stdout.resume());
      }
    };
    const fail = (status: number, message: string, retryToolCall = false, retryAfterSeconds = 60): void => {
      if (done) return;
      done = true;
      logCompletion("error", status);
      cleanup();
      stop();
      if (settled) output.destroy(new Error(message));
      else { settled = true; output.destroy(); resolve({ ...failure(status, message, retryAfterSeconds), retryToolCall }); }
    };
    const abort = (): void => {
      if (done) return;
      done = true;
      logCompletion("cancelled", 499);
      cleanup();
      stop();
      const error = new Error("Gemini Web request cancelled");
      output.destroy(error);
      if (!settled) { settled = true; reject(error); }
    };
    const timeout = setTimeout(() => fail(504, "Gemini Web request timed out"), goEngine ? 125000 : WORKER_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    // A cancelled Response body must terminate the upstream worker too.
    output.on("close", () => { if (!done) abort(); });
    child.on("error", () => fail(503, goEngine ? "Gemini Web Go engine unavailable; build or install it" : "Gemini Web Python worker unavailable; install its dependencies"));
    child.stdin.on("error", () => fail(502, "Gemini Web worker stopped before receiving the request"));
    lines.on("line", (line) => {
      if (done) return;
      try {
        if (Buffer.byteLength(line) > MAX_IMAGE_EVENT_BYTES) throw new Error("output limit");
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new Error("protocol");
        if (event.type === "diagnostic") {
          telemetry = workerTelemetry(event);
        } else if (event.type === "error") {
          const status = typeof event.status === "number" && [400, 401, 403, 404, 409, 429, 502, 503, 504].includes(event.status) ? event.status : 502;
          // Only our worker's fixed, non-secret messages cross this boundary.
          const retry = typeof event.retryAfterSeconds === "number" && Number.isInteger(event.retryAfterSeconds)
            && event.retryAfterSeconds >= 1 && event.retryAfterSeconds <= 604800 ? event.retryAfterSeconds : 60;
          fail(status, typeof event.message === "string" ? event.message : "Gemini Web request failed", false, retry);
        } else if (event.type === "ready" && !ready) {
          ready = true;
          readyMs = Math.round(performance.now() - startedAt);
          // A matching ID allows text; tool calls require a complete response.
          if (!bridge && !imageMode && payload.mode !== "probe") startResponse();
        } else if (event.type === "image" && ready && imageMode && !image && !bridge) {
          image = validateGeneratedWebImage(event);
        } else if (event.type === "tools" && goEngine && ready && bridge && !imageMode && !engineTools) {
          if (!Array.isArray(event.calls) || !event.calls.length || event.calls.length > 64 || !isRecord(payload.engineRequest)) throw new Error("invalid engine tools");
          const declarations = toolDeclarations(payload.engineRequest);
          const config = isRecord(payload.engineRequest.toolConfig) ? payload.engineRequest.toolConfig.functionCallingConfig : undefined;
          engineTools = event.calls.map((call: unknown) => {
            if (!isRecord(call) || typeof call.name !== "string" || !isRecord(call.args)) throw new Error("invalid engine tool");
            const declaration = declarations.find((tool) => tool.name === call.name);
            if (!declaration || !matchesToolSchema(call.args, declaration.parameters ?? { type: "object" }) ||
                (isRecord(config) && Array.isArray(config.allowedFunctionNames) && !config.allowedFunctionNames.includes(call.name))) throw new Error("invalid engine tool");
            return { functionCall: { name: call.name, args: call.args } };
          });
        } else if (event.type === "delta" && ready && typeof event.text === "string") {
          if (goEngine && !imageMode) {
            if (!settled) startResponse();
            streamedText = true;
            writeText(event.text);
            return;
          }
          if (imageMode || (bridge && !streamedText)) {
            buffered += event.text;
            if (buffered.length > 128000) throw new Error("output limit");
            if (!imageMode && bridge?.canStreamText(buffered)) {
              streamedText = true;
              startResponse();
              writeText(buffered);
              buffered = "";
            }
            return;
          }
          writeText(event.text);
        } else if (event.type === "done" && ready) {
          if (payload.mode === "probe") {
            done = settled = true;
            logCompletion("done", 200);
            cleanup();
            output.destroy();
            resolve({ endpoint: ENDPOINT, response: Response.json({ usage: event.usage ?? {},
              ...(payload.includeIdentity === true ? { identity: event.identity } : {}) }) });
            return;
          }
          if (imageMode) {
            if ((!image && (payload.output === "image" || !buffered.trim())) || event.truncated || bridge) { fail(502, "Gemini Web returned no complete generated image"); return; }
            startResponse();
            output.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: image ? [{ inlineData: image }] : [{ text: buffered }] } }] })}\n\n`);
          }
          if (goEngine && engineTools) {
            if (!settled) startResponse();
            output.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: engineTools } }] })}\n\n`);
          } else if (bridge && !streamedText) {
            if (event.truncated) { fail(502, "Gemini Web tool response exceeded the output limit"); return; }
            let part: Record<string, unknown>;
            try { part = bridge.parse(buffered); }
            catch { fail(502, "Gemini Web generated an invalid tool call", true); return; }
            startResponse();
            output.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] } }] })}\n\n`);
          }
          done = true;
          logCompletion("done", 200);
          cleanup();
          output.end(`data: ${JSON.stringify({ candidates: [{ finishReason: event.truncated ? "MAX_TOKENS" : "STOP" }] })}\n\n`);
        } else throw new Error("protocol");
      } catch { fail(502, "Invalid Gemini Web worker response"); }
    });
    child.once("close", () => {
      if (!done) fail(502, "Gemini Web worker ended without completing the response");
      lines.close();
    });
    child.stdin.end(JSON.stringify({
      ...payload,
      proxy: payload.proxy ?? process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY,
      diagnostics: true,
    }));
  });
}

export async function forwardRequest(
  account: AccountRuntime, body: RequestBody, _headers: Record<string, string>, signal?: AbortSignal,
): Promise<ForwardedResponse> {
  let prompt: string;
  let bridge: ToolBridge | undefined;
  let attachments: WebAttachment[];
  try {
    ({ prompt, attachments } = buildWebInput(body));
    if (isRecord(body.request)) {
      const declarations = toolDeclarations(body.request);
      const config = isRecord(body.request.toolConfig) ? body.request.toolConfig.functionCallingConfig : undefined;
      if (declarations.length && !(isRecord(config) && config.mode === "NONE")) {
        bridge = createToolBridge(declarations, isRecord(config) ? {
          mode: String(config.mode), allowedFunctionNames: config.allowedFunctionNames as string[] | undefined,
        } : undefined);
        if (webEngineBackend() === "python") prompt += `\n\n${bridge.instruction}`;
        if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new WebRequestError(`Gemini Web text context is limited to ${MAX_PROMPT_BYTES} UTF-8 bytes`);
      }
    }
  }
  catch (error) { return failure(400, error instanceof WebRequestError ? error.message : "Invalid Gemini Web request"); }
  const payload = {
    mode: "generate", streamText: true, ...(body.requestType === "image-generation" ? { output: "image" } : body.requestType === "image-or-text" ? { output: "image-or-text" } : {}), prompt, ...(attachments.length ? { attachments } : {}), thinkingLevel: getWebThinkingLevel(body.model), cookiesFile: getCookiesFile(account.config),
    proxy: getProviderProxyUrl(account.config, GEMINI_WEB_PROVIDER), engineRequest: body.request,
  };
  const result = await runWebWorker(payload, signal, bridge);
  if (!result.retryToolCall || !bridge) return result;
  // No tool has reached the client, so retrying cannot repeat a local action.
  const correctedPrompt = prompt + "\n\nYour previous response was rejected before executing any tools. Return exactly ONE tool call using the marker above and a valid JSON object matching its declared schema. Include all required arguments. Do not add markdown, explanations or a second call. Wait for the client result before continuing.";
  if (Buffer.byteLength(correctedPrompt) > MAX_PROMPT_BYTES) return result;
  await result.response.body?.cancel();
  return runWebWorker({ ...payload, prompt: correctedPrompt }, signal, bridge);
}
