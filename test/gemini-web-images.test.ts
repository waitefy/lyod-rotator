import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, before, it } from "node:test";
import { initDb } from "../src/db-store.js";
import { handleOpenAIImageGenerations, handleOpenAIResponsesCreate, handleGeminiGenerateContent, parseAntigravitySse } from "../src/compat.js";
import { runWebWorker } from "../src/providers/gemini-web/forward.js";
import { MAX_GENERATED_IMAGE_BYTES, validateGeneratedWebImage, validateWebImageRequest, webResponsesImageMode, webGeminiImageMode } from "../src/providers/gemini-web/image-output.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

const model = "gemini-4-argon-web-low";
const image = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=" };
const temp = await mkdtemp(join(tmpdir(), "gemini-web-images-"));
before(async () => { process.env.TUXEVIL_ROTATOR_DIR ||= temp; await initDb(); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

async function fakePython(events: unknown[], run: () => Promise<void>, output = "image"): Promise<void> {
  const path = join(temp, "fake-python");
  await writeFile(path, `#!/usr/bin/env python3\nimport json,sys\nrequest=json.load(sys.stdin)\nassert request.get('output', 'text') == ${JSON.stringify(output)}\nfor event in json.loads(${JSON.stringify(JSON.stringify(events))}):\n print(json.dumps(event),flush=True)\n`, { mode: 0o700 });
  const previous = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
  process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = path;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON;
    else process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON = previous;
  }
}

it("validates the image API subset without silently ignoring unsupported options", () => {
  for (const suffix of ["low", "medium", "high"]) {
    assert.equal(validateWebImageRequest({ model: `gemini-4-argon-web-${suffix}`, prompt: "Кот", n: 1, response_format: "b64_json" }).prompt, "Кот");
  }
  for (const request of [{ model: "auto", prompt: "x" }, { model, prompt: " " }, { model, prompt: "x", n: 2 },
    { model, prompt: "x", response_format: "url" }, { model, prompt: "x", stream: true },
    { model, prompt: "x", size: "1024x1024" }, { model, prompt: "x", quality: "high" }]) {
    assert.throws(() => validateWebImageRequest(request));
  }
});

it("validates native image modalities and the Responses image tool before translation", () => {
  const request = { tools: [{ type: "image_generation" }], store: false };
  assert.equal(webResponsesImageMode(request), "image-or-text");
  assert.equal(webResponsesImageMode({ ...request, tool_choice: { type: "image_generation" } }), "image");
  assert.equal(webResponsesImageMode({ ...request, tool_choice: "required" }), "image");
  assert.equal(webResponsesImageMode({ ...request, tool_choice: "none" }), "text");
  for (const bad of [{ ...request, store: true }, { ...request, store: undefined },
    { ...request, tools: [{ type: "image_generation", quality: "high" }] },
    { ...request, tools: [...request.tools, { type: "function", name: "read" }] },
    { ...request, tool_choice: { type: "image_generation", extra: true } }]) assert.throws(() => webResponsesImageMode(bad));
  assert.equal(webGeminiImageMode({ generationConfig: { responseModalities: ["IMAGE"] } }), "image");
  assert.equal(webGeminiImageMode({ generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }), "image-or-text");
  assert.equal(webGeminiImageMode({ generationConfig: { responseModalities: ["TEXT"] } }), undefined);
  for (const modes of [[], ["AUDIO"], ["IMAGE", "IMAGE"], "IMAGE"]) {
    assert.throws(() => webGeminiImageMode({ generationConfig: { responseModalities: modes } }));
  }
  assert.throws(() => webGeminiImageMode({ generationConfig: { responseModalities: ["IMAGE"], imageConfig: {} } }));
});

it("validates actual PNG/JPEG/WebP bytes, canonical base64 and the decoded size limit", () => {
  assert.deepEqual(validateGeneratedWebImage(image), image);
  for (const raw of [Buffer.from("ffd8ff0012", "hex"), Buffer.from("RIFF0000WEBPdata")]) {
    const mimeType = raw[0] === 255 ? "image/jpeg" : "image/webp";
    assert.equal(validateGeneratedWebImage({ mimeType, data: raw.toString("base64") }).mimeType, mimeType);
  }
  for (const value of [{ ...image, mimeType: "image/jpeg" }, { ...image, data: image.data + "\n" },
    { mimeType: "image/png", data: Buffer.from("<html>login</html>").toString("base64") },
    { ...image, data: "" }, { ...image, data: "Zh==" }]) assert.throws(() => validateGeneratedWebImage(value));
  const raw = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES);
  Buffer.from(image.data, "base64").copy(raw);
  assert.equal(validateGeneratedWebImage({ ...image, data: raw.toString("base64") }).mimeType, image.mimeType);
  assert.throws(() => validateGeneratedWebImage({ ...image, data: Buffer.concat([raw, Buffer.from([0])]).toString("base64") }));
});

