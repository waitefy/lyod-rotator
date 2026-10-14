import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { ProviderAdapter } from "../adapter.js";
import type { AccountConfig } from "../../types.js";
import { SseEventAccumulator } from "../google-antigravity/forward.js";
import { GEMINI_WEB_CONTEXT, GEMINI_WEB_MODEL, GEMINI_WEB_PROVIDER, getCookiesFile, validateCredentials } from "./credentials.js";
import { forwardRequest, runWebWorker } from "./forward.js";

async function runLogin(): Promise<AccountConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Gemini Web: limited text chat. Requires Argon in the account's Gemini App.");
    const email = (await rl.question("Account email: ")).trim();
    const path = (await rl.question("Path to cookie JSON (values are never pasted here): ")).trim();
    if (!email || !path) throw new Error("Account email and cookie file are required");
    const config: AccountConfig = {
      email, label: email.split("@")[0],
      credentials: [{ provider: GEMINI_WEB_PROVIDER, cookiesFile: resolve(path) }],
    };
    const valid = await validateCredentials(config);
    if (!valid.ok) throw new Error(valid.error);
    const { response } = await runWebWorker({ mode: "probe", cookiesFile: getCookiesFile(config) });
    const result = await response.text();
    if (!response.ok) throw new Error(`Gemini Web login failed: ${result}`);
    console.log("This session offers Argon. No generation request was made.");
    return config;
  } finally { rl.close(); }
}

export const geminiWebAdapter: ProviderAdapter = {
  id: GEMINI_WEB_PROVIDER,
  displayName: "Gemini App (limited web)",
  credentialKind: "web-session",
  tierRanking: { unknown: 0 },
  features: { circuitBreakers: false, concurrencyLimits: true, proactiveRotation: false },
  runLogin,
  validateCredentials,
  hasValidCredentials: (account) => Boolean(getCookiesFile(account.config)),
  // The worker validates authentication and returns a provider-scoped HTTP error.
  ensureValidToken: async () => undefined,
  // Authentication stays inside the worker; never send cookies as an API bearer.
  getAuthHeader: () => "",
  shouldRetryOnQuotaExhaustion: () => false,
  async fetchQuota(account) {
    // Gemini App exposes no dependable API quota/usage counts. Keep them unknown.
    account.lastQuotaPoll = Date.now();
    account.lastPollByProvider ??= {};
    account.lastPollByProvider[GEMINI_WEB_PROVIDER] = "Web quota unavailable; one request at a time";
  },
  forwardRequest,
  createStreamAccumulator: () => new SseEventAccumulator(),
  listModels: () => [{ id: GEMINI_WEB_MODEL, contextWindow: GEMINI_WEB_CONTEXT, quotaPool: GEMINI_WEB_PROVIDER, source: "catalog" }],
  ownsModel: (model) => model.toLowerCase() === GEMINI_WEB_MODEL,
  getPoolKey: () => GEMINI_WEB_PROVIDER,
  getKickstartModelForPool: () => undefined,
  getBenchmark: () => ({
    body: { project: "", model: GEMINI_WEB_MODEL, request: { contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }] } },
    parseUsage: () => null,
    parseText: (raw) => {
      const accumulator = new SseEventAccumulator();
      accumulator.append(raw);
      accumulator.final();
      return accumulator.getText();
    },
  }),
};
