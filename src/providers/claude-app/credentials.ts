import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AccountConfig } from "../../types.js";
import { getCredential } from "../credential-helpers.js";

export const CLAUDE_APP_PROVIDER = "claude-app";
const MODEL_PREFIX = "claude-app-";

/** Explicit operator allowlist, not a claim of account entitlement. */
export function claudeAppModels(): string[] {
  return [...new Set((process.env.LYOD_CLAUDE_APP_MODELS ?? "auto").split(",")
    .map((id) => id.trim()).filter((id) => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)))]
    .map((id) => MODEL_PREFIX + id);
}

export function isClaudeAppModel(model: string): boolean {
  return model.startsWith(MODEL_PREFIX);
}

export function upstreamModel(model: string): string {
  if (!claudeAppModels().includes(model)) throw new Error("Claude App model is not in LYOD_CLAUDE_APP_MODELS");
  return model.slice(MODEL_PREFIX.length);
}

export interface BridgeSession {
  email: string;
  baseUrl: string;
  apiKey: string;
  adminApiKey?: string;
  modelSelection: "explicit" | "default-only";
}

export function getSessionFile(config: AccountConfig): string | undefined {
  return getCredential(config, CLAUDE_APP_PROVIDER)?.sessionFile;
}

/** Secrets stay in a private file; never propagate JSON parser/network errors. */
export async function readBridgeSession(path: string | undefined): Promise<BridgeSession> {
  try {
    if (!path || !isAbsolute(path) || path.length > 4096) throw new Error();
    const file = await open(path, "r");
    let value: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error();
      value = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    const data = value as BridgeSession;
    if (!data || typeof data.email !== "string" || !data.email.trim() || data.email.length > 254 ||
      typeof data.apiKey !== "string" || !data.apiKey.trim() || data.apiKey.length > 4096 || /[\r\n]/.test(data.apiKey) ||
      typeof data.baseUrl !== "string" || data.baseUrl.length > 2048 ||
      !["explicit", "default-only"].includes(data.modelSelection)) throw new Error();
    if (data.adminApiKey !== undefined && (typeof data.adminApiKey !== "string" ||
      !data.adminApiKey.trim() || data.adminApiKey.length > 4096 || /[\r\n]/.test(data.adminApiKey))) throw new Error();
    const url = new URL(data.baseUrl);
    // Plain HTTP is restricted to local sidecars. Use HTTPS for remote bridges.
    if (!(url.protocol === "https:" || (url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) throw new Error();
    return { modelSelection: data.modelSelection, email: data.email.trim(), apiKey: data.apiKey.trim(),
      ...(data.adminApiKey ? { adminApiKey: data.adminApiKey.trim() } : {}), baseUrl: `${url.origin}/v1` };
  } catch {
    throw new Error("Claude App needs a private (0600) session JSON with email, baseUrl (HTTPS or loopback HTTP), a local bridge apiKey and modelSelection (explicit or default-only)");
  }
}

export async function accountFromSessionFile(path: string): Promise<AccountConfig> {
  const session = await readBridgeSession(path);
  return { email: session.email, credentials: [{ provider: CLAUDE_APP_PROVIDER, sessionFile: path }] };
}
