import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { ProviderAdapter } from "../adapter.js";
import { fetchWithHeadersTimeout } from "../../fetch-with-retry.js";
import { OpenCodeZenSseAccumulator } from "../opencode-zen/forward.js";
import { accountFromSessionFile, accountModels, getSessionFile, listedModels, parseModels, readSession,
  setCatalog, type WebAppProvider } from "./credentials.js";

export function createWebAppAdapter(provider: WebAppProvider): ProviderAdapter {
  const error = (status: number, message: string, headers?: Headers) => ({ endpoint: provider,
    response: Response.json({ error: { message, code: `${provider.replaceAll("-", "_")}_error` } }, { status, headers }) });
  return {
    id: provider, displayName: provider === "qwen-app" ? "Qwen App" : "DeepSeek App", credentialKind: "web-session",
    tierRanking: { unknown: 0 }, features: { circuitBreakers: false, concurrencyLimits: true, proactiveRotation: false },
    async runLogin() {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await accountFromSessionFile(resolve((await rl.question("Private bridge session file: ")).trim()), provider); }
      finally { rl.close(); }
    },
    async validateCredentials(config) {
      try { await accountFromSessionFile(getSessionFile(config, provider) ?? "", provider); return { ok: true }; }
      catch { return { ok: false, status: 0, error: `${provider} session or bridge unavailable` }; }
    },
    hasValidCredentials: (account) => Boolean(getSessionFile(account.config, provider)),
    canServeModel: (account, key) => accountModels(account.config, provider)
      .some((model) => model.chat && `${provider}:${provider}-${model.id}` === key),
    ensureValidToken: async () => undefined, getAuthHeader: () => "", shouldRetryOnQuotaExhaustion: () => true,
    async fetchQuota(account) {
      account.lastQuotaPoll = Date.now();
      account.lastPollByProvider ??= {};
      account.lastPollByProvider[provider] = "Usage quota unavailable";
      let session;
      try {
        session = readSession(getSessionFile(account.config, provider), provider);
        if (session.email.toLowerCase() !== account.config.email.toLowerCase()) throw new Error();
        const response = await fetch(`${session.baseUrl}/models`, { headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(15_000), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw new Error(); }
        const data = await response.json() as { accountId?: string; data?: unknown };
        if (data.accountId !== session.accountId) throw new Error();
        setCatalog(session, parseModels(data.data));
      } catch {
        if (session) setCatalog(session, []);
        account.lastPollByProvider[provider] = "Bridge unavailable; model availability could not be refreshed";
      }
    },
    async forwardRequest(account, body, _headers, signal) {
      let session;
      try {
        session = readSession(getSessionFile(account.config, provider), provider);
        if (session.email.toLowerCase() !== account.config.email.toLowerCase()) throw new Error();
      } catch { return error(401, `${provider} private session unavailable`); }
      const model = accountModels(account.config, provider).find((entry) => entry.chat && `${provider}-${entry.id}` === body.model);
      if (!model) return error(404, "Selected model is not offered by this account; no fallback was used");
      const request = body.request as Record<string, unknown>;
      if (!request || !Array.isArray(request.messages)) return error(400, "Chat Completions messages are required");
      const effort = request.reasoning_effort;
      if (effort !== undefined && effort !== "none" && effort !== "high") return error(400, "Web thinking supports off/none and on/high only");
      if (request.thinking !== undefined && typeof request.thinking !== "boolean") return error(400, "thinking must be boolean");
      const thinking = request.thinking ?? effort === "high";
      if (typeof thinking !== "boolean" || (effort !== undefined && thinking !== (effort === "high"))) return error(400, "Conflicting thinking options");
      if (thinking && !model.thinking) return error(400, "Thinking is not available for this model");
      if (request.search !== undefined && typeof request.search !== "boolean") return error(400, "search must be boolean");
      if (request.search && !model.search) return error(400, "Search is not available for this model");
      // File/vision inputs remain disabled until verified against the account's actual upload route.
      if (request.files || request.messages.some((message: { content?: unknown }) => Array.isArray(message.content) &&
        message.content.some((part: { type?: string }) => part.type !== "text"))) return error(400, "Attachments are not enabled for this provider yet");
      try {
        const response = await fetchWithHeadersTimeout(`${session.baseUrl}/chat/completions`, {
          method: "POST", redirect: "error", timeoutMs: 600_000, signal,
          headers: { Authorization: `Bearer ${session.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, model: model.id, thinking, search: request.search ?? false }),
        });
        if (!response.ok) {
          const headers = new Headers();
          const retry = response.headers.get("retry-after");
          if (retry && /^\d{1,8}$/.test(retry)) headers.set("retry-after", retry);
          await response.body?.cancel();
          return error(response.status, `${provider} bridge rejected request (${response.status})`, headers);
        }
        return { endpoint: provider, response };
      } catch {
        if (signal?.aborted) throw signal.reason;
        return error(502, `${provider} bridge unavailable or header deadline exceeded`);
      }
    },
    createStreamAccumulator: () => new OpenCodeZenSseAccumulator(),
    listModels: (context) => listedModels(context.accounts ?? [], provider).map((model) => ({
      id: `${provider}-${model.id}`, contextWindow: null, quotaPool: `${provider}:${provider}-${model.id}`, source: "discovered" })),
    ownsModel: (model) => model.startsWith(`${provider}-`), getPoolKey: (model) => `${provider}:${model}`,
    getKickstartModelForPool: () => undefined,
    getBenchmark(account) {
      const model = accountModels(account.config, provider).find((entry) => entry.chat);
      if (!model) throw new Error(`${provider} has no discovered chat model`);
      return { body: { project: "", model: `${provider}-${model.id}`, request: {
        messages: [{ role: "user", content: "Reply with OK." }], stream: false } },
      parseUsage: () => null, parseText: (raw) => {
        try { return String(JSON.parse(raw).choices?.[0]?.message?.content ?? ""); } catch { return ""; }
      } };
    },
  };
}
export const qwenAppAdapter = createWebAppAdapter("qwen-app");
export const deepseekAppAdapter = createWebAppAdapter("deepseek-app");
