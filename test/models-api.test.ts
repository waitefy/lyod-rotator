// HTTP surface of the Models page: /api/catalog, and what clients see when a
// model or provider is turned off.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setPersistedAdminToken } from "../src/admin-auth.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";
import {
  listCatalogModels,
  parseModelKey,
  resolveProviderOrder,
  setModelsTurnedOff,
  setProviderTurnedOff,
} from "../src/model-catalog.js";
import type { Config } from "../src/types.js";
import type { ModelCatalogResponse } from "../src/dashboard-types.js";

function makeRotator(config: Partial<Config> = {}, ollama: string[] = ["gemma4:31b", "big-pickle"]) {
  let current = { accounts: [], ...config } as Config;
  const rotator = {
    saveState() {},
    recordProxyEvent() {},
    getStatus: () => ({ accounts: [], security: { adminTokenConfigured: true } }),
    getConfig: () => current,
    getOllamaModels: () => ollama,
    getCodexModels: () => ["gpt-6-sol"],
    hasActiveProvider: () => true,
    getModelCatalog: () => listCatalogModels(rotator),
    refreshModelCatalogs: async () => {},
    setProviderEnabled: async (id: string, on: boolean) => {
      if (!["google-antigravity", "ollama", "openai-codex", "opencode-zen"].includes(id)) return false;
      current = { ...current, ...setProviderTurnedOff(current, id, !on) };
      return true;
    },
    setProviderOrder: async (order: string[]) => {
      current = { ...current, providerOrder: resolveProviderOrder(order) };
      return true;
    },
    setModelsEnabled: async (keys: string[], on: boolean) => {
      if (!keys.every((key) => parseModelKey(key))) return false;
      current = { ...current, ...setModelsTurnedOff(current, keys, !on) };
      return true;
    },
    setAutoEnableNewModels: async () => {},
    setAccountProviderEnabled: async () => false,
  };
  return rotator;
}

describe("Models page HTTP routes", () => {
  let server: Server | null = null;
  let base = "";
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  async function start(rotator: unknown): Promise<void> {
    server = startProxy(rotator as never, 0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}${path.includes("?") ? "&" : "?"}token=secret`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("secret");
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
    if (previousTelemetry === undefined) delete process.env.PI_ROTATOR_TELEMETRY;
    else process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
  });

  it("serves the catalog in provider order and marks which provider gets a shared id", async () => {
    await start(makeRotator());
    const response = await admin("/api/catalog");
    assert.equal(response.status, 200);
    const body = (await response.json()) as ModelCatalogResponse;
    assert.deepEqual(
      body.providers.map((provider) => provider.id),
      ["opencode-zen", "openai-codex", "ollama", "google-antigravity", "gemini-web", "chatgpt-app"],
    );
    const pickle = body.models.filter((entry) => entry.id === "big-pickle");
    assert.deepEqual(
      pickle.map((entry) => [entry.providerId, entry.routed]),
      [["opencode-zen", true], ["ollama", false]],
    );
    assert.equal(body.autoEnableNewModels, true);
  });

  it("requires admin auth", async () => {
    await start(makeRotator());
    assert.equal((await fetch(`${base}/api/catalog`)).status, 401);
  });

  it("changes switches and order, and rejects bad input", async () => {
    await start(makeRotator());
    let response = await admin("/api/catalog/providers/opencode-zen/off", { method: "POST" });
    let body = (await response.json()) as ModelCatalogResponse;
    assert.equal(response.status, 200);
    assert.equal(body.providers.find((provider) => provider.id === "opencode-zen")?.enabled, false);
    assert.equal(body.models.find((entry) => entry.id === "big-pickle" && entry.routed)?.providerId, "ollama");

    response = await admin("/api/catalog/provider-order", { method: "PUT", body: JSON.stringify({ order: ["ollama"] }) });
    body = (await response.json()) as ModelCatalogResponse;
    assert.equal(body.providers[0].id, "ollama");

    response = await admin("/api/catalog/models/off", { method: "POST", body: JSON.stringify({ models: ["ollama/gemma4:31b"] }) });
    body = (await response.json()) as ModelCatalogResponse;
    assert.equal(body.models.find((entry) => entry.id === "gemma4:31b")?.offReason, "model");

    assert.equal((await admin("/api/catalog/providers/nope/off", { method: "POST" })).status, 404);
    assert.equal((await admin("/api/catalog/models/off", { method: "POST", body: JSON.stringify({ models: ["gemma4:31b"] }) })).status, 400);
    assert.equal((await admin("/api/catalog/models/off", { method: "POST", body: "[]" })).status, 400);
    assert.equal((await admin("/api/catalog/accounts/a%40b.c/ollama/off", { method: "POST" })).status, 404);
    assert.equal((await admin("/api/catalog/unknown")).status, 404);
  });

  it("leaves turned-off models and providers out of /v1/models and lists shared ids once", async () => {
    await start(makeRotator({ disabledModels: ["ollama/gemma4:31b"], disabledProviders: ["google-antigravity"] }));
    const { data } = (await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = data.map((entry) => entry.id);
    assert.ok(!ids.includes("gemma4:31b"));
    assert.ok(!data.some((entry) => entry.owned_by === "tuxevil-rotator"));
    assert.deepEqual(
      data.filter((entry) => entry.id === "big-pickle").map((entry) => entry.owned_by),
      ["opencode-zen"],
    );
  });

  it("answers requests for a turned-off model with 404 in each API's format", async () => {
    await start(makeRotator({ disabledModels: ["ollama/gemma4:31b"] }));
    const messages = [{ role: "user", content: "hi" }];

    let response = await post("/v1/chat/completions", { model: "gemma4:31b", messages });
    assert.equal(response.status, 404);
    const openai = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(openai.error.code, "model_not_found");
    assert.match(openai.error.message, /turned off/);

    response = await post("/v1/messages", { model: "gemma4:31b", max_tokens: 16, messages });
    assert.equal(response.status, 404);
    const anthropic = (await response.json()) as { error: { type: string } };
    assert.equal(anthropic.error.type, "not_found_error");

    response = await post("/v1/messages", { model: "gpt-6-sol", max_tokens: 16, messages });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, /OpenAI Codex/);
  });
  it("rejects a native provider hint incompatible with its endpoint", async () => {
    await start(makeRotator({ disabledModels: ["ollama/big-pickle", "ollama/gemma4:31b"] }));
    const response = await post("/v1internal:generateContent", {
      model: "big-pickle",
      providerId: "ollama",
      request: { contents: [] },
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /body\.providerId.*google-antigravity/);
  });

  it("answers requests for turned-off Google and Ollama native models with 404", async () => {
    await start(makeRotator({ disabledModels: ["google-antigravity/gemini-3.8-flash-high", "ollama/gemma4:31b"] }));
    let response = await post("/v1internal:generateContent", {
      model: "gemini-3.8-flash-high",
      request: { contents: [] },
    });
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /turned off/);

    response = await post("/api/chat", { model: "gemma4:31b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { error: string }).error, /turned off/);
  });

  it("answers a wrong method on a known catalog path with 405", async () => {
    await start(makeRotator());
    const response = await admin("/api/catalog/refresh");
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });
});
