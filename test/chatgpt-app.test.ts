import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";
import { accountFromSessionFile, chatGptAppModels, readBridgeSession, upstreamModel } from "../src/providers/chatgpt-app/credentials.js";
import { chatGptAppAdapter } from "../src/providers/chatgpt-app/index.js";
import { findProviderForModel } from "../src/providers/registry.js";
import { getProviderIdForPoolKey } from "../src/providers/credential-helpers.js";
import { validateAccountConfig } from "../src/validators.js";
import { resolveModelRoute } from "../src/model-catalog.js";
import { mergeCredentials } from "../src/account-store.js";
import { buildOpenAIModelCatalog, handleOpenAIChatCompletions, handleOpenAIResponsesCreate,
  handleAnthropicMessages, resetResponsesStoreForTests } from "../src/compat.js";
import { serveCliLogin } from "../src/onboarding.js";
import type { ServerResponse } from "node:http";

const model = "chatgpt-app-fixture-thinking";
const originalModels = process.env.LYOD_CHATGPT_APP_MODELS;
let directory: string;
let sessionFile: string;
let bridge: Server;
let gateway: Server;
let baseUrl: string;
let account: AccountRuntime;
let selectedAccount: AccountRuntime;
let retryAccount: AccountRuntime | undefined;
let gatewayUrl: string;
const captures: Array<{ url: string; authorization?: string; leakedHeader?: string; body: Record<string, unknown> }> = [];
const invalid: string[] = [];
const cooldowns: string[] = [];
let endStream: (() => void) | undefined;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  process.env.LYOD_CHATGPT_APP_MODELS = "fixture-thinking";
  directory = await mkdtemp(join(tmpdir(), "lyod-chatgpt-test-"));
  sessionFile = join(directory, "session.json");
  bridge = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    captures.push({ url: req.url ?? "", authorization: req.headers.authorization,
      leakedHeader: req.headers["x-client-secret"] as string | undefined, body });
    const content = JSON.stringify(body.messages);
    if (content.includes("quota-rotation") && req.headers.authorization === "Bearer bridge-private-key") {
      res.writeHead(429, { "retry-after": "1" }); res.end("quota limit"); return;
    }
    const error = content.match(/reject-(\d+)/);
    if (error) {
      res.writeHead(Number(error[1]), { "retry-after": "17" });
      res.end('web-access-token-must-not-leak');
      return;
    }
    if (content.includes("hang")) return;
    if (content.includes("redirect")) {
      res.writeHead(302, { location: "/stolen" }); res.end(); return;
    }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"FIRST"}}]}\n\n');
      if (content.includes("incremental")) await new Promise<void>((accept) => { endStream = accept; });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"SECOND"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const message = body.tools ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function",
      function: { name: "read", arguments: '{"path":"example.txt"}' } }] }
      : { role: "assistant", content: "BRIDGE_OK" };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message, finish_reason: body.tools ? "tool_calls" : "stop" }] }));
  });
  baseUrl = await listen(bridge);
  await writeFile(sessionFile, JSON.stringify({ email: "fixture@example.test", baseUrl, apiKey: "bridge-private-key" }), { mode: 0o600 });
  account = { config: await accountFromSessionFile(sessionFile), inFlightRequests: 0,
    inFlightByModel: {}, quota: [], disabled: false, flagged: false } as unknown as AccountRuntime;
  selectedAccount = account;
  const rotator = {
    getConfig: () => ({}), hasActiveProvider: (id: string) => id === "chatgpt-app",
    getActiveAccount: async () => selectedAccount, getRetryAfterMs: () => 0,
    rotateToNext: async () => {
      const next = retryAccount; retryAccount = undefined;
      if (next) selectedAccount = next;
      return next ?? null;
    }, resolveQuotaModelKeyForDisplay: () => "chatgpt-app",
    getSafetyJitterMs: () => 0, getGlobalDelayMs: () => 0,
    recordUpstreamAttempt: () => {}, finishRequest: () => {}, recordRequest: () => false,
    recordProxyEvent: () => {}, recordLatency: () => {}, recordRequestLog: () => {},
    recordTokenUsage: () => {}, saveState: () => {},
    markProviderInvalid: (_account: AccountRuntime, id: string) => invalid.push(id),
    markExhausted: () => {}, recordProvider429: () => {},
    setProviderCooldown: (_account: AccountRuntime, id: string) => cooldowns.push(id),
    markFlagged: () => assert.fail("must not flag parent account"),
    markError: () => assert.fail("must not penalize sibling credentials"),
  } as unknown as AccountRotator;
  gateway = createServer((req, res) => {
    const handler = req.url === "/v1/responses" ? handleOpenAIResponsesCreate
      : req.url === "/v1/messages" ? handleAnthropicMessages : handleOpenAIChatCompletions;
    void handler(req, res, rotator).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  gatewayUrl = await listen(gateway);
});

