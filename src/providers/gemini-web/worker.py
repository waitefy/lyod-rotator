"""Private Gemini Web protocol. Requests use a persistent, local session broker."""

import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys

MAX_INPUT_BYTES = 256_000
MAX_OUTPUT_CHARS = 128_000
SESSION_LOCK_WAIT_SECONDS = 60
ARGON_NAME = re.compile(r"(?:\bgemini[\s_-]*4[\s_-]*argon\b|^argon$)", re.I)
# Gemini App's enum: STANDARD=1, EXTENDED=2, DEEP_THINK=3, MEDIUM=4.
# Low / Medium / High are STANDARD / MEDIUM / EXTENDED, not 1 / 2 / 3.
THINKING_LEVELS = {"low": 1, "medium": 4, "high": 2}
MODEL_HEADER = "x-goog-ext-525001261-jspb"


class ThinkingTransport:
    """Adapt the pinned client's boolean thinking switch to the web enum."""
    def __init__(self, transport, level):
        self.transport, self.level = transport, level

    def __getattr__(self, name):
        return getattr(self.transport, name)

    def stream(self, method, url, **kwargs):
        if method == "POST" and str(url) == "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate":
            try:
                data = dict(kwargs["data"])
                headers = dict(kwargs["headers"])
                outer = json.loads(data["f.req"])
                body = json.loads(outer[1])
                selector = json.loads(headers[MODEL_HEADER])
                if len(body) != 81 or len(selector) != 17 or body[80] not in (1, 2) or selector[15] != body[80]:
                    raise ValueError()
                body[80] = selector[15] = THINKING_LEVELS[self.level]
                outer[1] = json.dumps(body, ensure_ascii=False)
                data["f.req"] = json.dumps(outer, ensure_ascii=False)
                headers[MODEL_HEADER] = json.dumps(selector)
                kwargs.update(data=data, headers=headers)
            except (KeyError, TypeError, ValueError, IndexError):
                raise WorkerError(502, "Gemini Web thinking protocol changed; request was not sent") from None
        return self.transport.stream(method, url, **kwargs)


@contextlib.contextmanager
def thinking_transport(client, level):
    original = client.client
    wrapper = ThinkingTransport(original, level)
    client.client = wrapper
    try:
        yield
    finally:
        # Do not resurrect a transport the library closed after an upstream error.
        if client.client is wrapper:
            client.client = original


class WorkerError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


async def acquire_session_lock(lock):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SESSION_LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise WorkerError(409, "Gemini Web session remained busy for 60 seconds; retry the request") from None
            await asyncio.sleep(min(0.1, remaining))


def select_argon(models):
    """Only select a discovered, available Argon model; never use a default."""
    for model in models or []:
        names = [model.model_name, model.display_name, *model.aliases]
        if model.is_available and any(ARGON_NAME.search(name) for name in names if name):
            return model
    raise WorkerError(404, "Gemini 4 Argon is not offered by this web session; no fallback was used")


