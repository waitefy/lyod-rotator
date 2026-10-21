import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setPersistedAdminToken } from "../src/admin-auth.js";
import { startProxy } from "../src/proxy.js";
import { stopNotificationPoller } from "../src/notification-poller.js";
import { stopVersionChecker } from "../src/version-check.js";

function makeRotator() {
  const state = {
    enabledEmail: "",
    events: [] as string[],
  };
  const rotator = {
    saveState() {},
    getStatus() {
      return { accounts: [], security: { adminTokenConfigured: true } };
    },
    enableAccount(email: string) {
      state.enabledEmail = email;
      return email === "user@example.com";
    },
    recordProxyEvent(message: string) {
      state.events.push(message);
    },
  };
  return { rotator, state };
}

async function startTestProxy(rotator: unknown): Promise<Server> {
  const server = startProxy(rotator as never, 0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("proxy admin routes", () => {
  let server: Server | null = null;
  const previousTelemetry = process.env.PI_ROTATOR_TELEMETRY;

  beforeEach(() => {
    process.env.PI_ROTATOR_TELEMETRY = "off";
    setPersistedAdminToken("secret");
  });

  afterEach(async () => {
    setPersistedAdminToken(null);
    stopVersionChecker();
    stopNotificationPoller();
    if (server) {
      await closeServer(server);
      server = null;
    }
    if (previousTelemetry === undefined) {
      delete process.env.PI_ROTATOR_TELEMETRY;
    } else {
      process.env.PI_ROTATOR_TELEMETRY = previousTelemetry;
    }
  });

  it("protects custom budgets, validates input and targets an exact account identity", async () => {
    const { rotator } = makeRotator();
    const calls: unknown[][] = [];
    const customRotator = { ...rotator, async setCustomQuota(...args: unknown[]) {
      calls.push(args);
      return args[0] !== "missing";
    } };
    server = await startTestProxy(customRotator);
    const port = (server.address() as AddressInfo).port;
    const accountId = "test@example.com#qwen-app:::test";
    const url = `http://127.0.0.1:${port}/api/custom-quota/${encodeURIComponent(accountId)}`;
    const options = (rule: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "qwen-app", rule }) });
    assert.equal((await fetch(url, options({ requests: 5, windowHours: 24 }))).status, 401);
    assert.equal((await fetch(url + "?token=secret", options({ requests: 0, windowHours: 24 }))).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(url + "?token=secret", options({ requests: 5, windowHours: 24 }))).status, 200);
    assert.deepEqual(calls[0], [accountId, "qwen-app", { requests: 5, windowHours: 24 }]);
    assert.equal((await fetch(url + "?token=secret", options(null))).status, 200);
    assert.deepEqual(calls[1], [accountId, "qwen-app", null]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/custom-quota/missing?token=secret`, options(null))).status, 404);
  });

  it("matches dynamic admin routes by pathname while preserving query-token auth", async () => {
    const { rotator, state } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/enable/user%40example.com?token=secret`,
      { method: "POST" },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, email: "user@example.com" });
    assert.equal(state.enabledEmail, "user@example.com");
  });

  it("lets hosted OAuth callbacks reach state validation when admin auth is enabled", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/auth/antigravity/callback?code=abc&state=missing`,
    );
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Session Expired/);
    assert.doesNotMatch(body, /Unauthorized/);
  });

  it("does not expose config import exception details", async () => {
    const { rotator } = makeRotator();
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/config?token=secret`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      },
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { ok: false, error: "Invalid config request" });
    assert.doesNotMatch(JSON.stringify(body), /Unexpected token|SyntaxError/);
  });

  it("serves the admin /api/models catalog used by the Generate Virtual Key modal", async () => {
    // Build a rotator that advertises the static catalog plus one Ollama
    // model and one Codex model so the test exercises the active-provider
    // branch of buildOpenAIModelCatalog.
    const rotator = {
      saveState() {},
      getStatus() {
        return { accounts: [] };
      },
      hasActiveProvider(providerId: string) {
        return providerId === "ollama" || providerId === "openai-codex";
      },
      getOllamaModels() {
        return ["gemma4:31b"];
      },
      recordProxyEvent() {},
    };
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const noToken = await fetch(`http://127.0.0.1:${port}/api/models`);
    assert.equal(noToken.status, 401, "unauthenticated /api/models must be rejected");

    const response = await fetch(
      `http://127.0.0.1:${port}/api/models?token=secret`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      count: number;
      data: Array<{ id: string; owned_by: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.count, body.data.length);

    // The static Google Antigravity catalog must be present.
    assert.ok(
      body.data.some((m) => m.owned_by === "tuxevil-rotator" && m.id === "gemini-3.1-pro-high"),
      "missing static Gemini 3.1 Pro model",
    );
    assert.ok(
      body.data.some((m) => m.owned_by === "tuxevil-rotator" && m.id === "claude-sonnet-4-6"),
      "missing static Claude model",
    );

    // The Ollama model must come from the rotator's getOllamaModels() result.
    assert.ok(
      body.data.some((m) => m.owned_by === "ollama" && m.id === "gemma4:31b"),
      "missing Ollama model from active provider",
    );

    // Codex allowlist models must appear because hasActiveProvider returned true.
    assert.ok(
      body.data.some((m) => m.owned_by === "openai-codex" && m.id === "gpt-5.6-sol"),
      "missing Codex model from active provider",
    );
  });

  it("/api/models omits catalogs from providers with no active credentials", async () => {
    const rotator = {
      saveState() {},
      getStatus() {
        return { accounts: [] };
      },
      hasActiveProvider() {
        return false;
      },
      getOllamaModels() {
        return ["gemma4:31b"];
      },
      recordProxyEvent() {},
    };
    server = await startTestProxy(rotator);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/models?token=secret`,
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    assert.ok(
      !body.data.some((m) => m.owned_by === "openai-codex"),
      "Codex models must be hidden when the provider is inactive",
    );
    assert.ok(
      !body.data.some((m) => m.owned_by === "ollama"),
      "Ollama models must be hidden when the provider is inactive",
    );
    assert.ok(
      !body.data.some((m) => m.owned_by === "opencode-zen"),
      "OpenCode Zen models must be hidden when the provider is inactive",
    );
  });
});
