import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { customQuotaKey, customQuotaSnapshot, isCustomQuotaRule, withInitialCustomQuotas } from "../src/custom-quota.js";
import type { AccountConfig, AccountRuntime, CustomQuotaRule } from "../src/types.js";

const directory = mkdtempSync(join(tmpdir(), "custom-quota-"));
process.env.TUXEVIL_ROTATOR_DIR = directory;
process.env.PI_ROTATOR_DIR = directory;
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let closeDb: typeof import("../src/db-store.js").closeDb;
let validateAccountConfig: typeof import("../src/validators.js").validateAccountConfig;
const rotators: InstanceType<typeof AccountRotator>[] = [];
let sequence = 0;

before(async () => {
  const db = await import("../src/db-store.js");
  await db.initDb();
  closeDb = db.closeDb;
  ({ AccountRotator } = await import("../src/rotator.js"));
  ({ validateAccountConfig } = await import("../src/validators.js"));
});
afterEach(async () => {
  for (const rotator of rotators.splice(0)) {
    rotator.stopQuotaPolling();
    await rotator.flushPendingStateSave();
  }
});
after(async () => {
  await closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const provider = "google-antigravity";
const model = "gemini-3-flash";

function fixture(rule?: CustomQuotaRule, count = 2) {
  const id = ++sequence;
  const config = { requestsPerRotation: 50, proxyPort: 51200, rotateOnQuotaDrop: 0, quotaPollIntervalMs: 300_000, accounts: Array.from({ length: count }, (_, index): AccountConfig => ({
    email: `custom-${id}-${index}@example.test`,
    credentials: [{ provider, refreshToken: "not-used", projectId: `project-${id}-${index}` },
      { provider: "chatgpt-app", sessionFile: "/not-read/session.json" }],
    customQuotas: rule ? { [provider]: rule } : undefined,
  })) };
  const rotator = new AccountRotator(config);
  rotator.stopQuotaPolling();
  rotators.push(rotator);
  const accounts = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
  for (const account of accounts) {
    account.accessToken = "unused";
    account.tokenExpires = Date.now() + 365 * 86_400_000;
  }
  return { rotator, accounts, config };
}

describe("operator-defined request budgets", () => {
  it("persists the first connection budget and exposes it in runtime status", async () => {
    const store = await import("../src/account-store.js");
    const { rotator, config } = fixture(undefined, 0);
    await store.saveAccountsConfig(config);
    const entry: AccountConfig = { email: "first-connection@example.test", credentials: [
      { provider: "chatgpt-app", sessionFile: "/not-read/session.json" },
    ] };
    await store.addAccountToConfig(entry);
    assert.deepEqual(store.loadOrCreateAccountsConfig().accounts[0].customQuotas,
      { "chatgpt-app": { requests: 100, windowHours: 5 } });
    await rotator.addOrUpdateAccount(entry);
    const account = rotator.getStatus().accounts.find((a) => a.email === entry.email)!;
    assert.ok(account.id);
    assert.equal(account.customQuotas?.find((q) => q.providerId === "chatgpt-app")?.requests, 100);
    await rotator.setCustomQuota(account.id, "chatgpt-app", null);
    await store.addAccountToConfig(entry);
    await rotator.addOrUpdateAccount(entry);
    assert.deepEqual(store.loadOrCreateAccountsConfig().accounts[0].customQuotas, {});
    assert.deepEqual(rotator.getStatus().accounts.find((a) => a.email === entry.email)!.customQuotas, []);
  });

  it("assigns initial web budgets without overwriting edited or disabled budgets on re-login", () => {
    const expected = {
      "chatgpt-app": { requests: 100, windowHours: 5 },
      "claude-app": { requests: 12, windowHours: 5 },
      "qwen-app": { requests: 80, windowHours: 24 },
      "deepseek-app": { requests: 60, windowHours: 1 },
    };
    for (const [provider, rule] of Object.entries(expected)) {
      const entry: AccountConfig = { email: "new@example.test", credentials: [{ provider, sessionFile: "/not-read/session.json" }] };
      assert.deepEqual(withInitialCustomQuotas(entry).customQuotas, { [provider]: rule });
      assert.equal(withInitialCustomQuotas(entry, entry).customQuotas, undefined);
      const edited = { [provider]: { requests: 7, windowHours: 2 } };
      assert.deepEqual(withInitialCustomQuotas(entry, { ...entry, customQuotas: edited }).customQuotas, edited);
      assert.deepEqual(withInitialCustomQuotas({ ...entry, customQuotas: edited }).customQuotas, edited);
      const sibling = { "google-antigravity": { requests: 9, windowHours: 1 } };
      assert.deepEqual(withInitialCustomQuotas(entry, { email: entry.email, customQuotas: sibling }).customQuotas,
        { ...sibling, [provider]: rule });
    }
  });

  it("validates positive integer budgets and bounded windows, including config imports", () => {
    const { config } = fixture();
    for (const rule of [null, [], { requests: 0, windowHours: 24 }, { requests: 1.5, windowHours: 24 },
      { requests: 5, windowHours: 0 }, { requests: Infinity, windowHours: 24 }, { requests: 5, windowHours: 8761 }]) {
      assert.equal(isCustomQuotaRule(rule), false);
      assert.equal(validateAccountConfig({ ...config.accounts[0], customQuotas: { [provider]: rule } }).ok, false);
    }
    assert.equal(validateAccountConfig({ ...config.accounts[0], customQuotas: { typo: { requests: 5, windowHours: 24 } } }).ok, false);
    assert.equal(isCustomQuotaRule({ requests: 5, windowHours: 24 }), true);
  });

  it("does not start the window on a read and resets exactly at the boundary", () => {
    const rule = { requests: 2, windowHours: 1 };
    assert.equal(customQuotaSnapshot(rule, undefined, 1000).resetAt, null);
    const usage = { used: 2, windowHours: 1, startedAt: 1000 };
    assert.equal(customQuotaSnapshot(rule, usage, 3_600_999).used, 2);
    assert.equal(customQuotaSnapshot(rule, usage, 3_601_000).used, 0);
    assert.equal(customQuotaSnapshot({ ...rule, requests: 4 }, usage, 2000).used, 2);
    assert.equal(customQuotaSnapshot({ ...rule, windowHours: 2 }, usage, 2000).used, 0);
  });

  it("switches accounts at the limit and returns the reset time when all are exhausted", async () => {
    const { rotator } = fixture({ requests: 1, windowHours: 5 });
    const first = await rotator.getActiveAccount(model);
    assert.ok(first);
    rotator.recordRequest(first, model, provider);
    rotator.finishRequest(first, "gemini");
    const second = await rotator.getActiveAccount(model);
    assert.ok(second);
    assert.notEqual(first, second);
    rotator.recordRequest(second, model, provider);
    rotator.finishRequest(second, "gemini");
    assert.equal(await rotator.getActiveAccount(model), null);
    assert.ok(rotator.getRetryAfterMs(model) > 4.9 * 3_600_000);
  });

  it("reserves remaining capacity for concurrent work and releases failed attempts", async () => {
    const { rotator } = fixture({ requests: 1, windowHours: 24 }, 1);
    const first = await rotator.getActiveAccount(model);
    assert.ok(first);
    let resolved = false;
    const queued = rotator.getActiveAccount(model).then((account) => { resolved = true; return account; });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(resolved, false, "capacity reserved by a pending request must queue new work");
    rotator.finishRequest(first, "gemini");
    assert.equal(rotator.getStatus().accounts[0].customQuotas?.[0].used, 0);
    assert.equal(await queued, first);
    rotator.finishRequest(first, "gemini");
  });

  it("keeps sibling providers, accounts and native quota reports separate", () => {
    const { rotator, accounts } = fixture({ requests: 10, windowHours: 24 });
    accounts[0].quota = [{ modelKey: "gemini", displayName: "Gemini", providerId: provider,
      percentRemaining: 42, resetTime: null, timerType: "fresh" }];
    rotator.recordRequest(accounts[0], "chatgpt-app-auto", "chatgpt-app");
    rotator.recordRequest(accounts[0], model, provider);
    const status = rotator.getStatus();
    assert.equal(status.accounts[0].customQuotas?.[0].used, 1);
    assert.equal(status.accounts[1].customQuotas?.[0].used, 0);
    assert.equal(status.accounts[0].quota[0].percentRemaining, 42);
    const original = accounts[0].config;
    assert.equal(customQuotaKey(original, provider), customQuotaKey({ ...original,
      credentials: original.credentials?.filter((credential) => credential.provider === provider) }, provider));
    assert.notEqual(customQuotaKey(original, provider), customQuotaKey(accounts[1].config, provider));
  });

  it("persists usage and configuration across restart; disabling restores routing", async () => {
    const { rotator, accounts } = fixture(undefined, 1);
    const id = rotator.getStatus().accounts[0].id!;
    assert.equal(await rotator.setCustomQuota(id, provider, { requests: 1, windowHours: 24 }), true);
    assert.equal(await rotator.setCustomQuota(id, "missing", { requests: 1, windowHours: 24 }), false);
    rotator.recordRequest(accounts[0], model, provider);
    await rotator.flushPendingStateSave();
    const restarted = new AccountRotator(rotator.getConfig());
    restarted.stopQuotaPolling();
    rotators.push(restarted);
    assert.equal(restarted.getStatus().accounts[0].customQuotas?.[0].used, 1);
    assert.equal(await restarted.getActiveAccount(model), null);
    assert.equal(await restarted.setCustomQuota(id, provider, null), true);
    assert.deepEqual(restarted.getStatus().accounts[0].customQuotas, []);
  });

  it("shares one Qwen budget across models and effort variants without charging sibling providers", async (t) => {
    const { qwenAppAdapter } = await import("../src/providers/web-app/index.js");
    const originalCanServe = qwenAppAdapter.canServeModel;
    qwenAppAdapter.canServeModel = () => true;
    t.after(() => { qwenAppAdapter.canServeModel = originalCanServe; });
    const { config } = fixture();
    for (const account of config.accounts) {
      account.credentials!.push({ provider: "qwen-app", sessionFile: "/not-read/qwen.json" });
      account.customQuotas = { "qwen-app": { requests: 1, windowHours: 5 } };
    }
    const rotator = new AccountRotator(config);
    rotator.stopQuotaPolling();
    rotators.push(rotator);
    const first = await rotator.getActiveAccount("qwen-app-qwen-fixture", undefined, "qwen-app");
    assert.ok(first);
    rotator.recordRequest(first, "qwen-app-qwen-fixture", "qwen-app");
    rotator.finishRequest(first, "qwen-app:qwen-app-qwen-fixture");
    const next = await rotator.getActiveAccount("qwen-app-qwen-other", undefined, "qwen-app");
    assert.ok(next);
    assert.notEqual(next, first);
    rotator.finishRequest(next, "qwen-app:qwen-app-qwen-other");
    assert.equal(rotator.getStatus().accounts.find((account) => account.email === first.config.email)?.customQuotas?.[0].used, 1);
  });

  it("makes an exhausted account available again when the window expires", async (t) => {
    const { rotator, accounts } = fixture({ requests: 1, windowHours: 1 }, 1);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    rotator.recordRequest(accounts[0], model, provider);
    assert.equal(await rotator.getActiveAccount(model), null);
    t.mock.method(Date, "now", () => now + 3_600_000);
    assert.equal(await rotator.getActiveAccount(model), accounts[0]);
    rotator.finishRequest(accounts[0], "gemini");
  });
});
