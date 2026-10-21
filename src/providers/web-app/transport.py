"""Private, one-account FreeTokenAPI boundary. No token-management API is exposed."""
import argparse
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

REVISION = "a54a9bb5d32413dea819ab0a0bc37dfc352de928"
SOURCE = Path.home() / ".local/share/lyod-rotator/web-app" / REVISION
MODEL_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}")


def private_json(path):
    path = Path(path)
    stat = path.stat()
    if not path.is_file() or stat.st_mode & 0o077 or stat.st_size > 262144:
        raise ValueError("Private configuration required")
    return json.loads(path.read_text())


def qwen_models(raw):
    result = []
    seen = set()
    if not isinstance(raw, list):
        raise ValueError("Qwen model catalog unavailable")
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("id")
        if not isinstance(name, str) or not MODEL_ID.fullmatch(name) or name in seen:
            continue
        if entry.get("disabled") or entry.get("is_active") is False or entry.get("available") is False:
            continue
        meta = (entry.get("info") or {}).get("meta") or entry.get("meta") or {}
        caps = meta.get("capabilities") or {}
        types = meta.get("chat_type") or []
        if isinstance(types, str):
            types = [types]
        seen.add(name)
        result.append(dict(id=name, name=str(entry.get("name") or name)[:256],
                           thinking=caps.get("thinking") is True, search=caps.get("search") is True,
                           chat="t2t" in types))
    if not result:
        raise ValueError("Qwen returned no usable model catalog; no fallback was used")
    return result


def identity_payload(provider, payload):
    """Only explicit identity fields, never derive an account from a rotating token."""
    if provider == "qwen-app":
        info = payload.get("data", payload)
    else:
        if payload.get("code") != 0:
            raise ValueError("DeepSeek session rejected")
        data = payload.get("data") or {}
        if data.get("biz_code", 0) != 0:
            raise ValueError("DeepSeek session rejected")
        info = data.get("biz_data") or {}
        info = info.get("user") or info.get("user_info") or info
    account_id = info.get("id") or info.get("user_id")
    if not isinstance(account_id, (str, int)) or not str(account_id).strip():
        raise ValueError("Upstream did not return a stable account identity")
    account_id = str(account_id)
    email = info.get("email")
    if not isinstance(email, str) or "*" in email or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        # Phone-only/redacted identities can collide: use the stable server ID.
        import hashlib
        email = hashlib.sha256(account_id.encode()).hexdigest()[:16] + "@" + provider + ".local"
    return account_id, email.lower()


async def verify_identity(client, provider):
    route = "/api/v1/auths/" if provider == "qwen-app" else "/api/v0/users/current"
    response = await client.http.get(route, follow_redirects=False)
    if response.status_code != 200:
        raise ValueError("Web account verification failed")
    payload = response.json()
    account_id, email = identity_payload(provider, payload)
    return account_id, email


def configure(config, config_path=None):
    if config.get("provider") not in ("qwen-app", "deepseek-app") or not config.get("token") or not config.get("apiKey"):
        raise ValueError("Invalid private bridge configuration")
    actual = subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise ValueError("FreeTokenAPI revision mismatch")
    if config.get("proxy"):
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ[key] = config["proxy"]
    # A shared inherited environment must never enroll a second account/provider.
    os.environ.update(DEEPSEEK_TOKENS="", QWEN_TOKENS="", FREETOKENAPI_TIMEOUT="600",
                      FREETOKENAPI_CACHE_DISABLED="1", FREETOKENAPI_USAGE_ENABLED="0",
                      FREETOKENAPI_HUMAN_DELAY_MIN="0", FREETOKENAPI_HUMAN_DELAY_MAX="0",
                      FREETOKENAPI_SEARCH_ENABLED="0", FREETOKENAPI_ACQUIRE_TIMEOUT="30")
    os.environ["QWEN_TOKENS" if config["provider"] == "qwen-app" else "DEEPSEEK_TOKENS"] = config["token"]
    sys.path.insert(0, str(SOURCE))
    from freetokenapi.api import openai as upstream
    from freetokenapi.qwen import api as qwen_api
    if config["provider"] == "qwen-app":
        version = config.get("frontendVersion", "")
        if not isinstance(version, str) or not re.fullmatch(r"[0-9][0-9A-Za-z._-]{1,40}", version):
            raise ValueError("Verified Qwen frontend version required; refresh the saved browser profile")
        from freetokenapi.qwen import client as qwen_client
        qwen_client.COMMON_HEADERS["version"] = version
        from qwen_auth import QwenAuth
        auth = QwenAuth(config, config_path)
        class RefreshingClient(qwen_client.QwenClient):
            async def check_auth(self):
                await auth.ensure(self)
                return await super().check_auth()
        upstream.QwenClient = RefreshingClient
        upstream.qwen_session_refresh = auth
    upstream.MAX_RETRIES = qwen_api.MAX_RETRIES = 0
    upstream._reduced_prompt_variants = lambda *_args, **_kwargs: []

    async def strict_catalog(client):
        return qwen_models(await client.fetch_models())
    upstream._fetch_qwen_models = strict_catalog
    # Raw upstream exceptions may include authorization or conversation contents.
    logging.disable(logging.CRITICAL)
    return upstream


