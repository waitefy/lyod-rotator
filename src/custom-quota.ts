import { getAccountIdentity } from "./account-identity.js";
import { normalizeAccountConfig } from "./config-normalize.js";
import type { AccountConfig, CustomQuotaRule, CustomQuotaUsage } from "./types.js";

export function isCustomQuotaRule(value: unknown): value is CustomQuotaRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as CustomQuotaRule;
  return Number.isSafeInteger(rule.requests) && rule.requests > 0 &&
    Number.isSafeInteger(rule.windowHours) && rule.windowHours >= 1 && rule.windowHours <= 8760;
}

/** A sibling provider being added must not reset an existing provider's budget. */
export function customQuotaKey(account: AccountConfig, providerId: string): string {
  const normalized = normalizeAccountConfig(account);
  return getAccountIdentity({
    email: normalized.email,
    credentials: normalized.credentials?.filter((credential) => credential.provider === providerId),
  });
}

/** Windows start with the first successful request, not a dashboard view. */
export function customQuotaSnapshot(rule: CustomQuotaRule, usage: CustomQuotaUsage | undefined, now: number) {
  const duration = rule.windowHours * 3_600_000;
  const valid = usage && usage.windowHours === rule.windowHours &&
    Number.isFinite(usage.startedAt) && usage.startedAt > 0 && usage.startedAt <= now &&
    Number.isSafeInteger(usage.used) && usage.used >= 0 && usage.startedAt + duration > now;
  const used = valid ? usage.used : 0;
  return {
    ...rule,
    used,
    startedAt: valid ? usage.startedAt : null,
    resetAt: valid ? usage.startedAt + duration : null,
    percentRemaining: Math.max(0, Math.floor(100 * (rule.requests - used) / rule.requests)),
  };
}
