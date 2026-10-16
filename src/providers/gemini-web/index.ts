import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../../paths.js";
import { getProviderProxyUrl } from "../credential-helpers.js";
import type { ProviderAdapter } from "../adapter.js";
import type { AccountConfig } from "../../types.js";
import { SseEventAccumulator } from "../google-antigravity/forward.js";
import { GEMINI_WEB_CONTEXT, GEMINI_WEB_MODEL, GEMINI_WEB_MODELS, GEMINI_WEB_PROVIDER, getWebThinkingLevel, getCookiesFile, validateCredentials } from "./credentials.js";
import { forwardRequest, runWebWorker } from "./forward.js";
import { applyWebQuota } from "./quota.js";
import { webAccountFromIdentity } from "./identity.js";

async function runLogin(): Promise<AccountConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let path: string;
  let browser: boolean;
  try {
    console.log("Gemini App: sign in through a dedicated Firefox profile, or import an existing session file.");
    const method = (await rl.question("Login method [browser/file] (browser): ")).trim() || "browser";
    if (!["browser", "file"].includes(method)) throw new Error("A valid login method is required");
    browser = method === "browser";
    const directory = join(getConfigDir(), "gemini-web", randomUUID());
    path = browser ? join(directory, "cookies.json") : (await rl.question("Path to cookie JSON: ")).trim();
    if (!path) throw new Error("Cookie file path is required");
  } finally { rl.close(); }
  if (browser) {
    const script = fileURLToPath(new URL("./browser_login.py", import.meta.url));
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON || "python3", [script, "--cookies-file", path,
        "--profile", join(dirname(path), "firefox")], { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? accept() : reject(new Error("Gemini App browser login did not complete")));
    });
  }
  const config: AccountConfig = {
    email: "pending-gemini-identity",
    credentials: [{ provider: GEMINI_WEB_PROVIDER, cookiesFile: resolve(path) }],
  };
  const valid = await validateCredentials(config);
  if (!valid.ok) throw new Error(valid.error);
  const { response } = await runWebWorker({ mode: "probe", cookiesFile: getCookiesFile(config), includeIdentity: true });
  const result = await response.json() as { identity?: unknown };
  if (!response.ok) throw new Error("Gemini Web login failed; reconnect the browser session");
  console.log("This session offers Argon. No generation request was made.");
  return webAccountFromIdentity(result.identity, resolve(path));
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
  shouldRetryOnQuotaExhaustion: () => true,
  async fetchQuota(account, ctx) {
    account.lastQuotaPoll = Date.now();
    account.lastPollByProvider ??= {};
    try {
      const { response } = await runWebWorker({ mode: "probe", cookiesFile: getCookiesFile(account.config),
        proxy: getProviderProxyUrl(account.config, GEMINI_WEB_PROVIDER) }, AbortSignal.timeout(90000));
      if (response.ok) {
        const data: unknown = await response.json();
        applyWebQuota(account, data, ctx);
        return;
      }
      await response.text();
      account.lastPollByProvider[GEMINI_WEB_PROVIDER] = response.status === 401 ? "Reconnect Gemini App: session expired or rejected"
        : response.status === 404 ? "Gemini App connected but Argon unavailable" : `Session check failed (${response.status}); quota unavailable`;
    } catch {
      account.lastPollByProvider[GEMINI_WEB_PROVIDER] = "Session check deferred or service unavailable; quota unavailable";
    }
  },
  forwardRequest,
  createStreamAccumulator: () => new SseEventAccumulator(),
  listModels: () => GEMINI_WEB_MODELS.map((id) => ({ id, contextWindow: GEMINI_WEB_CONTEXT, quotaPool: GEMINI_WEB_PROVIDER, source: "catalog" })),
  ownsModel: (model) => getWebThinkingLevel(model) !== undefined,
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
