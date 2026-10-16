import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWebQuota } from "../src/providers/gemini-web/quota.js";
import type { AccountRuntime, ModelQuota } from "../src/types.js";
import type { QuotaFetchContext } from "../src/providers/adapter.js";

const now = Date.parse("2026-10-16T20:00:00Z");
const fiveHourReset = "2026-10-16T21:00:00Z";
const weeklyReset = "2026-10-20T20:00:00Z";
function fixture() {
  const sibling: ModelQuota = { modelKey: "monthly", providerId: "ollama", displayName: "Other",
    percentRemaining: 40, resetTime: null, timerType: "monthly" };
  const account = { quota: [sibling], lastPollByProvider: {} } as AccountRuntime;
  const cooldowns: [string, number][] = [];
  const ctx: QuotaFetchContext = { log() {}, markFlagged() {}, reportQuotaPollFlag() {},
    setProviderCooldown(_account, provider, duration) { cooldowns.push([provider, duration]); } };
  return { account, sibling, cooldowns, ctx };
}

describe("Gemini Web compute quota", () => {
  it("uses both windows without treating a rounded 100% as exhaustion", () => {
    const { account, sibling, cooldowns, ctx } = fixture();
    applyWebQuota(account, { usage: {
      current_5h: { usage_level: 0.999, remaining_credits: 1, reset_at: fiveHourReset },
      weekly: { usage_level: 0.15, remaining_credits: 40000, reset_at: weeklyReset },
    } }, ctx, now);
    assert.equal(account.quota[0], sibling);
    const pool = account.quota.find((row) => row.modelKey === "gemini-web")!;
    assert.ok(pool.percentRemaining > 0 && pool.percentRemaining < 1);
    assert.equal(pool.timerType, "5h");
    assert.deepEqual(cooldowns, []);
  });

  it("uses the longest exhausted window and cools only this provider", () => {
    const { account, cooldowns, ctx } = fixture();
    applyWebQuota(account, { usage: {
      current_5h: { usage_level: 1, remaining_credits: 0, reset_at: fiveHourReset },
      weekly: { usage_level: 1, remaining_credits: 0, reset_at: weeklyReset },
    } }, ctx, now);
    const pool = account.quota.find((row) => row.modelKey === "gemini-web")!;
    assert.equal(pool.percentRemaining, 0);
    assert.equal(pool.timerType, "7d");
    assert.equal(pool.resetTime, new Date(weeklyReset).toISOString());
    assert.deepEqual(cooldowns, [["gemini-web", Date.parse(weeklyReset) - now]]);
    assert.equal(account.quota[0].percentRemaining, 40);
  });

  it("clears stale web rows on an expired or unavailable snapshot without touching siblings", () => {
    const { account, sibling, ctx } = fixture();
    applyWebQuota(account, { usage: { current_5h: { usage_level: 1, reset_at: fiveHourReset } } }, ctx, now);
    applyWebQuota(account, { usage: { current_5h: { usage_level: 1, reset_at: fiveHourReset } } }, ctx, Date.parse(fiveHourReset));
    assert.deepEqual(account.quota, [sibling]);
    for (const data of [null, [], { usage: [] }, { usage: { weekly: { usage_level: "PRIVATE", remaining_credits: -1 } } }]) {
      applyWebQuota(account, data, ctx, now);
      assert.deepEqual(account.quota, [sibling]);
      assert.doesNotMatch(JSON.stringify(account), /PRIVATE/);
    }
  });

  it("treats zero credits as exhausted even when no usage fraction is returned", () => {
    const { account, cooldowns, ctx } = fixture();
    applyWebQuota(account, { usage: { current_5h: { remaining_credits: 0 } } }, ctx, now);
    assert.equal(account.quota.find((row) => row.modelKey === "gemini-web")!.percentRemaining, 0);
    assert.equal(account.quota.find((row) => row.modelKey === "gemini-web")!.resetTime, new Date(now + 60000).toISOString());
    assert.deepEqual(cooldowns, [["gemini-web", 60000]]);
  });
});
