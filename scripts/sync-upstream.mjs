#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const UPSTREAM = "https://github.com/tuxevil/tuxevil-rotator.git";
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const gitOptions = (cwd) => ({ cwd, encoding: "utf8", timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  stdio: ["ignore", "pipe", "pipe"] });
const gitArgs = (args) => ["-c", "core.hooksPath=/dev/null", "-c", "rerere.enabled=false",
  "-c", "user.name=Rotator upstream sync", "-c", "user.email=rotator-sync@example.invalid", ...args];
const git = (cwd, ...args) => execFileSync("git", gitArgs(args), gitOptions(cwd)).trim();

export async function loadStableRelease(tag, fetchImpl = fetch) {
  if (tag) assert.match(tag, stableTag, "Only stable vX.Y.Z releases are supported");
  const endpoint = tag ? `tags/${tag}` : "latest";
  const response = await fetchImpl(`https://api.github.com/repos/tuxevil/tuxevil-rotator/releases/${endpoint}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "rotator-argon-upstream-sync" },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Upstream release lookup failed (HTTP ${response.status})`);
  const release = await response.json();
  assert.equal(release.draft, false, "Draft releases are not supported");
  assert.equal(release.prerelease, false, "Prereleases are not supported");
  assert.match(release.tag_name, stableTag, "Only stable vX.Y.Z releases are supported");
  if (tag) assert.equal(release.tag_name, tag, "Upstream returned a different release");
  return release.tag_name;
}

