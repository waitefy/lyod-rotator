import type { AccountRuntime, ModelQuota } from "../../types.js";
import type { QuotaFetchContext } from "../adapter.js";
import { GEMINI_WEB_PROVIDER } from "./credentials.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Both compute windows constrain every Argon level. Keep sibling pools intact. */
export function applyWebQuota(account: AccountRuntime, data: unknown, ctx: QuotaFetchContext, now = Date.now()): void {
  const windows: ModelQuota[] = [];
  const usage = record(data) && record(data.usage) ? data.usage : {};
  for (const [key, timerType, label] of [["current_5h", "5h", "5-hour"], ["weekly", "7d", "weekly"]] as const) {
    const window = usage[key];
    if (!record(window)) continue;
    const fraction = window.usage_level;
    const remaining = window.remaining_credits;
    const validFraction = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0;
    const exhausted = typeof remaining === "number" && Number.isFinite(remaining) && remaining === 0;
    if (!validFraction && !exhausted) continue;
    const reset = typeof window.reset_at === "string" ? Date.parse(window.reset_at) : NaN;
    // Expired snapshots must not strand an account until a successful repoll.
    if (Number.isFinite(reset) && reset <= now) continue;
    windows.push({
      providerId: GEMINI_WEB_PROVIDER,
      modelKey: `${GEMINI_WEB_PROVIDER}:${key}`,
      displayName: `Gemini App ${label}`,
      percentRemaining: exhausted ? 0 : Math.max(0, Math.min(100, (1 - (fraction as number)) * 100)),
      usageRaw: validFraction ? fraction : 1,
      resetTime: Number.isFinite(reset) ? new Date(reset).toISOString()
        : exhausted || (validFraction && fraction >= 1) ? new Date(now + 60000).toISOString() : null,
      timerType,
    });
  }
  const exhausted = windows.filter((window) => window.percentRemaining === 0);
  // Select the longest exhausted window, otherwise the tightest budget.
  const dominant = exhausted.length ? exhausted.reduce((a, b) =>
    (b.resetTime ? Date.parse(b.resetTime) : now + 60000) > (a.resetTime ? Date.parse(a.resetTime) : now + 60000) ? b : a)
    : windows.reduce<ModelQuota | undefined>((a, b) => !a || b.percentRemaining < a.percentRemaining ? b : a, undefined);
  // Like Codex, expose one routing pool constrained by both windows. Window
  // details belong in the poll summary, not in three independently counted pools.
  const rows = dominant ? [{ ...dominant, modelKey: GEMINI_WEB_PROVIDER, displayName: "Gemini App" }] : [];
  account.quota = [...account.quota.filter((row) => row.providerId !== GEMINI_WEB_PROVIDER), ...rows];
  account.lastPollByProvider ??= {};
  account.lastPollByProvider[GEMINI_WEB_PROVIDER] = windows.length
    ? windows.map((row) => `${row.displayName}: ${Math.round(row.percentRemaining)}% remaining`).join(" | ")
    : "Session connected; background refresh active; quota unavailable";
  if (exhausted.length) {
    const until = Math.max(...exhausted.map((row) => row.resetTime ? Date.parse(row.resetTime) : now + 60_000));
    ctx.setProviderCooldown?.(account, GEMINI_WEB_PROVIDER, until - now);
  }
}
