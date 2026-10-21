"""Refresh the short-lived Qwen access token using the website's auth flow."""
import asyncio
import base64
import datetime
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


def expires_at(token):
    try:
        payload = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
    except (ValueError, KeyError, IndexError, TypeError):
        return 0


def save_config(path, config):
    """Persist rotated cookies before using the new token; never truncate a session."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".refresh-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(config, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class QwenAuth:
    def __init__(self, config, path=None, clock=time.time):
        self.config = config
        self.path = path
        self.clock = clock
        self.lock = asyncio.Lock()

    async def ensure(self, client):
        async with self.lock:
            if expires_at(self.config["token"]) <= self.clock() + 180:
                if not self.config.get("refreshToken"):
                    raise ValueError("Saved Qwen refresh session required")
                # Endpoint and cookie flow confirmed in Qwen's 0.3.20 frontend.
                # A separate client prevents expired Bearer headers from leaking
                # into the auth request and limits cookies to the auth domain.
                from curl_cffi.requests import AsyncSession
                async with AsyncSession(impersonate="firefox", proxy=self.config.get("proxy"), timeout=30, allow_redirects=False) as auth:
                    auth.cookies.set("refresh_token", self.config["refreshToken"], domain=".qwen.ai", path="/")
                    if self.config.get("authSession"):
                        auth.cookies.set("auth-session", self.config["authSession"], domain="auth.qwen.ai", path="/")
                    if self.config.get("authClearance"):
                        auth.cookies.set("acw_tc", self.config["authClearance"], domain="auth.qwen.ai", path="/")
                    response = await auth.get("https://auth.qwen.ai/api/v2/auths/refresh", headers={
                        "Origin": "https://chat.qwen.ai", "Referer": "https://chat.qwen.ai/",
                        "x-request-origin": "https://chat.qwen.ai", "X-Request-Id": str(uuid.uuid4()),
                        "Timezone": datetime.datetime.now().astimezone().strftime("%a %b %d %Y %H:%M:%S GMT%z"),
                        "User-Agent": client.http.headers["User-Agent"],
                        "version": self.config["frontendVersion"], "source": "web"})
                    if response.status_code != 200:
                        raise ValueError("Qwen session refresh rejected")
                    payload = response.json()
                    token = (payload.get("data") or {}).get("access_token")
                    if payload.get("success") is not True or not isinstance(token, str) or expires_at(token) <= self.clock() + 180:
                        raise ValueError("Qwen session refresh failed")
                    updated = {**self.config, "token": token}
                    for cookie in auth.cookies.jar:
                        if cookie.domain.lstrip(".") not in ("qwen.ai", "auth.qwen.ai"):
                            continue
                        field = {"refresh_token": "refreshToken", "auth-session": "authSession", "acw_tc": "authClearance"}.get(cookie.name)
                        if field and cookie.value:
                            updated[field] = cookie.value
                    refresh = (payload.get("data") or {}).get("refresh_token")
                    if isinstance(refresh, str) and refresh:
                        updated["refreshToken"] = refresh
                    if self.path:
                        save_config(self.path, updated)
                    self.config.update(updated)
            client.token = self.config["token"]
            client.http.headers["Authorization"] = "Bearer " + client.token
            client.http.cookies.set("token", client.token, domain="chat.qwen.ai", path="/")
