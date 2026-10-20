import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { ProviderAdapter } from "../adapter.js";
import type { AccountConfig } from "../../types.js";
import { fetchWithHeadersTimeout } from "../../fetch-with-retry.js";
import { OpenCodeZenSseAccumulator } from "../opencode-zen/forward.js";
import { accountFromSessionFile, CHATGPT_APP_PROVIDER, chatGptAppModels, getSessionFile,
  isChatGptAppModel, readBridgeSession, upstreamModel } from "./credentials.js";

export async function validateCredentials(config: AccountConfig) {
  try {
    await readBridgeSession(getSessionFile(config));
    return { ok: true } as const;
  } catch {
    return { ok: false, status: 0, error: "ChatGPT App bridge session file is missing or invalid" } as const;
  }
}

export const chatGptAppAdapter: ProviderAdapter = {
  id: CHATGPT_APP_PROVIDER,
  displayName: "ChatGPT App",
  credentialKind: "web-session",
  tierRanking: { unknown: 0 },
  features: { circuitBreakers: false, concurrencyLimits: true, proactiveRotation: false },
  async runLogin() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const path = (await rl.question("Path to private ChatGPT App bridge session JSON: ")).trim();
      if (!path) throw new Error("Session file path is required");
      return await accountFromSessionFile(resolve(path));
    } finally { rl.close(); }
  },
  validateCredentials,
  hasValidCredentials: (account) => Boolean(getSessionFile(account.config)),
  ensureValidToken: async () => undefined,
  // Web access tokens belong to the sidecar, not the rotator's OAuth lifecycle.
  getAuthHeader: () => "",
  shouldRetryOnQuotaExhaustion: () => true,
  async fetchQuota(account) {
    account.lastQuotaPoll = Date.now();
    account.lastPollByProvider ??= {};
    account.lastPollByProvider[CHATGPT_APP_PROVIDER] = "Usage quota unavailable; bridge connectivity and account entitlement are not verified by the static model catalog";
  },
  async forwardRequest(account, body, _originalHeaders, signal) {
    let session;
    try {
      session = await readBridgeSession(getSessionFile(account.config));
      if (session.email.toLowerCase() !== account.config.email.toLowerCase()) throw new Error();
    }
    catch {
      return { endpoint: "chatgpt-app", response: Response.json({ error: { message: "ChatGPT App bridge session unavailable" } }, { status: 401 }) };
    }
    let model: string;
    try { model = upstreamModel(body.model); }
    catch {
      return { endpoint: "chatgpt-app", response: Response.json({ error: { message: "ChatGPT App model is not enabled" } }, { status: 400 }) };
    }
    const request = body.request as Record<string, unknown>;
    if (!request || !Array.isArray(request.messages)) {
      return { endpoint: "chatgpt-app", response: Response.json({ error: { message: "ChatGPT App requires a Chat Completions request" } }, { status: 400 }) };
    }
    const endpoint = `${session.baseUrl}/chat/completions`;
    try {
      const response = await fetchWithHeadersTimeout(endpoint, {
        method: "POST", redirect: "error", signal, timeoutMs: 600_000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.apiKey}`,
          Accept: request.stream === true ? "text/event-stream" : "application/json" },
        body: JSON.stringify({ ...request, model }),
      });
      // Upstream errors may echo authentication/session data. Keep status and
      // retry-after only, never forward an arbitrary sidecar error body.
      if (!response.ok) {
        await response.body?.cancel();
        const headers = new Headers();
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) headers.set("retry-after", retryAfter);
        return { endpoint: "chatgpt-app", response: Response.json({ error: {
          message: `ChatGPT App bridge rejected request (${response.status})`, code: "chatgpt_app_error",
        } }, { status: response.status, headers }) };
      }
      return { endpoint: "chatgpt-app", response };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { endpoint: "chatgpt-app", response: Response.json({ error: {
        message: "ChatGPT App bridge unavailable or header deadline exceeded", code: "chatgpt_app_error",
      } }, { status: 502 }) };
    }
  },
  createStreamAccumulator: () => new OpenCodeZenSseAccumulator(),
  listModels: () => chatGptAppModels().map((id) => ({ id, contextWindow: null,
    quotaPool: CHATGPT_APP_PROVIDER, source: "catalog" })),
  ownsModel: isChatGptAppModel,
  getPoolKey: () => CHATGPT_APP_PROVIDER,
  getKickstartModelForPool: () => undefined,
  getBenchmark() {
    const model = chatGptAppModels()[0];
    if (!model) throw new Error("Configure LYOD_CHATGPT_APP_MODELS before benchmarking ChatGPT App");
    return { body: { project: "", model, request: {
      messages: [{ role: "user", content: "Reply with OK." }], stream: false,
    } }, parseUsage: () => null, parseText: (raw) => {
      try { return String(JSON.parse(raw).choices?.[0]?.message?.content ?? ""); }
      catch { return ""; }
    } };
  },
};
