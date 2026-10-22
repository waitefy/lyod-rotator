import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { AccountConfig, AccountRuntime, Config, ModelRouteStatus, RoutingPolicy } from "../src/types.js";
import { buildOverview } from "../src/dashboard-live.js";
import { buildProviderGroups, summarizeLocalBudgets } from "../src/web/lib/pools.js";
import { createMasker } from "../src/web/lib/mask.js";
import { buildAttention } from "../src/web/lib/attention.js";
import type { AccountRotator as RotatorClass, getAccountIdentity as AccountIdentityFunction } from "../src/rotator.js";
import type { closeDb as CloseDbFunction } from "../src/db-store.js";

const directory = mkdtempSync(join(tmpdir(), "app-model-routes-"));
process.env.TUXEVIL_ROTATOR_DIR = directory;
process.env.PI_ROTATOR_DIR = directory;
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
process.env.LYOD_CHATGPT_APP_MODELS = "fixture-a,fixture-b";
process.env.LYOD_CLAUDE_APP_MODELS = "sonnet-5-5,auto";
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

let AccountRotator: typeof RotatorClass;
let getAccountIdentity: typeof AccountIdentityFunction;
let closeDb: typeof CloseDbFunction;
const rotators: InstanceType<typeof AccountRotator>[] = [];
let sequence = 0;
const providers = ["chatgpt-app", "claude-app", "qwen-app", "deepseek-app"] as const;
const models: Record<typeof providers[number], string[]> = {
  "chatgpt-app": ["chatgpt-app-fixture-a", "chatgpt-app-fixture-b"],
  "claude-app": ["claude-app-sonnet-5-5", "claude-app-auto"],
  "qwen-app": ["qwen-app-fixture-a", "qwen-app-fixture-b"],
  "deepseek-app": ["deepseek-app-fixture-a", "deepseek-app-fixture-b"],
};

