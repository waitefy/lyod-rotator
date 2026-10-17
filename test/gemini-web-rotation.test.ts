import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withRotation } from "../src/proxy.js";
import { geminiWebAdapter } from "../src/providers/gemini-web/index.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

const model = "gemini-4-argon-web-low";
const body = { project: "", model, providerId: "gemini-web", request: {
  contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
} };

function fixture(maxRetries = 1, replacement = true) {
  const accounts = ["first", "second"].map((label) => ({
    config: { email: `${label}@example.test`, credentials: [
      { provider: "google-antigravity", refreshToken: "unrelated-oauth" },
      { provider: "gemini-web", cookiesFile: `/not-read/${label}.json` },
    ] },
  } as AccountRuntime));
  let selected = 0;
  const released: AccountRuntime[] = [];
  const invalid: unknown[][] = [];
  const cooldowns: unknown[][] = [];
  const rotations: unknown[][] = [];
  const rotator = {
    getActiveAccount: async () => accounts[selected],
    rotateToNext: async (...args: unknown[]) => {
      rotations.push(args);
      if (!replacement || selected === 1) return null;
      return accounts[++selected];
    },
    finishRequest: (account: AccountRuntime) => released.push(account),
    getRetryAfterMs: () => 0,
    getSafetyJitterMs: () => 0,
    getGlobalDelayMs: () => 0,
    getConfig: () => ({ streamRecoveryMaxRetries: maxRetries }),
    recordUpstreamAttempt: () => {},
    recordProxyEvent: () => {},
    recordRequest: () => false,
    markProviderInvalid: (...args: unknown[]) => invalid.push(args),
    setProviderCooldown: (...args: unknown[]) => cooldowns.push(args),
    markFlagged: () => assert.fail("A web failure must not flag the parent account"),
    markError: () => assert.fail("A web failure must not damage unrelated credentials"),
  } as unknown as AccountRotator;
  return { rotator, accounts, released, invalid, cooldowns, rotations };
}

describe("Gemini Web account recovery", () => {
  for (const status of [401, 403, 409, 503, 504]) {
    it(`retries HTTP ${status} on another web account before output`, async (t) => {
      const f = fixture();
      const called: AccountRuntime[] = [];
      t.mock.method(geminiWebAdapter, "forwardRequest", async (account: AccountRuntime) => {
        called.push(account);
        return { endpoint: "web", response: new Response(account === f.accounts[0] ? "safe error" : "OK", {
          status: account === f.accounts[0] ? status : 200,
        }) };
      });
      const result = await withRotation(f.rotator, model, {}, body, async (response) => response.text());
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.result, "OK");
      assert.deepEqual(called, f.accounts);
      assert.deepEqual(f.released, f.accounts);
      assert.equal(f.rotations.length, 1);
      assert.deepEqual(f.rotations[0], [model, f.accounts[0], "gemini-web"]);
      if (status === 401) {
        assert.equal(f.invalid.length, 1);
        assert.equal(f.invalid[0][1], "gemini-web");
      } else {
        assert.equal(f.cooldowns.length, 1);
        assert.deepEqual(f.cooldowns[0].slice(0, 2), [f.accounts[0], "gemini-web"]);
      }
    });
  }

  for (const status of [400, 404, 502]) {
    it(`does not blindly replay HTTP ${status}`, async (t) => {
      const f = fixture();
      let calls = 0;
      t.mock.method(geminiWebAdapter, "forwardRequest", async () => {
        calls++;
        return { endpoint: "web", response: new Response("safe error", { status }) };
      });
      const result = await withRotation(f.rotator, model, {}, body, async () => assert.fail("No output expected"));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, status);
      assert.equal(calls, 1);
      assert.equal(f.rotations.length, 0);
      assert.deepEqual(f.released, [f.accounts[0]]);
    });
  }

  it("respects the retry limit and releases each failed admission once", async (t) => {
    const f = fixture();
    let calls = 0;
    t.mock.method(geminiWebAdapter, "forwardRequest", async () => {
      calls++;
      return { endpoint: "web", response: new Response("temporary failure", { status: 503 }) };
    });
    const result = await withRotation(f.rotator, model, {}, body, async () => assert.fail("No output expected"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 503);
    assert.equal(calls, 2);
    assert.equal(f.rotations.length, 1);
    assert.deepEqual(f.released, f.accounts);
  });

  it("preserves the error when no replacement account exists", async (t) => {
    const f = fixture(1, false);
    t.mock.method(geminiWebAdapter, "forwardRequest", async () => ({
      endpoint: "web", response: new Response("busy", { status: 409 }),
    }));
    const result = await withRotation(f.rotator, model, {}, body, async () => assert.fail("No output expected"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
    assert.equal(f.rotations.length, 1);
    assert.deepEqual(f.released, [f.accounts[0]]);
  });

  it("does not rotate when retries are disabled", async (t) => {
    const f = fixture(0);
    let calls = 0;
    t.mock.method(geminiWebAdapter, "forwardRequest", async () => {
      calls++;
      return { endpoint: "web", response: new Response("busy", { status: 409 }) };
    });
    const result = await withRotation(f.rotator, model, {}, body, async () => assert.fail("No output expected"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
    assert.equal(calls, 1);
    assert.equal(f.rotations.length, 0);
    assert.deepEqual(f.released, [f.accounts[0]]);
  });
});
