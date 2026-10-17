#!/usr/bin/env node
// Runs only an isolated container with empty data and no provider credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2];
if (!image || image.startsWith("-") || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/smoke-gemini-web-image.mjs <image>");
}
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
}).trim();
const root = new URL("../", import.meta.url);
const expectedVersion = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
const expectedBase = JSON.parse(readFileSync(new URL("fork-base.json", root), "utf8"));
const expectedEngine = JSON.parse(readFileSync(new URL("gemini-engine.json", root), "utf8")).engine;
const expectedClient = readFileSync(new URL("requirements-gemini-web.txt", root), "utf8")
  .match(/gemini-webapi\s*@\s*git\+[^\s]+@([a-f0-9]{40})/)[1];
const name = `rotator-argon-smoke-${randomUUID()}`;
const temporary = mkdtempSync(join(tmpdir(), "rotator-image-smoke-"));
let created = false;
try {
  // The normal CLI requires an account, even when only checking local routes.
  // A nonexistent cookie file makes this fixture unusable for authentication.
  const fixture = join(temporary, "accounts.json");
  writeFileSync(fixture, JSON.stringify({
    accounts: [{ email: "image-smoke@example.invalid", credentials: [
      { provider: "gemini-web", cookiesFile: "/sessions/missing-smoke-cookies.json" },
    ] }],
    disabledProviders: ["gemini-web"],
  }));
  docker("create", "--pull=never", "--name", name,
    "--publish", "127.0.0.1::51200",
    "--env", "TUXEVIL_ROTATOR_TELEMETRY=off",
    "--env", "TUXEVIL_ROTATOR_ADMIN_TOKEN=isolated-image-smoke",
    image);
  created = true;
  docker("cp", fixture, `${name}:/data/accounts.json`);
  docker("start", name);
  const info = JSON.parse(docker("exec", name, "cat", "/app/build-info.json"));
  assert.equal(info.version, expectedVersion);
  assert.deepEqual(info.upstream, expectedBase);
  assert.equal(info.geminiWebapi.commit, expectedClient);
  assert.deepEqual(info.geminiEngine, expectedEngine);
  assert.equal(docker("exec", name, "/usr/local/bin/rotator-gemini-engine", "--version"), expectedEngine.commit);
  const expectedCommit = process.env.ROTATOR_EXPECTED_COMMIT || process.env.GITHUB_SHA;
  if (expectedCommit) assert.equal(info.source.commit, expectedCommit);
  const nodeMajor = Number(docker("exec", name, "node", "-p", "process.versions.node.split('.')[0]"));
  assert.ok(nodeMajor >= 22, "Node.js 22+ is required");
  docker("exec", name, "/opt/gemini-web/bin/python", "-c", `
import importlib.metadata, json, sys
from pathlib import Path
from gemini_webapi import GeminiClient
assert sys.version_info >= (3, 11)
assert callable(GeminiClient.generate_content_stream)
installed = json.loads(importlib.metadata.distribution("gemini-webapi").read_text("direct_url.json"))
info = json.loads(Path("/app/build-info.json").read_text())
assert installed["vcs_info"]["commit_id"] == info["geminiWebapi"]["commit"]
sys.path.insert(0, "/app/src/providers/gemini-web")
import worker, session, browser_login
`);
  const bindings = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports["51200/tcp"];
  const port = bindings.find((binding) => binding.HostIp === "127.0.0.1")?.HostPort;
  assert.ok(port, "Container must expose an isolated loopback port");
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.equal(catalog.object, "list");
      assert.ok(Array.isArray(catalog.data));
      ready = true;
      break;
    } catch (error) {
      lastError = error;
      const state = JSON.parse(docker("inspect", name))[0].State;
      assert.ok(state.Running, `Container exited before HTTP startup (exit ${state.ExitCode})`);
      await delay(500);
    }
  }
  assert.ok(ready, `HTTP startup failed: ${lastError}`);
  const dashboard = await fetch(`${endpoint}/dashboard`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("content-type"), /text\/html/);
  console.log(JSON.stringify({ result: "passed", image, version: info.version,
    upstream: info.upstream.tag, clientCommit: expectedClient, credentialsUsed: false }));
} catch (error) {
  if (created) console.error(docker("logs", "--tail", "80", name));
  throw error;
} finally {
  try {
    if (created) docker("rm", "--force", "--volumes", name);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
