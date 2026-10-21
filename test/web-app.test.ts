import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";
import { accountFromSessionFile, readSession, listedModels, accountModels, setCatalog } from "../src/providers/web-app/credentials.js";
import { qwenAppAdapter, deepseekAppAdapter } from "../src/providers/web-app/index.js";
import { findProviderForModel, getProviderIdForPoolKey } from "../src/providers/registry.js";
import { validateAccountConfig } from "../src/validators.js";
import { resolveModelRoute } from "../src/model-catalog.js";
import { buildOpenAIModelCatalog, handleOpenAIChatCompletions, handleOpenAIResponsesCreate, handleAnthropicMessages } from "../src/compat.js";
import { serveCliLogin } from "../src/onboarding.js";
import type { ServerResponse } from "node:http";

const offered = [{ id: "qwen-fixture", name: "Fixture", thinking: true, search: true, chat: true },
  { id: "image-fixture", name: "Image", thinking: false, search: false, chat: false }];
let directory: string;
let file: string;
let account: AccountRuntime;
let bridge: Server;
let gateway: Server;
let url: string;
let base: string;
let finishStream: (() => void) | undefined;
let catalogFailure = false;
const calls: Array<Record<string, unknown>> = [];
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "lyod-web-app-"));
  file = join(directory, "session.json");
  bridge = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-private-key");
    assert.equal(req.headers["x-secret"], undefined);
    if (req.url === "/v1/models") {
      if (catalogFailure) { res.writeHead(503); res.end("SECRET"); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ accountId: "stable-id", data: offered })); return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls.push(request);
    if (request.messages[0]?.content === "reject") {
      res.writeHead(429, { "retry-after": "50" }); res.end("SECRET"); return;
    }
    if (request.messages[0]?.content === "hang") return;
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"stream-id","object":"chat.completion.chunk","model":"qwen-fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"FIRST"},"finish_reason":null}]}\n\n');
      await new Promise<void>((done) => { finishStream = done; });
      res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "completion-id", object: "chat.completion", model: request.model,
      choices: [{ index: 0, message: request.tools ? { role: "assistant", content: null,
        tool_calls: [{ id: "call-fixture", type: "function", function: { name: "read", arguments: '{"path":"fixture.txt"}' } }] }
        : { role: "assistant", content: "OK" }, finish_reason: request.tools ? "tool_calls" : "stop" }] }));
  });
  base = await listen(bridge);
  await writeFile(file, JSON.stringify({ provider: "qwen-app", email: "fixture@example.test", accountId: "stable-id",
    apiKey: "test-private-key", baseUrl: base, availableModels: offered }), { mode: 0o600 });
  account = { config: await accountFromSessionFile(file, "qwen-app"), quota: [], disabled: false,
    flagged: false, inFlightRequests: 0, inFlightByModel: {} } as unknown as AccountRuntime;
  const rotator = {
    getConfig: () => ({ accounts: [account.config] }), hasActiveProvider: (id: string) => id === "qwen-app",
    getActiveAccount: async () => account, getRetryAfterMs: () => 0, rotateToNext: async () => null,
    resolveQuotaModelKeyForDisplay: () => "qwen-app:qwen-app-qwen-fixture",
    getSafetyJitterMs: () => 0, getGlobalDelayMs: () => 0, recordUpstreamAttempt: () => {}, finishRequest: () => {},
    recordRequest: () => false, recordProxyEvent: () => {}, recordLatency: () => {}, recordRequestLog: () => {},
    recordTokenUsage: () => {}, saveState: () => {}, markProviderInvalid: () => {}, markExhausted: () => {},
    recordProvider429: () => {}, setProviderCooldown: () => {},
    markFlagged: () => assert.fail("must not flag parent"), markError: () => assert.fail("must not penalize siblings"),
  } as unknown as AccountRotator;
  gateway = createServer((req, res) => {
    const handler = req.url === "/v1/responses" ? handleOpenAIResponsesCreate
      : req.url === "/v1/messages" ? handleAnthropicMessages : handleOpenAIChatCompletions;
    void handler(req, res, rotator).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  url = await listen(gateway);
});
after(async () => {
  finishStream?.();
  for (const server of [gateway, bridge]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await rm(directory, { recursive: true, force: true });
});
function body(content: string, extra: Record<string, unknown> = {}) {
  return { project: "", model: "qwen-app-qwen-fixture", request: { messages: [{ role: "user", content }], ...extra } };
}
function post(path: string, value: unknown) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}
it("separates provider ownership, pools, account catalogs and private descriptors", async () => {
  assert.equal(findProviderForModel("qwen-app-unknown")?.id, "qwen-app");
  assert.equal(findProviderForModel("deepseek-app-current")?.id, "deepseek-app");
  assert.equal(getProviderIdForPoolKey("deepseek-app:deepseek-app-current"), "deepseek-app");
  assert.equal(getProviderIdForPoolKey("qwen-app:qwen-app-qwen-fixture"), "qwen-app");
  assert.equal(validateAccountConfig(account.config).ok, true);
  assert.equal(qwenAppAdapter.canServeModel?.(account, "qwen-app:qwen-app-qwen-fixture"), true);
  assert.equal(qwenAppAdapter.canServeModel?.(account, "qwen-app:qwen-app-other"), false);
  assert.deepEqual(deepseekAppAdapter.listModels({ ollamaModels: [], codexModels: [], accounts: [account.config] }), []);
  assert.equal(listedModels([account.config], "qwen-app").length, 1);
  assert.deepEqual(resolveModelRoute({ getConfig: () => ({ accounts: [account.config] }) as never }, "qwen-app-qwen-fixture"),
    { kind: "provider", providerId: "qwen-app", modelId: "qwen-app-qwen-fixture" });
  await chmod(file, 0o644);
  assert.throws(() => readSession(file, "qwen-app"));
  await chmod(file, 0o600);
});
it("fails closed for unknown models, unsupported effort and attachments before any request", async () => {
  const before = calls.length;
  for (const request of [{ ...body("OK"), model: "qwen-app-guessed" }, body("OK", { reasoning_effort: "medium" }),
    body("OK", { thinking: true, reasoning_effort: "none" }), body("OK", { files: ["file"] })]) {
    const result = await qwenAppAdapter.forwardRequest(account, request, {});
    assert.ok([400, 404].includes(result.response.status));
  }
  assert.equal(calls.length, before);
});
it("forwards exact messages and tools, isolates authorization and preserves cooldown metadata", async () => {
  const result = await qwenAppAdapter.forwardRequest(account, body("OK", { reasoning_effort: "high" }), { "x-secret": "caller-secret" });
  assert.equal(result.response.status, 200);
  await result.response.body?.cancel();
  assert.equal(calls.at(-1)?.model, "qwen-fixture");
  assert.equal(calls.at(-1)?.thinking, true);
  const rejected = await qwenAppAdapter.forwardRequest(account, body("reject"), {});
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.response.headers.get("retry-after"), "50");
  assert.ok(!(await rejected.response.text()).includes("SECRET"));
});
it("serves a linked account by verified provider ID and refuses a different ID", async () => {
  const linked = { ...account, config: { ...account.config, email: "linked@example.test" } } as AccountRuntime;
  const result = await qwenAppAdapter.forwardRequest(linked, body("OK"), {});
  assert.equal(result.response.status, 200);
  await result.response.body?.cancel();
  assert.equal((await qwenAppAdapter.validateCredentials(linked.config)).ok, true);
  linked.config.credentials = [{ ...linked.config.credentials![0], providerAccountId: "wrong-id" }];
  assert.equal((await qwenAppAdapter.forwardRequest(linked, body("OK"), {})).response.status, 401);
  assert.equal((await qwenAppAdapter.validateCredentials(linked.config)).ok, false);
});
it("delivers first SSE delta before the bridge finishes and supports cancellation", async () => {
  const controller = new AbortController();
  const result = await qwenAppAdapter.forwardRequest(account, body("stream", { stream: true }), {}, controller.signal);
  const reader = result.response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /FIRST/);
  controller.abort();
  finishStream?.();
  await reader.cancel().catch(() => {});
  const abort = new AbortController();
  const pending = qwenAppAdapter.forwardRequest(account, body("hang"), {}, abort.signal);
  abort.abort();
  await assert.rejects(pending);
});
it("supports Chat Completions, Responses and Messages tool use through existing translators", async () => {
  const chat = await post("/v1/chat/completions", { model: "qwen-app-qwen-fixture", messages: [{ role: "user", content: "read" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }] });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.tool_calls[0].function.name, "read");
  const responses = await post("/v1/responses", { model: "qwen-app-qwen-fixture", input: "read", store: false,
    tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }] });
  assert.equal(responses.status, 200);
  assert.ok((await responses.json()).output.some((entry: { type: string }) => entry.type === "function_call"));
  const messages = await post("/v1/messages", { model: "qwen-app-qwen-fixture", max_tokens: 100,
    messages: [{ role: "user", content: "read" }], tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }] });
  assert.equal(messages.status, 200);
  assert.ok((await messages.json()).content.some((entry: { type: string }) => entry.type === "tool_use"));
});
it("does not invent quota, context window or model availability", async () => {
  const catalog = buildOpenAIModelCatalog({ getConfig: () => ({ accounts: [account.config] }),
    hasActiveProvider: (id: string) => id === "qwen-app" } as unknown as AccountRotator);
  const entry = catalog.find((item) => item.id === "qwen-app-qwen-fixture");
  assert.ok(entry);
  assert.equal(entry.context_window, null);
  assert.equal(entry.meta?.multimodal, false);
  catalogFailure = true;
  await qwenAppAdapter.fetchQuota(account, {} as never);
  assert.deepEqual(accountModels(account.config, "qwen-app"), []);
  assert.deepEqual(account.quota, []);
  catalogFailure = false;
  setCatalog(readSession(file, "qwen-app"), offered);
});
it("renders distinct login controls without duplicate element IDs or Claude-specific instructions", () => {
  let html = "";
  serveCliLogin({ setHeader() {}, writeHead() {}, end(value: string) { html = value; } } as unknown as ServerResponse);
  for (const provider of ["qwen", "deepseek"]) {
    assert.ok(html.includes(`id="${provider}-connect"`));
    assert.ok(html.includes(`lyod-${provider}://login`));
    const panel = html.slice(html.indexOf(`id="panel-${provider}-app"`)).split('<div class="panel"')[0];
    assert.ok(!panel.includes("Sonnet"));
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
