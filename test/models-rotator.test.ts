// Models page switches inside the rotator: provider and per-account
// provider switches take accounts out of routing, and survive a restart.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.TUXEVIL_ROTATOR_DIR = mkdtempSync(join(tmpdir(), "rotator-models-"));

import { initDb } from "../src/db-store.js";
import { AccountRotator } from "../src/rotator.js";
import { benchmarkAccount } from "../src/proxy.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import type { AccountConfig, Config } from "../src/types.js";

before(async () => {
  await initDb();
});

const ACCOUNT: AccountConfig = {
  email: "both@example.com",
  credentials: [
    { provider: "google-antigravity", refreshToken: "1//token", projectId: "proj" },
    { provider: "ollama", apiKey: "ollama-key" },
  ],
};

function makeRotator(overrides: Partial<Config> = {}): any {
  const rotator = new AccountRotator({
    proxyPort: 51200,
    requestsPerRotation: 5,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    accounts: [structuredClone(ACCOUNT)],
    ...overrides,
  });
  rotator.stopQuotaPolling();
  rotator.setOllamaModels(["gemma4:31b"]);
  return rotator;
}

describe("Models page switches in the rotator", () => {
  it("turning a provider off stops routing to it but keeps the account's other providers", async () => {
    const rotator = makeRotator();
    const account = rotator.accounts[0];
    assert.equal(rotator.hasActiveProvider("ollama"), true);

    assert.equal(await rotator.setProviderEnabled("ollama", false), true);
    assert.equal(rotator.hasActiveProvider("ollama"), false);
    assert.match(rotator.getProviderEligibilityRejection(account, "monthly").detail, /Ollama Cloud is turned off/);
    assert.equal(rotator.getProviderEligibilityRejection(account, "gemini"), null);
    assert.ok(
      rotator
        .getModelCatalog()
        .filter((entry: { providerId: string }) => entry.providerId === "ollama")
        .every((entry: { offReason: string }) => entry.offReason === "provider"),
    );

    await rotator.setProviderEnabled("ollama", true);
    assert.equal(rotator.getProviderEligibilityRejection(account, "monthly"), null);
    assert.equal(await rotator.setProviderEnabled("nope", false), false);
  });

  it("turns a provider off for one account and remembers it across a restart", async () => {
    const rotator = makeRotator();
    const account = rotator.accounts[0];

    assert.equal(await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", false), true);
    assert.deepEqual(rotator.getStatus().accounts[0].disabledProviders, ["ollama"]);
    assert.match(rotator.getProviderEligibilityRejection(account, "monthly").detail, /turned off for this account/);
    assert.equal(rotator.hasActiveProvider("ollama"), false);
    assert.equal(rotator.hasActiveProvider("google-antigravity"), true);

    const restarted = makeRotator();
    assert.deepEqual(restarted.getStatus().accounts[0].disabledProviders, ["ollama"]);

    await restarted.setAccountProviderEnabled(ACCOUNT.email, "ollama", true);
    assert.equal(restarted.getStatus().accounts[0].disabledProviders, undefined);
    assert.equal(await restarted.setAccountProviderEnabled(ACCOUNT.email, "openai-codex", false), false);
  });

  it("refuses to kickstart a pool whose provider is off", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    const result = await rotator.kickstartTimerForAccount(ACCOUNT.email, "gemini", false);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /turned off/);
  });

  it("saves model switches and provider order in the config", async () => {
    const rotator = makeRotator();
    assert.equal(await rotator.setModelsEnabled(["ollama/gemma4:31b"], false), true);
    assert.equal(await rotator.setModelsEnabled(["gemma4:31b"], false), false);
    assert.equal(await rotator.setProviderOrder(["google-antigravity"]), true);
    const config = rotator.getConfig();
    assert.deepEqual(config.disabledModels, ["ollama/gemma4:31b"]);
    assert.deepEqual(config.providerOrder, ["google-antigravity", "opencode-zen", "openai-codex", "ollama", "gemini-web", "chatgpt-app"]);
    assert.equal(
      rotator.getModelCatalog().find((entry: { id: string }) => entry.id === "gemma4:31b").offReason,
      "model",
    );
  });
  it("picks the pool of the provider a request is pinned to, even for a dynamic Google id", () => {
    dynamicCatalog.restoreDiscoveredQuotaPools({ "gemini-9-shared": "gemini" });
    const rotator = makeRotator();
    rotator.setOllamaModels(["gemini-9-shared"]);
    assert.equal(rotator.resolveQuotaModelKeyForDisplay("gemini-9-shared", "ollama"), "monthly");
    assert.equal(rotator.resolveQuotaModelKeyForDisplay("gemini-9-shared", "google-antigravity"), "gemini-9-shared");
  });

  it("reports an account whose providers are all off as off, not ready", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    assert.notEqual(rotator.getStatus().accounts[0].status, "off");
    await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", false);
    assert.equal(rotator.getStatus().accounts[0].status, "off");
    await rotator.setAccountProviderEnabled(ACCOUNT.email, "ollama", true);
  });

  it("refuses to kickstart with a turned-off model", async () => {
    const rotator = makeRotator({ disabledModels: ["google-antigravity/gemini-3-flash"] });
    const result = await rotator.kickstartTimerForAccount(ACCOUNT.email, "gemini", false);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /model turned off/);
  });

  it("skips benchmarks for providers that are turned off", async () => {
    const rotator = makeRotator({ disabledProviders: ["google-antigravity"] });
    const result = await benchmarkAccount(rotator, rotator.accounts[0]);
    assert.equal(result.status, "skipped");
    assert.match(result.error ?? "", /turned off/);
  });

  it("loads the live model lists before snapshotting for review", async () => {
    const rotator = makeRotator();
    rotator.refreshModelCatalogs = async () => rotator.setOllamaModels(["gemma4:31b", "late-arrival"]);
    await rotator.setAutoEnableNewModels(false);
    assert.ok(rotator.getConfig().reviewedModels.includes("ollama/late-arrival"));
  });

  it("does not rewrite the config when a switch is already in that state", async () => {
    const rotator = makeRotator();
    const turnedOff = () =>
      rotator.getStatus().recentEvents.filter((event: { message: string }) => /turned Ollama Cloud off/.test(event.message)).length;
    await rotator.setProviderEnabled("ollama", false);
    await rotator.setProviderEnabled("ollama", false);
    assert.equal(turnedOff(), 1);
  });
});