after(async () => {
  endStream?.();
  for (const server of [gateway, bridge]) {
    server?.closeAllConnections();
    if (server) await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  }
  if (originalModels === undefined) delete process.env.LYOD_CHATGPT_APP_MODELS;
  else process.env.LYOD_CHATGPT_APP_MODELS = originalModels;
  resetResponsesStoreForTests();
  await rm(directory, { recursive: true, force: true });
});

function body(content: string, stream = false) {
  return { project: "", model, request: { messages: [{ role: "user", content }], stream } };
}

async function post(path: string, payload: unknown): Promise<Response> {
  return fetch(gatewayUrl + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

it("uses explicit model aliases and a separate provider/pool, without Codex or Google fallback", () => {
  assert.deepEqual(chatGptAppModels(), [model]);
  assert.equal(upstreamModel(model), "fixture-thinking");
  assert.throws(() => upstreamModel("chatgpt-app-auto"));
  assert.equal(findProviderForModel(model)?.id, "chatgpt-app");
  assert.equal(findProviderForModel("chatgpt-app-unknown")?.id, "chatgpt-app");
  assert.equal(getProviderIdForPoolKey("chatgpt-app"), "chatgpt-app");
  assert.deepEqual(resolveModelRoute({}, model), { kind: "provider", providerId: "chatgpt-app", modelId: model });
});

it("validates a private session file and preserves existing same-email credentials", async () => {
  const config = await accountFromSessionFile(sessionFile);
  assert.equal(validateAccountConfig(config).ok, true);
  assert.equal((await chatGptAppAdapter.validateCredentials(config)).ok, true);
  const existing = [{ provider: "openai-codex", refreshToken: "codex-private" }, { provider: "gemini-web", cookiesFile: "/cookies.json" }];
  const merged = mergeCredentials(existing, config.credentials)!;
  assert.equal(merged.length, 3);
  assert.ok(merged.some((credential) => credential.refreshToken === "codex-private"));
  assert.doesNotMatch(JSON.stringify(config), /bridge-private-key/);
  await chmod(sessionFile, 0o644);
  await assert.rejects(readBridgeSession(sessionFile), /private/);
  await chmod(sessionFile, 0o600);
  assert.equal(validateAccountConfig({ email: "test", credentials: [{ provider: "chatgpt-app", sessionFile: "relative.json" }] }).ok, false);
  const beforeCount = captures.length;
  const mismatched = { ...account, config: { ...account.config, email: "other@example.test" } };
  assert.equal((await chatGptAppAdapter.forwardRequest(mismatched, body("test"), {})).response.status, 401);
  assert.equal(captures.length, beforeCount);
});

it("rejects malformed files and unsafe endpoints without echoing secrets", async () => {
  const path = join(directory, "bad.json");
  for (const value of ['{"secret":"do-not-echo"', JSON.stringify({ email: "x", apiKey: "do-not-echo", baseUrl: "http://example.com" }),
    JSON.stringify({ email: "x", apiKey: "do-not-echo", baseUrl: "https://user:password@example.com" })]) {
    await writeFile(path, value, { mode: 0o600 });
    await assert.rejects(readBridgeSession(path), (error: Error) => !/do-not-echo|password/.test(error.message));
  }
});

it("advertises only configured models for active accounts and honors model switches", () => {
  const source = (active: boolean, disabledModels: string[] = []) => ({
    hasActiveProvider: (id: string) => active && id === "chatgpt-app", getConfig: () => ({ disabledModels }),
  });
  assert.equal(buildOpenAIModelCatalog(source(false) as never).some((entry) => entry.id === model), false);
  const entry = buildOpenAIModelCatalog(source(true) as never).find((entry) => entry.id === model)!;
  assert.equal(entry.context_window, null);
  assert.equal(entry.meta.availability_unverified, true);
  assert.equal(buildOpenAIModelCatalog(source(true, [`chatgpt-app/${model}`]) as never).some((entry) => entry.id === model), false);
});

it("forwards tools and history exactly, replaces authorization and never forwards client headers", async () => {
  const request = body("tools");
  Object.assign(request.request, { tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    reasoning_effort: "high", tool_choice: "auto" });
  const result = await chatGptAppAdapter.forwardRequest(account, request, { authorization: "Bearer client-key", "x-client-secret": "secret" });
  assert.equal(result.response.status, 200);
  const reply = await result.response.json();
  assert.equal(reply.choices[0].message.tool_calls[0].function.name, "read");
  const capture = captures.at(-1)!;
  assert.equal(capture.url, "/v1/chat/completions");
  assert.equal(capture.authorization, "Bearer bridge-private-key");
  assert.equal(capture.leakedHeader, undefined);
  assert.deepEqual(capture.body, { ...request.request, model: "fixture-thinking" });
  const history = body("unused");
  Object.assign(history.request, { messages: [
    { role: "assistant", content: null, tool_calls: reply.choices[0].message.tool_calls },
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
  ] });
  await (await chatGptAppAdapter.forwardRequest(account, history, {})).response.text();
  assert.deepEqual(captures.at(-1)!.body.messages, history.request.messages);
});

it("delivers the first SSE chunk while the upstream response is still open", async () => {
  const result = await chatGptAppAdapter.forwardRequest(account, body("incremental", true), {});
  const reader = result.response.body!.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /FIRST/);
    assert.doesNotMatch(new TextDecoder().decode(first.value), /SECOND/);
    assert.ok(endStream);
    endStream(); endStream = undefined;
    let rest = "";
    while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.match(rest, /SECOND/);
  } finally { endStream?.(); endStream = undefined; reader.releaseLock(); }
});

