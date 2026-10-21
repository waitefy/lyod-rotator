# Deploying Lyod Rotator

## Source installation

```bash
git clone https://github.com/waitefy/lyod-rotator.git
cd lyod-rotator
npm ci
npm link
lyod-rotator login
lyod-rotator start
```

Node.js 22+ is required. Existing `tuxevil-rotator` commands and config paths are
compatible. Installing the upstream npm package does not install this fork.
For Gemini App dependencies and sessions, follow [the provider guide](gemini-web.md).

Dashboard: `http://localhost:51200/dashboard`. Add providers at `/login-cli`.

## Desktop-assisted App providers

ChatGPT App, Claude App, Qwen App and DeepSeek App can use a separate private
bridge on the desktop for each account. The login helpers register connections
with the server automatically when their remote settings are configured. Use
the provider button at `/login-cli`, complete sign-in in the separate Firefox
window and close that window. Manual descriptor registration is the advanced
path, not an additional step after a successful automatic registration.

Keep the desktop online while using these bridges. Their processes and SSH
tunnels are user services with automatic restart; shutting down the desktop
makes the corresponding server routes unavailable. Gemini App can also depend
on the desktop's configured egress tunnel. An active rotator container alone
does not prove that an upstream web session is usable.

For an operational check, verify both `/api/catalog` and `/v1/models`, provider
routing availability in `/api/status`, and authenticated bridge `/v1/models`
responses. These read-only checks do not generate model answers or establish
remaining upstream quota. Do not include session descriptors, authentication
headers or full request logs in diagnostic reports.

Configure [local request budgets](custom-quotas.md) independently from
[model context windows](model-context.md). Exhausting a budget excludes only
that account/provider until reset; it does not authorize a silent switch to a
different model or provider.

## Docker (build on your PC)

From this fork's checkout:

```bash
mkdir -p docker-data
docker compose build
docker compose up -d
```

Compose builds `Dockerfile.gemini-web` into `lyod-rotator:local` and retains the
existing `tuxevil-rotator` service/container name. It persists data in
`./docker-data`, binds `127.0.0.1:51200` and runs as UID/GID 1000. Existing Gemini
session mounts and environment settings must be retained when updating a deployment.
The upstream GHCR image does not contain this fork's additions.

For versioned builds, provenance checks and transfer to a server, see
[fork maintenance](fork-maintenance.md). Building or publishing a candidate image
does not update a running service automatically.

**Enable Virtual Keys and Spend Logging inside Docker:**

Add `TUXEVIL_ROTATOR_DATABASE_URL` to your compose environment block:

```yaml
environment:
  TUXEVIL_ROTATOR_DATABASE_URL: "postgres://user:pass@postgres_host:5432/rotatordb"
```

See [Setting up PostgreSQL](integrations/setup-postgresql.md) for a full setup guide.

**LAN access:**

By default the compose file binds to `127.0.0.1` only. To expose on the LAN, change the port mapping to `51200:51200` and ensure you are behind a firewall or reverse proxy.

Inside the container the rotator always listens on `0.0.0.0`, and it cannot see which host address the port is published on. The dashboard therefore lists **Proxy listens on all interfaces** as a note rather than a warning: the native and `/v1` proxy routes reach as far as the published port.

**Linux permissions:**

On Linux, ensure `docker-data` is writable by UID 1000:

```bash
sudo chown -R 1000:1000 docker-data
```

---

## Running as a systemd Service

Create `/etc/systemd/system/tuxevil-rotator.service`:

```ini
[Unit]
Description=Lyod Rotator
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/lyod-rotator
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=TUXEVIL_ROTATOR_BIND_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable tuxevil-rotator
sudo systemctl start tuxevil-rotator
sudo journalctl -u tuxevil-rotator -f
```

---

## Running with nohup

```bash
nohup npm start > rotator.log 2>&1 &
echo $! > rotator.pid
```

Stop it:

```bash
kill $(cat rotator.pid)
```

---

## Reverse Proxy with nginx

For HTTPS or custom domain setups, put the rotator behind nginx:

```nginx
server {
    listen 443 ssl;
    server_name rotator.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:51200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        chunked_transfer_encoding on;
    }
}
```

The `proxy_buffering off` and long `proxy_read_timeout` are important for SSE streaming, both for model responses and for the dashboard's live updates.

The dashboard signs in with a session cookie. Forwarding `Host` lets the rotator confirm that dashboard actions come from its own page (without it they fail with `403`), and `X-Forwarded-Proto` marks the cookie `Secure` when the proxy serves HTTPS.

---

## Updating

Upstream releases are merged into this fork through the
[upstream-sync workflow](fork-maintenance.md#upstream-synchronization). Review and
merge the update before rebuilding. Do not install `tuxevil-rotator@latest` over
this fork; npm self-update is disabled here.

For a clean source checkout on the branch you deploy:

```bash
git pull --ff-only
npm ci
```

For Docker, rebuild on your PC and transfer the image using your deployment
procedure. To update a local Compose deployment:

```bash
docker compose build
docker compose up -d
```

Keep config, session files, volume mounts and existing service names unchanged.
