import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AccountConfig } from "../src/types.js";
import { checkGeminiWebRuntime, diagnoseGeminiWeb, type GeminiWebCheck } from "../src/providers/gemini-web/diagnostics.js";

const runtimeReady = async (): Promise<GeminiWebCheck> => ({ code: "runtime-ready", severity: "info", message: "Runtime ready" });
const secret = "PRIVATE_COOKIE_OR_EXCEPTION_MUST_NOT_APPEAR";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "argon-diagnostics-"));
  const cookiesFile = join(directory, "cookies.json");
  await writeFile(cookiesFile, JSON.stringify({ "__Secure-1PSID": secret }), { mode: 0o600 });
  const account: AccountConfig = { email: "fixture@example.invalid", credentials: [
    { provider: "gemini-web", cookiesFile, proxyUrl: "http://proxy.example.invalid:8080" },
  ] };
  return { directory, cookiesFile, account };
}

describe("Gemini Web diagnostics", () => {
  it("does not inspect Python or contact Google without Gemini Web accounts", async () => {
    const result = await diagnoseGeminiWeb([{ email: "other", credentials: [{ provider: "ollama" }] }], {
      probe: true,
      runtimeCheck: async () => { assert.fail("runtime must not be inspected"); },
      probeSession: async () => { assert.fail("must not probe"); },
    });
    assert.deepEqual(result, { mode: "probe", accountCount: 0, checks: [] });
  });

  it("checks local cookie format without claiming authentication or probing", async (t) => {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const result = await diagnoseGeminiWeb([f.account], { runtimeCheck: runtimeReady,
      probeSession: async () => { assert.fail("offline check must not probe"); } });
    assert.equal(result.mode, "offline");
    assert.equal(result.checks[1].code, "session-file-ready");
    assert.match(result.checks[1].message, /were not checked/);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(f.cookiesFile));
  });

  it("rejects missing, relative, corrupt, oversized and invalid cookies without probing", async (t) => {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const credential = f.account.credentials![0];
    for (const path of [undefined, "relative.json", join(f.directory, "missing.json")]) {
      credential.cookiesFile = path;
      const result = await diagnoseGeminiWeb([f.account], { probe: true, runtimeCheck: runtimeReady,
        probeSession: async () => { assert.fail("invalid cookies must not be probed"); } });
      assert.equal(result.checks[1].code, "session-file-invalid");
    }
    credential.cookiesFile = f.cookiesFile;
    for (const raw of [secret, "[]", "{}", JSON.stringify({ "__Secure-1PSID": " " }),
      JSON.stringify({ "__Secure-1PSID": secret, "__Secure-1PSIDTS": 2 }), "x".repeat(65537)]) {
      await writeFile(f.cookiesFile, raw);
      const result = await diagnoseGeminiWeb([f.account], { probe: true, runtimeCheck: runtimeReady,
        probeSession: async () => { assert.fail("invalid cookies must not be probed"); } });
      assert.equal(result.checks[1].code, "session-file-invalid");
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  });

  it("does not probe when the runtime failed", async (t) => {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const result = await diagnoseGeminiWeb([f.account], { probe: true,
      runtimeCheck: async () => ({ code: "dependency-unavailable", severity: "error", message: "Missing dependency" }),
      probeSession: async () => { assert.fail("must not probe without runtime"); } });
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].code, "dependency-unavailable");
  });

  for (const [status, protocolError, code] of [
    [200, false, "connected"], [401, false, "auth-required"], [403, false, "blocked"],
    [404, false, "argon-unavailable"], [409, false, "session-busy"], [429, false, "rate-limited"],
    [502, true, "protocol-error"], [502, false, "upstream-error"], [503, false, "service-unavailable"],
    [504, false, "timeout"],
  ] as const) {
    it(`reports ${code} with a fixed message and correct severity`, async (t) => {
      const f = await fixture();
      t.after(() => rm(f.directory, { recursive: true, force: true }));
      const result = await diagnoseGeminiWeb([f.account], { probe: true, runtimeCheck: runtimeReady,
        probeSession: async (account) => { assert.equal(account, f.account); return { status, protocolError }; } });
      assert.equal(result.checks[1].code, code);
      assert.equal(result.checks[1].severity, status === 200 ? "info" : "error");
      if (status !== 200) assert.ok(result.checks[1].action);
    });
  }

  it("checks runtime once and probes accounts sequentially", async (t) => {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const order: string[] = [];
    let active = 0;
    let runtimeCalls = 0;
    const result = await diagnoseGeminiWeb([f.account, { ...f.account, email: "second" }], { probe: true,
      runtimeCheck: async () => { runtimeCalls++; return runtimeReady(); },
      probeSession: async (account) => {
        assert.equal(active++, 0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push(account.email);
        active--;
        return { status: 200 };
      } });
    assert.equal(runtimeCalls, 1);
    assert.deepEqual(order, [f.account.email, "second"]);
    assert.equal(result.checks.length, 3);
  });
});

