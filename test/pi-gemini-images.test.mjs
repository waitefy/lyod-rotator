import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register, { generateImage } from "../plugins/pi-gemini-images.js";

const png = Buffer.from("89504e470d0a1a0a0001", "hex");
async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-images-"));
  const calls = [];
  let status = 200;
  let body = { data: [{ b64_json: png.toString("base64") }] };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ url: request.url, body: JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ctx = {
    cwd, model: { id: "gemini-4-argon-web-low", provider: "tuxevil-rotator", baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
    modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "private-test-token" }; } },
  };
  try { await run({ ctx, calls, reply(code, value) { status = code; body = value; } }); }
  finally { await new Promise((resolve) => server.close(resolve)); await rm(cwd, { recursive: true, force: true }); }
}

test("registers a discoverable image tool with the current Pi execute signature", async () => {
  let tool;
  register({ registerTool(value) { tool = value; } });
  assert.equal(tool.name, "generate_image");
  assert.ok(tool.promptSnippet);
  await fixture(async ({ ctx }) => {
    const output = await tool.execute("call1", { prompt: "island", filename: "island" }, undefined, undefined, ctx);
    assert.equal(output.content[1].mimeType, "image/png");
  });
});

test("uses Images API, preserves the chosen Argon level, saves exact bytes and returns an image block", async () => {
  await fixture(async ({ ctx, calls }) => {
    ctx.model.id = "gemini-4-argon-web-medium";
    const output = await generateImage({ prompt: "cozy island", filename: "island.jpg" }, ctx);
    assert.deepEqual(calls, [{ url: "/v1/images/generations", body: { model: ctx.model.id, prompt: "cozy island", n: 1, response_format: "b64_json" }, authorization: "Bearer private-test-token" }]);
    assert.deepEqual(await readFile(join(ctx.cwd, "island.png")), png);
    assert.deepEqual(output.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });
});

test("does not overwrite files or accept paths outside the current directory", async () => {
  await fixture(async ({ ctx, calls }) => {
    for (const filename of ["../outside", "/tmp/outside", "a\\b", ".", "..", "a\n"]) {
      await assert.rejects(generateImage({ prompt: "island", filename }, ctx), /file name/);
    }
    assert.equal(calls.length, 0);
    await writeFile(join(ctx.cwd, "island.png"), "keep");
    await assert.rejects(generateImage({ prompt: "island", filename: "island" }, ctx), /already exists/);
    assert.equal(await readFile(join(ctx.cwd, "island.png"), "utf8"), "keep");
  });
});

test("fails without retrying or exposing upstream response bodies", async () => {
  await fixture(async ({ ctx, calls, reply }) => {
    reply(502, { error: { message: "secret-cookie-and-signed-url" } });
    await assert.rejects(generateImage({ prompt: "island" }, ctx), (error) => {
      assert.match(error.message, /HTTP 502/);
      assert.doesNotMatch(error.message, /secret-cookie/);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(await readdir(ctx.cwd), []);
  });
});

test("rejects missing images, invalid base64, wrong formats and oversized responses without saving", async () => {
  await fixture(async ({ ctx, reply }) => {
    for (const body of [{}, { data: [{ b64_json: "aHRtbA==" }] }, { data: [{ b64_json: png.toString("base64") + "\n" }] }, { data: [{ b64_json: "A".repeat(12 * 1024 * 1024 + 1) }] }]) {
      reply(200, body);
      await assert.rejects(generateImage({ prompt: "island" }, ctx), /image|size limit/);
      assert.deepEqual(await readdir(ctx.cwd), []);
    }
  });
});

test("honors cancellation and rejects other providers before making requests", async () => {
  await fixture(async ({ ctx, calls }) => {
    ctx.model.provider = "other-provider";
    await assert.rejects(generateImage({ prompt: "island" }, ctx), /Select a Gemini/);
    ctx.model.provider = "tuxevil-rotator";
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(generateImage({ prompt: "island" }, ctx, abort.signal), { name: "AbortError" });
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(ctx.cwd), []);
  });
});