def create_app(config, upstream):
    from fastapi import FastAPI, Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse, StreamingResponse
    from starlette.exceptions import HTTPException
    provider = config["provider"]
    cache = {"at": 0, "models": []}

    @asynccontextmanager
    async def lifespan(_app):
        async with upstream.lifespan(upstream.app):
            pool = upstream.app.state.qwen_pool if provider == "qwen-app" else upstream.app.state.pool
            if pool is None or len(pool.accounts) != 1:
                raise ValueError("Exactly one upstream account is required")
            actual_id, actual_email = await verify_identity(pool.accounts[0].client, provider)
            if actual_id != config["accountId"] or actual_email != config["email"]:
                raise ValueError("Bridge account identity mismatch")
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        if not secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + config["apiKey"]):
            return JSONResponse({"error": {"message": "Bridge authentication required"}}, status_code=401)
        try:
            return await call_next(request)
        except Exception:
            return JSONResponse({"error": {"message": "Web bridge request failed"}}, status_code=502)

    @app.exception_handler(HTTPException)
    async def upstream_error(_request, exc):
        # Keep status, not potentially secret-bearing exception text.
        return JSONResponse({"error": {"message": "Web upstream rejected request", "code": "web_app_error"}}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, _exc):
        return JSONResponse({"error": {"message": "Invalid chat request"}}, status_code=400)

    async def catalog():
        if provider == "qwen-app" and getattr(upstream, "qwen_session_refresh", None):
            pool = upstream.app.state.qwen_pool
            if not pool or len(pool.accounts) != 1:
                raise HTTPException(401)
            await upstream.qwen_session_refresh.ensure(pool.accounts[0].client)
        if time.monotonic() - cache["at"] < 60 and cache["models"]:
            return cache["models"]
        cache.update(at=0, models=[])
        if provider == "qwen-app":
            pool = upstream.app.state.qwen_pool
            if not pool or len(pool.healthy) != 1:
                raise HTTPException(401)
            models = qwen_models(await pool.healthy[0].client.fetch_models())
            upstream.app.state.qwen_models = models
        else:
            configs, _errors = await upstream._deepseek_model_configs(upstream.app.state.pool)
            if not configs:
                raise HTTPException(503)
            model = next(iter(configs.values()))
            # Website's current/default model. Version attribution is not independently verified.
            models = [dict(id="current", name="DeepSeek current (reported 4.1 Flash 1017)",
                           thinking=model.thinking, search=model.search, chat=True)]
        cache.update(at=time.monotonic(), models=models)
        return models

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "accountId": config["accountId"], "data": await catalog()}

    async def safe_events(iterator):
        # Preserve delta streaming; sanitize error records, do not buffer the answer.
        pending = ""
        try:
            async for chunk in iterator:
                pending += chunk.decode() if isinstance(chunk, bytes) else chunk
                while "\n\n" in pending:
                    record, pending = pending.split("\n\n", 1)
                    for line in record.splitlines():
                        if line.startswith("data:") and line[5:].strip() != "[DONE]":
                            data = json.loads(line[5:])
                            if "error" in data:
                                yield 'data: {"error":{"message":"Web upstream stream failed","code":"web_app_error"}}\n\n'
                                return
                    yield record + "\n\n"
                if len(pending) > 4 * 1024 * 1024:
                    raise ValueError()
            if pending.strip():
                raise ValueError()
        except Exception:
            yield 'data: {"error":{"message":"Web upstream stream interrupted","code":"web_app_error"}}\n\n'
        finally:
            close = getattr(iterator, "aclose", None)
            if close:
                await close()

    @app.post("/v1/chat/completions")
    async def completions(request: Request):
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(400) from None
        if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
            raise HTTPException(400)
        offered = next((m for m in await catalog() if m["id"] == data.get("model") and m["chat"]), None)
        if not offered:
            raise HTTPException(404)
        thinking = data.get("thinking", False)
        search = data.get("search", False)
        if not isinstance(thinking, bool) or not isinstance(search, bool) or (thinking and not offered["thinking"]) or (search and not offered["search"]):
            raise HTTPException(400)
        if data.get("files") or any(isinstance(m.get("content"), list) and any(p.get("type") != "text" for p in m["content"]) for m in data["messages"]):
            raise HTTPException(400)
        data.update(thinking=thinking, search=search)
        if provider == "deepseek-app":
            data["model"] = "deepseek-web"
        try:
            req = upstream.ChatCompletionRequest.model_validate(data)
        except ValueError:
            raise HTTPException(400) from None
        # Dispatch explicitly: never let an upstream alias select another provider.
        handler = upstream._chat_completions_qwen if provider == "qwen-app" else upstream._chat_completions_deepseek
        result = await handler(req)
        if isinstance(result, StreamingResponse):
            return StreamingResponse(safe_events(result.body_iterator), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}, background=result.background)
        if isinstance(result, dict) and "error" in result:
            raise HTTPException(502)
        return result
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = private_json(args.config)
        upstream = configure(config, args.config)
        import uvicorn
        uvicorn.run(create_app(config, upstream), host="127.0.0.1", port=int(config["port"]),
                    log_level="critical", access_log=False)
    except Exception:
        print("Private web bridge could not start; verify login and pinned installation.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
