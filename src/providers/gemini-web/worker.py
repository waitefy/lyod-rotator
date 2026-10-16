"""Private Gemini Web protocol. Requests use a persistent, local session broker."""

import asyncio
import base64
import binascii
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urljoin, urlsplit

# Mirror GEMINI_WEB_MAX_PROMPT_BYTES in credentials.ts.
MAX_PROMPT_BYTES = 4 * 1024 * 1024
# Mirror attachments.ts. No local paths or remote URLs cross this protocol.
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS = 8
ATTACHMENT_EXTENSIONS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
}
# JSON escaping can expand one input byte into six (e.g. control characters).
MAX_INPUT_BYTES = MAX_PROMPT_BYTES * 6 + 4 * ((MAX_TOTAL_ATTACHMENT_BYTES + 2) // 3) + 65_536
MAX_OUTPUT_CHARS = 128_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_EVENT_BYTES = max(MAX_OUTPUT_CHARS * 6, 4 * ((MAX_IMAGE_BYTES + 2) // 3)) + 4096
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
        self.original_stream = transport.stream

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
        return self.original_stream(method, url, **kwargs)


@contextlib.contextmanager
def thinking_transport(client, level):
    original = client.client
    wrapper = ThinkingTransport(original, level)
    # upload_file validates the concrete AsyncSession type. Preserve the
    # transport object and intercept only StreamGenerate's stream method.
    original.stream = wrapper.stream
    try:
        yield
    finally:
        original.stream = wrapper.original_stream


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


def decode_attachments(value):
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS:
        raise WorkerError(400, f"Gemini Web accepts at most {MAX_ATTACHMENTS} inline attachments")
    decoded, total = [], 0
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("mimeType"), str) or item["mimeType"] not in ATTACHMENT_EXTENSIONS or not isinstance(item.get("data"), str):
            raise WorkerError(400, "Unsupported Gemini Web inline attachment")
        data = item["data"]
        if not data or len(data) > 4 * ((MAX_ATTACHMENT_BYTES + 2) // 3):
            raise WorkerError(400, "Gemini Web attachment exceeds the per-file limit")
        try:
            raw = base64.b64decode(data, validate=True)
            if base64.b64encode(raw).decode() != data:
                raise ValueError()
        except (ValueError, binascii.Error):
            raise WorkerError(400, "Invalid Gemini Web attachment base64 data") from None
        total += len(raw)
        if not raw or len(raw) > MAX_ATTACHMENT_BYTES or total > MAX_TOTAL_ATTACHMENT_BYTES:
            raise WorkerError(400, "Gemini Web attachment byte limit exceeded")
        decoded.append((item["mimeType"], raw))
    return decoded


async def run(payload, client_factory=None, *, keep_open=False, emit_event=emit):
    mode = payload.get("mode")
    if mode not in ("probe", "generate"):
        raise WorkerError(400, "Invalid Gemini Web worker operation")
    if mode == "generate":
        if payload.get("output", "text") not in ("text", "image", "image-or-text"):
            raise WorkerError(400, "Unsupported Gemini Web output type")
        level = payload.get("thinkingLevel")
        if level is not None and (not isinstance(level, str) or level not in THINKING_LEVELS):
            raise WorkerError(400, "Gemini Web thinking level must be low, medium or high")
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > MAX_PROMPT_BYTES:
            raise WorkerError(400, f"Gemini Web requires a text prompt of at most {MAX_PROMPT_BYTES} UTF-8 bytes")
        attachments = decode_attachments(payload.get("attachments", []))
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
                    completed = await generate(client, payload, model, emit_event, attachments)
        finally:
            if not keep_open:
                with contextlib.suppress(Exception):
                    await client.close()
    # Flush refreshed cookies and release the session lock before acknowledging
    # completion, so the next conversation turn can start immediately.
    emit_event(completed)


async def generate(client, payload, model, emit_event, attachments=()):
    with contextlib.ExitStack() as cleanup:
        kwargs = {}
        if attachments:
            directory = Path(cleanup.enter_context(tempfile.TemporaryDirectory(prefix="gemini-web-upload-")))
            files = []
            for index, (mime_type, raw) in enumerate(attachments, 1):
                path = directory / f"attachment-{index}{ATTACHMENT_EXTENSIONS[mime_type]}"
                path.write_bytes(raw)
                path.chmod(0o600)
                files.append(path)
            kwargs["files"] = files
        return await consume_stream(client, payload, model, emit_event, kwargs)


async def consume_stream(client, payload, model, emit_event, kwargs):
    image_mode = payload.get("output") in ("image", "image-or-text")
    image = None
    async with contextlib.aclosing(
        client.generate_content_stream(payload["prompt"], model=model, temporary=True, **kwargs)
    ) as stream:
        first = await anext(stream, None)
        if first is None:
            raise WorkerError(502, "Gemini Web returned no response")
        emit_event({"type": "ready"})
        count = 0
        truncated = False

        def send(output):
            nonlocal count, truncated, image
            if image_mode:
                candidates = getattr(output, "candidates", [])
                chosen = getattr(output, "chosen", 0)
                if isinstance(chosen, int) and 0 <= chosen < len(candidates):
                    generated = getattr(candidates[chosen], "generated_images", [])
                    if generated:
                        image = generated[0]
                if payload.get("output") == "image":
                    return
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
    if image_mode and image is None and payload.get("output") == "image":
        raise WorkerError(502, "Gemini Web returned no generated image; the request may have been refused")
    if image_mode and image is not None:
        # Match the pinned GeneratedImage.save() size fallback instead of
        # downloading Google's small default thumbnail. Actual size is upstream.
        image_url = image.url.replace("=s1024-rj", "=s2048-rj")
        if "=s2048-rj" not in image_url:
            image_url += "=s2048-rj"
        emit_event({"type": "image", **await download_generated_image(client.client, image_url)})
    return {"type": "done", "truncated": truncated}


async def download_generated_image(transport, url):
    """Download only a generated-image object, without exposing its signed URL.

    The library's save() buffers unbounded responses and follows redirects.
    Use its authenticated transport with bounded reads and checked redirects.
    """
    for _ in range(4):
        try:
            parsed = urlsplit(url)
            host = parsed.hostname or ""
            if (parsed.scheme != "https" or parsed.username or parsed.password or
                    parsed.port not in (None, 443) or parsed.fragment or
                    not (host in ("googleusercontent.com", "work.fife.usercontent.google.com") or host.endswith(".googleusercontent.com")) or
                    any(c.isspace() or ord(c) < 32 or c == "\\" for c in url)):
                raise ValueError()
        except (ValueError, TypeError):
            raise WorkerError(502, "Gemini Web returned an unsupported generated-image address") from None
        async with transport.stream("GET", url, headers={"Referer": "https://gemini.google.com/"}, allow_redirects=False) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    break
                if any(c.isspace() or ord(c) < 32 or c == "\\" for c in location):
                    raise WorkerError(502, "Gemini Web returned an unsupported generated-image address")
                url = urljoin(url, location)
                continue
            if response.status_code != 200:
                raise WorkerError(502, "Cannot download the Gemini Web generated image")
            length = response.headers.get("content-length", "")
            if str(length).isdigit() and int(length) > MAX_IMAGE_BYTES:
                raise WorkerError(502, "Gemini Web generated image exceeds the 8 MiB limit")
            raw = bytearray()
            async for chunk in response.aiter_content():
                if len(raw) + len(chunk) > MAX_IMAGE_BYTES:
                    raise WorkerError(502, "Gemini Web generated image exceeds the 8 MiB limit")
                raw.extend(chunk)
            mime = ("image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else
                    "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else
                    "image/webp" if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" else None)
            if mime is None:
                raise WorkerError(502, "Gemini Web returned an unsupported generated-image format")
            return {"mimeType": mime, "data": base64.b64encode(raw).decode()}
    raise WorkerError(502, "Gemini Web generated-image redirect limit exceeded")


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
