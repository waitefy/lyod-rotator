import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolBridge, toolDeclarations } from "../src/providers/gemini-web/tool-bridge.js";
import { buildWebPrompt, webCapabilityError } from "../src/providers/gemini-web/forward.js";
import { openAIToAntigravityBody, anthropicToAntigravityBody, normalizeOpenAIResponsesRequest, convertResponsesToChatRequest } from "../src/providers/google-antigravity/translators.js";
import { GEMINI_WEB_MODEL } from "../src/providers/gemini-web/credentials.js";

function parser(parameters: Record<string, unknown>, name = "mcp__project__update") {
  const bridge = createToolBridge([{ name, parameters }]);
  const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
  return (args: unknown) => bridge.parse(marker + JSON.stringify({ name, arguments: args }));
}

describe("client-defined Gemini Web tools", () => {
  it("enforces required and named tool choices without changing native Gemini defaults", () => {
    const declarations = [{ name: "first" }, { name: "second" }];
    const required = createToolBridge(declarations, { mode: "ANY" });
    assert.throws(() => required.parse("I am done"), /required/i);
    const named = createToolBridge(declarations, { mode: "ANY", allowedFunctionNames: ["second"] });
    const marker = named.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    assert.throws(() => named.parse(marker + JSON.stringify({ name: "first", arguments: {} })));
    assert.deepEqual(named.parse(marker + JSON.stringify({ name: "second", arguments: {} })), { functionCall: { name: "second", args: {} } });
    const request = { model: GEMINI_WEB_MODEL, messages: [{ role: "user" as const, content: "test" }],
      tools: declarations.map((tool) => ({ type: "function" as const, function: tool })), tool_choice: "required" };
    assert.equal(webCapabilityError(request), undefined);
    const body = openAIToAntigravityBody(request);
    assert.deepEqual((body.request as Record<string, unknown>).toolConfig, { functionCallingConfig: { mode: "ANY" } });
    assert.doesNotThrow(() => buildWebPrompt(body));
    assert.deepEqual((openAIToAntigravityBody({ ...request, model: "gemini-2.5-flash" }).request as Record<string, unknown>).toolConfig,
      { functionCallingConfig: { mode: "AUTO" } });
    assert.ok(webCapabilityError({ ...request, tool_choice: { type: "function", function: { name: "missing" } } }));
  });

  it("accepts Responses and Anthropic tool envelopes and choices before translation", () => {
    const parameters = { type: "object", properties: { type: { type: "string" } } };
    const responses = { model: GEMINI_WEB_MODEL, input: "test", tools: [{ type: "function", name: "custom", parameters }],
      tool_choice: { type: "function", name: "custom" } };
    assert.equal(webCapabilityError(responses, "responses"), undefined);
    const normalized = normalizeOpenAIResponsesRequest(responses);
    const converted = convertResponsesToChatRequest(normalized as Parameters<typeof convertResponsesToChatRequest>[0]);
    const body = openAIToAntigravityBody(converted.chatRequest);
    assert.deepEqual((body.request as Record<string, unknown>).toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["custom"] } });
    assert.doesNotThrow(() => buildWebPrompt(body));
    const anthropic = { model: GEMINI_WEB_MODEL, max_tokens: 100, messages: [{ role: "user" as const, content: "test" }],
      tools: [{ name: "custom", input_schema: parameters }], tool_choice: { type: "any" } };
    assert.equal(webCapabilityError(anthropic, "anthropic"), undefined);
    assert.deepEqual((anthropicToAntigravityBody(anthropic).request as Record<string, unknown>).toolConfig, { functionCallingConfig: { mode: "ANY" } });
    assert.deepEqual((anthropicToAntigravityBody({ ...anthropic, tool_choice: { type: "none" } }).request as Record<string, unknown>).toolConfig,
      { functionCallingConfig: { mode: "NONE" } });
    for (const format of ["responses", "anthropic"] as const) {
      const base = format === "responses" ? responses : anthropic;
      assert.ok(webCapabilityError({ ...base, tools: [{ type: "web_search" }] }, format));
      assert.ok(webCapabilityError({ ...base, tools: [format === "responses" ? { type: "function", name: "custom", parameters: null }
        : { name: "custom", input_schema: null }] }, format));
    }
  });

  it("checks tool history as protocol while treating arguments as opaque data", () => {
    const parameters = { type: "object" };
    const responses = { tools: [{ type: "function", name: "custom", parameters }], input: [
      { type: "function_call", call_id: "c1", name: "custom", arguments: '{"type":"input_image"}' },
      { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "error: missing file" }] },
    ] };
    assert.equal(webCapabilityError(responses, "responses"), undefined);
    assert.ok(webCapabilityError({ ...responses, input: [{ type: "function_call", name: "other", call_id: "c1", arguments: "{}" }] }, "responses"));
    const anthropic = { tools: [{ name: "custom", input_schema: parameters }], messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "custom", input: { type: "image", image_url: "ordinary argument" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: [{ type: "text", text: "missing file" }] }] },
    ] };
    assert.equal(webCapabilityError(anthropic, "anthropic"), undefined);
    const history = anthropicToAntigravityBody({ ...anthropic, model: GEMINI_WEB_MODEL, max_tokens: 100 } as Parameters<typeof anthropicToAntigravityBody>[0]);
    assert.match(buildWebPrompt(history), /Client tool error \(action failed\):\\nmissing file/);
    for (const [format, base, content] of [
      ["responses", responses, { input: [{ type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "https://example.test/a.png" }] }] }],
      ["anthropic", anthropic, { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "image", source: {} }] }] }] }],
    ] as const) assert.ok(webCapabilityError({ ...base, ...content }, format));
  });

  it("accepts auto and none without declarations but rejects required calls without tools", () => {
    for (const tool_choice of ["auto", "none"]) {
      const request = { model: GEMINI_WEB_MODEL, messages: [{ role: "user" as const, content: "hello" }], tool_choice };
      assert.equal(webCapabilityError(request), undefined);
      assert.doesNotThrow(() => buildWebPrompt(openAIToAntigravityBody(request)));
    }
    assert.ok(webCapabilityError({ tool_choice: "required" }));
    for (const config of [{ mode: "ANY" }, { mode: "ANY", allowedFunctionNames: ["missing"] },
      { mode: "ANY", allowedFunctionNames: [] }, { mode: "AUTO", allowedFunctionNames: ["custom"] }]) {
      const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, messages: [{ role: "user", content: "hello" }] });
      body.request = { ...(body.request as Record<string, unknown>), toolConfig: { functionCallingConfig: config } };
      assert.throws(() => buildWebPrompt(body));
    }
  });

  it("preserves tool names and call IDs when rendering client results for the web model", () => {
    const body = openAIToAntigravityBody({ model: GEMINI_WEB_MODEL, tools: [{ type: "function", function: { name: "probe_echo" } }], messages: [
      { role: "user", content: "Call the probe once, then return its result" },
      { role: "assistant", content: null, tool_calls: [{ id: "probe_123", type: "function", function: { name: "probe_echo", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "probe_123", content: "FRESH_RESULT" },
    ] });
    const prompt = buildWebPrompt(body);
    const call = JSON.parse(prompt.match(/Client tool call \(data\): (.*)/)![1]);
    const result = JSON.parse(prompt.match(/Client tool result \(data\): (.*)/)![1]);
    assert.equal(call.id, "probe_123");
    assert.equal(result.id, call.id);
    assert.equal(result.name, call.name);
    assert.equal(result.response.output, "FRESH_RESULT");
  });

  it("accepts an arbitrary name and preserves nested schemas through the API translator", () => {
    const parameters = {
      type: "object", additionalProperties: false,
      properties: {
        operations: { type: "array", minItems: 1, maxItems: 3, items: {
          type: "object", additionalProperties: false,
          properties: { file: { type: "string", minLength: 1 }, delta: { type: ["integer", "null"], minimum: -5, maximum: 5 } },
          required: ["file", "delta"],
        } },
      }, required: ["operations"],
    };
    const request = { model: GEMINI_WEB_MODEL, messages: [{ role: "user" as const, content: "Update" }],
      tools: [{ type: "function" as const, function: { name: "mcp__project__update", parameters } }] };
    assert.equal(webCapabilityError(request), undefined);
    const body = openAIToAntigravityBody(request);
    const declarations = toolDeclarations(body.request as Record<string, unknown>);
    assert.deepEqual(declarations[0].parameters, parameters);
    assert.doesNotThrow(() => buildWebPrompt(body));
    const parse = parser(parameters);
    const args = { operations: [{ file: "a.py", delta: -2 }, { file: "b.py", delta: null }] };
    assert.deepEqual(parse(args), { functionCall: { name: "mcp__project__update", args } });
    for (const invalid of [
      { operations: [] }, { operations: [{ file: "a" }] },
      { operations: [{ file: "", delta: 0 }] }, { operations: [{ file: "a", delta: 6 }] },
      { operations: [{ file: "a", delta: 0.5 }] }, { operations: [{ file: "a", delta: 1, extra: true }] },
      { operations: [{ file: "a", delta: 1 }], extra: true },
    ]) assert.throws(() => parse(invalid), /arguments/);
  });

  it("uses the declared schema even for names formerly reserved for OMP", () => {
    const parse = parser({ type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"] }, "bash");
    assert.deepEqual(parse({ argv: ["python", "test.py"] }), { functionCall: { name: "bash", args: { argv: ["python", "test.py"] } } });
    const bridge = createToolBridge([{ name: "read_file", parameters: { type: "object" } }]);
    assert.doesNotMatch(bridge.instruction, /Use bash|Use cwd|snapshot tag|async and pty/);
  });

  it("supports empty and omitted parameter schemas and JSON Schema additionalProperties defaults", () => {
    const declarations = toolDeclarations({ tools: [{ functionDeclarations: [{ name: "ping" }] }] });
    assert.equal(declarations.length, 1);
    assert.doesNotThrow(() => createToolBridge(declarations));
    const parse = parser({ type: "object" });
    assert.doesNotThrow(() => parse({ arbitrary: { nested: [1, null, false] } }));
    assert.throws(() => parse([]));
    assert.doesNotThrow(() => parser({ type: "object", additionalProperties: { type: "integer" } })({ a: -1 }));
    assert.throws(() => parser({ type: "object", additionalProperties: { type: "integer" } })({ a: "1" }));
  });

  it("checks unions, constants and structural enums without changing their meaning", () => {
    const parse = parser({ type: "object", properties: {
      target: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      mode: { const: "apply" },
      config: { enum: [{ a: 1, b: [true] }] },
    }, required: ["target", "mode", "config"], additionalProperties: false });
    assert.doesNotThrow(() => parse({ target: null, mode: "apply", config: { b: [true], a: 1 } }));
    for (const args of [{ target: "", mode: "apply", config: { a: 1, b: [true] } },
      { target: "a", mode: "delete", config: { a: 1, b: [true] } },
      { target: "a", mode: "apply", config: { a: 1, b: [false] } }]) assert.throws(() => parse(args));
    const exactlyOne = parser({ type: "object", properties: { n: { oneOf: [{ type: "integer" }, { type: "number" }] } } });
    assert.throws(() => exactlyOne({ n: 1 }));
    assert.doesNotThrow(() => exactlyOne({ n: 1.5 }));
    const all = parser({ type: "object", properties: { n: { allOf: [{ type: "number", minimum: -2 }, { maximum: 2 }] } } });
    assert.doesNotThrow(() => all({ n: -1 }));
    assert.throws(() => all({ n: 3 }));
  });

  it("honours explicit nullability, booleans and object properties named like schema keywords", () => {
    const parse = parser({ type: "object", properties: {
      type: { type: "string" }, properties: { type: "boolean" },
      result: { type: "string", nullable: true, enum: [null, "ok"] },
      denied: false, allowed: true,
    } });
    assert.doesNotThrow(() => parse({ type: "file", properties: false, result: null, allowed: [1] }));
    assert.throws(() => parse({ denied: null }));
    assert.throws(() => parse({ result: "other" }));
  });

  it("rejects unsupported or malformed schemas with an actionable error before generation", () => {
    for (const schema of [
      { type: "object", properties: { x: { $ref: "#/$defs/X" } } },
      { type: "object", patternProperties: { ".*": { type: "string" } } },
      { type: "object", properties: { x: { type: "string", pattern: "a+" } } },
      { type: "object", properties: { x: { type: "unknown" } } },
      { type: "object", required: "x" }, { type: "object", properties: { x: { minimum: "1" } } },
      { type: "object", properties: { x: { anyOf: [] } } },
      { type: "object", properties: { x: { items: [{ type: "string" }] } } },
      { type: "object", properties: { x: { type: [] } } },
      { type: "object", properties: { x: { maxItems: -1 } } },
      { type: "object", properties: { x: { enum: [] } } },
      { type: "object", properties: { x: { nullable: "true" } } },
      { type: "object", required: ["x", "x"] },
    ]) {
      const tool = { name: "custom", parameters: schema };
      assert.throws(() => toolDeclarations({ tools: [{ functionDeclarations: [tool] }] }), /schema/i);
      assert.match(webCapabilityError({ tools: [{ type: "function", function: tool }] }) ?? "", /schema/i);
    }
  });

  it("enforces numeric, Unicode string, collection and object bounds", () => {
    const parse = parser({ type: "object", minProperties: 1, maxProperties: 1, properties: {
      text: { type: "string", minLength: 1, maxLength: 1 },
      n: { type: "number", exclusiveMinimum: -1, exclusiveMaximum: 1 },
      values: { type: "array", maxItems: 1, items: { type: "boolean" } },
    }, additionalProperties: false });
    for (const value of [{ text: "🌍" }, { n: -0.5 }, { values: [false] }]) assert.doesNotThrow(() => parse(value));
    for (const value of [{}, { text: "" }, { text: "🌍a" }, { n: -1 }, { n: 1 },
      { text: "a", n: 0 }, { values: [true, false] }, { values: [0] }]) assert.throws(() => parse(value));
  });

  it("treats prototype-related property names as ordinary JSON keys", () => {
    const parse = parser(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}'));
    assert.doesNotThrow(() => parse(JSON.parse('{"__proto__":"data"}')));
    assert.throws(() => parse({ constructor: "data" }));
    assert.throws(() => parse(JSON.parse('{"__proto__":1}')));
  });

  it("rejects invalid names, non-object parameters and malformed or undeclared calls", () => {
    for (const tool of [{ name: " " }, { name: "bad name" }, { name: "custom", parameters: null },
      { name: "custom", parameters: { type: "array" } }, { name: "custom", description: 1 }]) {
      assert.throws(() => toolDeclarations({ tools: [{ functionDeclarations: [tool] }] }));
    }
    const bridge = createToolBridge([{ name: "custom", parameters: {} }]);
    const marker = bridge.instruction.match(/ROTATOR_TOOL_[a-f0-9-]+/)![0];
    for (const call of [{ name: "other", arguments: {} }, { name: "custom", arguments: [] },
      { name: "custom", arguments: {}, extra: true }]) assert.throws(() => bridge.parse(marker + JSON.stringify(call)));
    assert.deepEqual(bridge.parse('Example: {"name":"custom","arguments":{}}'), { text: 'Example: {"name":"custom","arguments":{}}' });
  });

  it("does not sanitize schemas for Argon while retaining the normal Gemini conversion", () => {
    const parameters = { type: "object", properties: { n: { type: ["number", "string"], minimum: -2, maximum: 2 } } };
    const request = { model: GEMINI_WEB_MODEL, messages: [{ role: "user" as const, content: "test" }],
      tools: [{ type: "function" as const, function: { name: "custom", parameters } }] };
    const web = openAIToAntigravityBody(request).request as Record<string, unknown>;
    assert.deepEqual(toolDeclarations(web)[0].parameters, parameters);
    const native = openAIToAntigravityBody({ ...request, model: "gemini-2.5-flash" }).request as { tools: { functionDeclarations: { parameters: unknown }[] }[] };
    assert.notDeepEqual(native.tools[0].functionDeclarations[0].parameters, parameters);
  });

  it("rejects duplicate declarations and limits schema nesting", () => {
    const declaration = { name: "custom", parameters: { type: "object" } };
    assert.throws(() => toolDeclarations({ tools: [{ functionDeclarations: [declaration, declaration] }] }), /duplicate/i);
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 80; i++) schema = { type: "object", properties: { child: schema } };
    assert.throws(() => createToolBridge([{ name: "custom", parameters: schema }]), /schema/i);
  });
});
