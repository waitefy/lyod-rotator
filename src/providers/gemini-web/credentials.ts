import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AccountConfig } from "../../types.js";
import type { CredentialValidationResult } from "../adapter.js";
import { getCredential } from "../credential-helpers.js";

export const GEMINI_WEB_PROVIDER = "gemini-web";
export const GEMINI_WEB_MODEL = "gemini-4-argon-web";
export const GEMINI_WEB_MODELS = ["low", "medium", "high"].map((level) => `${GEMINI_WEB_MODEL}-${level}`);

export function getWebThinkingLevel(model: string): "low" | "medium" | "high" | undefined {
  const id = model.toLowerCase();
  if (id === GEMINI_WEB_MODEL || id === `${GEMINI_WEB_MODEL}-low`) return "low";
  if (id === `${GEMINI_WEB_MODEL}-medium`) return "medium";
  if (id === `${GEMINI_WEB_MODEL}-high`) return "high";
  return undefined;
}
// Gemini App on AI Pro: a one-million-token window, shared with the output.
export const GEMINI_WEB_CONTEXT = 1_000_000;
// Reserve ample UTF-8 space for history and tool framing; mirror in worker.py.
export const GEMINI_WEB_MAX_PROMPT_BYTES = 16 * 1024 * 1024;

export function getCookiesFile(config: AccountConfig): string | undefined {
  return getCredential(config, GEMINI_WEB_PROVIDER)?.cookiesFile;
}

export async function validateCredentials(config: AccountConfig): Promise<CredentialValidationResult> {
  const path = getCookiesFile(config);
  if (!path || !isAbsolute(path)) {
    return { ok: false, status: 401, error: "Gemini Web requires an absolute cookiesFile path" };
  }
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error("oversized");
    const cookies: unknown = JSON.parse(raw);
    if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)) throw new Error("invalid");
    const value = cookies as Record<string, unknown>;
    if (typeof value["__Secure-1PSID"] !== "string" || !value["__Secure-1PSID"].trim()) throw new Error("missing");
    if (value["__Secure-1PSIDTS"] !== undefined && typeof value["__Secure-1PSIDTS"] !== "string") throw new Error("invalid");
    return { ok: true };
  } catch {
    // Never include file contents, browser cookies or Python exception details.
    return { ok: false, status: 401, error: "Cannot read Gemini Web cookie JSON; reconnect the web session" };
  }
}
