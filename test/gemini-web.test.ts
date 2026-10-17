import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { buildOpenAIModelCatalog, openAIToAntigravityBody, handleOpenAIChatCompletions, handleOpenAIResponsesCreate, handleAnthropicMessages } from "../src/compat.js";
import type { AccountRotator } from "../src/rotator.js";
import { resolveModelRoute } from "../src/model-catalog.js";
import { findProviderForModel, getProviderIdForPoolKey } from "../src/providers/registry.js";
import { geminiWebAdapter } from "../src/providers/gemini-web/index.js";
import { GEMINI_WEB_MODEL as LEGACY_MODEL, GEMINI_WEB_MODELS, GEMINI_WEB_MAX_PROMPT_BYTES, getWebThinkingLevel, validateCredentials } from "../src/providers/gemini-web/credentials.js";
import { buildWebPrompt, runWebWorker, webCapabilityError } from "../src/providers/gemini-web/forward.js";
import { classifyUpstreamResponse } from "../src/proxy.js";
import { validateAccountConfig } from "../src/validators.js";
import type { AccountConfig, AccountRuntime, Config } from "../src/types.js";
import { createToolBridge, toolDeclarations } from "../src/providers/gemini-web/tool-bridge.js";
import { handleCliLoginApi } from "../src/onboarding.js";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { removeAccountFromConfig } from "../src/account-store.js";
import { initDb } from "../src/db-store.js";

const readTool = { type: "function" as const, function: { name: "read", parameters: {
  type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 }, i: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["path", "i"],
} } };
const globTool = { type: "function" as const, function: { name: "glob", parameters: {
  type: "object", additionalProperties: false, properties: { i: { type: "string" }, path: { type: "string" }, hidden: { type: "boolean" }, limit: { type: "number" } }, required: ["i"],
} } };
const grepTool = { type: "function" as const, function: { name: "grep", parameters: {
  type: "object", additionalProperties: false, properties: { i: { type: "string" }, pattern: { type: "string" }, path: { type: "string" }, skip: { type: ["number", "null"], minimum: 0 } }, required: ["pattern", "i"],
} } };
const searchTools = [readTool, globTool, grepTool];
const editTool = { type: "function" as const, function: { name: "edit", parameters: {
  type: "object", additionalProperties: false, properties: { i: { type: "string" }, input: { type: "string", minLength: 1 } }, required: ["input", "i"],
} } };
const writeTool = { type: "function" as const, function: { name: "write", parameters: {
  type: "object", additionalProperties: false, properties: { i: { type: "string" }, path: { type: "string", minLength: 1 }, content: { type: "string" } }, required: ["path", "i"],
} } };
const fileTools = [...searchTools, editTool, writeTool];
const bashTool = { type: "function" as const, function: { name: "bash", parameters: {
  type: "object", additionalProperties: false, properties: { command: { type: "string", minLength: 1 }, i: { type: "string" }, cwd: { type: "string" },
    timeout: { type: "number", minimum: 0 }, pty: { type: "boolean" }, async: { type: "boolean" }, name: { type: "string" }, ready: { type: "object" } },
  required: ["command", "i"],
} } };
const customTool = { type: "function" as const, function: { name: "mcp__project__update", parameters: {
  type: "object", properties: { operations: { type: "array", items: { type: "object", properties: {
    file: { type: "string" }, delta: { type: ["integer", "null"], minimum: -5 },
  }, required: ["file", "delta"], additionalProperties: false } } }, required: ["operations"], additionalProperties: false,
} } };
const allTools = [...fileTools, bashTool, customTool];
const GEMINI_WEB_MODEL = GEMINI_WEB_MODELS[0];

const temp = await mkdtemp(join(tmpdir(), "gemini-web-contract-"));
before(async () => {
  process.env.TUXEVIL_ROTATOR_DIR ||= temp;
  await initDb();
});
after(async () => {
  await removeAccountFromConfig("web-login-fixture@example.test");
  await rm(temp, { recursive: true, force: true });
});

