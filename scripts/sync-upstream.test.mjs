import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadStableRelease, syncUpstream, UPSTREAM } from "./sync-upstream.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null",
  "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (cwd, file) => JSON.parse(readFileSync(join(cwd, file), "utf8"));
const save = (cwd, file, value) => writeFileSync(join(cwd, file), JSON.stringify(value, null, 2) + "\n");
const commit = (cwd) => { git(cwd, "add", "."); git(cwd, "commit", "-m", "fixture"); };

async function fixture(run, { dependencyConflict = false, codeConflict = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rotator-upstream-test-"));
  const upstream = join(directory, "upstream");
  const cwd = join(directory, "fork");
  const output = join(directory, "prepared");
  try {
    git(directory, "init", "--quiet", upstream);
    const pkg = { name: "fixture", version: "4.2.0", scripts: { test: "node --test" }, dependencies: { example: "1.0.0" } };
    save(upstream, "package.json", pkg);
    save(upstream, "package-lock.json", { name: "fixture", version: pkg.version, lockfileVersion: 3,
      packages: { "": { name: "fixture", version: pkg.version, dependencies: pkg.dependencies } } });
    writeFileSync(join(upstream, "shared.txt"), "original\n");
    commit(upstream);
    const baseCommit = git(upstream, "rev-parse", "HEAD");
    git(upstream, "tag", "v4.2.0");
    git(directory, "clone", "--quiet", upstream, cwd);
    save(cwd, "fork-base.json", { repository: UPSTREAM, tag: "v4.2.0", commit: baseCommit });
    pkg.version = "4.2.0-argon.3";
    pkg.scripts["test:gemini-web"] = "python3 -m unittest";
    if (dependencyConflict) pkg.dependencies.example = "2.0.0";
    save(cwd, "package.json", pkg);
    const lock = read(cwd, "package-lock.json");
    lock.version = lock.packages[""].version = pkg.version;
    lock.packages[""].dependencies = pkg.dependencies;
    save(cwd, "package-lock.json", lock);
    writeFileSync(join(cwd, "argon.txt"), "keep this fork feature\n");
    if (codeConflict) writeFileSync(join(cwd, "shared.txt"), "fork change\n");
    commit(cwd);
    const sourceHead = git(cwd, "rev-parse", "HEAD");
    const options = { cwd, output, upstream, releaseLookup: async () => "v4.3.0" };
    function advance({ tag = "v4.3.0", version = tag.slice(1), annotated = false } = {}) {
      const next = read(upstream, "package.json");
      next.version = version;
      next.dependencies.example = "3.0.0";
      save(upstream, "package.json", next);
      const nextLock = read(upstream, "package-lock.json");
      nextLock.version = nextLock.packages[""].version = version;
      nextLock.packages[""].dependencies = next.dependencies;
      save(upstream, "package-lock.json", nextLock);
      writeFileSync(join(upstream, "shared.txt"), "upstream fix\n");
      commit(upstream);
      if (annotated) git(upstream, "tag", "-a", tag, "-m", "stable release");
      else git(upstream, "tag", tag);
      return git(upstream, "rev-parse", "HEAD");
    }
    await run({ directory, cwd, output, upstream, baseCommit, sourceHead, options, advance });
    assert.equal(git(cwd, "rev-parse", "HEAD"), sourceHead, "Source HEAD must remain unchanged");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release discovery uses stable GitHub releases and validates API failures", async () => {
  for (const tag of [undefined, "v4.3.0"]) {
    const selected = await loadStableRelease(tag, async (url) => {
      assert.ok(url.endsWith(tag ? `/tags/${tag}` : "/latest"));
      return { ok: true, json: async () => ({ tag_name: "v4.3.0", draft: false, prerelease: false }) };
    });
    assert.equal(selected, "v4.3.0");
  }
  for (const invalid of [{ draft: true }, { prerelease: true }, { tag_name: "v4.3.0-rc.1" }, { tag_name: "v04.3.0" }]) {
    await assert.rejects(loadStableRelease(undefined, async () => ({ ok: true,
      json: async () => ({ tag_name: "v4.3.0", draft: false, prerelease: false, ...invalid }) })));
  }
  await assert.rejects(loadStableRelease(undefined, async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(loadStableRelease("v4.3.0", async () => ({ ok: true,
    json: async () => ({ tag_name: "v4.4.0", draft: false, prerelease: false }) })), /different release/);
});

test("prepares an isolated merge, preserves fork features and updates both lockfile versions", () => fixture(async ({ options, cwd, output, sourceHead, advance }) => {
  const nextCommit = advance();
  const result = await syncUpstream(options);
  assert.equal(result.status, "prepared");
  assert.equal(result.version, "4.3.0-argon.1");
  assert.equal(read(output, "package.json").version, result.version);
  assert.equal(read(output, "package-lock.json").version, result.version);
  assert.equal(read(output, "package-lock.json").packages[""].version, result.version);
  assert.equal(read(output, "package.json").dependencies.example, "3.0.0");
  assert.equal(read(output, "package.json").scripts["test:gemini-web"], "python3 -m unittest");
  assert.equal(readFileSync(join(output, "argon.txt"), "utf8"), "keep this fork feature\n");
  assert.equal(read(output, "fork-base.json").commit, nextCommit);
  assert.equal(git(output, "rev-parse", "MERGE_HEAD"), nextCommit);
  assert.equal(git(output, "rev-parse", "HEAD"), sourceHead, "Preparation must not create commits");
  assert.equal(git(cwd, "status", "--porcelain"), "");
  // Commit only inside the disposable fixture, as the publishing workflow does.
  git(output, "commit", "-m", "test prepared merge");
  const checker = fileURLToPath(new URL("./check-fork-base.mjs", import.meta.url));
  const checked = spawnSync(process.execPath, [checker, "--require-clean"], { cwd: output, encoding: "utf8",
    env: { ...process.env, GITHUB_REF_TYPE: "branch", ROTATOR_EXPECTED_UPSTREAM_COMMIT: "" } });
  assert.equal(checked.status, 0, checked.stderr);
}));

test("stops on a code conflict and preserves the conflicting copy", () => fixture(async ({ options, output, advance }) => {
  advance();
  const result = await syncUpstream(options);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["shared.txt"]);
  assert.match(readFileSync(join(output, "shared.txt"), "utf8"), /<<<<<<< HEAD/);
}, { codeConflict: true }));

test("does not resolve conflicting dependencies as a version-only change", () => fixture(async ({ options, advance }) => {
  advance();
  const result = await syncUpstream(options);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["package-lock.json", "package.json"]);
}, { dependencyConflict: true }));

test("read-only discovery accepts a dirty source while preparation refuses it", () => fixture(async ({ options, cwd, output, advance }) => {
  advance();
  writeFileSync(join(cwd, "untracked.txt"), "preserve me");
  const before = git(cwd, "show-ref");
  const result = await syncUpstream({ ...options, output: undefined });
  assert.equal(result.status, "available");
  assert.equal(result.dirty, true);
  assert.equal(git(cwd, "show-ref"), before, "Discovery must not fetch or alter refs");
  await assert.rejects(syncUpstream(options), /Source tree must be clean/);
  assert.equal(existsSync(output), false);
  assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf8"), "preserve me");
}));

test("an already integrated release is a no-op and a retagged release is rejected", () => fixture(async ({ options, output, upstream }) => {
  const current = { ...options, releaseLookup: async () => "v4.2.0" };
  assert.equal((await syncUpstream(current)).status, "up-to-date");
  assert.equal(existsSync(output), false);
  writeFileSync(join(upstream, "new.txt"), "retag");
  commit(upstream);
  git(upstream, "tag", "--force", "v4.2.0");
  await assert.rejects(syncUpstream(current), /release tag has moved/);
}));

test("annotated releases use the peeled commit rather than the tag object", () => fixture(async ({ options, advance }) => {
  const expected = advance({ annotated: true });
  const result = await syncUpstream(options);
  assert.equal(result.commit, expected);
  assert.equal(result.status, "prepared");
}));

test("rejects a downgrade, malformed tags and a tag/package version mismatch", () => fixture(async ({ options, advance }) => {
  await assert.rejects(syncUpstream({ ...options, releaseLookup: async () => "v4.1.9" }), /downgrade/);
  await assert.rejects(syncUpstream({ ...options, tag: "--bad-ref" }));
  advance({ version: "4.3.1" });
  await assert.rejects(syncUpstream(options), /tag and package version differ/);
}));

test("refuses an existing destination or a destination inside the source tree", () => fixture(async ({ options, cwd, directory, advance }) => {
  advance();
  await assert.rejects(syncUpstream({ ...options, output: directory }), /already exists/);
  await assert.rejects(syncUpstream({ ...options, output: join(cwd, "output") }), /outside the source tree/);
}));

test("pins discovery to its exact commit before preparing or publishing", () => fixture(async ({ options, advance, output }) => {
  advance();
  await assert.rejects(syncUpstream({ ...options, expectedCommit: "0".repeat(40) }), /changed after discovery/);
  assert.equal(existsSync(output), false);
}));

test("rejects a release from rewritten upstream history", () => fixture(async ({ options, upstream }) => {
  git(upstream, "checkout", "--orphan", "rewritten");
  const pkg = read(upstream, "package.json");
  pkg.version = "4.3.0";
  save(upstream, "package.json", pkg);
  commit(upstream);
  git(upstream, "tag", "v4.3.0");
  await assert.rejects(syncUpstream(options), /does not descend from the recorded base/);
}));

test("does not replace a missing Git release tag with another ref", () => fixture(async ({ options, output }) => {
  await assert.rejects(syncUpstream(options), /tag was not found/);
  assert.equal(existsSync(output), false);
}));
