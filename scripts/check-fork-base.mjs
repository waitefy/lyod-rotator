#!/usr/bin/env node
// Validate the recorded upstream base before testing or releasing a fork.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--require-clean"),
  "Usage: node scripts/check-fork-base.mjs [--require-clean]");
const git = (...values) => execFileSync("git", values, { encoding: "utf8", timeout: 10_000 }).trim();
const base = JSON.parse(readFileSync("fork-base.json", "utf8"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
assert.equal(base.repository, "https://github.com/tuxevil/tuxevil-rotator.git");
assert.match(base.tag, /^v\d+\.\d+\.\d+$/);
assert.match(base.commit, /^[a-f0-9]{40}$/);
assert.ok(version.startsWith(`${base.tag.slice(1)}-argon.`) && /-argon\.[1-9]\d*$/.test(version),
  "Fork version must match the upstream version and include an Argon revision");
git("merge-base", "--is-ancestor", base.commit, "HEAD");
const upstreamPackage = JSON.parse(git("show", `${base.commit}:package.json`));
assert.equal(upstreamPackage.version, base.tag.slice(1), "Recorded upstream commit has another version");
if (process.env.ROTATOR_EXPECTED_UPSTREAM_COMMIT) {
  assert.equal(base.commit, process.env.ROTATOR_EXPECTED_UPSTREAM_COMMIT,
    "Prepared branch does not contain the selected upstream release");
}
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, "Release tag differs from package.json");
}
const dirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
if (args.includes("--require-clean")) assert.equal(dirty, false, "Release source tree must be clean");
console.log(JSON.stringify({ version, upstream: base, sourceCommit: git("rev-parse", "HEAD"), dirty }));
