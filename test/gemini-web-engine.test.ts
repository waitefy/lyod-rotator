import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runWebWorker, webEngineBackend } from "../src/providers/gemini-web/forward.js";
import { createToolBridge } from "../src/providers/gemini-web/tool-bridge.js";

const temp = await mkdtemp(join(tmpdir(), "rotator-go-contract-"));
after(() => rm(temp, { recursive: true, force: true }));
const declaration = { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const payload = { mode: "generate", engineRequest: { tools: [{ functionDeclarations: [declaration] }] } };
async function fakeEngine(source: string, run: () => Promise<void>): Promise<void> {
  const keys = ["TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND", "TUXEVIL_ROTATOR_GEMINI_WEB_ENGINE"] as const;
  const previous = keys.map(key => process.env[key]);
  const path = join(temp, "engine");
  await writeFile(path, `#!/usr/bin/env python3\nimport json,sys,time\nreceived=json.load(sys.stdin)\n${source}\n`, { mode: 0o700 });
  process.env[keys[0]] = "go";
  process.env[keys[1]] = path;
  try { await run(); } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
}
describe("Go engine worker boundary", () => {
  it("uses the same default egress for login probes and generation while preserving account overrides", async () => {
    const previous = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY;
    process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY = "http://127.0.0.1:12080";
    try {
      for (const mode of ["probe", "generate"]) {
        for (const proxy of [undefined, "http://127.0.0.1:12081", ""]) {
          const expected = proxy ?? process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY;
          await fakeEngine(`assert received.get('proxy') == ${JSON.stringify(expected)}
print(json.dumps({'type':'ready'}),flush=True)
print(json.dumps({'type':'done'}),flush=True)`, async () => {
            const { response } = await runWebWorker({ mode, proxy });
            assert.equal(response.status, 200, await response.text());
          });
        }
      }
    } finally {
      if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY;
      else process.env.TUXEVIL_ROTATOR_GEMINI_WEB_PROXY = previous;
    }
  });
  it("streams verified text before completion even when tools are declared", async () => {
    await fakeEngine(`print(json.dumps({'type':'ready'}),flush=True)
print(json.dumps({'type':'delta','text':'first'}),flush=True)
time.sleep(0.3)
print(json.dumps({'type':'delta','text':'second'}),flush=True)
print(json.dumps({'type':'done'}),flush=True)`, async () => {
      const { response } = await runWebWorker(payload, undefined, createToolBridge([declaration]));
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /first/);
      assert.doesNotMatch(first, /second/);
      let rest = "";
      for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
      assert.match(rest, /second/);
    });
  });
  it("accepts a complete schema-valid tool and rejects unknown or invalid calls", async () => {
    for (const [name, args, status] of [["read", { path: "x" }, 200], ["exec", {}, 502], ["read", { path: 1 }, 502]] as const) {
      await fakeEngine(`for event in ${JSON.stringify([{ type: "ready" }, { type: "tools", calls: [{ name, args }] }, { type: "done" }])}:
 print(json.dumps(event),flush=True)`, async () => {
        const { response } = await runWebWorker(payload, undefined, createToolBridge([declaration]));
        assert.equal(response.status, status);
        const output = await response.text();
        if (status === 200) assert.match(output, /functionCall/);
        else assert.doesNotMatch(output, /functionCall/);
      });
    }
  });
  it("cancels a running engine stream", async () => {
    await fakeEngine(`print(json.dumps({'type':'ready'}),flush=True)\ntime.sleep(60)`, async () => {
      const controller = new AbortController();
      const { response } = await runWebWorker({}, controller.signal);
      controller.abort();
      await assert.rejects(response.text());
    });
  });
  it("fails closed on invalid configuration", () => {
    const previous = process.env.TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND;
    try { process.env.TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND = "invalid"; assert.throws(webEngineBackend, /Invalid Gemini Web backend/); }
    finally { if (previous === undefined) delete process.env.TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND; else process.env.TUXEVIL_ROTATOR_GEMINI_WEB_BACKEND = previous; }
  });
});
