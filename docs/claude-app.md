# Claude App bridge (experimental, local first)

Claude App is a separate provider (`claude-app`), independent of Antigravity,
Claude Code and ChatGPT App. This first integration uses
[ClewdR](https://github.com/Xerxes-2/clewdr) **v0.13.5**, source commit
`ced44ece9cef0686262855479362072105ef9d8e`.

The Linux x86_64 release ZIP is pinned to SHA-256:
`ecad65308f055540ae2e9c1afdae8c192b01946fda2c4e2bc6b3a645c30262fd`.
The installer verifies the archive before replacing the executable. It does not
build or modify the upstream project.

## Free account and model identity

The default public model is **`claude-app-auto`**. ClewdR omits the outbound
model selector for free accounts; Claude's website selects the actual model.
Auto must never be presented as a verified Sonnet or Opus version.

The login helper checks `/api/bootstrap` for the account email and organization
capabilities, using the same paid-capability rule as this pinned bridge. Its
private descriptor records `modelSelection: "default-only"` for free accounts.
Such accounts cannot serve an explicit named alias: the adapter rejects that
request before contacting the bridge.

`LYOD_CLAUDE_APP_MODELS` is an operator allowlist, default `auto`, not entitlement
discovery. Do not add named slugs until the selected account and the outbound
selection have been checked. Neither the bridge's static `/v1/models`, its
returned `model` nor self-identification proves which model executed a request.
The catalog deliberately reports unknown context and unverified availability.

## Local installation and sign-in

Prerequisites: Linux x86_64, Python with venv, Firefox, a user systemd session,
Node.js and the rotator dependencies. Run as the desktop user:

```sh
python3 scripts/claude-app/install-login.py --origin https://rotator.lyod.online
rotator-claude-login
```

Where a proxy is needed, pass `--proxy http://127.0.0.1:2080` to the installer.
Existing trusted settings and account files are preserved. The installer sets
up the `lyod-claude://login` handler used by `/login-cli` → **Claude App**.
The website panel becomes available after deployment of this code.

Sign in to any Claude account in the separate Firefox window, wait for the chat
to open, then close that specific window. The helper checks identity, allocates
an isolated bridge and private connection descriptor, and preserves the signed-in
Firefox profile. To refresh an existing account without resetting its login:

```sh
rotator-claude-login --account user@example.com
```

A new-account login uses a separate profile and clears only Claude/Google login
cookies in that staging profile, allowing Google account selection. Existing
account profiles and their extensions are not cleared. Refresh rejects an
unexpected account before writing bridge configuration.

Each account gets its own loopback listener (3140–3239), bridge password, private
TOML and user service. Ports reserved by stopped accounts are not reassigned.
If bridge startup or readiness fails, the previous connection files are restored.
The helper uses one cookie per process and disables internal request retries;
rotator rotation on HTTP 429 remains within Claude App.

Private files live under `~/.config/lyod-rotator/claude-app/` with 0600 permissions.
The bridge writes neither response debug files nor stdout/stderr logs. Its web
endpoint is explicitly `https://claude.ai/`, rather than the release's API-host
default. The systemd unit contains paths only, not cookies or API keys.

## Registering and testing

The helper currently provisions the **local bridge only**. It does not silently
register or deploy an untested account on production. Successful `/v1/models`
readiness means the listener is running; a real short generation must still
succeed before declaring connectivity verified.

Register the private descriptor through `/login-cli` → Claude App → Advanced,
or `lyod-rotator login --provider claude-app`. The file must be readable by the
rotator process. Its format is:

```json
{
  "email": "user@example.com",
  "baseUrl": "http://127.0.0.1:3140/v1",
  "apiKey": "LOCAL_BRIDGE_KEY",
  "adminApiKey": "LOCAL_BRIDGE_ADMIN_KEY",
  "modelSelection": "default-only"
}
```

A server cannot reach a desktop's loopback listener directly. Production needs
an authenticated tunnel and a server-side descriptor with the tunnel endpoint;
that deployment is separate from this first local milestone. Do not expose the
bridge listener or reuse the website session as a public API credential.

## Capabilities and boundaries

- Chat Completions, Responses and Anthropic Messages are translated through the
  existing compatibility layer. Text can stream incrementally, including when
  tools are declared. Client cancellation propagates to the bridge.
- The adapter uses ClewdR's native `/v1/messages` route. In the pinned release,
  the OpenAI SSE mapper drops completion/error events; the adapter translates
  native events itself and requires `message_stop` before reporting completion.
- ClewdR's web transformation drops custom tool declarations. The adapter instead
  uses the existing experimental text tool protocol: one client function per
  response, validated against JSON Schema. Tool results are carried as untrusted
  history; the client executes tools. This is not native Claude tool calling.
- Partial tool markers are buffered; ordinary text is streamed immediately.
  A truncated converted stream fails instead of claiming successful completion.
- Attachments/vision, structured output, thinking effort selection and audio are explicitly rejected in this
  first integration. Image upload in the underlying project is insufficient
  evidence of working end-to-end support.
- Header deadline is 600 seconds; no short idle timeout or sidecar retry loop has
  been introduced. Actual latency and free-tier quotas require a live check.
- Errors preserve status/Retry-After but redact arbitrary upstream bodies.
  Authentication errors affect Claude App credentials only; other providers on
  the same account remain intact.
- An optional private `adminApiKey` enables pool diagnosis after a bridge 500/504.
  Only a single exhausted account with a future reset time and no valid/invalid
  entries is mapped to 429 with Retry-After. Unknown errors retain their status.
  The administrative response contains cookies and must never be logged or
  exposed to clients. The helper generates this key automatically.

## Targeted checks

```sh
node --import tsx/esm --test test/claude-app.test.ts test/claude-app-tools.test.ts test/claude-app-wire.test.ts test/chatgpt-app.test.ts
python3 -m unittest discover -s test -p 'claude_app_browser_test.py' -v
npm run typecheck
python3 -m py_compile src/providers/claude-app/browser_login.py scripts/claude-app/install-login.py
```

The browser test requires `curl_cffi` in its interpreter; use the login venv if
it is not installed globally. All automated tests above use local fixtures, not
real account quotas. They do not prove successful website authentication or
which backend model served a live request.

## Initial live check

The first free-account control request returned the requested `CLAUDE_OK` text;
the first text arrived in approximately 5.2 seconds. This exposed the OpenAI SSE
completion issue described above. A subsequent request using native Messages
encountered an exhausted sidecar account, rather than verifying the new live
completion path. The corrected error mapping returned 429 in 32 ms without a
new generation. The bridge supplied a reset timestamp, but it does not preserve
enough detail to distinguish a quota response from every other temporary
restriction. Successful native streaming completion and a real client tool
round trip still require a live check once the account becomes eligible.
