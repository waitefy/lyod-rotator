import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
    const abort = new globalThis.AbortController();
    abort.abort();
    await assert.rejects(generateImage({ prompt: "island" }, ctx, abort.signal), { name: "AbortError" });
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(ctx.cwd), []);
  });
});

test("uploads the actual reference image through Responses and saves the result separately", async () => {
  await fixture(async ({ ctx, calls, reply }) => {
    const source = join(ctx.cwd, "night.png");
    await writeFile(source, png);
    reply(200, { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: png.toString("base64"), output_format: "png" }] });
    const result = await generateImage({ prompt: "Make this scene daytime", reference_image: "night.png", filename: "day" }, ctx);
    assert.deepEqual(calls, [{ url: "/v1/responses", authorization: "Bearer private-test-token", body: {
      model: ctx.model.id, store: false, stream: false, tools: [{ type: "image_generation" }], tool_choice: "required",
      input: [{ role: "user", content: [{ type: "input_text", text: "Make this scene daytime" },
        { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }] }],
    } }]);
    assert.deepEqual(await readFile(source), png);
    assert.deepEqual(await readFile(result.details.path), png);
    assert.equal(result.details.path, join(ctx.cwd, "day.png"));
    await assert.rejects(generateImage({ prompt: "day", reference_image: source, filename: "night" }, ctx), /already exists/);
    assert.deepEqual(await readFile(source), png);
  });
});

test("rejects unreadable, non-image, non-file and oversized references before contacting the API", async () => {
  await fixture(async ({ ctx, calls }) => {
    await writeFile(join(ctx.cwd, "text.png"), "not an image");
    await writeFile(join(ctx.cwd, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    for (const reference_image of ["missing.png", "text.png", "huge.png", ".", "", null, 1]) {
      await assert.rejects(generateImage({ prompt: "day", reference_image }, ctx), /reference|Reference/);
    }
    assert.equal(calls.length, 0);
  });
});

test("rejects missing, incomplete, duplicate or incorrectly labelled Responses images", async () => {
  await fixture(async ({ ctx, reply }) => {
    await writeFile(join(ctx.cwd, "source.png"), png);
    const image = { type: "image_generation_call", status: "completed", result: png.toString("base64"), output_format: "png" };
    for (const body of [{}, { data: [{ b64_json: png.toString("base64") }] },
      { status: "in_progress", output: [image] }, { status: "completed", output: [{ ...image, status: "in_progress" }] },
      { status: "completed", output: [image, image] }, { status: "completed", output: [{ ...image, output_format: "jpeg" }] }]) {
      reply(200, body);
      await assert.rejects(generateImage({ prompt: "day", reference_image: "source.png", filename: "day" }, ctx), /image/i);
      assert.deepEqual(await readdir(ctx.cwd), ["source.png"]);
    }
  });
});
