import assert from "node:assert/strict";
import { it } from "node:test";
import { getDefaultConfig } from "../src/config-defaults.js";
import { getAccountIdentity } from "../src/account-identity.js";
import { bindWebAppAccount } from "../src/providers/web-app/binding.js";
import { registeredAccountEmail, sessionMatchesAccount, type WebAppSession } from "../src/providers/web-app/credentials.js";
import type { AccountConfig } from "../src/types.js";

const provider = "deepseek-app";
const source: AccountConfig = { email: "opaque@deepseek-app.local", credentials: [{ provider, sessionFile: "/fixture/session.json" }],
  customQuotas: { [provider]: { requests: 10, windowHours: 24 } } };
const target: AccountConfig = { email: "person@example.test", credentials: [{ provider: "qwen-app", sessionFile: "/fixture/qwen.json" }] };
const verified: AccountConfig = { ...source, credentials: [{ ...source.credentials![0], providerAccountId: "stable-provider-id" }] };
const session: WebAppSession = { provider, email: source.email, accountId: "stable-provider-id", baseUrl: "http://127.0.0.1:3340/v1",
  apiKey: "fixture", availableModels: [] };
const config = () => ({ ...getDefaultConfig(), accounts: structuredClone([source, target]) });

it("links a verified identity, retains target providers and removes the empty technical card", () => {
  const original = config();
  const result = bindWebAppAccount(original, getAccountIdentity(source), getAccountIdentity(target), provider, verified);
  assert.equal(result.accounts.length, 1);
  assert.equal(original.accounts.length, 2);
  assert.equal(result.accounts[0].email, target.email);
  assert.deepEqual(result.accounts[0].credentials?.map((credential) => credential.provider), ["qwen-app", provider]);
  assert.deepEqual(result.accounts[0].customQuotas?.[provider], source.customQuotas![provider]);
  assert.ok(sessionMatchesAccount(session, result.accounts[0]));
  assert.equal(registeredAccountEmail(verified, result.accounts, provider), target.email);
});

it("keeps unrelated source credentials and budgets instead of deleting their account", () => {
  const original = config();
  original.accounts[0].credentials!.push({ provider: "chatgpt-app", sessionFile: "/fixture/chatgpt.json" });
  original.accounts[0].customQuotas!["chatgpt-app"] = { requests: 5, windowHours: 1 };
  const result = bindWebAppAccount(original, getAccountIdentity(original.accounts[0]), getAccountIdentity(target), provider, verified);
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts[0].credentials?.map((credential) => credential.provider), ["chatgpt-app"]);
  assert.equal(result.accounts[0].customQuotas?.[provider], undefined);
  assert.equal(result.accounts[1].customQuotas?.["chatgpt-app"], undefined);
});

it("rejects missing, identical, changed source and conflicting target connections", () => {
  assert.throws(() => bindWebAppAccount(config(), "missing", getAccountIdentity(target), provider, verified));
  assert.throws(() => bindWebAppAccount(config(), getAccountIdentity(source), getAccountIdentity(source), provider, verified));
  assert.throws(() => bindWebAppAccount(config(), getAccountIdentity(source), getAccountIdentity(target), provider,
    { ...verified, credentials: [{ provider, sessionFile: "/different/session.json", providerAccountId: "other" }] }));
  const conflict = config();
  conflict.accounts[1].credentials!.push({ provider, sessionFile: "/not-a-verified-session.json", providerAccountId: "different" });
  assert.throws(() => bindWebAppAccount(conflict, getAccountIdentity(source), getAccountIdentity(conflict.accounts[1]), provider, verified));
});

it("preserves legacy email checks and rejects a mismatching provider ID even with matching email", () => {
  assert.ok(sessionMatchesAccount(session, source));
  assert.equal(sessionMatchesAccount(session, target), false);
  assert.equal(sessionMatchesAccount(session, { ...source, credentials: [{ provider, providerAccountId: "wrong" }] }), false);
});

it("does not guess links and rejects ambiguous bindings during repeat registration", () => {
  assert.equal(registeredAccountEmail(verified, [target], provider), source.email);
  const bound = { ...target, credentials: verified.credentials };
  assert.equal(registeredAccountEmail(verified, [bound], provider), target.email);
  assert.throws(() => registeredAccountEmail(verified, [source, bound], provider));
});
