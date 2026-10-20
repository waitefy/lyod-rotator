import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AccountConfig } from "../../types.js";
import { getCredential } from "../credential-helpers.js";

export const CHATGPT_APP_PROVIDER = "chatgpt-app";
const MODEL_PREFIX = "chatgpt-app-";

/** Explicit operator allowlist, not a claim of account entitlement. */
export function chatGptAppModels(): string[] {
  return [...new Set((process.env.LYOD_CHATGPT_APP_MODELS ?? "").split(",")
    .map((id) => id.trim()).filter((id) => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)))]
    .map((id) => MODEL_PREFIX + id);
}

export function isChatGptAppModel(model: string): boolean {
  return model.startsWith(MODEL_PREFIX);
}

export function upstreamModel(model: string): string {
  if (!chatGptAppModels().includes(model)) throw new Error("ChatGPT App model is not in LYOD_CHATGPT_APP_MODELS");
  return model.slice(MODEL_PREFIX.length);
}

export interface BridgeSession {
  email: string;
  baseUrl: string;
  apiKey: string;
}

export function getSessionFile(config: AccountConfig): string | undefined {
  return getCredential(config, CHATGPT_APP_PROVIDER)?.sessionFile;
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
      typeof data.baseUrl !== "string" || data.baseUrl.length > 2048) throw new Error();
    const url = new URL(data.baseUrl);
    // Plain HTTP is restricted to local sidecars. Use HTTPS for remote bridges.
    if (!(url.protocol === "https:" || (url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) throw new Error();
    return { email: data.email.trim(), apiKey: data.apiKey.trim(), baseUrl: `${url.origin}/v1` };
  } catch {
    throw new Error("ChatGPT App needs a private (0600) session JSON with email, baseUrl (HTTPS or loopback HTTP), and a local bridge apiKey");
  }
}

export async function accountFromSessionFile(path: string): Promise<AccountConfig> {
  const session = await readBridgeSession(path);
  return { email: session.email, credentials: [{ provider: CHATGPT_APP_PROVIDER, sessionFile: path }] };
}
