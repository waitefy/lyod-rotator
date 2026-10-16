import { isRecord } from "../../compat/schema-sanitizer.js";
import { GEMINI_WEB_MAX_PROMPT_BYTES, getWebThinkingLevel } from "./credentials.js";

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_EVENT_BYTES = 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) + 4096;
export interface GeneratedWebImage { mimeType: string; data: string }
export type WebImageMode = "image" | "image-or-text";

/** Responses built-in tool subset. Do not silently discard image options. */
export function webResponsesImageMode(value: unknown): WebImageMode | "text" | undefined {
  if (!isRecord(value) || !Array.isArray(value.tools) ||
      !value.tools.some((tool) => isRecord(tool) && tool.type === "image_generation")) return undefined;
  const tool = value.tools[0];
  if (value.tools.length !== 1 || !isRecord(tool) || tool.type !== "image_generation" ||
      Object.keys(tool).some((key) => key !== "type")) {
    throw new Error("Gemini Web supports one image_generation tool without options; combining it with function tools is unavailable");
  }
  const choice = value.tool_choice;
  if (value.store !== false) throw new Error("Gemini Web image responses require store=false; resend images explicitly as input_image for follow-up requests");
  if (choice === "none") return "text";
  const forced = choice === "required" || (isRecord(choice) && choice.type === "image_generation" && Object.keys(choice).length === 1);
  if (!forced && choice !== undefined && choice !== "auto") throw new Error("Invalid Gemini Web image tool choice");
  return forced ? "image" : "image-or-text";
}

/** Gemini output modalities are opt-in, independent of uploaded input images. */
export function webGeminiImageMode(request: unknown): WebImageMode | undefined {
  if (!isRecord(request) || !isRecord(request.generationConfig)) return undefined;
  const config = request.generationConfig;
  if (config.responseModalities === undefined) return undefined;
  const modes = config.responseModalities;
  if (!Array.isArray(modes) || !modes.length || new Set(modes).size !== modes.length ||
      modes.some((mode) => mode !== "TEXT" && mode !== "IMAGE")) throw new Error("Gemini Web output modalities support TEXT and IMAGE only");
  if (!modes.includes("IMAGE")) return undefined;
  if (config.imageConfig !== undefined || (Array.isArray(request.tools) && request.tools.length)) {
    throw new Error("Gemini Web image output does not support imageConfig or function tools");
  }
  return modes.includes("TEXT") ? "image-or-text" : "image";
}

/** Private worker output is checked independently before entering the public API. */
export function validateGeneratedWebImage(value: unknown): GeneratedWebImage {
  if (!isRecord(value) || typeof value.data !== "string" || !value.data.length ||
      value.data.length > 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) ||
      value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw new Error("Invalid Gemini Web image data");
  }
  const raw = Buffer.from(value.data, "base64");
  const mime = raw.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
    : raw.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "image/jpeg"
    : raw.subarray(0, 4).toString() === "RIFF" && raw.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
  if (!mime || value.mimeType !== mime || raw.length > MAX_GENERATED_IMAGE_BYTES || raw.toString("base64") !== value.data) {
    throw new Error("Invalid Gemini Web image format or size");
  }
  return { mimeType: mime, data: value.data };
}

export function validateWebImageRequest(value: unknown): { model: string; prompt: string } {
  if (!isRecord(value) || typeof value.model !== "string" || getWebThinkingLevel(value.model) === undefined) {
    throw new Error("Image generation requires an explicit Gemini Web Argon model id");
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim() || Buffer.byteLength(value.prompt) > GEMINI_WEB_MAX_PROMPT_BYTES - 256) {
    throw new Error("Image generation requires a nonempty prompt within the Gemini Web text limit");
  }
  if ((value.n !== undefined && value.n !== 1) ||
      (value.response_format !== undefined && value.response_format !== "b64_json")) {
    throw new Error("Gemini Web image generation supports n=1 and response_format=b64_json only");
  }
  const allowed = new Set(["model", "prompt", "n", "response_format", "user"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || (value.user !== undefined && typeof value.user !== "string")) {
    throw new Error("Unsupported image generation parameter; size, quality, style, output_format and streaming are unavailable");
  }
  return { model: value.model, prompt: value.prompt };
}
