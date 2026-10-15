import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./check-fork-base.mjs", import.meta.url));

function fixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), "rotator-provenance-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const json = (name, value) => writeFileSync(join(cwd, name), JSON.stringify(value) + "\n");
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  };
  try {
    git("init", "--quiet");
    json("package.json", { version: "4.2.0" });
    commit();
    const base = { repository: "https://github.com/tuxevil/tuxevil-rotator.git", tag: "v4.2.0", commit: git("rev-parse", "HEAD") };
    json("fork-base.json", base);
    json("package.json", { version: "4.2.0-argon.1" });
    commit();
    const check = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "test",
        ROTATOR_EXPECTED_UPSTREAM_COMMIT: "", ...env },
    });
    run({ cwd, base, json, git, commit, check });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("accepts a clean fork descended from its recorded upstream version", () => fixture(({ check }) => {
  const result = check(["--require-clean"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dirty, false);
}));

test("checks a prepared branch against the exact selected upstream release", () => fixture(({ base, check }) => {
  assert.equal(check([], { ROTATOR_EXPECTED_UPSTREAM_COMMIT: base.commit }).status, 0);
  const mismatch = check([], { ROTATOR_EXPECTED_UPSTREAM_COMMIT: "0".repeat(40) });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not contain the selected upstream release/);
}));

test("rejects stale base metadata after a package version update", () => fixture(({ json, check }) => {
  json("package.json", { version: "4.3.0-argon.1" });
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fork version must match/);
}));

test("rejects an upstream commit that has the wrong package version", () => fixture(({ base, git, commit, json, check }) => {
  json("package.json", { version: "4.3.0" });
  commit();
  json("fork-base.json", { ...base, commit: git("rev-parse", "HEAD") });
  json("package.json", { version: "4.2.0-argon.1" });
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Recorded upstream commit has another version/);
}));

test("rejects a commit outside the fork's ancestry", () => fixture(({ base, git, json, check }) => {
  const tree = git("rev-parse", "HEAD^{tree}");
  const unrelated = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "unrelated fixture");
  json("fork-base.json", { ...base, commit: unrelated });
  assert.notEqual(check().status, 0);
}));

test("reports local changes and rejects them when clean sources are required", () => fixture(({ cwd, check }) => {
  writeFileSync(join(cwd, "untracked.txt"), "local change");
  const local = check();
  assert.equal(local.status, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).dirty, true);
  const release = check(["--require-clean"]);
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /Release source tree must be clean/);
}));

test("rejects a release tag that differs from the package version", () => fixture(({ check }) => {
  const result = check([], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v4.2.0-argon.2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release tag differs/);
  assert.equal(check([], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v4.2.0-argon.1" }).status, 0);
}));
