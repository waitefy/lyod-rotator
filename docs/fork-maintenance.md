# Lyod Rotator maintenance

The fork keeps Gemini Web changes on top of a recorded stable rotator release.
`fork-base.json` records that release's repository, tag and commit. The package
version follows `<upstream-version>-argon.<revision>`. The historical suffix is
retained for compatibility with release validation and upstream synchronization;
the product and repository are now named Lyod Rotator. The Gemini Web client is
pinned separately in `requirements-gemini-web.txt`.

The npm updater is disabled in this fork: it must not install the upstream
package over Lyod Rotator. Deploy reviewed fork commits or images instead.

## Validation

Run from the repository root using Node.js 22 and Python 3.11 or newer:

```sh
node scripts/check-fork-base.mjs
node --test scripts/check-fork-base.test.mjs scripts/sync-upstream.test.mjs scripts/omp-gemini-web.test.mjs
npm run check
npm run test:gemini-web
npm run coverage
```

The provenance check verifies that the recorded upstream commit is an ancestor
of HEAD and has the expected package version. Release checks additionally use
`--require-clean` to reject tracked or untracked source changes. Git tags must
match `v<package-version>` when running a tag workflow.

## Container build and startup check

```sh
docker build --file Dockerfile.gemini-web --tag lyod-rotator:local \
  --build-arg ROTATOR_VERSION="$(node -p 'require("./package.json").version')" \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --build-arg VCS_URL=local \
  --build-arg SOURCE_STATE=dirty .
node scripts/smoke-gemini-web-image.mjs lyod-rotator:local
```

Use `SOURCE_STATE=clean` only after validating a clean checkout. The image's
`/app/build-info.json` records the package version, upstream base, source commit,
source state and pinned Gemini Web client. The build rejects a supplied version
that differs from `package.json`.

The startup check creates an isolated container with fresh anonymous data
volumes, disables telemetry and binds a random loopback port. The CLI requires an
account, so the check seeds a fixture account pointing to a nonexistent cookie
file and disables its provider. It checks runtime
imports, the installed client's commit, `/v1/models` and `/dashboard`, then
removes the container and its anonymous volumes. It does not mount account
credentials or make a real Gemini generation request.

## GitHub Actions

- `argon-ci.yml` runs checks on branch pushes and pull requests, then builds and
  starts the Gemini Web image on Linux amd64. It can also be called by another
  workflow.
- `argon-image.yml` repeats those gates before building Linux amd64/arm64
  candidate images. Tags matching `v*-argon.*` publish to the current repository's
  GHCR namespace. Manual runs build without publishing unless `publish` is set.
  Image tags include the package version, source SHA and `candidate`.
- The original upstream workflows run only in `tuxevil/tuxevil-rotator`, so a fork
  does not run the upstream image publication or legacy-image deprecation jobs.

These workflows require the changes to be present in a GitHub repository with
Actions enabled. Local validation does not activate remote automation.

## Upstream synchronization

Read-only discovery can run with local changes present:

```sh
node scripts/sync-upstream.mjs
node scripts/sync-upstream.mjs --release v4.3.0 --report /tmp/argon-sync.json
```

The explicit release is an example; it must exist as a stable GitHub release and
as an upstream Git tag. Drafts, prereleases, downgrades, retagged current releases,
missing tags and rewritten upstream history stop the process. API failures do
not fall back to arbitrary tags or branches.

To prepare an available update, start from a clean committed source tree and
choose a new directory outside it:

```sh
node scripts/sync-upstream.mjs --output /tmp/argon-upstream \
  --report /tmp/argon-sync.json
```

Preparation clones the committed fork into that directory, fetches the exact
release commit and runs a merge without committing. The original checkout is
left alone. Only the fork version suffix in conflicted package manifests is
normalized before repeating a textual three-way merge; dependency and code
conflicts still stop the update. Successful merges update the package version,
both lockfile root versions and `fork-base.json` together. The new fork revision
starts at `<new-upstream-version>-argon.1`.

The result is JSON with `up-to-date`, `available`, `prepared`, `conflict` or
`error` status. Conflicts return exit code 2, other errors return 1. A conflicting
copy is retained for inspection. The script never commits, pushes, installs
dependencies, runs upstream scripts or deploys. An existing destination is never
overwritten. Commit the prepared merge before running provenance checks, because
the new upstream commit must be an ancestor of HEAD.

### Scheduled GitHub workflow

`argon-upstream-sync.yml` checks every six hours after repository variable
`ARGON_UPSTREAM_SYNC_ENABLED` is set to `true`. It operates from the fork's default
branch. Manual runs default to discovery only; set `publish` to prepare and push
an update branch. The workflow must already exist on the default branch for
scheduled runs.

Publication needs secret `UPSTREAM_SYNC_TOKEN`, scoped to this fork with Contents,
Pull requests and Workflows write permissions. A fine-grained token needs
Workflows permission because upstream updates can change workflow files. Do not
place the token in the repository or reports.

The publication path is:

1. Discover and pin a stable upstream tag and its commit.
2. Prepare an isolated merge, stopping on conflicts.
3. Commit the merge in the isolated copy and push `automation/upstream-vX.Y.Z`
   without force. Existing update branches are preserved and checked again.
4. Call `argon-ci.yml` directly with the prepared fork commit and expected upstream
   commit. Both type/test checks and container checks check out that exact source;
   the image metadata is checked against it. CI does not depend on a push from a
   workflow triggering another workflow.
5. Open a draft PR with a link to the checks, including when CI fails. Existing
   open PRs are reused. Reports and conflict diffs are kept as Actions artifacts
   for 14 days. Conflicts stop before publication and are shown in the run summary.

The write token is used only to publish the prepared branch and open the PR.
Upstream code and tests run in separate CI jobs with read-only permissions.
After the first remote run, configure required status checks for the
`Argon typecheck and tests` and `Argon image and startup` jobs before merging an
update. The Argon names distinguish them from skipped upstream jobs. Review the PR and test a
real Gemini session before marking it ready. For a conflicted update, inspect the
report and resolve it manually; no automatic conflict resolution is attempted
beyond manifest version normalization.

This workflow does not merge PRs, create release tags, promote stable images or
deploy production. After review, the existing Argon tag workflow can build and
publish a candidate image. The unauthenticated startup check remains separate
from a live Gemini test; candidate images need account-backed testing before
stable promotion.
