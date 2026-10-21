import { toBridgeRequest, fromBridgeResponse } from "./wire.js";
import { prepareRequest, translateResponse } from "./tools.js";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { webAppContextWindow } from "../web-app/context.js";
import type { ProviderAdapter } from "../adapter.js";
import type { AccountConfig } from "../../types.js";
import { fetchClaudeMessage } from "./request.js";
import { OpenCodeZenSseAccumulator } from "../opencode-zen/forward.js";
import { accountFromSessionFile, CLAUDE_APP_PROVIDER, claudeAppModels, getSessionFile,
  isClaudeAppModel, readBridgeSession, upstreamModel } from "./credentials.js";
import type { BridgeSession } from "./credentials.js";

/** ClewdR turns exhausted cookies into 500/504; verify pool state before mapping. */
async function exhaustedRetryAfter(session: BridgeSession, signal?: AbortSignal): Promise<string | undefined> {
  if (!session.adminApiKey) return undefined;
  try {
    const response = await fetch(`${new URL(session.baseUrl).origin}/api/cookies?refresh=true`, {
      headers: { Authorization: `Bearer ${session.adminApiKey}` }, redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    // This private endpoint contains cookies. Inspect only pool sizes/reset time;
    // never forward its response or include it in an error message.
    const state = await response.json();
    if (!Array.isArray(state.valid) || state.valid.length || !Array.isArray(state.invalid) || state.invalid.length ||
      !Array.isArray(state.exhausted) || state.exhausted.length !== 1) return undefined;
    const reset = state.exhausted[0]?.reset_time;
    if (typeof reset !== "number" || !Number.isFinite(reset)) return undefined;
    const seconds = Math.ceil(reset - Date.now() / 1000);
    return seconds > 0 ? String(seconds) : undefined;
  } catch { return undefined; }
}

export async function validateCredentials(config: AccountConfig) {
  try {
    await readBridgeSession(getSessionFile(config));
    return { ok: true } as const;
  } catch {
    return { ok: false, status: 0, error: "Claude App bridge session file is missing or invalid" } as const;
  }
}

export const claudeAppAdapter: ProviderAdapter = {
  id: CLAUDE_APP_PROVIDER,
  displayName: "Claude App",
  credentialKind: "web-session",
  tierRanking: { unknown: 0 },
  features: { circuitBreakers: false, concurrencyLimits: true, proactiveRotation: false },
  async runLogin() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const path = (await rl.question("Path to private Claude App bridge session JSON: ")).trim();
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
    account.lastPollByProvider[CLAUDE_APP_PROVIDER] = "Usage quota unavailable; bridge connectivity and account entitlement are not verified by the static model catalog";
  },
  async forwardRequest(account, body, _originalHeaders, signal) {
    let session;
    try {
      session = await readBridgeSession(getSessionFile(account.config));
      if (session.email.toLowerCase() !== account.config.email.toLowerCase()) throw new Error();
    }
    catch {
      return { endpoint: "claude-app", response: Response.json({ error: { message: "Claude App bridge session unavailable" } }, { status: 401 }) };
    }
    let model: string;
    try { model = upstreamModel(body.model); }
    catch {
      return { endpoint: "claude-app", response: Response.json({ error: { message: "Claude App model is not enabled" } }, { status: 400 }) };
    }
    if (session.modelSelection === "default-only" && model !== "auto") {
      return { endpoint: "claude-app", response: Response.json({ error: { message:
        "This Claude App account supports Auto only; explicit model selection is unavailable" } }, { status: 403 }) };
    }
    const capability = session.availableModels?.find((entry) => entry.id === model);
    if (model !== "auto" && (session.availableModels || model === "claude-sonnet-5-5") && !capability) {
      return { endpoint: "claude-app", response: Response.json({ error: { message: "Selected Claude model is unavailable for this account" } }, { status: 403 }) };
    }
    const request = body.request as Record<string, unknown>;
    if (!request || !Array.isArray(request.messages)) {
      return { endpoint: "claude-app", response: Response.json({ error: { message: "Claude App requires a Chat Completions request" } }, { status: 400 }) };
    }
    const effort = request.reasoning_effort ?? (model === "claude-sonnet-5-5" ? "medium" : undefined);
    if (effort !== undefined && (!capability || !capability.efforts.includes(String(effort)))) {
      return { endpoint: "claude-app", response: Response.json({ error: { message: "Selected Claude effort is unavailable for this account and model" } }, { status: 400 }) };
    }
    let prepared;
    try { prepared = prepareRequest(request); }
    catch (error) {
      return { endpoint: "claude-app", response: Response.json({ error: { message:
        error instanceof Error ? error.message : "Unsupported Claude App request" } }, { status: 400 }) };
    }
    const endpoint = `${session.baseUrl}/messages`;
    try {
      const response = await fetchClaudeMessage(endpoint, {
        method: "POST", redirect: "error", signal, timeoutMs: 600_000,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.apiKey}`,
          Accept: request.stream === true ? "text/event-stream" : "application/json" },
        body: JSON.stringify(toBridgeRequest({ ...prepared.request,
          ...(effort !== undefined ? { reasoning_effort: effort } : {}),
          model: model === "auto" ? "default" : model })),
      });
      // Upstream errors may echo authentication/session data. Keep status and
      // retry-after only, never forward an arbitrary sidecar error body.
      if (!response.ok) {
        await response.body?.cancel();
        const headers = new Headers();
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) headers.set("retry-after", retryAfter);
        const exhausted = [500, 504].includes(response.status) ? await exhaustedRetryAfter(session, signal) : undefined;
        if (signal?.aborted) throw signal.reason;
        if (exhausted) headers.set("retry-after", exhausted);
        return { endpoint: "claude-app", response: Response.json({ error: {
          message: exhausted ? "Claude App account temporarily unavailable until its bridge reset time"
            : `Claude App bridge rejected request (${response.status})`, code: "claude_app_error",
        } }, { status: exhausted ? 429 : response.status, headers }) };
      }
      return { endpoint: "claude-app", response: await translateResponse(await fromBridgeResponse(response, model, request.stream === true), prepared.bridge, model, request.stream === true) };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { endpoint: "claude-app", response: Response.json({ error: {
        message: "Claude App bridge unavailable or header deadline exceeded", code: "claude_app_error",
      } }, { status: 502 }) };
    }
  },
  createStreamAccumulator: () => new OpenCodeZenSseAccumulator(),
  listModels: () => claudeAppModels().map((id) => ({ id, contextWindow: webAppContextWindow(id),
    quotaPool: CLAUDE_APP_PROVIDER, source: "catalog" })),
  ownsModel: isClaudeAppModel,
  getPoolKey: () => CLAUDE_APP_PROVIDER,
  getKickstartModelForPool: () => undefined,
  getBenchmark() {
    const model = claudeAppModels()[0];
    if (!model) throw new Error("Configure LYOD_CLAUDE_APP_MODELS before benchmarking Claude App");
    return { body: { project: "", model, request: {
      messages: [{ role: "user", content: "Reply with OK." }], stream: false,
    } }, parseUsage: () => null, parseText: (raw) => {
      try { return String(JSON.parse(raw).choices?.[0]?.message?.content ?? ""); }
      catch { return ""; }
    } };
  },
};