before(async () => {
  // Load stateful modules only after the isolated environment is installed.
  const db = await import("../src/db-store.js");
  await db.initDb();
  closeDb = db.closeDb;
  ({ AccountRotator, getAccountIdentity } = await import("../src/rotator.js"));
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

interface AppFixture {
  rotator: RotatorClass;
  accounts: AccountRuntime[];
  provider: typeof providers[number];
  model: string;
  otherModel: string;
}
function fixture(provider: typeof providers[number], count = 3, overrides: Partial<Config> = {}): AppFixture {
  const id = ++sequence;
  const configs = Array.from({ length: count }, (_, index): AccountConfig => {
    const email = `app-${id}-${index}@example.test`;
    const sessionFile = join(directory, `${provider}-${id}-${index}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      provider, email, accountId: email, baseUrl: "http://127.0.0.1:1/v1", apiKey: "private-test-key",
      modelSelection: "explicit",
      availableModels: provider === "claude-app" ? [{ id: "claude-sonnet-5-5", efforts: ["medium", "high"] }]
        : ["fixture-a", "fixture-b"].map((model) => ({ id: model, name: model, chat: true, thinking: true, search: false })),
    }), { mode: 0o600 });
    return { email, credentials: [{ provider, sessionFile }], customQuotas: { [provider]: { requests: 100, windowHours: 5 } } };
  });
  const rotator = new AccountRotator({ proxyPort: 51200, requestsPerRotation: 50, rotateOnQuotaDrop: 0,
    quotaPollIntervalMs: 300_000, maxConcurrentRequestsPerAccount: 2, ...overrides, accounts: configs });
  rotator.stopQuotaPolling();
  rotators.push(rotator);
  // The runtime list is private; this test seam deliberately inspects it.
  const internal = rotator as unknown as { accounts: AccountRuntime[]; modelState: Map<string, unknown> };
  const accounts = internal.accounts;
  // Each fixture starts unassigned, independently of previous persisted indices.
  internal.modelState.clear();
  return { rotator, accounts, provider, model: models[provider][0], otherModel: models[provider][1] };
}
function route(rotator: InstanceType<typeof AccountRotator>, model: string): ModelRouteStatus {
  const result = rotator.getStatus().modelRoutes?.find((entry) => entry.modelId === model);
  assert.ok(result, `route for ${model}`);
  return result;
}
function ranking(rotator: InstanceType<typeof AccountRotator>, model: string) {
  const status = rotator.getStatus();
  const entry = status.modelRoutes!.find((entry) => entry.modelId === model)!;
  return status.routingDiagnostics![entry.diagnosticKey];
}
function release(f: AppFixture, account: AccountRuntime, model = f.model) {
  f.rotator.finishRequest(account, f.rotator.resolveQuotaModelKeyForDisplay(model, f.provider), model, f.provider);
}

describe("concrete App model routes", () => {
  for (const provider of providers) {
    it(`${provider}: tracks multiple workers separately from idle assignments and other models`, async () => {
      const f = fixture(provider);
      const initial = route(f.rotator, f.model);
      assert.deepEqual(initial.servingAccountIds, []);
      assert.equal(initial.assignedAccountId, null);
      assert.equal(ranking(f.rotator, f.model).rankedAccountIds?.length, 3);
      const first = await f.rotator.getActiveAccount(f.model, undefined, provider);
      const second = await f.rotator.getActiveAccount(f.model, undefined, provider);
      assert.ok(first && second);
      assert.notEqual(first, second);
      assert.deepEqual(new Set(route(f.rotator, f.model).servingAccountIds), new Set([first, second].map(getAccountIdentity)));
      assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, []);
      const diagnostics = ranking(f.rotator, f.model);
      assert.equal(diagnostics.rankingMode, "concurrent");
      const nextId = diagnostics.rankedAccountIds![0];
      const next = await f.rotator.getActiveAccount(f.model, undefined, provider);
      assert.ok(next);
      assert.equal(getAccountIdentity(next), nextId, "ranking must agree with real concurrent admission");
      release(f, first); release(f, second); release(f, next);
      const idle = route(f.rotator, f.model);
      assert.deepEqual(idle.servingAccountIds, []);
      assert.equal(idle.assignedAccountId, getAccountIdentity(next));
      assert.equal(ranking(f.rotator, f.model).rankingMode, "rotation");
      const overview = buildOverview(f.rotator.getStatus(), Date.now(), { database: false });
      assert.deepEqual(overview.modelRoutes, f.rotator.getStatus().modelRoutes);
      const group = buildProviderGroups(overview, Date.now()).find((group) => group.provider === provider)!;
      assert.equal(group.routes.length, 2);
      assert.equal(group.routes.find((entry) => entry.modelId === f.model)!.assigned?.id, getAccountIdentity(next));
      assert.ok(summarizeLocalBudgets(group, Date.now()), "local budget remains independent");
      assert.equal(group.pools.length, 0, "do not fabricate native App quota pools");
    });

    it(`${provider}: one account remains Serving at capacity but has no eligible fallback`, async () => {
      const f = fixture(provider, 1, { maxConcurrentRequestsPerAccount: 1 });
      const account = await f.rotator.getActiveAccount(f.model, undefined, provider);
      assert.ok(account);
      assert.deepEqual(route(f.rotator, f.model).servingAccountIds, [getAccountIdentity(account)]);
      assert.deepEqual(ranking(f.rotator, f.model).rankedAccountIds, []);
      assert.equal(ranking(f.rotator, f.model).accounts[0].rejectedReason, "account-concurrency");
      release(f, account);
      assert.deepEqual(route(f.rotator, f.model).servingAccountIds, []);
      assert.equal(route(f.rotator, f.model).assignedAccountId, getAccountIdentity(account));
      assert.deepEqual(ranking(f.rotator, f.model).rankedAccountIds, []);
      const idleStatus = f.rotator.getStatus();
      const idleRoute = route(f.rotator, f.model);
      assert.equal(idleStatus.routingDiagnostics![idleRoute.diagnosticKey].selectedEmail, account.config.email);
      assert.ok(!buildAttention(buildOverview(idleStatus, Date.now(), { database: false }), Date.now())
        .some((item) => item.id === `unroutable:${idleRoute.diagnosticKey}`), "an eligible idle account is still routable");
    });

    it(`${provider}: retry admissions and operator-cleared workers never leave stale Serving entries`, async () => {
      const f = fixture(provider);
      const first = await f.rotator.getActiveAccount(f.model, undefined, provider);
      assert.ok(first);
      release(f, first);
      const rotated = await f.rotator.rotateToNext(f.model, first, provider);
      assert.ok(rotated);
      assert.deepEqual(route(f.rotator, f.model).servingAccountIds, [], "rotation alone is not admission");
      const retried = await f.rotator.getActiveAccount(f.model, undefined, provider);
      assert.ok(retried);
      assert.deepEqual(route(f.rotator, f.model).servingAccountIds, [getAccountIdentity(retried)]);
      f.rotator.clearInFlightRequests(retried.config.email, f.rotator.resolveQuotaModelKeyForDisplay(f.model, provider));
      assert.deepEqual(route(f.rotator, f.model).servingAccountIds, []);
      release(f, retried);
    });

    it(`${provider}: rejects cooldown, budget, auth, disabled and provider-disabled accounts`, async () => {
      const f = fixture(provider, 6);
      const [ready, cooldown, budget, auth, disabled, off] = f.accounts;
      cooldown.providerCooldowns = { [provider]: Date.now() + 60_000 };
      await f.rotator.setCustomQuota(getAccountIdentity(budget), provider, { requests: 1, windowHours: 5 });
      f.rotator.recordRequest(budget, f.model, provider);
      auth.invalidProviders = { [provider]: "reauthentication required" };
      disabled.disabled = true;
      off.disabledProviders = [provider];
      const diag = ranking(f.rotator, f.model);
      assert.deepEqual(diag.rankedAccountIds, [getAccountIdentity(ready)]);
      const rejection = (account: AccountRuntime) => diag.accounts.find((entry) => entry.id === getAccountIdentity(account))!;
      assert.equal(rejection(cooldown).rejectedReason, "cooldown");
      assert.equal(rejection(budget).rejectedReason, "quota-zero");
      assert.equal(rejection(auth).rejectedReason, "provider-ineligible");
      assert.equal(rejection(disabled).rejectedReason, "disabled");
      assert.equal(rejection(off).rejectedReason, "provider-ineligible");
    });
  }

  for (const policy of ["timer-first", "quota-first", "tier-first", "hybrid", "sequential-quota", "sticky-quota"] satisfies RoutingPolicy[]) {
    it(`uses authoritative ${policy} fallback ordering rather than client scores`, () => {
      const f = fixture("chatgpt-app", 3, { routingPolicy: policy });
      f.accounts.forEach((account, index) => {
        account.quota = [{ modelKey: "chatgpt-app", providerId: "chatgpt-app", displayName: "App", percentRemaining: [20, 80, 50][index], timerType: "fresh", resetTime: null }];
      });
      // Compare the observable ranking with the existing private policy picker.
      const internal = f.rotator as unknown as { pickBestModelAccount(key: string, now: number): AccountRuntime };
      const expected = internal.pickBestModelAccount("chatgpt-app", Date.now());
      assert.equal(ranking(f.rotator, f.model).rankedAccountIds![0], getAccountIdentity(expected));
      const status = f.rotator.getStatus();
      const diag = status.routingDiagnostics![`${f.provider}:${f.model}`];
      diag.accounts.reverse();
      for (const entry of diag.accounts) entry.score = entry.id === diag.rankedAccountIds![0] ? -100 : 999;
      const group = buildProviderGroups(buildOverview(status, Date.now(), { database: false }), Date.now()).find((group) => group.provider === f.provider)!;
      assert.deepEqual(group.routes[0].nextUp.map((account) => account.id), diag.rankedAccountIds);
    });
  }

  it("uses per-model Claude capabilities without probing or generating", (t) => {
    const f = fixture("claude-app", 2);
    const file = f.accounts[0].config.credentials![0].sessionFile!;
    writeFileSync(file, JSON.stringify({ email: f.accounts[0].config.email, baseUrl: "http://127.0.0.1:1", apiKey: "private", modelSelection: "default-only" }), { mode: 0o600 });
    t.mock.method(globalThis, "fetch", () => assert.fail("diagnostics must not make network requests"));
    assert.deepEqual(ranking(f.rotator, f.model).rankedAccountIds, [getAccountIdentity(f.accounts[1])]);
    assert.equal(ranking(f.rotator, f.otherModel).rankedAccountIds?.length, 2);
    const mask = createMasker(f.accounts.map((account) => account.config), true);
    assert.notEqual(mask.name(f.accounts[0].config.email), f.accounts[0].config.email);
  });

  it("does not count queued or cancelled requests as Serving", async () => {
    const f = fixture("chatgpt-app", 1, { maxConcurrentRequestsPerAccount: 1 });
    const first = await f.rotator.getActiveAccount(f.model, undefined, f.provider);
    assert.ok(first);
    const controller = new AbortController();
    const cancelled = f.rotator.getActiveAccount(f.otherModel, controller.signal, f.provider);
    assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, []);
    controller.abort();
    assert.equal(await cancelled, null);
    const queued = f.rotator.getActiveAccount(f.otherModel, undefined, f.provider);
    assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, []);
    release(f, first);
    const admitted = await queued;
    assert.ok(admitted);
    assert.deepEqual(route(f.rotator, f.model).servingAccountIds, []);
    assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, [getAccountIdentity(admitted)]);
    release(f, admitted, f.otherModel);
    assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, []);
  });

  it("releases concrete-model workers independently within a shared budget pool", async () => {
    const f = fixture("chatgpt-app", 1, { maxConcurrentRequestsPerAccount: 3 });
    const a = await f.rotator.getActiveAccount(f.model, undefined, f.provider);
    const b = await f.rotator.getActiveAccount(f.model, undefined, f.provider);
    const c = await f.rotator.getActiveAccount(f.otherModel, undefined, f.provider);
    assert.ok(a && b && c);
    release(f, a);
    assert.deepEqual(route(f.rotator, f.model).servingAccountIds, [getAccountIdentity(a)]);
    release(f, c, f.otherModel);
    assert.deepEqual(route(f.rotator, f.otherModel).servingAccountIds, []);
    assert.deepEqual(route(f.rotator, f.model).servingAccountIds, [getAccountIdentity(b)]);
    release(f, b);
    assert.deepEqual(route(f.rotator, f.model).servingAccountIds, []);
  });

  for (const provider of ["qwen-app", "deepseek-app"] as const) {
    it(`${provider}: differentiates per-account model catalogs`, () => {
      const f = fixture(provider, 2);
      const file = f.accounts[0].config.credentials![0].sessionFile!;
      writeFileSync(file, JSON.stringify({ provider, email: f.accounts[0].config.email, accountId: f.accounts[0].config.email,
        baseUrl: "http://127.0.0.1:1", apiKey: "private", availableModels: [{ id: "fixture-a", name: "A", chat: true, thinking: false, search: false }] }), { mode: 0o600 });
      assert.equal(ranking(f.rotator, f.model).rankedAccountIds?.length, 2);
      assert.deepEqual(ranking(f.rotator, f.otherModel).rankedAccountIds, [getAccountIdentity(f.accounts[1])]);
    });
  }
});
