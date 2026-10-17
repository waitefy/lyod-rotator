import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** Call the separate Images API; chat completions cannot return generated images. */
export async function generateImage(params, ctx, signal) {
  const model = ctx.model;
  if (model?.provider !== "tuxevil-rotator" || !/^gemini-4-argon-web(?:-(?:low|medium|high))?$/.test(model.id)) {
    throw new Error("Select a Gemini Web Argon model from tuxevil-rotator first.");
  }
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("An image prompt is required.");
  const name = params.filename ?? `argon-${randomUUID()}`;
  if (typeof name !== "string" || !name || name === "." || name === ".." || basename(name) !== name || /[\\\x00-\x1f]/.test(name)) {
    throw new Error("filename must be a file name in the current directory.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error("Cannot resolve rotator credentials; check Pi provider settings.");
  const endpoint = new URL(`${(auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "")}/images/generations`);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("The Images API requires HTTPS or a local HTTP endpoint.");
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries({ ...model.headers, ...auth.headers })) {
    if (value !== null) headers.set(key, value);
  }
  if (auth.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${auth.apiKey}`);
  headers.set("content-type", "application/json");
  const combinedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(480_000)]);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers, redirect: "error", signal: combinedSignal,
      body: JSON.stringify({ model: model.id, prompt: params.prompt, n: 1, response_format: "b64_json" }),
    });
  } catch {
    combinedSignal.throwIfAborted();
    throw new Error("Cannot reach the rotator Images API.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Never include raw upstream bodies, signed image addresses or credentials.
    throw new Error(`Rotator Images API returned HTTP ${response.status}; no image was saved. No automatic retry was made.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The Images API returned an empty response.");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("The Images API response exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The Images API returned invalid JSON."); }
  const encoded = result?.data?.[0]?.b64_json;
  if (!Array.isArray(result?.data) || result.data.length !== 1 || typeof encoded !== "string" || !encoded || encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
    throw new Error("The Images API did not return one supported image.");
  }
  const bytes = Buffer.from(encoded, "base64");
  const format = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "png"
    : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : undefined;
  if (!format || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded) throw new Error("The Images API returned invalid image data.");
  combinedSignal.throwIfAborted();
  const path = join(ctx.cwd, `${name.replace(/\.(?:png|jpe?g|webp)$/i, "")}.${format === "jpeg" ? "jpg" : format}`);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("The output file already exists; choose another filename. No existing file was changed.");
    throw new Error("The generated image could not be saved in the current directory.");
  }
  return {
    content: [{ type: "text", text: `Generated image saved to ${path}` }, { type: "image", data: encoded, mimeType: `image/${format}` }],
    details: { path, bytes: bytes.length, mimeType: `image/${format}` },
  };
}

export default function registerGeminiImages(pi) {
  pi.registerTool({
    name: "generate_image", label: "Generate image",
    description: "Generate a real image through Gemini Web Argon, save it in the current directory, and display it. Text-to-image only; existing files are never overwritten.",
    promptSnippet: "Generate an image, save it in the current directory, and display it",
    promptGuidelines: ["For image creation requests, use generate_image instead of searching model documentation or writing drawing code. Report generation errors honestly; do not claim an image was created after a failed call."],
    parameters: {
      type: "object", properties: {
        prompt: { type: "string", description: "Describe the image to generate." },
        filename: { type: "string", description: "Optional output file name, without directories. The actual image extension is added automatically." },
      }, required: ["prompt"], additionalProperties: false,
    },
    async execute(_id, params, signal, _onUpdate, ctx) { return generateImage(params, ctx, signal); },
  });
}
