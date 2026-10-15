import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROVIDER_ORDER,
  isModelServed,
  isRequestOff,
  listCatalogModels,
  parseModelKey,
  resolveModelRoute,
  resolveProviderOrder,
  setAutoEnableNewModels,
  setModelsTurnedOff,
  setProviderTurnedOff,
  type ModelCatalogSource,
} from "../src/model-catalog.js";
import { applyConfigDefaults } from "../src/config-defaults.js";
import { validateConfig } from "../src/validators.js";
import type { Config } from "../src/types.js";

function source(
  config: Partial<Config> = {},
  options: { ollama?: string[]; codex?: string[]; active?: string[] } = {},
): ModelCatalogSource & { config: Config } {
  const state = { config: { accounts: [], ...config } as Config };
  return {
    get config() {
      return state.config;
    },
    set config(next: Config) {
      state.config = next;
    },
    getConfig: () => state.config,
    getOllamaModels: () => options.ollama ?? [],
    getCodexModels: () => options.codex ?? [],
    hasActiveProvider: (id: string) => (options.active ? options.active.includes(id) : true),
  };
}

describe("model routing", () => {
  it("sends a listed id to the provider that lists it", () => {
    const s = source({}, { ollama: ["glm-5.1"] });
    assert.deepEqual(resolveModelRoute(s, "glm-5.1"), { kind: "provider", providerId: "ollama", modelId: "glm-5.1" });
    assert.equal(resolveModelRoute(s, "claude-sonnet-4-6").kind, "provider");
    assert.equal((resolveModelRoute(s, "big-pickle") as { providerId: string }).providerId, "opencode-zen");
  });

  it("keeps the historical order by default and follows providerOrder when set", () => {
    // Ollama lists an id OpenCode Zen also lists.
    const shared = { ollama: ["big-pickle"] };
    assert.deepEqual([...DEFAULT_PROVIDER_ORDER], ["opencode-zen", "openai-codex", "ollama", "google-antigravity", "gemini-web"]);
    assert.equal((resolveModelRoute(source({}, shared), "big-pickle") as { providerId: string }).providerId, "opencode-zen");
    const reordered = source({ providerOrder: ["ollama"] }, shared);
    assert.equal((resolveModelRoute(reordered, "big-pickle") as { providerId: string }).providerId, "ollama");
  });

  it("moves a shared id to the next provider when the first is turned off", () => {
    const s = source({ disabledProviders: ["opencode-zen"] }, { ollama: ["big-pickle"] });
    assert.equal((resolveModelRoute(s, "big-pickle") as { providerId: string }).providerId, "ollama");
  });

  it("prefers a provider with a usable account, else the first one that is on", () => {
    const shared = { ollama: ["big-pickle"] };
    assert.equal(
      (resolveModelRoute(source({}, { ...shared, active: ["ollama"] }), "big-pickle") as { providerId: string }).providerId,
      "ollama",
    );
    assert.equal(
      (resolveModelRoute(source({}, { ...shared, active: [] }), "big-pickle") as { providerId: string }).providerId,
      "opencode-zen",
    );
  });

  it("reports a model as off when every provider that lists it is off for it", () => {
    const s = source({ disabledModels: ["Ollama/GLM-5.1"] }, { ollama: ["glm-5.1"] });
    assert.deepEqual(resolveModelRoute(s, "glm-5.1"), { kind: "off", providerIds: ["ollama"] });
    assert.equal(isModelServed(s, "ollama", "glm-5.1"), false);
  });

  it("leaves unlisted ids to the caller unless their provider is off", () => {
    assert.deepEqual(resolveModelRoute(source(), "gemini-pro-agent"), { kind: "unlisted" });
    assert.deepEqual(
      resolveModelRoute(source({ disabledProviders: ["google-antigravity"] }), "gemini-pro-agent"),
      { kind: "off", providerIds: ["google-antigravity"] },
    );
  });

  it("treats an alias as the model it stands for", () => {
    const s = source();
    assert.equal((resolveModelRoute(s, "gpt-oss-120b") as { providerId: string }).providerId, "google-antigravity");
    s.config = { ...s.config, ...setModelsTurnedOff(s.config, ["google-antigravity/gpt-oss-120b-medium"], true) };
    assert.equal(resolveModelRoute(s, "gpt-oss-120b").kind, "off");
  });

  it("no longer hands an Ollama model ending in -free to OpenCode Zen", () => {
    const s = source({}, { ollama: ["qwen4-free"] });
    assert.equal((resolveModelRoute(s, "qwen4-free") as { providerId: string }).providerId, "ollama");
  });
});

