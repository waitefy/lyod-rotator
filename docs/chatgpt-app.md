# ChatGPT App bridge (experimental)

This provider is separate from `openai-codex`. It connects Lyod Rotator to an
operator-managed [aurorax-neo/chat2api](https://github.com/aurorax-neo/chat2api)
sidecar. Initial integration targets commit
`dbf6bf39686348449c25de3b6131ca733f448deb`.

The sidecar handles the ChatGPT web protocol and emulates function calling.
The rotator handles explicit model routing, account selection, provider-scoped
credential failures and the existing Chat Completions / Responses / Messages
compatibility endpoints. Native ChatGPT API tools are not implied.

## Private sidecar configuration

Use exactly **one** entry in `chatgpts` per sidecar. Give every instance its own
local API key and port. A shared sidecar pool would hide account selection and
quota failures from the rotator. This constraint is operational, not enforced
by the bridge protocol. The configured email is an operator-supplied label,
not an independently verified ChatGPT identity.

Create a private directory and `app.prod.yaml` (0600) outside the repository:

```yaml
log_level: error
bind: 0.0.0.0
port: 3040
auth:
  access_tokens:
    - REPLACE_WITH_RANDOM_LOCAL_BRIDGE_KEY
  access_token_prefix: []
chatgpt_base_url: https://chatgpt.com
chatgpts:
  - access_token: REPLACE_LOCALLY_WITH_WEB_ACCESS_TOKEN
    email: user@example.com
```

Web access tokens are obtained through the existing signed-in ChatGPT browser
session and stored locally in the sidecar config. Do not paste them into chat,
commit them, or reuse Codex OAuth credentials as ChatGPT web credentials.
An integrated browser login/refresh flow is not implemented in this stage.
Keep sidecar configuration, logs and admin endpoints private. Docker logging is
disabled in the example; upstream may also write files under `/app/logs`.

Build on the **PC**, not the production server:

```sh
export LYOD_CHATGPT_APP_CONFIG_DIR=/absolute/private/chat2api-config
docker compose -f docker-compose.chatgpt-app.yml build
docker compose -f docker-compose.chatgpt-app.yml up -d
```

This optional Compose file does not change the production rotator or Gemini.
The port is bound only to host loopback. A containerized rotator cannot reach
the host sidecar through its own `127.0.0.1`; use an existing protected HTTPS
endpoint to the sidecar or an explicitly configured shared host network.
Never expose port 3040 directly to the public network.

## Register with Lyod Rotator

Create a separate 0600 JSON, e.g. `/sessions/chatgpt-app.json`, readable by the
rotator process (mount it read-only when running in Docker):

```json
{
  "email": "user@example.com",
  "baseUrl": "http://127.0.0.1:3040/v1",
  "apiKey": "REPLACE_WITH_THE_LOCAL_BRIDGE_KEY"
}
```

`baseUrl` accepts HTTPS or loopback HTTP; credentials in URLs and redirects
are rejected. The key is a **sidecar API key**, not a ChatGPT access token.
The rotator account configuration stores only the absolute `sessionFile` path.
The file is reread per request, so replacing its key does not require a restart.

Register through `/login-cli` → **ChatGPT App** or:

```sh
lyod-rotator login --provider chatgpt-app
```

Registration checks the private connection file only. It makes no generation
request and does **not** assert that the web session works. Same-email accounts
use existing provider credential merging; Google and Codex credentials remain.

## Explicit model allowlist

Set on the rotator process, then restart that process:

```sh
LYOD_CHATGPT_APP_MODELS=gpt-5-5-instant,gpt-5-5-thinking
```

These example slugs come from the pinned sidecar source, not a verified account
catalog. Choose only slugs confirmed available on your account. No models are
enabled by default. Public IDs become `chatgpt-app-gpt-5-5-instant`, etc.; the
prefix is stripped only at the sidecar boundary. Unknown/unconfigured IDs fail
instead of falling back to Gemini, Codex or `auto`.

The sidecar's `/v1/models` list is static; it cannot prove account entitlement.
Context size and usage quotas are unknown. The adapter does not invent a quota
percentage; reported usage is an estimate made by the sidecar. No automatic
cross-provider fallback is added. Errors discard upstream text and preserve
only status and Retry-After. Client cancellation propagates to the sidecar;
whether it stops internal upstream work depends on chat2api.

## Validation boundaries

Local contract tests cover HTTP/SSE, tool call round trips, model pinning,
cancellation, safe errors and private file validation using a local fake bridge.
They do not prove ChatGPT session acceptance, actual model identity, quality,
multimodal support or limits. A real account smoke test is required before
production rollout. Claude App is a subsequent integration, not available here.

### Local live smoke test, 2026-10-20

The pinned image built successfully on the PC (Docker Buildx is required).
Startup, API key rejection and loading one web account passed. A short request
through the rotator adapter returned 502: chat2api received an upstream 403 HTML
response at `sentinel prepare`, before model generation. Repeating through the
existing PC proxy produced the same refusal. The imported JWT was not expired;
the exact reason for the upstream refusal remains unverified. Real generation,
streaming and tool use have therefore **not passed** live validation. The test
sidecar was stopped; production configuration and the model allowlist were left
unchanged. Resolve the upstream transport refusal before rollout.