function compareTags(left, right) {
  const a = left.match(stableTag).slice(1).map(BigInt);
  const b = right.match(stableTag).slice(1).map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function setVersion(document, version, lock) {
  document.version = version;
  if (lock) {
    assert.ok(document.packages?.[""], "A modern package-lock.json with a root package is required");
    document.packages[""].version = version;
  }
  return document;
}

function mergeManifest(cwd, file, forkVersion) {
  // Remove only our version suffix before a regular textual three-way merge.
  // Conflicting dependencies or other metadata remain unresolved.
  const base = git(cwd, "show", `:1:${file}`);
  const ours = jsonFromStage(2);
  const theirs = jsonFromStage(3);
  const ancestor = JSON.parse(base);
  assert.equal(ours.version, forkVersion, `Unexpected fork version in ${file}`);
  const lock = file === "package-lock.json";
  if (lock) {
    for (const value of [ancestor, ours, theirs]) {
      assert.equal(value.packages?.[""].version, value.version, "Inconsistent lockfile root version");
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), "rotator-manifest-merge-"));
  try {
    const paths = ["ours", "base", "theirs"].map((name) => join(temporary, name));
    const normalized = setVersion(ours, ancestor.version, lock);
    [normalized, ancestor, theirs].forEach((value, i) => save(paths[i], value));
    const merged = spawnSync("git", gitArgs(["merge-file", "--stdout", ...paths]), gitOptions(cwd));
    assert.ifError(merged.error);
    if (merged.status !== 0) return false;
    writeFileSync(join(cwd, file), merged.stdout);
    git(cwd, "add", "--", file);
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  function jsonFromStage(stage) { return JSON.parse(git(cwd, "show", `:${stage}:${file}`)); }
}

// `upstream` and `releaseLookup` are injectable for local Git fixtures; the CLI
// always uses the official repository and the GitHub stable-release API.
export async function syncUpstream({ cwd = process.cwd(), output, tag, expectedCommit,
  upstream = UPSTREAM, releaseLookup = loadStableRelease } = {}) {
  cwd = realpathSync(cwd);
  assert.equal(realpathSync(git(cwd, "rev-parse", "--show-toplevel")), cwd, "Run from the repository root");
  const base = json(join(cwd, "fork-base.json"));
  const fork = json(join(cwd, "package.json"));
  assert.equal(base.repository, UPSTREAM, "Unexpected upstream repository");
  assert.match(base.tag, stableTag);
  assert.match(base.commit, /^[a-f0-9]{40}$/);
  assert.match(fork.version, new RegExp(`^${base.tag.slice(1).replaceAll(".", "\\.")}-argon\\.[1-9]\\d*$`));
  git(cwd, "merge-base", "--is-ancestor", base.commit, "HEAD");
  assert.equal(JSON.parse(git(cwd, "show", `${base.commit}:package.json`)).version, base.tag.slice(1));
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=normal").length > 0;
  if (output) assert.equal(dirty, false, "Source tree must be clean before preparing an update");
  if (tag) assert.match(tag, stableTag);
  const selected = await releaseLookup(tag);
  assert.match(selected, stableTag);
  if (tag) assert.equal(selected, tag, "Release lookup returned another tag");
  const comparison = compareTags(selected, base.tag);
  assert.ok(comparison >= 0, "Refusing to downgrade the upstream base");
  const ref = `refs/tags/${selected}`;
  const refs = new Map(git(cwd, "ls-remote", "--tags", upstream, ref, `${ref}^{}`)
    .split("\n").filter(Boolean).map((line) => line.split(/\s+/).reverse()));
  const commit = refs.get(`${ref}^{}`) || refs.get(ref);
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "Stable release tag was not found in upstream Git");
  if (expectedCommit) assert.equal(commit, expectedCommit, "Upstream release changed after discovery");
  if (comparison === 0) assert.equal(commit, base.commit, "Recorded upstream release tag has moved");
  const result = { status: comparison === 0 ? "up-to-date" : "available", tag: selected, commit,
    version: comparison === 0 ? fork.version : `${selected.slice(1)}-argon.1`,
    branch: `automation/upstream-${selected}`, sourceHead: git(cwd, "rev-parse", "HEAD"), dirty,
    compareUrl: `https://github.com/tuxevil/tuxevil-rotator/compare/${base.tag}...${selected}` };
  if (comparison === 0 || !output) return result;

  const destination = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
  const inside = relative(cwd, destination);
  assert.ok(inside.startsWith(`..${sep}`) || inside === "..", "Output must be outside the source tree");
  assert.ok(!existsSync(destination), "Output directory already exists; refusing to overwrite it");
  git(cwd, "clone", "--no-hardlinks", "--no-checkout", "--no-tags", "--", cwd, destination);
  git(destination, "checkout", "--detach", result.sourceHead);
  git(destination, "fetch", "--no-tags", upstream, commit);
  assert.equal(git(destination, "rev-parse", "FETCH_HEAD^{commit}"), commit);
  const ancestry = spawnSync("git", gitArgs(["merge-base", "--is-ancestor", base.commit, commit]), gitOptions(destination));
  assert.ifError(ancestry.error);
  assert.equal(ancestry.status, 0, "Selected upstream release does not descend from the recorded base");
  assert.equal(JSON.parse(git(destination, "show", `${commit}:package.json`)).version, selected.slice(1),
    "Upstream tag and package version differ");
  const merged = spawnSync("git", gitArgs(["merge", "--no-commit", "--no-ff", commit]), gitOptions(destination));
  assert.ifError(merged.error);
  const conflicts = () => git(destination, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  if (merged.status !== 0) {
    assert.ok(conflicts().length, `Git merge failed: ${merged.stderr}`);
    for (const file of conflicts()) {
      if (["package.json", "package-lock.json"].includes(file)) mergeManifest(destination, file, fork.version);
    }
  }
  if (conflicts().length) return { ...result, status: "conflict", output: destination, conflicts: conflicts() };

  for (const file of ["package.json", "package-lock.json"]) {
    const document = json(join(destination, file));
    assert.equal(document.version, selected.slice(1), `Unexpected merged version in ${file}`);
    if (file === "package-lock.json") assert.equal(document.packages?.[""].version, document.version);
    save(join(destination, file), setVersion(document, result.version, file === "package-lock.json"));
  }
  save(join(destination, "fork-base.json"), { repository: UPSTREAM, tag: selected, commit });
  git(destination, "add", "--", "package.json", "package-lock.json", "fork-base.json");
  git(destination, "diff", "--cached", "--check");
  assert.equal(git(cwd, "rev-parse", "HEAD"), result.sourceHead, "Source HEAD changed during preparation");
  return { ...result, status: "prepared", output: destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    release: { type: "string" }, output: { type: "string" }, report: { type: "string" },
    "expected-commit": { type: "string" },
  } });
  let result;
  try {
    result = await syncUpstream({ tag: values.release, output: values.output, expectedCommit: values["expected-commit"] });
    if (result.status === "conflict") process.exitCode = 2;
  } catch (error) {
    result = { status: "error", error: error.message };
    process.exitCode = 1;
  }
  if (values.report) save(values.report, result);
  if (process.env.GITHUB_OUTPUT) {
    for (const key of ["status", "tag", "commit", "version", "branch"]) {
      if (result[key]) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