describe("request switch checks", () => {
  it("honors explicit keys for ids no provider lists", () => {
    const s = source({ disabledModels: ["google-antigravity/gemini-pro-agent"] });
    assert.deepEqual(resolveModelRoute(s, "gemini-pro-agent"), { kind: "off", providerIds: ["google-antigravity"] });
  });

  it("checks the catalog id and the upstream alias of a request", () => {
    const s = source({ disabledModels: ["google-antigravity/gemini-3.1-pro-high", "google-antigravity/gemini-3.8-flash-low"] });
    // Effort routing resolved to a turned-off target; the upstream name is an alias.
    assert.equal(isRequestOff(s, { model: "gemini-pro-agent", catalogModel: "gemini-3.1-pro-high" }), true);
    assert.equal(isRequestOff(s, { model: "gemini-3.1-pro-low", catalogModel: "gemini-3.1-pro-low" }), false);
    // whisper-1 is sent upstream as gemini-3.8-flash-low.
    assert.equal(isRequestOff(s, { model: "whisper-1" }), true);
  });

  it("checks a pinned provider's own copy of a shared model", () => {
    const s = source({ disabledModels: ["ollama/big-pickle"] }, { ollama: ["big-pickle"] });
    assert.equal(isRequestOff(s, { model: "big-pickle" }), false);
    assert.equal(isRequestOff(s, { model: "big-pickle", providerId: "opencode-zen" }), false);
    assert.equal(isRequestOff(s, { model: "big-pickle", providerId: "ollama" }), true);
    assert.equal(isRequestOff(source({ disabledProviders: ["ollama"] }), { model: "anything", providerId: "ollama" }), true);
  });

  it("holds only listed models for review", () => {
    const s = source({ autoEnableNewModels: false, reviewedModels: [] }, { ollama: ["glm-5.1"] });
    assert.equal(isRequestOff(s, { model: "glm-5.1", providerId: "ollama" }), true);
    assert.equal(isRequestOff(s, { model: "some-upstream-name", providerId: "ollama" }), false);
  });

  it("reports each model's own switch separately from its provider's", () => {
    const s = source({ disabledProviders: ["ollama"], disabledModels: ["ollama/glm-5.1"] }, { ollama: ["glm-5.1", "kimi-k3"] });
    const entry = (id: string) => listCatalogModels(s).find((model) => model.id === id)!;
    assert.deepEqual([entry("glm-5.1").offReason, entry("glm-5.1").modelSwitch], ["provider", "off"]);
    assert.deepEqual([entry("kimi-k3").offReason, entry("kimi-k3").modelSwitch], ["provider", "on"]);
  });
});

describe("model settings", () => {
  it("normalizes the provider order", () => {
    assert.deepEqual(resolveProviderOrder(["ollama", "nope", "ollama"]), [
      "ollama",
      "opencode-zen",
      "openai-codex",
      "google-antigravity",
      "gemini-web",
    ]);
  });

  it("parses provider/model keys, including ids with slashes", () => {
    assert.deepEqual(parseModelKey("ollama/gpt-oss:20b"), { providerId: "ollama", modelId: "gpt-oss:20b" });
    assert.deepEqual(parseModelKey("google-antigravity/models/x"), { providerId: "google-antigravity", modelId: "models/x" });
    assert.equal(parseModelKey("whisper-1"), null);
    assert.equal(parseModelKey("nope/x"), null);
  });

  it("turns providers and models on and off", () => {
    const config = { accounts: [] } as unknown as Config;
    assert.deepEqual(setProviderTurnedOff(config, "ollama", true), { disabledProviders: ["ollama"] });
    assert.deepEqual(setProviderTurnedOff({ ...config, disabledProviders: ["ollama"] }, "ollama", false), { disabledProviders: [] });
    assert.deepEqual(setModelsTurnedOff({ ...config, disabledModels: ["ollama/A"] }, ["ollama/a"], false), { disabledModels: [] });
  });

  it("holds models found later for review once automatic enabling is off", () => {
    const ollama = ["glm-5.1"];
    const s = source({}, { ollama });
    s.config = { ...s.config, ...setAutoEnableNewModels(s, false) };
    assert.equal(s.config.autoEnableNewModels, false);
    assert.ok(s.config.reviewedModels?.includes("ollama/glm-5.1"));

    ollama.push("kimi-k3");
    const offReason = (id: string) => listCatalogModels(s).find((entry) => entry.id === id)?.offReason;
    assert.equal(offReason("glm-5.1"), null);
    assert.equal(offReason("kimi-k3"), "review");
    assert.equal(resolveModelRoute(s, "kimi-k3").kind, "off");

    s.config = { ...s.config, ...setModelsTurnedOff(s.config, ["ollama/kimi-k3"], false) };
    assert.equal(offReason("kimi-k3"), null);

    s.config = { ...s.config, ...setAutoEnableNewModels(s, true) };
    assert.equal(s.config.autoEnableNewModels, true);
    assert.equal(s.config.reviewedModels, undefined);
  });

  it("survives config defaults and validates the new fields", () => {
    const config = {
      accounts: [],
      providerOrder: ["ollama"],
      disabledProviders: ["openai-codex"],
      disabledModels: ["ollama/gpt-oss:20b"],
      autoEnableNewModels: false,
      reviewedModels: ["ollama/glm-5.1"],
    } as unknown as Config;
    const normalized = applyConfigDefaults(config);
    assert.deepEqual(normalized.providerOrder, ["ollama"]);
    assert.deepEqual(normalized.disabledProviders, ["openai-codex"]);
    assert.deepEqual(normalized.disabledModels, ["ollama/gpt-oss:20b"]);
    assert.equal(normalized.autoEnableNewModels, false);
    assert.deepEqual(normalized.reviewedModels, ["ollama/glm-5.1"]);
    assert.equal(validateConfig(config).ok, true);

    const bad = validateConfig({
      accounts: [],
      providerOrder: ["nope"],
      disabledProviders: "ollama",
      disabledModels: ["gpt-oss:20b"],
      autoEnableNewModels: "yes",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 4);
  });
});
