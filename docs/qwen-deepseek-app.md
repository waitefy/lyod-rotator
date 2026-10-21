# Qwen App and DeepSeek App

Two independent, experimental web-session providers: `qwen-app` and `deepseek-app`.
They do not use developer API keys or share the Codex, Gemini or Claude account pools.
A local Firefox login helper verifies the account, starts one private bridge per
account and registers its descriptor with the server over SSH. The PC must stay
online while the server uses these bridges.

## Install and connect

Run on the Linux desktop with Firefox, Python 3.11+, Node.js and user systemd:

```sh
python3 scripts/web-app/install-login.py --origin https://your-rotator.example
rotator-qwen-login
rotator-deepseek-login
```

The same helpers are linked from `/login-cli`. Sign in and close the separate
Firefox window. No cookie/token copy is required. A fresh sign-in uses an isolated
profile so Google cannot silently reuse the last account; existing connections
are preserved. A phone-only account without a returned email gets a stable
`@deepseek-app.local` identity derived from its server account ID.

Private settings are under `~/.config/lyod-rotator/{qwen-app,deepseek-app}`.
The installer reuses an existing Claude helper's **remote registration settings**,
not its credentials. On a new installation configure the same `remote` object
as described in [Claude setup](claude-app.md). Without it, a local bridge is saved
but no server registration is claimed. The installer preserves a configured
proxy or records the current credential-free proxy URL; SOCKS support is included.
Qwen's required frontend-version header is read from the site bundle cached during
Firefox login. The bridge never uses the dependency's hard-coded older version.
If Qwen updates its protocol, refreshing the saved profile also refreshes that
version; arbitrary upstream errors do not trigger repeated generation attempts.

To refresh an existing account's saved Firefox profile:

```sh
rotator-qwen-login --account your@email.example
rotator-deepseek-login --account your@email.example
```

After a server-registration failure, retry without signing in again:

```sh
rotator-qwen-login --register-only --account your@email.example
```

## Models and capabilities

Qwen public IDs are `qwen-app-` followed by the exact model ID returned by the
website, for example `qwen-app-qwen3.8-max` **only if the account lists it**.
There is no built-in substitute catalog. Non-chat entries are retained in the
private descriptor but not advertised as chat endpoints. A listed model is not
proof that the account has remaining quota; the generation request can still
be rejected by the website.

DeepSeek exposes one ID, `deepseek-app-current`, using the site's `default`
model. The user-reported version is **4.1 Flash 1017**; that version is not
independently certified by a server model-version field. We do not turn the
bridge's multiple aliases for the same default model into separate models.

Both providers accept Chat Completions; the rotator's existing translators also
serve Responses and Anthropic Messages. Tool calls are text-emulated by the
bridge, not native website function calling. Thinking is boolean: `none` means
off and `high` means on, only where the account catalog permits it. Intermediate
reasoning levels are rejected rather than silently treated as the same setting.
Search is opt-in and validated against the account/model catalog.

**Current boundary:** text, incremental SSE and tool trajectories. Attachments,
vision, image/video generation and deep research are not enabled by this initial
integration. Unknown context windows and usage quotas are not replaced with
invented values. Usage counters from the bridge are estimates, not billing data.

## Isolation and failure handling

- FreeTokenAPI is pinned to `a54a9bb5d32413dea819ab0a0bc37dfc352de928`.
  Source: https://github.com/mmmlllnnn/FreeTokenAPI (MIT, copyright FANATFANATA).
  Its own license stays with the separately installed checkout. Python dependencies
  are pinned in `scripts/web-app/requirements.lock`.
- The wrapper exposes only authenticated `/v1/models` and
  `/v1/chat/completions`; token-management and image-generation routes are absent.
- One account per process. Rotation is owned by Lyod Rotator; model cooldowns
  stay in that provider's pool. No Google/other-provider fallback is used.
- Internal request retries and reduced-history retries are disabled. A context
  failure is reported; the bridge must not rescue it by dropping earlier messages.
- Credentials are stored in private files, not commands, URLs or systemd units.
  The server gets a local bridge key, never the website token. Error text and
  process logs do not expose upstream payloads.
- A failed catalog refresh empties runtime availability. Missing/stale model
  metadata cannot select a guessed default model.

## Targeted checks

```sh
npm run typecheck
npm run typecheck:test
node --import tsx/esm --test test/web-app.test.ts test/claude-app.test.ts test/chatgpt-app.test.ts
~/.local/share/lyod-rotator/web-app-venv/bin/python -m unittest discover -s test -p web_app_transport_test.py
```

Offline tests cover private access, catalog isolation, unknown models, boolean
thinking, error redaction, incremental forwarding, cancellation, compatibility
protocols and Firefox storage decoding. They do not establish live entitlement,
model quality, real quota size or immunity to future website protocol changes.