describe("Gemini Web runtime check", () => {
  for (const code of ["runtime-ready", "python-version", "worker-import-failed", "dependency-unavailable"] as const) {
    it(`recognises the ${code} runtime result`, async (t) => {
      const f = await fixture();
      t.after(() => rm(f.directory, { recursive: true, force: true }));
      const python = join(f.directory, "python");
      await writeFile(python, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(code)});`, { mode: 0o700 });
      const result = await checkGeminiWebRuntime(python);
      assert.equal(result.code, code);
      assert.equal(result.severity, code === "runtime-ready" ? "info" : "error");
    });
  }

  it("does not expose stdout, stderr or exception details", async (t) => {
    const f = await fixture();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    assert.equal((await checkGeminiWebRuntime(join(f.directory, "missing"))).code, "python-unavailable");
    const python = join(f.directory, "python");
    for (const exit of [0, 1]) {
      await writeFile(python, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(secret)}); console.error(${JSON.stringify(secret)}); process.exit(${exit});`, { mode: 0o700 });
      const result = await checkGeminiWebRuntime(python);
      assert.equal(result.code, exit ? "python-unavailable" : "runtime-protocol-error");
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  });
});

describe("doctor Gemini Web command", () => {
  for (const mode of ["offline", "connected", "expired", "protocol", "incomplete"] as const) {
    it(`runs the ${mode} check through the CLI using an isolated worker`, async (t) => {
      const f = await fixture();
      t.after(() => rm(f.directory, { recursive: true, force: true }));
      await writeFile(join(f.directory, "accounts.json"), JSON.stringify({ accounts: [f.account], proxyPort: 51200 }));
      const python = join(f.directory, "python");
      const events = mode === "expired" ? [{ type: "error", status: 401, message: secret }]
        : mode === "protocol" ? ["INVALID_JSON"] : mode === "incomplete" ? [{ type: "ready" }]
        : [{ type: "ready" }, { type: "done" }];
      await writeFile(python, `#!/usr/bin/env node
if (process.argv[2] === '-c') { console.log('runtime-ready'); process.exit(0); }
if (${JSON.stringify(mode)} === 'offline') process.exit(9);
let input=''; process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
 const payload = JSON.parse(input);
 if (payload.mode !== 'probe' || payload.prompt !== undefined || payload.proxy !== 'http://proxy.example.invalid:8080') process.exit(8);
 for (const event of ${JSON.stringify(events)}) console.log(typeof event === 'string' ? event : JSON.stringify(event));
});`, { mode: 0o700 });
      const result = spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "doctor", "--config-dir", f.directory,
        ...(mode === "offline" ? [] : ["--gemini-web-probe"])], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 20000,
        env: { ...process.env, TUXEVIL_ROTATOR_DIR: f.directory, TUXEVIL_ROTATOR_DATABASE_URL: "", DATABASE_URL: "",
          TUXEVIL_ROTATOR_GEMINI_WEB_PYTHON: python },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, ["offline", "connected"].includes(mode) ? 0 : 1, result.stdout + result.stderr);
      const expected = mode === "offline" ? "session-file-ready" : mode === "connected" ? "connected"
        : mode === "expired" ? "auth-required" : "protocol-error";
      assert.match(result.stdout, new RegExp(`"code":"${expected}"`));
      assert.ok(!(result.stdout + result.stderr).includes(secret));
      assert.ok(!result.stdout.includes("proxy.example.invalid"));
    });
  }
});
