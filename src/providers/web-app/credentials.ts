import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AccountConfig } from "../../types.js";
import { getCredential } from "../credential-helpers.js";

export const WEB_APP_PROVIDERS = ["qwen-app", "deepseek-app"] as const;
export type WebAppProvider = typeof WEB_APP_PROVIDERS[number];
export interface WebAppModel {
  id: string;
  name: string;
  thinking: boolean;
  search: boolean;
  // Keep unsupported image/video/research entries in the descriptor, not the chat catalog.
  chat: boolean;
}
export interface WebAppSession {
  provider: WebAppProvider;
  email: string;
  accountId: string;
  baseUrl: string;
  apiKey: string;
  availableModels: WebAppModel[];
}
export function webAppProvider(model: string): WebAppProvider | undefined {
  return WEB_APP_PROVIDERS.find((id) => model.startsWith(`${id}-`));
}
export function getSessionFile(config: AccountConfig, provider: WebAppProvider): string | undefined {
  return getCredential(config, provider)?.sessionFile;
}
export function parseModels(value: unknown): WebAppModel[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("Invalid web model catalog");
  const seen = new Set<string>();
  return value.map((entry) => {
    const model = entry as WebAppModel;
    if (!model || typeof model.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.id) ||
      seen.has(model.id) || typeof model.name !== "string" || model.name.length > 256 ||
      [model.thinking, model.search, model.chat].some((flag) => typeof flag !== "boolean")) {
      throw new Error("Invalid web model catalog");
    }
    seen.add(model.id);
    return { id: model.id, name: model.name, thinking: model.thinking, search: model.search, chat: model.chat };
  });
}
export function readSession(path: string | undefined, provider: WebAppProvider): WebAppSession {
  try {
    if (!path || !isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 262144 || (stat.mode & 0o077) !== 0) throw new Error();
    const data = JSON.parse(readFileSync(path, "utf8")) as WebAppSession;
    if (data.provider !== provider || typeof data.email !== "string" || !data.email.trim() || data.email.length > 254 ||
      typeof data.accountId !== "string" || !data.accountId.trim() || data.accountId.length > 256 ||
      typeof data.apiKey !== "string" || !data.apiKey.trim() || data.apiKey.length > 4096 || /[\r\n]/.test(data.apiKey)) throw new Error();
    const url = new URL(data.baseUrl);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) throw new Error();
    return { provider, email: data.email.trim(), accountId: data.accountId, apiKey: data.apiKey.trim(),
      baseUrl: `${url.origin}/v1`, availableModels: parseModels(data.availableModels) };
  } catch { throw new Error(`${provider} requires a private session descriptor with verified identity and model catalog`); }
}
// Runtime catalogs expire closed: failed refreshes never preserve a fabricated/default list.
const catalogs = new Map<string, { at: number; models: WebAppModel[] }>();
export function setCatalog(session: WebAppSession, models: WebAppModel[]): void {
  catalogs.set(`${session.provider}:${session.accountId}`, { at: Date.now(), models });
}
export function accountModels(config: AccountConfig, provider: WebAppProvider): WebAppModel[] {
  try {
    const session = readSession(getSessionFile(config, provider), provider);
    if (session.email.toLowerCase() !== config.email.toLowerCase()) return [];
    const cached = catalogs.get(`${provider}:${session.accountId}`);
    return cached ? (Date.now() - cached.at < 600_000 ? cached.models : []) : session.availableModels;
  } catch { return []; }
}
export function listedModels(accounts: readonly AccountConfig[], provider: WebAppProvider): WebAppModel[] {
  return [...new Map(accounts.flatMap((account) => accountModels(account, provider))
    .filter((model) => model.chat).map((model) => [model.id, model])).values()];
}
export async function accountFromSessionFile(path: string, provider: WebAppProvider): Promise<AccountConfig> {
  const session = readSession(path, provider);
  const response = await fetch(`${session.baseUrl}/models`, { headers: { Authorization: `Bearer ${session.apiKey}` },
    signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${provider} bridge rejected verification`); }
  const catalog = await response.json() as { accountId?: string; data?: unknown };
  if (catalog.accountId !== session.accountId) throw new Error(`${provider} bridge identity mismatch`);
  setCatalog(session, parseModels(catalog.data));
  return { email: session.email, credentials: [{ provider, sessionFile: path }] };
}
