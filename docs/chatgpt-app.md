# ChatGPT App bridge (experimental)

This provider is separate from `openai-codex`. It connects Lyod Rotator to an
operator-managed [aurorax-neo/chat2api](https://github.com/aurorax-neo/chat2api)
sidecar. Initial integration targets commit
`dbf6bf39686348449c25de3b6131ca733f448deb`.

The sidecar handles the ChatGPT web protocol and emulates function calling.
An account-scoped curl_cffi transport supplies a coherent browser HTTP/TLS
fingerprint; the pinned sidecar's original transport failed our live smoke.
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
chatgpt_base_url: http://chatgpt-app-transport:3041
chatgpts:
  - access_token: REPLACE_LOCALLY_WITH_WEB_ACCESS_TOKEN
    email: user@example.com
```

Web access tokens are obtained through the existing signed-in ChatGPT browser
session and stored locally in the sidecar config. Do not paste them into chat,
commit them, or reuse Codex OAuth credentials as ChatGPT web credentials.
The local Firefox helper below can obtain and replace the token without copying it.
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

The transport has **no published port**. It accepts the one configured account's
Bearer token, sends only to `https://chatgpt.com`, rejects anonymous routes and
redirects, and streams response chunks without buffering the complete answer.
Both containers read the same private configuration. Restart the transport after
replacing the web token. Its dependencies are pinned in
`scripts/chatgpt-app-transport/requirements.txt`.

If an upstream proxy is needed, set `LYOD_CHATGPT_APP_TRANSPORT_PROXY` to a URL
reachable **from the transport container**. Leave chat2api's own `proxy` empty:
its upstream is now the local transport. A host-only proxy on `127.0.0.1` needs
an explicit host-network override for both services; then bind both services to
`127.0.0.1`, and use `http://127.0.0.1:3041` as `chatgpt_base_url`.

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
LYOD_CHATGPT_APP_MODELS=gpt-6,gpt-5-6-mini
```

Both example slugs were returned by the real free test account's
`/backend-api/models` and accepted in separate live requests on 2026-10-20.
The server's message metadata identified `gpt-6` and `gpt-5-6-mini`, respectively.
The catalog calls the latter GPT-5.6 Luna; OpenAI's October rollout assigns
GPT-6 Luna to Free and Go accounts ([announcement](https://openai.com/index/gpt-6-for-everyone/)).
Other accounts may differ. Choose only slugs confirmed available on your account.
No models are enabled by default.

Use `chatgpt-app-gpt-6` as the primary selection in your client and
`chatgpt-app-gpt-5-6-mini` as a separate, explicitly selected alternative.
Allowlist order makes GPT-6 the provider's benchmark model; it does not override
the model selected by the client or enable automatic fallback.

For a local start, save the assignment above in a private environment file and
load it into the rotator process, for example:

```sh
node --env-file="$HOME/.config/lyod-rotator/chatgpt-app/models.env" --import tsx/esm src/cli.ts start
```

Run from the repository root with the account registered as described above.
This environment file configures the rotator, not the chat2api sidecar.
Public IDs become `chatgpt-app-gpt-6`, `chatgpt-app-gpt-5-6-mini`; the
prefix is stripped only at the sidecar boundary. Unknown/unconfigured IDs fail
instead of falling back to Gemini, Codex or `auto`.

## Browser sign-in on the PC

The `/login-cli` → **ChatGPT App** panel offers **Open Firefox** through the
user-installed `lyod-chatgpt` URL handler. It opens a local progress page and a
dedicated Firefox profile. Sign in to any of your ChatGPT accounts,
then close that separate Firefox window. An existing account is refreshed; a new
account gets its own sidecar pair, private API key and loopback listeners. The helper reads only ChatGPT cookies
from that dedicated profile and requests `/api/auth/session` directly from
ChatGPT. It checks the authenticated model catalog before saving the token.

Install once, after preparing the single-account sidecar configuration and
`session.json` above. Use a persistent virtual environment:

```sh
python3 -m venv "$HOME/.local/share/lyod-rotator/chatgpt-login-venv"
"$HOME/.local/share/lyod-rotator/chatgpt-login-venv/bin/pip" install -r scripts/chatgpt-app-transport/requirements.txt
"$HOME/.local/share/lyod-rotator/chatgpt-login-venv/bin/python" src/providers/chatgpt-app/browser_login.py \
  --install --origin https://rotator.lyod.online \
  --compose-file "$PWD/docker-compose.chatgpt-app.yml"
```

For a host-network setup, append another `--compose-file` with the private
override and `--proxy` with the local outbound proxy. Use `--project` if the
existing Compose project is not `lyod-chatgpt-app`. These trusted local settings
are private; links from the website cannot override paths, proxies or commands.
The helper accepts links only for the origin chosen during installation.

You can also start it directly:

```sh
"$HOME/.local/share/lyod-rotator/chatgpt-login-venv/bin/python" src/providers/chatgpt-app/browser_login.py --login
```

After successful verification it atomically replaces the sidecar token and
recreates only the two ChatGPT App containers, using existing images. If startup
or readiness fails, it restores the previous configuration and attempts to
restart the old bridge. An explicit account-refresh link still rejects a different
email; use the general sign-in button or `--login` to add another account.
Cookies, access tokens and full upstream responses are not shown on the status
page or retained in its diagnostic JSON. The Firefox profile persists across
restarts; token renewal requires running the helper again. Explicit account-refresh
links reuse browser sign-in when the session remains valid.

The initial bridge remains in place. Additional connections are saved privately
under `accounts/<email-hash>/` inside the helper configuration directory. Each
transport still serves exactly one account; accounts are never pooled inside
chat2api. New bridges reuse the installed images and do not rebuild them. Their
loopback addresses and ports are allocated separately, including when a bridge
is stopped. A failed startup removes only the new bridge. The shared sign-in
profile (including installed extensions such as Bitwarden) is preserved. To switch
accounts, general sign-in clears local ChatGPT/OpenAI and Google authentication
cookies before opening the closed profile, so Google cannot silently reuse the
previous account. It does not call upstream logout or revoke
previously connected bridge tokens. Bitwarden, other sites and bridge credentials
are preserved. Close the dedicated Firefox window before starting another login.
To refresh an existing account without clearing browser sign-in, use an explicit
account link or `rotator-chatgpt-login --account user@example.com`.

The progress page reports the account and absolute `session.json` path. Register
that file through **Advanced** or `lyod-rotator login --provider chatgpt-app`.
The helper does not deploy to production, register accounts on a remote rotator,
or expose the PC bridge to the server. A local success message describes the PC
bridge, not production connectivity.

Test without opening Firefox or using a real account:

```sh
"$HOME/.local/share/lyod-rotator/chatgpt-login-venv/bin/python" -m unittest discover -s test -p chatgpt_app_browser_test.py -v
```

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

Run the transport's isolated tests in an environment with its requirements:

```sh
python -m unittest discover -s test -p chatgpt_app_transport_test.py -v
```

### Local live smoke test, 2026-10-20

The pinned image built successfully on the PC (Docker Buildx is required).
Its original transport received upstream 403 HTML at `sentinel prepare`, through
both tested routes. It advertises Chrome 148 but uses a Chrome 124 TLS profile;
the exact cause of the refusal was not independently established.

Using curl_cffi on the same PC proxy, the saved **free account** token received
200 from `/backend-api/models`. The former example `gpt-5-5-instant` was absent
from this real catalog. A diagnostic relay then passed all observed sentinel
and conversation steps with 200; `gpt-5-6-mini` returned `APP_OK` in 15.5 seconds.
This proves a working authenticated request path, not independently verified
internal model execution or paid-model entitlement. Production was not changed.

The packaged transport image then passed live requests through Lyod's real
`chatGptAppAdapter` with the same free account and explicit model slug:

- SSE: HTTP 200, first chunk 12.278 s, completion 15.740 s, `APP_STREAM_OK`,
  two received chunks and terminal `[DONE]`.
- Function call: HTTP 200 in 24.047 s, `add_numbers` with `{"a":2,"b":3}`.
- Tool-result continuation: HTTP 200, supplied result `5`, expected
  `APP_TOOL_OK_5` received.

These are short local smoke tests, not a reliability or performance benchmark.
An initial request raced transport startup; Compose now waits for the transport
TCP healthcheck before starting chat2api. Seven isolated transport tests and
13 existing ChatGPT App adapter tests passed. Both local listeners are bound
to loopback; production configuration/model allowlists were left unchanged.