describe("Gemini Web integration", () => {
  it("routes the separate public id to the web provider and its own quota pool", () => {
    for (const [i, id] of GEMINI_WEB_MODELS.entries()) {
      assert.equal(findProviderForModel(id)?.id, "gemini-web");
      assert.deepEqual(resolveModelRoute({}, id), { kind: "provider", providerId: "gemini-web", modelId: id });
      assert.equal(getWebThinkingLevel(id), ["low", "medium", "high"][i]);
      assert.ok(buildWebPrompt(openAIToAntigravityBody({ model: id, messages: [{ role: "user", content: "test" }] })).includes("test"));
    }
    assert.equal(findProviderForModel(LEGACY_MODEL)?.id, "gemini-web");
    assert.equal(getWebThinkingLevel("gemini-4-argon-web-ultra"), undefined);
    assert.equal(getProviderIdForPoolKey("gemini-web"), "gemini-web");
    assert.deepEqual(resolveModelRoute({}, GEMINI_WEB_MODEL), { kind: "provider", providerId: "gemini-web", modelId: GEMINI_WEB_MODEL });
    assert.equal(geminiWebAdapter.getKickstartModelForPool("gemini-web"), undefined);
  });

  it("advertises limited capabilities only with an active account and respects switches", () => {
    const source = (active: boolean, disabledModels: string[] = []) => ({
      hasActiveProvider: (id: string) => active && id === "gemini-web",
      getConfig: () => ({ disabledModels }),
    });
    assert.equal(buildOpenAIModelCatalog(source(false) as never).some((m) => m.id === GEMINI_WEB_MODEL), false);
    const entry = buildOpenAIModelCatalog(source(true) as never).find((m) => m.id === GEMINI_WEB_MODEL)!;
    assert.deepEqual(buildOpenAIModelCatalog(source(true) as never).filter((m) => m.owned_by === "gemini-web").map((m) => m.id), GEMINI_WEB_MODELS);
    assert.equal(buildOpenAIModelCatalog(source(true) as never).some((m) => m.id === LEGACY_MODEL), false);
    assert.equal(entry.owned_by, "gemini-web");
    assert.equal(entry.context_window, 262144);
    assert.equal(entry.meta.tool_calling, false);
    assert.equal(entry.meta.multimodal, true);
    assert.equal(entry.meta.usage_unavailable, true);
    assert.equal(buildOpenAIModelCatalog(source(true, [`gemini-web/${GEMINI_WEB_MODEL}`]) as never).some((m) => m.id === GEMINI_WEB_MODEL), false);
  });

  it("accepts cookie paths without requiring OAuth and never returns their contents", async () => {
    const path = join(temp, "cookies.json");
    const config = { email: "web@example.com", credentials: [{ provider: "gemini-web", cookiesFile: path }] };
    assert.equal(validateAccountConfig(config).ok, true);
    assert.equal(validateAccountConfig({ ...config, credentials: [{ provider: "gemini-web", cookiesFile: "relative.json" }] }).ok, false);
    await writeFile(path, JSON.stringify({ "__Secure-1PSID": "fixture-cookie-value" }), { mode: 0o600 });
    assert.deepEqual(await validateCredentials(config), { ok: true });
    await writeFile(path, "fixture-cookie-value");
    const failure = await validateCredentials(config);
    assert.equal(failure.ok, false);
    assert.doesNotMatch(JSON.stringify(failure), /fixture-cookie-value/);
  });

  it("preserves text history and rejects invalid parts, tools, structured output and oversized UTF-8", () => {
    const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, messages: [
      { role: "system", content: "Keep it short." }, { role: "user", content: "Привет" },
      { role: "assistant", content: "Здравствуйте" }, { role: "user", content: "🌍" },
    ] });
    const prompt = buildWebPrompt(body);
    for (const text of ["Keep it short.", "Привет", "Здравствуйте", "🌍"]) assert.ok(prompt.includes(text));
    assert.throws(() => buildWebPrompt({ ...body, request: { contents: [{ role: "user", parts: [{ inlineData: { data: "abc" } }] }] } }), /MIME type/);
    assert.throws(() => buildWebPrompt({ ...body, request: { tools: [{}] } }), /API tool/);
    assert.throws(() => buildWebPrompt(openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, messages: [{ role: "user", content: "🌍".repeat(GEMINI_WEB_MAX_PROMPT_BYTES / 4 + 1) }] })), /UTF-8/);
    assert.ok(webCapabilityError({ response_format: { type: "json_schema" } }));
    assert.ok(webCapabilityError({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/img" } }] }] }));
    assert.equal(webCapabilityError({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), undefined);
  });

  it("accepts large Unicode tool history without dropping results", () => {
    const content = "Я🌍".repeat(80000) + "LARGE_TOOL_RESULT_END";
    const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, tools: allTools, messages: [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: null, tool_calls: [{ id: "large_read", type: "function", function: { name: "read", arguments: '{"path":"file.txt","i":"Read"}' } }] },
      { role: "tool", tool_call_id: "large_read", content },
    ] });
    const prompt = buildWebPrompt(body);
    assert.ok(Buffer.byteLength(prompt) > 48000);
    assert.ok(prompt.includes(content));
  });

  it("never treats a busy session or web authentication failure as successful upstream output", async () => {
    for (const status of [400, 401, 403, 404, 409, 502, 503, 504]) {
      const action = await classifyUpstreamResponse(new Response("safe error", { status }), "web", {} as AccountRuntime, GEMINI_WEB_MODEL, "gemini-web", "gemini-web");
      assert.equal(action.kind, "web-error");
    }
  });

  it("accepts OMP search schemas and validates tool selection, nullable values and history", () => {
    const original = { model: GEMINI_WEB_MODEL, tools: searchTools, messages: [{ role: "user" as const, content: "search" }] };
    assert.equal(webCapabilityError(original), undefined);
    const translated = openAIToAntigravityBody(original);
    assert.doesNotThrow(() => buildWebPrompt(translated));
    const bridge = createToolBridge(toolDeclarations(translated.request as Record<string, unknown>));
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    for (const [name, args] of [["glob", { i: "Find", path: "**/*.ts", hidden: false, limit: 10 }],
      ["glob", { i: "List" }], ["grep", { i: "Search", pattern: "ARGON", skip: null }]] as const) {
      assert.deepEqual(bridge.parse(marker + JSON.stringify({ name, arguments: args })), { functionCall: { name, args } });
    }
    for (const [name, args] of [["eval", {}], ["grep", { i: "Search" }], ["grep", { i: "Search", pattern: "x", skip: -1 }],
      ["glob", { i: "Find", hidden: "true" }], ["glob", { i: "Find", command: "pwd" }]]) {
      assert.throws(() => bridge.parse(marker + JSON.stringify({ name, arguments: args })));
    }
    assert.ok(webCapabilityError({ ...original, tools: [...searchTools, readTool] }));
    assert.ok(webCapabilityError({ ...original, messages: [{ role: "assistant", tool_calls: [{ type: "function", function: { name: "eval" } }] }] }));
    for (const name of ["glob", "grep"]) {
      const history = openAIToAntigravityBody({ ...original, messages: [...original.messages,
        { role: "assistant", content: null, tool_calls: [{ id: "call_search", type: "function", function: { name, arguments: '{"i":"Search"}' } }] },
        { role: "tool", tool_call_id: "call_search", content: "SEARCH_RESULT_OK" }] });
      assert.match(buildWebPrompt(history), /SEARCH_RESULT_OK/);
    }
  });

  it("bridges OMP edit/write schemas and preserves patch text, errors and history", () => {
    const patch = "[fixture.py#A1B2]\nPUT 1.=1:\n+value = 2\n";
    const original = { model: GEMINI_WEB_MODEL, tools: fileTools, messages: [{ role: "user" as const, content: "edit" }] };
    assert.equal(webCapabilityError(original), undefined);
    const translated = openAIToAntigravityBody(original);
    const bridge = createToolBridge(toolDeclarations(translated.request as Record<string, unknown>));
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    for (const [name, args] of [["edit", { input: patch, i: "Update value" }],
      ["write", { path: "fixture.py", content: "value = 1\n", i: "Create fixture" }],
      ["write", { path: "empty.txt", content: "", i: "Create empty file" }]] as const) {
      assert.deepEqual(bridge.parse(marker + JSON.stringify({ name, arguments: args })), { functionCall: { name, args } });
      const history = openAIToAntigravityBody({ ...original, messages: [...original.messages,
        { role: "assistant", content: null, tool_calls: [{ id: "call_edit", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        { role: "tool", tool_call_id: "call_edit", content: "EDIT_ERROR: stale tag; reread file" }] });
      assert.match(buildWebPrompt(history), /EDIT_ERROR: stale tag; reread file/);
    }
    for (const [name, args] of [["edit", { i: "Edit" }], ["edit", { i: "Edit", input: "" }],
      ["edit", { i: "Edit", input: patch, command: "pwd" }], ["write", { i: "Write", path: "" }],
      ["write", { i: "Write", path: "a", content: 1 }], ["eval", { command: "pwd" }]]) {
      assert.throws(() => bridge.parse(marker + JSON.stringify({ name, arguments: args })));
    }
    assert.equal(webCapabilityError({ ...original, tools: [...fileTools, { ...writeTool, function: { ...writeTool.function, name: "eval" } }] }), undefined);
  });

  it("bridges bash according to its client schema and preserves command output and exit status", () => {
    const command = "python3 test_calculator.py";
    const original = { model: GEMINI_WEB_MODEL, tools: allTools, messages: [{ role: "user" as const, content: "run tests" }] };
    assert.equal(webCapabilityError(original), undefined);
    const translated = openAIToAntigravityBody(original);
    const bridge = createToolBridge(toolDeclarations(translated.request as Record<string, unknown>));
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    const args = { command, i: "Run tests", cwd: "/tmp/project", timeout: 30, pty: false, async: false };
    assert.deepEqual(bridge.parse(marker + JSON.stringify({ name: "bash", arguments: args })), { functionCall: { name: "bash", args } });
    for (const extra of [{ async: true }, { pty: true }, { ready: {} }, { name: "server" }]) {
      assert.doesNotThrow(() => bridge.parse(marker + JSON.stringify({ name: "bash", arguments: { ...args, ...extra } })));
    }
    for (const invalid of [{ ...args, command: "" }, { ...args, command: 1 }, { ...args, timeout: -1 },
      { ...args, cwd: 1 }, { ...args, unknown: "x" }, { command }]) {
      assert.throws(() => bridge.parse(marker + JSON.stringify({ name: "bash", arguments: invalid })));
    }
    const history = openAIToAntigravityBody({ ...original, messages: [...original.messages,
      { role: "assistant", content: null, tool_calls: [{ id: "call_bash", type: "function", function: { name: "bash", arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: "call_bash", content: "x".repeat(700) + "AssertionError: add(2, 3) != 5; exit code 1" }] });
    assert.match(buildWebPrompt(history), /AssertionError: add\(2, 3\) != 5; exit code 1/);
  });

  it("accepts read, preserves its history and validates framed arguments", () => {
    const original: Parameters<typeof openAIToAntigravityBody>[0] = { model: GEMINI_WEB_MODEL, tools: [readTool], messages: [
      { role: "user", content: "read a file" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"a.txt","i":"Read"}' } }] },
      { role: "tool", tool_call_id: "call_read", content: "x".repeat(700) + "random fixture result" },
    ] };
    assert.equal(webCapabilityError(original), undefined);
    const prompt = buildWebPrompt(openAIToAntigravityBody(original));
    assert.match(prompt, /Client tool call/);
    assert.match(prompt, /random fixture result/);
    assert.ok(webCapabilityError({ ...original, tools: [{ type: "function", function: { ...readTool.function, name: "eval" } }] }));
    assert.equal(webCapabilityError({ ...original, tool_choice: "required" }), undefined);
    const bridge = createToolBridge([readTool.function]);
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    assert.deepEqual(bridge.parse(`${marker}{"name":"read","arguments":{"path":"a.txt","i":"Read"}}`), {
      functionCall: { name: "read", args: { path: "a.txt", i: "Read" } },
    });
    for (const args of [{ path: "a.txt" }, { path: 2, i: "Read" }, { path: "a", i: "Read", command: "rm" }, { path: "a", i: "Read", offset: -1 }]) {
      assert.throws(() => bridge.parse(marker + JSON.stringify({ name: "read", arguments: args })));
    }
    assert.throws(() => bridge.parse(marker + '{"name":"eval","arguments":{}}'));
    assert.throws(() => bridge.parse(marker + '{broken'));
    assert.deepEqual(bridge.parse("<tool_call>plain text</tool_call>"), { text: "<tool_call>plain text</tool_call>" });
  });
});

describe("private worker protocol", () => {
  async function fakePython(source: string, run: () => Promise<void>): Promise<void> {
    const path = join(temp, `python-${Math.random().toString(36).slice(2)}`);
    await writeFile(path, `#!/usr/bin/env python3\n${source}\n`, { mode: 0o700 });
    const previous = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
    process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = path;
    try { await run(); } finally {
      if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
      else process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = previous;
    }
  }

  it("accepts private diagnostics without forwarding them to the API stream", async () => {
    await fakePython(`import json,sys
request=json.load(sys.stdin)
assert request['diagnostics'] is True
for event in [{'type':'ready'},{'type':'delta','text':'ok'},{'type':'diagnostic','googleCode':1100,'timingsMs':{'init':2},'cookies':'private-cookie'},{'type':'done'}]:
 print(json.dumps(event),flush=True)`, async () => {
      const { response } = await runWebWorker({ mode: "generate", prompt: "private-prompt" });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /"text":"ok"/);
      assert.doesNotMatch(text, /diagnostic|private-cookie|private-prompt|googleCode|timingsMs/);
    });
  });

  it("rejects malformed tool calls before committing HTTP 200", async () => {
    const bridge = createToolBridge([readTool.function]);
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    await fakePython(`import json,sys
json.load(sys.stdin)
for event in [{'type':'ready'},{'type':'delta','text':${JSON.stringify(marker)} + '{broken'},{'type':'done'}]:
 print(json.dumps(event),flush=True)`, async () => {
      const result = await runWebWorker({}, undefined, bridge);
      assert.equal(result.response.status, 502);
      assert.match(await result.response.text(), /invalid tool call/);
    });
  });

  it("retries a rejected tool call once without executing it", async () => {
    const counter = join(temp, "tool-retry-counter");
    await fakePython(`import json,sys,re,pathlib
request=json.load(sys.stdin)
counter=pathlib.Path(${JSON.stringify(counter)})
attempt=int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(attempt))
marker=re.search(r'ROTATOR_TOOL_[a-f0-9-]+',request['prompt']).group(0)
if attempt == 2:
 assert 'rejected before executing any tools' in request['prompt']
text=marker + ('{broken' if attempt == 1 else json.dumps({'name':'read','arguments':{'path':'package.json','i':'Read package'}}))
for event in [{'type':'ready'},{'type':'delta','text':text},{'type':'done'}]:
 print(json.dumps(event),flush=True)`, async () => {
      const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, tools: [readTool], messages: [{ role: "user", content: "Read package.json" }] });
      const result = await geminiWebAdapter.forwardRequest({ config: { email: "fixture@local", credentials: [] } } as unknown as AccountRuntime, body, {});
      assert.equal(result.response.status, 200);
      const raw = await result.response.text();
      assert.match(raw, /"functionCall":\{"name":"read"/);
      assert.doesNotMatch(raw, /broken/);
      assert.equal(await readFile(counter, "utf8"), "2");
    });
  });

  it("stops after two rejected tool calls and returns a regular HTTP error", async () => {
    const counter = join(temp, "tool-retry-limit-counter");
    await fakePython(`import json,sys,re,pathlib
request=json.load(sys.stdin)
counter=pathlib.Path(${JSON.stringify(counter)})
counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
marker=re.search(r'ROTATOR_TOOL_[a-f0-9-]+',request['prompt']).group(0)
for event in [{'type':'ready'},{'type':'delta','text':marker+'{broken'},{'type':'done'}]:
 print(json.dumps(event),flush=True)`, async () => {
      const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, tools: [readTool], messages: [{ role: "user", content: "Read package.json" }] });
      const result = await geminiWebAdapter.forwardRequest({ config: { email: "fixture@local", credentials: [] } } as unknown as AccountRuntime, body, {});
      assert.equal(result.response.status, 502);
      assert.match(await result.response.text(), /invalid tool call/);
      assert.equal(await readFile(counter, "utf8"), "2");
    });
  });

  it("does not retry authentication, worker protocol or truncated response failures", async () => {
    for (const kind of ["auth", "protocol", "truncated"]) {
      const counter = join(temp, "no-tool-retry-" + kind);
      await fakePython(`import json,sys,pathlib
json.load(sys.stdin)
counter=pathlib.Path(${JSON.stringify(counter)})
counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
kind=${JSON.stringify(kind)}
if kind == 'protocol':
 print('broken',flush=True)
else:
 events=[{'type':'error','status':401,'message':'session expired'}] if kind == 'auth' else [{'type':'ready'},{'type':'delta','text':'partial'},{'type':'done','truncated':True}]
 for event in events: print(json.dumps(event),flush=True)`, async () => {
        const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, tools: [readTool], messages: [{ role: "user", content: "Read package.json" }] });
        const result = await geminiWebAdapter.forwardRequest({ config: { email: "fixture@local", credentials: [] } } as unknown as AccountRuntime, body, {});
        assert.equal(result.response.status, kind === "auth" ? 401 : 502);
        const text = await result.response.text();
        assert.match(text, kind === "auth" ? /session expired/ : kind === "protocol" ? /Invalid Gemini Web worker response/ : /output limit/);
        assert.equal(await readFile(counter, "utf8"), "1");
      });
    }
  });

  it("cancels a tool response while waiting for validation", async () => {
    await fakePython(`import json,sys,time
json.load(sys.stdin)
print(json.dumps({'type':'ready'}),flush=True)
time.sleep(30)`, async () => {
      const controller = new AbortController();
      const pending = runWebWorker({}, controller.signal, createToolBridge([readTool.function]));
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(pending, /cancelled/);
    });
  });

  it("fixes the worker thinking level by model id even if the client supplies effort", async () => {
    for (const id of GEMINI_WEB_MODELS) {
      await fakePython(`import json,sys
request=json.load(sys.stdin)
assert request['thinkingLevel']==${JSON.stringify(getWebThinkingLevel(id))}
for event in [{'type':'ready'},{'type':'delta','text':'OK'},{'type':'done'}]:
 print(json.dumps(event),flush=True)`, async () => {
        const body = openAIToAntigravityBody({ model: id, reasoning_effort: "high", messages: [{ role: "user", content: "test" }] });
        assert.equal(body.model, id);
        const { response } = await geminiWebAdapter.forwardRequest({ config: { email: "fixture@local", credentials: [] } } as unknown as AccountRuntime, body, {});
        assert.equal(response.status, 200);
        assert.match(await response.text(), /OK/);
      });
    }
  });

  it("registers browser sessions only after a successful Argon probe and reports reconnect status", async () => {
    const cookiesFile = join(temp, "login-cookies.json");
    await writeFile(cookiesFile, JSON.stringify({ "__Secure-1PSID": "private-fixture" }));
    for (const status of [200, 401, 404]) {
      await fakePython(`import json,sys
request=json.load(sys.stdin)
assert request['mode']=='probe'
events=[{'type':'ready'},{'type':'done','identity':{'email':'web-login-fixture@example.test','id':'1234567890'}}] if ${status}==200 else [{'type':'error','status':${status},'message':'session rejected'}]
for event in events: print(json.dumps(event),flush=True)`, async () => {
        const updated: unknown[] = [];
        let code = 0, text = "";
        const req = Readable.from([Buffer.from(JSON.stringify({ provider: "gemini-web", email: "web-login-fixture@local", cookiesFile }))]) as IncomingMessage;
        req.headers = {};
        const res = { writeHead(value: number) { code = value; }, end(value: string) { text += value; } } as ServerResponse;
        await handleCliLoginApi(req, res, { addOrUpdateAccount: async (entry) => { updated.push(entry); } });
        assert.equal(code, status);
        assert.equal(updated.length, status === 200 ? 1 : 0);
        if (status === 200) {
          assert.equal((updated[0] as AccountConfig).email, "web-login-fixture@example.test");
          assert.equal((updated[0] as AccountConfig).credentials![0].providerAccountId, "1234567890");
        }
        assert.doesNotMatch(text, /private-fixture/);
        const account = { quota: [], config: { email: "fixture", credentials: [{ provider: "gemini-web", cookiesFile }] } } as unknown as AccountRuntime;
        await geminiWebAdapter.fetchQuota(account, {} as never);
        const message = account.lastPollByProvider?.["gemini-web"];
        assert.match(message ?? "", status === 200 ? /background refresh active/ : status === 401 ? /Reconnect/ : /Argon unavailable/);
      });
    }
  });

  it("merges a verified web login into its real account and retires only the matching synthetic session", async () => {
    const cookiesFile = join(temp, "canonical-login.json");
    await writeFile(cookiesFile, JSON.stringify({ "__Secure-1PSID": "private-fixture" }));
    await fakePython(`import json,sys
request=json.load(sys.stdin)
assert request['includeIdentity'] is True
for event in [{'type':'ready'},{'type':'done','identity':{'email':'web-login-fixture@example.test','id':'1234567890'}}]: print(json.dumps(event),flush=True)`, async () => {
      const accounts: AccountConfig[] = [
        { email: "web-login-fixture@example.test", label: "Keep my label", credentials: [{ provider: "google-antigravity", refreshToken: "other-provider" }] },
        { email: "gemini-web-session@local", credentials: [{ provider: "gemini-web", cookiesFile }] },
        { email: "different@local", credentials: [{ provider: "gemini-web", cookiesFile: "/sessions/different.json" }] },
        { email: "shared@local", credentials: [{ provider: "gemini-web", cookiesFile }, { provider: "ollama", apiKey: "other" }] },
      ];
      const updated: AccountConfig[] = [], removed: string[] = [];
      let code = 0, text = "";
      const req = Readable.from([Buffer.from(JSON.stringify({ provider: "gemini-web", email: "gemini-web-session@local", cookiesFile }))]) as IncomingMessage;
      req.headers = {};
      const res = { writeHead(value: number) { code = value; }, end(value: string) { text += value; } } as ServerResponse;
      await handleCliLoginApi(req, res, {
        getConfig: () => ({ accounts }) as Config,
        addOrUpdateAccount: async (entry) => { updated.push(entry); },
        removeAccount: async (email) => { removed.push(email); return true; },
      });
      assert.equal(code, 200);
      assert.equal(JSON.parse(text).email, accounts[0].email);
      assert.equal(updated[0].label, "Keep my label");
      assert.equal(updated[0].credentials![0].providerAccountId, "1234567890");
      assert.deepEqual(removed, ["gemini-web-session@local"]);
    });
  });

  it("refuses to register an alias when a successful probe has no verified identity", async () => {
    const cookiesFile = join(temp, "unidentified-login.json");
    await writeFile(cookiesFile, JSON.stringify({ "__Secure-1PSID": "private-fixture" }));
    await fakePython("import json,sys\njson.load(sys.stdin)\nprint(json.dumps({'type':'ready'}))\nprint(json.dumps({'type':'done'}))", async () => {
      let code = 0;
      const req = Readable.from([Buffer.from(JSON.stringify({ provider: "gemini-web", email: "unknown@local", cookiesFile }))]) as IncomingMessage;
      req.headers = {};
      const res = { writeHead(value: number) { code = value; }, end() {} } as ServerResponse;
      await handleCliLoginApi(req, res, { addOrUpdateAccount: async () => { assert.fail("Unverified account must not be registered"); } });
      assert.equal(code, 401);
    });
  });

  it("streams Unicode deltas through the existing Gemini accumulator without invented usage", async () => {
    await fakePython(`import json, sys
request = json.load(sys.stdin)
assert request['prompt'] == 'Привет'
for event in [{'type':'ready'}, {'type':'delta','text':'Привет 🌍'}, {'type':'done','truncated':False}]:
    print(json.dumps(event), flush=True)`, async () => {
      const { response } = await runWebWorker({ mode: "generate", prompt: "Привет" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Rotator-Usage"), "unavailable");
      const raw = await response.text();
      const accumulator = geminiWebAdapter.createStreamAccumulator();
      accumulator.append(raw);
      assert.equal(accumulator.final(), null);
      assert.equal(accumulator.getText(), "Привет 🌍");
      assert.match(raw, /STOP/);
    });
  });

  it("returns discovery and quota failures before committing HTTP 200", async () => {
    for (const status of [401, 404, 409, 429]) {
      await fakePython(`import json, sys
json.load(sys.stdin)
print(json.dumps({'type':'error','status':${status},'message':'safe failure'}), flush=True)`, async () => {
        const { response } = await runWebWorker({ mode: "probe" });
        assert.equal(response.status, status);
        assert.match(await response.text(), /safe failure/);
        if (status === 429) assert.equal(response.headers.get("retry-after"), "60");
      });
    }
  });

  it("returns bounded quota metrics from probes and preserves the quota reset delay", async () => {
    await fakePython(`import json,sys
json.load(sys.stdin)
print(json.dumps({'type':'ready'}),flush=True)
print(json.dumps({'type':'done','usage':{'current_5h':{'usage_level':1,'remaining_credits':0}}}),flush=True)`, async () => {
      const { response } = await runWebWorker({ mode: "probe" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { usage: { current_5h: { usage_level: 1, remaining_credits: 0 } } });
    });
    for (const [value, expected] of [[7200, "7200"], [-1, "60"], [604801, "60"], ["PRIVATE", "60"]]) {
      await fakePython(`import json,sys
json.load(sys.stdin)
print(json.dumps({'type':'error','status':429,'message':'RESOURCE_EXHAUSTED','retryAfterSeconds':${JSON.stringify(value)}}),flush=True)`, async () => {
        const { response } = await runWebWorker({});
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), expected);
      });
    }
  });

  it("rejects worker crashes and malformed protocol", async () => {
    for (const source of ["raise SystemExit(1)", "print('broken', flush=True)"]) {
      await fakePython(source, async () => {
        const { response } = await runWebWorker({ mode: "probe" });
        assert.equal(response.status, 502);
      });
    }
  });

  it("cancels a stalled worker before any response", async () => {
    await fakePython("import time\ntime.sleep(30)", async () => {
      const controller = new AbortController();
      const pending = runWebWorker({}, controller.signal);
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(pending, /cancelled/);
    });
  });

  it("surfaces failures after ready instead of silently completing a partial answer", async () => {
    await fakePython(`import json
for event in [{'type':'ready'}, {'type':'error','status':502,'message':'upstream stream failed'}]:
    print(json.dumps(event), flush=True)`, async () => {
      const { response } = await runWebWorker({});
      await assert.rejects(response.text(), /upstream stream failed/);
    });
  });

  it("serves chat, Responses and Anthropic tools over HTTP/SSE and isolates rejected credentials", async () => {
    const cookiesFile = join(temp, "http-cookies.json");
    await writeFile(cookiesFile, JSON.stringify({ "__Secure-1PSID": "test-only" }));
    const account = {
      config: { email: "web@example.test", credentials: [{ provider: "gemini-web", cookiesFile }] },
      inFlightRequests: 0, inFlightByModel: {}, disabled: false, flagged: false,
    } as AccountRuntime;
    const invalid: string[] = [];
    let finished = 0;
    const rotator = {
      getConfig: () => ({}), hasActiveProvider: (id: string) => id === "gemini-web",
      getActiveAccount: async () => account, getRetryAfterMs: () => 0,
      resolveQuotaModelKeyForDisplay: () => "gemini-web", getSafetyJitterMs: () => 0,
      getGlobalDelayMs: () => 0, recordUpstreamAttempt: () => {}, finishRequest: () => { finished++; },
      recordRequest: () => false, recordProxyEvent: () => {}, recordLatency: () => {},
      recordRequestLog: () => {}, recordTokenUsage: () => {}, saveState: () => {},
      markProviderInvalid: (_account: AccountRuntime, id: string) => invalid.push(id),
      markFlagged: () => assert.fail("must not flag the parent account"),
      markError: () => assert.fail("must not penalize other account credentials"),
    } as unknown as AccountRotator;
    const server = createServer((req, res) => {
      const handler = req.url === "/v1/responses" ? handleOpenAIResponsesCreate
        : req.url === "/v1/messages" ? handleAnthropicMessages : handleOpenAIChatCompletions;
      void handler(req, res, rotator).catch((error) => {
        res.writeHead(500); res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    async function request(stream: boolean, content = "Привет") {
      return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: GEMINI_WEB_MODEL, messages: [{ role: "user", content }], stream }) });
    }
    try {
      await fakePython(`import json, sys
request = json.load(sys.stdin)
if 'reject-session' in request['prompt']:
    print(json.dumps({'type':'error','status':401,'message':'session expired'}), flush=True)
else:
    for event in [{'type':'ready'}, {'type':'delta','text':'Привет 🌍 [Tool call: example({})] <tool_call name="example">{}</tool_call>'}, {'type':'done'}]:
        print(json.dumps(event, ensure_ascii=False), flush=True)`, async () => {
        const response = await request(false);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("X-Rotator-Usage"), "unavailable");
        const json = await response.json();
        assert.equal(json.choices[0].message.content, 'Привет 🌍 [Tool call: example({})] <tool_call name="example">{}</tool_call>');
        assert.equal(json.choices[0].finish_reason, "stop");
        assert.equal(json.usage, null);
        const streamed = await request(true);
        assert.equal(streamed.status, 200);
        const sse = await streamed.text();
        assert.match(sse, /Привет 🌍/);
        assert.match(sse, /data: \[DONE\]/);
        assert.doesNotMatch(sse, /"tool_calls"/);
        const rejected = await request(false, "reject-session");
        assert.equal(rejected.status, 401);
        await rejected.text();
        assert.deepEqual(invalid, ["gemini-web"]);
      });
      await fakePython("raise AssertionError('unsupported schema must not reach the worker')", async () => {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: GEMINI_WEB_MODEL, messages: [{ role: "user", content: "test" }], tools: [
            { type: "function", function: { name: "custom", parameters: { type: "object", properties: { x: { $ref: "#/$defs/X" } } } } },
          ] }) });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error.message, /parameters\.properties\.x\.\$ref: unsupported schema keyword/);
      });
      await fakePython(`import json, sys, re
prompt = json.load(sys.stdin)['prompt']
marker = re.search(r'ROTATOR_TOOL_[a-f0-9-]+', prompt).group(0)
name = 'mcp__project__update' if 'REQUEST_CUSTOM' in prompt else next((name for name in ['bash','edit','write','grep','glob'] if 'REQUEST_' + name.upper() in prompt), 'read')
args = {'operations':[{'file':'fixture.txt','delta':-2},{'file':'other.txt','delta':None}]} if name == 'mcp__project__update' else {'command':'python3 test_calculator.py','i':'Run tests','timeout':30} if name == 'bash' else {'pattern':'fixture','i':'Search fixture'} if name == 'grep' else {'input':'[fixture.txt#A1B2]\\nPUT 1.=1:\\n+updated','i':'Edit fixture'} if name == 'edit' else {'path':'fixture.txt','content':'created','i':'Write fixture'} if name == 'write' else {'path':'fixture.txt','i':'Read fixture'}
text = 'FILE_ROUND_TRIP_OK' if 'Client tool result (data):' in prompt else marker + json.dumps({'name':name,'arguments':args})
for event in [{'type':'ready'}, {'type':'delta','text':text}, {'type':'done'}]:
    print(json.dumps(event), flush=True)`, async () => {
        for (const [name, content] of [["read", "Read fixture.txt"], ["glob", "REQUEST_GLOB"], ["grep", "REQUEST_GREP"], ["edit", "REQUEST_EDIT"], ["write", "REQUEST_WRITE"], ["bash", "REQUEST_BASH"], ["mcp__project__update", "REQUEST_CUSTOM"]]) {
        for (const stream of [false, true]) {
          const messages: unknown[] = [{ role: "user", content }];
          const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: GEMINI_WEB_MODEL, tools: allTools, messages, stream }) });
          const response = await send();
          assert.equal(response.status, 200);
          if (stream) {
            const text = await response.text();
            assert.match(text, /"tool_calls"/);
            assert.match(text, /"finish_reason":"tool_calls"/);
            assert.doesNotMatch(text, /ROTATOR_TOOL_/);
          } else {
            const result = await response.json();
            const call = result.choices[0].message.tool_calls[0];
            assert.equal(call.function.name, name);
            assert.deepEqual(JSON.parse(call.function.arguments), name === "mcp__project__update" ? { operations: [{ file: "fixture.txt", delta: -2 }, { file: "other.txt", delta: null }] } : name === "bash" ? { command: "python3 test_calculator.py", i: "Run tests", timeout: 30 } : name === "grep" ? { pattern: "fixture", i: "Search fixture" } : name === "edit" ? { input: "[fixture.txt#A1B2]\nPUT 1.=1:\n+updated", i: "Edit fixture" } : name === "write" ? { path: "fixture.txt", content: "created", i: "Write fixture" } : { path: "fixture.txt", i: "Read fixture" });
            messages.push(result.choices[0].message, { role: "tool", tool_call_id: call.id, content: "FILE_ROUND_TRIP_OK" });
            const final = await send();
            assert.equal(final.status, 200);
            assert.equal((await final.json()).choices[0].message.content, "FILE_ROUND_TRIP_OK");
          }
        }
        }
      });
      await fakePython(`import json, sys, re
prompt = json.load(sys.stdin)['prompt']
marker = re.search(r'ROTATOR_TOOL_[a-f0-9-]+', prompt)
text = 'API_ROUND_TRIP_OK' if 'Client tool result (data):' in prompt or marker is None else marker.group(0) + json.dumps({'name':'custom','arguments':{'type':'image_url'}})
for event in [{'type':'ready'}, {'type':'delta','text':text}, {'type':'done'}]:
    print(json.dumps(event), flush=True)`, async () => {
        const parameters = { type: "object", properties: { type: { type: "string" } }, required: ["type"] };
        const send = (path: string, payload: unknown) => fetch(new URL(path, url), { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        for (const format of ["chat", "responses", "anthropic"] as const) {
          const path = format === "responses" ? "/v1/responses" : format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
          const tools = format === "responses" ? [{ type: "function", name: "custom", parameters }]
            : format === "anthropic" ? [{ name: "custom", input_schema: parameters }]
            : [{ type: "function", function: { name: "custom", parameters } }];
          const named = format === "responses" ? { type: "function", name: "custom" }
            : format === "anthropic" ? { type: "tool", name: "custom" }
            : { type: "function", function: { name: "custom" } };
          for (const choice of [format === "anthropic" ? { type: "any" } : "required", named]) {
            for (const stream of [false, true]) {
              const base = { model: GEMINI_WEB_MODEL, tools, max_tokens: 100 };
              const payload = { ...base, stream, tool_choice: choice,
                ...(format === "responses" ? { input: "Use custom" } : { messages: [{ role: "user", content: "Use custom" }] }) };
              const response = await send(path, payload);
              assert.equal(response.status, 200, await response.clone().text());
              assert.equal(response.headers.get("X-Rotator-Usage"), "unavailable");
              if (stream) {
                const sse = await response.text();
                assert.doesNotMatch(sse, /ROTATOR_TOOL_/);
                assert.match(sse, format === "responses" ? /response.function_call_arguments.done/ : format === "anthropic" ? /"type":"tool_use"/ : /"tool_calls"/);
                assert.match(sse, format === "responses" ? /response.completed/ : format === "anthropic" ? /message_stop/ : /\[DONE\]/);
              } else {
                const result = await response.json();
                const call = format === "responses" ? result.output.find((item: { type: string }) => item.type === "function_call")
                  : format === "anthropic" ? result.content.find((item: { type: string }) => item.type === "tool_use")
                  : result.choices[0].message.tool_calls[0];
                assert.ok(call);
                assert.equal(format === "chat" ? call.function.name : call.name, "custom");
                assert.deepEqual(format === "anthropic" ? call.input : JSON.parse(format === "chat" ? call.function.arguments : call.arguments), { type: "image_url" });
                const continuation = format === "responses" ? { previous_response_id: result.id,
                  input: [{ type: "function_call_output", call_id: call.call_id, output: "API_ROUND_TRIP_OK" }] }
                  : { messages: [{ role: "user", content: "Use custom" },
                    format === "anthropic" ? { role: "assistant", content: result.content } : result.choices[0].message,
                    format === "anthropic" ? { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "API_ROUND_TRIP_OK" }] }
                      : { role: "tool", tool_call_id: call.id, content: "API_ROUND_TRIP_OK" }] };
                const final = await send(path, { ...base, ...continuation });
                assert.equal(final.status, 200, await final.clone().text());
                const json = await final.json();
                assert.equal(format === "responses" ? json.output_text : format === "anthropic" ? json.content[0].text : json.choices[0].message.content, "API_ROUND_TRIP_OK");
              }
            }
          }
          const disabled = await send(path, { model: GEMINI_WEB_MODEL, tools, max_tokens: 100,
            tool_choice: format === "anthropic" ? { type: "none" } : "none",
            ...(format === "responses" ? { input: "No tools" } : { messages: [{ role: "user", content: "No tools" }] }) });
          assert.equal(disabled.status, 200);
          assert.match(await disabled.text(), /API_ROUND_TRIP_OK/);
        }
      });
      await fakePython(`import json
for event in [{'type':'ready'}, {'type':'delta','text':'No tool call'}, {'type':'done'}]:
    print(json.dumps(event), flush=True)`, async () => {
        for (const stream of [false, true]) {
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: GEMINI_WEB_MODEL, tools: [readTool], tool_choice: "required", stream,
              messages: [{ role: "user", content: "Read fixture" }] }) });
          assert.equal(response.status, 502);
          assert.match(await response.text(), /invalid tool call/);
        }
      });
      const started = join(temp, "http-cancel-started");
      const stopped = join(temp, "http-cancel-stopped");
      await fakePython(`import json,sys,time,signal,pathlib
json.load(sys.stdin)
def stop(*args):
 pathlib.Path(${JSON.stringify(stopped)}).write_text('stopped')
 raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
pathlib.Path(${JSON.stringify(started)}).write_text('started')
print(json.dumps({'type':'ready'}),flush=True)
time.sleep(30)`, async () => {
        for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
          for (const stream of [false, true]) {
            await Promise.all([rm(started, { force: true }), rm(stopped, { force: true })]);
            const beforeFinished = finished;
            const controller = new AbortController();
            const pending = fetch(`http://127.0.0.1:${address.port}${path}`, {
              method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
              body: JSON.stringify({ model: GEMINI_WEB_MODEL, stream, max_tokens: 100,
                tools: path === "/v1/messages" ? [{ name: "read", input_schema: readTool.function.parameters }]
                  : path === "/v1/responses" ? [{ type: "function", ...readTool.function }] : [readTool],
                ...(path === "/v1/responses" ? { input: "Read fixture" }
                  : { messages: [{ role: "user", content: "Read fixture" }] }),
              }),
            });
            // Observe rejection immediately even if setup fails before assert.rejects.
            void pending.catch(() => {});
            try {
              for (let i = 0; i < 200 && !(await readFile(started, "utf8").catch(() => "")); i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(await readFile(started, "utf8"), "started");
              controller.abort();
              await assert.rejects(pending, { name: "AbortError" });
              for (let i = 0; i < 200; i++) {
                if (finished > beforeFinished && await readFile(stopped, "utf8").catch(() => "")) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(await readFile(stopped, "utf8"), "stopped", `${path} stream=${stream}: worker still running`);
              assert.ok(finished > beforeFinished, `${path} stream=${stream}: account not released`);
            } finally {
              controller.abort();
              await pending.catch(() => {});
            }
          }
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
