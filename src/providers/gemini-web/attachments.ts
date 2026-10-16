import { isRecord } from "../../compat/schema-sanitizer.js";

// Adapter limits, independent of Gemini App's changing upload limits.
export const WEB_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const WEB_MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const WEB_MAX_ATTACHMENTS = 8;
export const WEB_ATTACHMENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf", "text/plain", "text/csv",
]);
export interface WebAttachment { mimeType: string; data: string }

export function validateWebAttachment(value: unknown, imageOnly = false): WebAttachment {
  if (!isRecord(value) || typeof value.mimeType !== "string" || typeof value.data !== "string") {
    throw new Error("Gemini Web attachments require a MIME type and base64 data");
  }
  const { mimeType, data } = value;
  if (!WEB_ATTACHMENT_TYPES.has(mimeType) || (imageOnly && !mimeType.startsWith("image/"))) {
    throw new Error("Unsupported Gemini Web attachment MIME type");
  }
  if (!data.length || data.length > 4 * Math.ceil(WEB_MAX_ATTACHMENT_BYTES / 3)) {
    throw new Error(`Gemini Web attachments must contain 1 to ${WEB_MAX_ATTACHMENT_BYTES} bytes each`);
  }
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
      Buffer.from(data, "base64").toString("base64") !== data) {
    throw new Error("Invalid Gemini Web attachment base64 data");
  }
  if (Buffer.byteLength(data, "base64") > WEB_MAX_ATTACHMENT_BYTES) {
    throw new Error(`Gemini Web attachments are limited to ${WEB_MAX_ATTACHMENT_BYTES} bytes each`);
  }
  return { mimeType, data };
}

/** Recognize only inline API content blocks. Never fetch URLs or read client paths. */
export function apiWebAttachment(part: Record<string, unknown>): WebAttachment | undefined {
  const type = part.type;
  if (!["image_url", "input_image", "image", "document", "file", "input_file"].includes(String(type))) return;
  const imageOnly = type === "image_url" || type === "input_image" || type === "image";
  if (type === "image" || type === "document") {
    if (!isRecord(part.source) || part.source.type !== "base64") {
      throw new Error("Gemini Web attachments require an inline base64 source; URLs and file IDs are unavailable");
    }
    return validateWebAttachment({ mimeType: part.source.media_type, data: part.source.data }, imageOnly);
  }
  const url = type === "image_url" ? (isRecord(part.image_url) ? part.image_url.url : undefined)
    : type === "input_image" ? part.image_url
      : type === "file" ? (isRecord(part.file) ? part.file.file_data : undefined) : part.file_data;
  const match = typeof url === "string" ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
  if (!match) throw new Error("Gemini Web attachments require a base64 data URL; external URLs and file IDs are unavailable");
  return validateWebAttachment({ mimeType: match[1], data: match[2] }, imageOnly);
}

export function checkWebAttachmentTotals(attachments: WebAttachment[]): void {
  if (attachments.length > WEB_MAX_ATTACHMENTS ||
      attachments.reduce((sum, file) => sum + Buffer.byteLength(file.data, "base64"), 0) > WEB_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Gemini Web accepts at most ${WEB_MAX_ATTACHMENTS} attachments and ${WEB_MAX_TOTAL_ATTACHMENT_BYTES} total bytes`);
  }
}