it("buffers image output until done and rejects missing, duplicate, invalid or failed downloads", async () => {
  const valid = [{ type: "ready" }, { type: "image", ...image }, { type: "done" }];
  await fakePython(valid, async () => {
    const { response } = await runWebWorker({ output: "image" });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.deepEqual(parseAntigravitySse(sse, { includeImages: true }).images, [image]);
    assert.equal(parseAntigravitySse(sse).images, undefined);
    assert.doesNotMatch(sse, /googleusercontent/);
  });
  for (const events of [[valid[0], valid[2]], [valid[0], valid[1], valid[1], valid[2]],
    [valid[0], { type: "image", mimeType: "image/png", data: "aHRtbA==" }, valid[2]],
    [valid[0], valid[1], { type: "error", status: 502, message: "Image download failed" }],
    [valid[0], valid[1]], [valid[0], valid[1], { type: "done", truncated: true }]]) {
    await fakePython(events, async () => {
      const { response } = await runWebWorker({ output: "image" });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      assert.doesNotMatch(await response.text(), /b64_json|inlineData|googleusercontent/);
    });
  }
});

it("serves Images API through authenticated routing, enforces switches and releases the account", async () => {
  const cookiesFile = join(temp, "cookies.json");
  await writeFile(cookiesFile, '{"__Secure-1PSID":"fixture"}', { mode: 0o600 });
  const account = { config: { email: "image-fixture@local", credentials: [{ provider: "gemini-web", cookiesFile }] },
    inFlightRequests: 0, inFlightByModel: {}, disabled: false, flagged: false } as AccountRuntime;
  let disabled = false, admitted = 0, finished = 0;
  const rotator = {
    getConfig: () => ({ disabledModels: disabled ? [`gemini-web/${model}`] : [] }),
    hasActiveProvider: (id: string) => id === "gemini-web", getActiveAccount: async () => { admitted++; return account; },
    getRetryAfterMs: () => 0, resolveQuotaModelKeyForDisplay: () => "gemini-web", getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0, recordUpstreamAttempt: () => {}, finishRequest: () => { finished++; },
    recordRequest: () => false, recordProxyEvent: () => {}, recordLatency: () => {}, recordRequestLog: () => {},
    recordTokenUsage: () => assert.fail("web usage is unknown"), saveState: () => {},
    markError: () => assert.fail("successful image request must not mark an account as failed"),
  } as unknown as AccountRotator;
  const server = createServer((req, res) => {
    void handleOpenAIImageGenerations(req, res, rotator).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/images/generations`;
  const request = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await fakePython([{ type: "ready" }, { type: "image", ...image }, { type: "done" }], async () => {
      const response = await request({ model, prompt: "Draw a green cat", n: 1, response_format: "b64_json" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Rotator-Usage"), "unavailable");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const json = await response.json();
      assert.equal(typeof json.created, "number");
      assert.equal(json.output_format, "png");
      assert.deepEqual(json.data, [{ b64_json: image.data }]);
      assert.equal(json.usage, undefined);
      assert.equal(admitted, 1);
      assert.equal(finished, 1);
      disabled = true;
      const off = await request({ model, prompt: "Draw" });
      assert.equal(off.status, 404);
      await off.text();
      assert.equal(admitted, 1);
      const bad = await request({ model, prompt: "Draw", n: 2 });
      assert.equal(bad.status, 400);
      await bad.text();
      assert.equal(admitted, 1);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

it("serves Responses and Gemini images as JSON/SSE, with optional text, stable ids and no partial successes", async () => {
  const cookiesFile = join(temp, "multimodal-cookies.json");
  await writeFile(cookiesFile, '{"__Secure-1PSID":"fixture"}', { mode: 0o600 });
  const account = { config: { email: "multimodal-fixture@local", credentials: [{ provider: "gemini-web", cookiesFile }] },
    inFlightRequests: 0, inFlightByModel: {}, disabled: false, flagged: false } as AccountRuntime;
  let admitted = 0, finished = 0, disabled = false;
  const rotator = {
    getConfig: () => ({ disabledModels: disabled ? [`gemini-web/${model}`] : [] }),
    hasActiveProvider: (id: string) => id === "gemini-web", getActiveAccount: async () => { admitted++; return account; },
    getRetryAfterMs: () => 0, resolveQuotaModelKeyForDisplay: () => "gemini-web", getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0, recordUpstreamAttempt: () => {}, finishRequest: () => { finished++; },
    recordRequest: () => false, recordProxyEvent: () => {}, recordLatency: () => {}, recordRequestLog: () => {},
    recordTokenUsage: () => assert.fail("web usage is unknown"), saveState: () => {}, markError: () => {},
  } as unknown as AccountRotator;
  const server = createServer((req, res) => {
    const handler = req.url?.startsWith("/v1beta/") ? handleGeminiGenerateContent : handleOpenAIResponsesCreate;
    void handler(req, res, rotator).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const send = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const responses = { model, input: "Draw a cat", tools: [{ type: "image_generation" }], store: false };
  const imageEvents = [{ type: "ready" }, { type: "delta", text: "discarded image caption" }, { type: "image", ...image }, { type: "done" }];
  try {
    for (const output of ["image", "image-or-text"]) for (const stream of [false, true]) {
      await fakePython(imageEvents, async () => {
        const response = await send("/v1/responses", { ...responses, stream, ...(output === "image" ? { tool_choice: { type: "image_generation" } } : {}) });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get("X-Rotator-Usage"), "unavailable");
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        const raw = await response.text();
        assert.doesNotMatch(raw, /discarded image caption|googleusercontent|partial_image/);
        const events = stream ? raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))) : [];
        const json = stream ? events.at(-1).response : JSON.parse(raw);
        assert.equal(json.usage, null);
        assert.equal(json.store, false);
        assert.equal(json.output.length, 1);
        assert.equal(json.output[0].type, "image_generation_call");
        assert.equal(json.output[0].result, image.data);
        assert.equal(json.output[0].output_format, "png");
        assert.equal(json.output[0].status, "completed");
        if (stream) {
          assert.equal(events[0].type, "response.created");
          assert.equal(events.at(-1).type, "response.completed");
          assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, i) => i));
          assert.deepEqual(events.find((event) => event.type === "response.output_item.done").item, json.output[0]);
          assert.equal(events.find((event) => event.type === "response.output_item.added").item.result, null);
          assert.equal(events.find((event) => event.type === "response.image_generation_call.completed").item_id, json.output[0].id);
        }
        const native = await send(`/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`, {
          contents: [{ role: "user", parts: [{ text: "Draw a cat" }] }],
          generationConfig: { responseModalities: output === "image" ? ["IMAGE"] : ["TEXT", "IMAGE"] },
        });
        assert.equal(native.status, 200);
        assert.equal(native.headers.get("Cache-Control"), "no-store");
        const nativeRaw = await native.text();
        const nativeJson = JSON.parse(stream ? nativeRaw.slice(6).trim() : nativeRaw);
        assert.deepEqual(nativeJson.candidates[0].content.parts, [{ inlineData: image }]);
        assert.equal(nativeJson.usageMetadata, undefined);
      }, output);
    }
    for (const stream of [false, true]) for (const output of ["image-or-text", "text"]) {
      await fakePython([{ type: "ready" }, { type: "delta", text: "A text answer" }, { type: "done" }], async () => {
        const response = await send("/v1/responses", { ...responses, stream, ...(output === "text" ? { tool_choice: "none" } : {}) });
        assert.equal(response.status, 200);
        const raw = await response.text();
        assert.match(raw, /A text answer/);
        assert.doesNotMatch(raw, /image_generation_call/);
      }, output);
    }
    for (const events of [[{ type: "ready" }, { type: "done" }],
      [imageEvents[0], imageEvents[2], { type: "error", status: 502, message: "Image download failed" }]]) {
      await fakePython(events, async () => {
        const response = await send("/v1/responses", { ...responses, stream: true, tool_choice: "required" });
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("Content-Type"), "application/json");
        assert.doesNotMatch(await response.text(), /response.completed|iVBORw/);
      });
    }
    await fakePython(imageEvents, async () => {
      const response = await send("/v1/responses", { ...responses, model: "gemini-4-argon-web", tool_choice: "required" });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).output[0].result, image.data);
    });
    const beforeInvalid = admitted;
    for (const invalid of [{ ...responses, store: true }, { ...responses, tools: [{ type: "image_generation", size: "1024x1024" }] },
      { ...responses, tools: [...responses.tools, { type: "function", name: "read", parameters: { type: "object" } }] }]) {
      const response = await send("/v1/responses", invalid);
      assert.equal(response.status, 400);
      await response.text();
    }
    const invalidNative = await send(`/v1beta/models/${model}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "Draw" }] }], generationConfig: { responseModalities: ["AUDIO"] },
    });
    assert.equal(invalidNative.status, 400);
    await invalidNative.text();
    disabled = true;
    assert.equal((await send("/v1/responses", responses)).status, 404);
    assert.equal(admitted, beforeInvalid);
    assert.equal(finished, admitted);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
