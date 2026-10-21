import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AccountRuntime } from "../src/types.js";

const directory = mkdtempSync(join(tmpdir(), "lyod-binding-runtime-"));
process.env.TUXEVIL_ROTATOR_DIR = directory;
process.env.PI_ROTATOR_DIR = directory;
let Rotator: typeof import("../src/rotator.js").AccountRotator;
let identity: typeof import("../src/account-identity.js").getAccountIdentity;
let closeDb: typeof import("../src/db-store.js").closeDb;
const bridge = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ accountId: "deepseek-id", data: [] }));
});
const file = join(directory, "session.json");
before(async () => {
  const db = await import("../src/db-store.js");
  await db.initDb(); closeDb = db.closeDb;
  ({ AccountRotator: Rotator } = await import("../src/rotator.js"));
  ({ getAccountIdentity: identity } = await import("../src/account-identity.js"));
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address(); assert.ok(address && typeof address === "object");
  writeFileSync(file, JSON.stringify({ provider: "deepseek-app", email: "opaque@deepseek-app.local", accountId: "deepseek-id",
    apiKey: "fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, availableModels: [] }), { mode: 0o600 });
});
after(async () => {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  await closeDb(); rmSync(directory, { recursive: true, force: true });
});

it("moves the real runtime credential without resurrecting it on the source, and refuses active requests", async () => {
  const rotator = new Rotator({ requestsPerRotation: 50, proxyPort: 51200, rotateOnQuotaDrop: 0, quotaPollIntervalMs: 300000,
    accounts: [{ email: "opaque@deepseek-app.local", credentials: [{ provider: "deepseek-app", sessionFile: file },
      { provider: "qwen-app", sessionFile: "/unrelated.json" }] },
    { email: "person@example.test", credentials: [{ provider: "chatgpt-app", sessionFile: "/keep.json" }] }] });
  rotator.stopQuotaPolling();
  try {
    const runtime = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
    const sourceId = identity(runtime[0]); const targetId = identity(runtime[1]);
    runtime[0].inFlightRequests = 1;
    await assert.rejects(rotator.linkWebAppAccount(sourceId, targetId, "deepseek-app"), /active requests/);
    assert.equal(rotator.getConfig().accounts[0].credentials?.length, 2);
    runtime[0].inFlightRequests = 0;
    await rotator.linkWebAppAccount(sourceId, targetId, "deepseek-app");
    const config = rotator.getConfig();
    assert.deepEqual(config.accounts[0].credentials?.map((credential) => credential.provider), ["qwen-app"]);
    assert.deepEqual(config.accounts[1].credentials?.map((credential) => credential.provider).sort(), ["chatgpt-app", "deepseek-app"]);
    assert.equal(config.accounts[1].credentials?.find((credential) => credential.provider === "deepseek-app")?.providerAccountId, "deepseek-id");
    const { handleCliLoginApi, serveCliLogin } = await import("../src/onboarding.js");
    let response = "";
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(body: string) { response = body; } } as unknown as ServerResponse;
    const req = Readable.from([Buffer.from(JSON.stringify({ provider: "deepseek-app", sessionFile: file }))]) as IncomingMessage;
    req.headers = {};
    await handleCliLoginApi(req, res, rotator);
    assert.equal(status, 200, response);
    assert.equal(JSON.parse(response).email, "person@example.test");
    assert.equal(JSON.parse(response).providerEmail, "opaque@deepseek-app.local");
    assert.equal(rotator.getConfig().accounts.filter((entry) => entry.credentials?.some((credential) => credential.provider === "deepseek-app")).length, 1);
    serveCliLogin(res, rotator, "person@example.test");
    assert.match(response, /id="deepseek-connect" data-account="opaque@deepseek-app.local"/);
  } finally { rotator.stopQuotaPolling(); await rotator.flushPendingStateSave(); }
});
