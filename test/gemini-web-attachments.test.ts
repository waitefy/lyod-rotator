import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { initDb } from "../src/db-store.js";
import { handleOpenAIChatCompletions, handleOpenAIResponsesCreate, handleAnthropicMessages } from "../src/compat.js";
import { anthropicToAntigravityBody, convertResponsesToChatRequest, normalizeOpenAIResponsesRequest, openAIToAntigravityBody } from "../src/providers/google-antigravity/translators.js";
import { buildWebInput, webCapabilityError } from "../src/providers/gemini-web/forward.js";
import { validateWebAttachment, WEB_MAX_ATTACHMENT_BYTES, WEB_MAX_TOTAL_ATTACHMENT_BYTES, WEB_MAX_ATTACHMENTS } from "../src/providers/gemini-web/attachments.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

const model = "gemini-4-argon-web-low";
const files = [
  { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=" },
  { mimeType: "application/pdf", data: Buffer.from("%PDF-1.4\nATTACHMENT_ONLY_PDF_MARKER").toString("base64") },
  { mimeType: "text/plain", data: Buffer.from("ATTACHMENT_ONLY_TEXT_MARKER").toString("base64") },
];
function block(format: string, file: typeof files[number]) {
  const image = file.mimeType.startsWith("image/");
  const url = `data:${file.mimeType};base64,${file.data}`;
  return format === "anthropic" ? { type: image ? "image" : "document", source: { type: "base64", media_type: file.mimeType, data: file.data } }
    : format === "responses" ? image ? { type: "input_image", image_url: url } : { type: "input_file", file_data: url, filename: "file" }
      : image ? { type: "image_url", image_url: { url } } : { type: "file", file: { file_data: url, filename: "file" } };
}
function request(format: "chat" | "responses" | "anthropic") {
  const content = [{ type: format === "responses" ? "input_text" : "text", text: "Describe the attachments." }, ...files.map((f) => block(format, f))];
  return format === "responses" ? { model, input: [{ role: "user", content }] }
    : { model, messages: [{ role: "user", content }], ...(format === "anthropic" ? { max_tokens: 100 } : {}) };
}

const temp = await mkdtemp(join(tmpdir(), "gemini-web-attachments-"));
before(async () => { process.env.TUXEVIL_ROTATOR_DIR ||= temp; await initDb(); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

it("retains inline images, PDF and text bytes through all three request translators", () => {
  for (const format of ["chat", "responses", "anthropic"] as const) {
    const original = request(format);
    assert.equal(webCapabilityError(original, format), undefined);
    const input = format === "responses" ? openAIToAntigravityBody(convertResponsesToChatRequest(original as never).chatRequest)
      : format === "anthropic" ? anthropicToAntigravityBody(original as never) : openAIToAntigravityBody(original as never);
    const result = buildWebInput(input);
    assert.deepEqual(result.attachments, files);
    for (let i = 0; i < files.length; i++) assert.ok(result.prompt.includes(`[Attached file ${i + 1}: ${files[i].mimeType}]`));
    for (const file of files) assert.ok(!result.prompt.includes(file.data));
    assert.ok(!result.prompt.includes("ATTACHMENT_ONLY_"));
  }
});

it("retains old attachments on later turns and accepts an image-only user turn", () => {
  const input = openAIToAntigravityBody({ model, messages: [
    { role: "user", content: [block("chat", files[0])] },
    { role: "assistant", content: "An image." }, { role: "user", content: "Describe it again." },
  ] } as never);
  const result = buildWebInput(input);
  assert.deepEqual(result.attachments, [files[0]]);
  assert.match(result.prompt, /Attached file 1.*\n\nAssistant:\nAn image\.\n\nUser:\nDescribe it again\./);
});

it("retains image tool results in Chat, Responses and Anthropic", () => {
  const tool = { name: "screenshot", description: "Get a screenshot", parameters: { type: "object", properties: {} } };
  const chat = { model, tools: [{ type: "function", function: tool }], messages: [
    { role: "user", content: "Look at the screen" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: [block("chat", files[0])] },
  ] };
  const responses = { model, tools: [{ type: "function", ...tool }], input: [
    { role: "user", content: "Look at the screen" },
    { type: "function_call", call_id: "call_1", name: tool.name, arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: [block("responses", files[0])] },
  ] };
  const anthropic = { model, max_tokens: 100, tools: [{ name: tool.name, input_schema: tool.parameters }], messages: [
    { role: "user", content: "Look at the screen" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: tool.name, input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [block("anthropic", files[0])] }] },
  ] };
  const inputs = [openAIToAntigravityBody(chat as never),
    openAIToAntigravityBody(convertResponsesToChatRequest(normalizeOpenAIResponsesRequest(responses) as never).chatRequest), anthropicToAntigravityBody(anthropic as never)];
  for (const [i, original] of [chat, responses, anthropic].entries()) {
    assert.equal(webCapabilityError(original, ["chat", "responses", "anthropic"][i] as "chat"), undefined);
    const result = buildWebInput(inputs[i]);
    assert.deepEqual(result.attachments, [files[0]]);
    assert.match(result.prompt, /Client tool result/);
    assert.match(result.prompt, /Attached file 1/);
  }
});

it("rejects remote URLs, file IDs, invalid MIME/base64 and attachment limits without accepting paths", () => {
  const invalid = [
    { type: "image_url", image_url: { url: "http://127.0.0.1/private" } },
    { type: "input_file", file_id: "file-123" }, { type: "file", file: { file_data: "/etc/passwd" } },
    { type: "document", source: { type: "url", url: "https://example.test/a.pdf" } },
    { type: "image_url", image_url: { url: "data:application/pdf;base64,YQ==" } },
    { type: "input_file", file_data: "data:audio/mp3;base64,YQ==" },
    { type: "input_file", file_data: "data:text/plain;base64,YQ=\n=" },
    { type: "input_file", file_data: "data:text/plain;base64,YR==" },
    { type: "input_file", file_data: "data:text/plain;base64," },
  ];
  for (const part of invalid) assert.ok(webCapabilityError({ messages: [{ role: "user", content: [part] }] }));
  const large = { mimeType: "text/plain", data: Buffer.alloc(WEB_MAX_ATTACHMENT_BYTES + 1).toString("base64") };
  assert.throws(() => validateWebAttachment(large), /limit|bytes/);
  assert.ok(webCapabilityError({ messages: [{ role: "user", content: Array.from({ length: WEB_MAX_ATTACHMENTS + 1 }, () => block("chat", files[0])) }] }));
  const total = { mimeType: "text/plain", data: Buffer.alloc(WEB_MAX_TOTAL_ATTACHMENT_BYTES / 2).toString("base64") };
  assert.ok(webCapabilityError({ messages: [{ role: "user", content: [block("chat", total), block("chat", total), block("chat", files[0])] }] }));
  assert.ok(webCapabilityError({ messages: [{ role: "assistant", content: [block("chat", files[0])] }] }));
  assert.ok(webCapabilityError({ system: [block("anthropic", files[0])] }, "anthropic"));
});

it("passes inline uploads through the actual HTTP handlers in all three APIs, JSON and SSE", async () => {
  const python = join(temp, "python-fixture");
  await writeFile(python, `#!/usr/bin/env python3
import json,sys
payload=json.load(sys.stdin)
assert payload['attachments']==${JSON.stringify(files)}
assert 'ATTACHMENT_ONLY_' not in payload['prompt']
for event in [{'type':'ready'},{'type':'delta','text':'ATTACHMENTS_OK'},{'type':'done'}]:
 print(json.dumps(event),flush=True)
`, { mode: 0o700 });
  const previous = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
  process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = python;
  const account = { config: { email: "attachments@example.test", credentials: [{ provider: "gemini-web", cookiesFile: join(temp, "cookies.json") }] }, inFlightRequests: 0, inFlightByModel: {}, disabled: false, flagged: false } as AccountRuntime;
  const rotator = {
    getConfig: () => ({}), hasActiveProvider: (id: string) => id === "gemini-web", getActiveAccount: async () => account,
    getRetryAfterMs: () => 0, resolveQuotaModelKeyForDisplay: () => "gemini-web", getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0, recordUpstreamAttempt: () => {}, finishRequest: () => {}, recordRequest: () => false,
    recordProxyEvent: () => {}, recordLatency: () => {}, recordRequestLog: () => {}, recordTokenUsage: () => {}, saveState: () => {},
  } as unknown as AccountRotator;
  const server = createServer((req, res) => {
    const handler = req.url === "/v1/responses" ? handleOpenAIResponsesCreate : req.url === "/v1/messages" ? handleAnthropicMessages : handleOpenAIChatCompletions;
    void handler(req, res, rotator).catch(() => { res.writeHead(500); res.end(); });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const format of ["chat", "responses", "anthropic"] as const) {
      for (const stream of [false, true]) {
        const path = format === "chat" ? "/v1/chat/completions" : format === "responses" ? "/v1/responses" : "/v1/messages";
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request(format), stream }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.match(text, /ATTACHMENTS_OK/);
        assert.equal(response.headers.get("Content-Type")?.includes("text/event-stream"), stream);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
    else process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = previous;
  }
});