async def run(payload, client_factory=None, *, keep_open=False, emit_event=emit):
    mode = payload.get("mode")
    if mode not in ("probe", "generate"):
        raise WorkerError(400, "Invalid Gemini Web worker operation")
    if mode == "generate":
        level = payload.get("thinkingLevel")
        if level is not None and (not isinstance(level, str) or level not in THINKING_LEVELS):
            raise WorkerError(400, "Gemini Web thinking level must be low, medium or high")
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 48_000:
            raise WorkerError(400, "Gemini Web requires a text prompt of at most 48000 UTF-8 bytes")
    cookies_path = payload.get("cookiesFile")
    if not isinstance(cookies_path, str) or not Path(cookies_path).is_absolute():
        raise WorkerError(401, "Gemini Web requires an absolute cookie file path")
    cookies_path = Path(cookies_path).resolve()
    try:
        raw = cookies_path.read_bytes()
        if len(raw) > 65_536:
            raise ValueError()
        cookies = json.loads(raw)
        psid = cookies["__Secure-1PSID"]
        psidts = cookies.get("__Secure-1PSIDTS", "")
        if not isinstance(psid, str) or not psid.strip() or not isinstance(psidts, str):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise WorkerError(401, "Cannot read Gemini Web cookie JSON; reconnect the web session") from None

    # Each session gets an isolated persistent refresh cache and an OS-level
    # lock, including across separate rotator processes. Never mix cookies.
    cache = cookies_path.parent / ".gemini-web-cache" / hashlib.sha256(str(cookies_path).encode()).hexdigest()[:24]
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.environ["GEMINI_COOKIE_PATH"] = str(cache)
    with (cache / "session.lock").open("a") as lock:
        await acquire_session_lock(lock)
        if client_factory is None:
            from gemini_webapi import GeminiClient, set_log_level

            set_log_level("CRITICAL")
            client_factory = GeminiClient
        client = client_factory(psid, psidts, proxy=payload.get("proxy"))
        try:
            await client.init(timeout=450, auto_close=False, auto_refresh=True, verbose=False)
            # The library can initialize successfully in guest mode after cookies
            # expire. Treat that as failed authentication before model discovery.
            if getattr(getattr(client, "account_status", None), "name", None) == "UNAUTHENTICATED":
                raise WorkerError(401, "Gemini Web session expired or was rejected; reconnect it")
            model = select_argon(client.list_models())
            if mode == "probe":
                emit_event({"type": "ready"})
                completed = {"type": "done"}
            else:
                # Validate upstream before sending HTTP 200 to the downstream client.
                with thinking_transport(client, level) if level is not None else contextlib.nullcontext():
                    completed = await generate(client, payload, model, emit_event)
        finally:
            if not keep_open:
                with contextlib.suppress(Exception):
                    await client.close()
    # Flush refreshed cookies and release the session lock before acknowledging
    # completion, so the next conversation turn can start immediately.
    emit_event(completed)


async def generate(client, payload, model, emit_event):
    async with contextlib.aclosing(
        client.generate_content_stream(payload["prompt"], model=model, temporary=True)
    ) as stream:
        first = await anext(stream, None)
        if first is None:
            raise WorkerError(502, "Gemini Web returned no response")
        emit_event({"type": "ready"})
        count = 0
        truncated = False

        def send(output):
            nonlocal count, truncated
            delta = output.text_delta or ""
            remaining = MAX_OUTPUT_CHARS - count
            text = delta[:remaining]
            if text:
                emit_event({"type": "delta", "text": text})
                count += len(text)
            truncated = len(delta) > remaining or count >= MAX_OUTPUT_CHARS

        send(first)
        if not truncated:
            async for output in stream:
                send(output)
                if truncated:
                    break
        return {"type": "done", "truncated": truncated}


def safe_error(error):
    if isinstance(error, WorkerError):
        return error.status, error.message
    # Never forward library exception strings: they may contain browser tokens.
    name = type(error).__name__
    if name in ("AuthError",):
        return 401, "Gemini Web session expired or was rejected; reconnect it"
    if name == "UsageLimitExceededError":
        return 429, "Gemini Web usage limit reached; wait before retrying"
    if name == "TemporarilyBlockedError":
        return 403, "Gemini Web session is temporarily blocked"
    if name == "ModelInvalidError":
        return 404, "Gemini Web rejected the selected Argon model; no fallback was used"
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)) or name == "TimeoutError":
        return 504, "Gemini Web request timed out"
    if isinstance(error, ImportError):
        return 503, "Gemini Web Python dependencies are not installed"
    return 502, "Gemini Web request failed; check session access and connectivity"


def main():
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise WorkerError(400, "Gemini Web worker request is too large")
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise WorkerError(400, "Invalid Gemini Web worker request") from None
        from session import request
        asyncio.run(request(payload))
    except Exception as error:
        status, message = safe_error(error)
        emit({"type": "error", "status": status, "message": message})
        return 1
    return 0


if __name__ == "__main__":
    sys.modules["worker"] = sys.modules[__name__]
    raise SystemExit(main())