it("rejects unknown models before sending and does not follow redirects", async () => {
  const beforeCount = captures.length;
  const request = body("test"); request.model = "chatgpt-app-auto";
  assert.equal((await chatGptAppAdapter.forwardRequest(account, request, {})).response.status, 400);
  assert.equal(captures.length, beforeCount);
  const result = await chatGptAppAdapter.forwardRequest(account, body("redirect"), {});
  assert.equal(result.response.status, 502);
  assert.equal(captures.length, beforeCount + 1);
});

it("propagates client cancellation without retrying", async () => {
  const controller = new AbortController();
  const result = chatGptAppAdapter.forwardRequest(account, body("hang"), {}, controller.signal);
  setTimeout(() => controller.abort(new Error("client cancelled")), 50);
  await assert.rejects(result, /client cancelled/);
});

it("redacts bridge errors while preserving HTTP status and Retry-After", async () => {
  for (const status of [401, 403, 429, 502]) {
    const result = await chatGptAppAdapter.forwardRequest(account, body(`reject-${status}`), {});
    assert.equal(result.response.status, status);
    assert.equal(result.response.headers.get("retry-after"), "17");
    assert.doesNotMatch(await result.response.text(), /web-access-token|bridge-private-key/);
  }
});

it("serves Chat, Responses and Messages through the real compatibility handlers", async () => {
  const chat = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }] });
  assert.equal(chat.status, 200, await chat.clone().text());
  assert.equal((await chat.json()).choices[0].message.content, "BRIDGE_OK");
  const streamed = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }], stream: true });
  assert.equal(streamed.status, 200);
  const sse = await streamed.text();
  assert.match(sse, /FIRST/); assert.match(sse, /SECOND/); assert.match(sse, /\[DONE\]/);
  const responses = await post("/v1/responses", { model, input: "hello", store: false });
  assert.equal(responses.status, 200, await responses.clone().text());
  assert.match(JSON.stringify(await responses.json()), /BRIDGE_OK/);
  const messages = await post("/v1/messages", { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
  assert.equal(messages.status, 200, await messages.clone().text());
  assert.match(JSON.stringify(await messages.json()), /BRIDGE_OK/);
});

it("scopes authentication failures and access cooldown to ChatGPT App", async () => {
  for (const status of [401, 403]) {
    const response = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: `reject-${status}` }] });
    assert.equal(response.status, status, await response.clone().text());
    assert.doesNotMatch(await response.text(), /web-access-token/);
  }
  assert.deepEqual(invalid, ["chatgpt-app"]);
  assert.deepEqual(cooldowns, ["chatgpt-app"]);
});

it("rotates a rate-limited account to another explicit bridge without changing model", async () => {
  const path = join(directory, "second.json");
  await writeFile(path, JSON.stringify({ email: "second@example.test", baseUrl, apiKey: "second-private-key" }), { mode: 0o600 });
  retryAccount = { ...account, config: await accountFromSessionFile(path) };
  const start = captures.length;
  try {
    const response = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "quota-rotation" }] });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /BRIDGE_OK/);
    const requests = captures.slice(start);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.authorization), ["Bearer bridge-private-key", "Bearer second-private-key"]);
    assert.deepEqual(requests.map((request) => request.body.model), ["fixture-thinking", "fixture-thinking"]);
  } finally { selectedAccount = account; retryAccount = undefined; }
});

it("offers local browser sign-in and keeps remote bridge registration explicit", () => {
  let html = "";
  serveCliLogin({ writeHead() {}, end(value: string) { html = value; } } as unknown as ServerResponse);
  assert.match(html, /panel-chatgpt-app/);
  assert.match(html, /lyod-chatgpt:\/\/login/);
  assert.match(html, /does not deploy a bridge or connect a remote rotator automatically/);
  assert.match(html, /Advanced: register an existing bridge/);
  assert.match(html, /fetch\('\/api\/cli-login'/);
});
