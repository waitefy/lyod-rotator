"""Private Gemini Web protocol. Requests use a persistent, local session broker."""

import asyncio
import base64
import binascii
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urljoin, urlsplit

from citation_text import CitationText

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
MAX_UPSTREAM_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_CHARS = 128_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_EVENT_BYTES = max(MAX_OUTPUT_CHARS * 6, 4 * ((MAX_IMAGE_BYTES + 2) // 3)) + 4096
SESSION_LOCK_WAIT_SECONDS = 60
ARGON_NAME = re.compile(r"(?:\bgemini[\s_-]*4[\s_-]*argon\b|^argon$)", re.I)
# Gemini App's enum: STANDARD=1, EXTENDED=2, DEEP_THINK=3, MEDIUM=4.
# Low / Medium / High are STANDARD / MEDIUM / EXTENDED, not 1 / 2 / 3.
THINKING_LEVELS = {"low": 1, "medium": 4, "high": 2}
MODEL_HEADER = "x-goog-ext-525001261-jspb"
GENERATE_ENDPOINT = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"


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
    def __init__(self, status, message, retry_after=None):
        self.status = status
        self.message = message
        self.retry_after = retry_after


class ModelVerificationError(WorkerError):
    def __init__(self, reason):
        super().__init__(502, f"Gemini Web response model could not be verified ({reason}); response discarded")


class GoogleStreamError(WorkerError):
    def __init__(self, code):
        # ErrorCode and _process_parts in the pinned gemini-webapi revision.
        status, reason = {
            1013: (503, "temporary upstream error"),
            1037: (429, "RESOURCE_EXHAUSTED: usage limit reached"),
            1050: (404, "selected model is inconsistent with the conversation"),
            1052: (404, "selected model or request structure was rejected"),
            1060: (403, "session IP is temporarily blocked"),
        }.get(code, (502, "upstream API error"))
        self.google_code = code
        super().__init__(status, f"Gemini Web {reason} (Google code {code}); response discarded",
                         60 if code == 1037 else None)


def response_metadata(raw):
    """Read only model IDs and fatal error codes from Google's JSON envelopes.

    Lengths are JavaScript UTF-16 code units, not bytes. Never search arbitrary
    response text for model names: user content can contain those same strings.
    """
    text = raw.decode("utf-8")
    if text.startswith(")]}'"):
        text = text[4:]
    decoder, ids, errors = json.JSONDecoder(), [], []
    position = 0
    while position < len(text):
        while position < len(text) and text[position].isspace():
            position += 1
        if position == len(text):
            break
        end = text.index("\n", position)
        marker = text[position:end].strip()
        if not marker.isascii() or not marker.isdecimal():
            raise ValueError()
        # The delimiter newline belongs to the declared frame length, as
        # does trailing whitespace. Match the pinned StreamingFrameParser.
        start, position, units = end, end, 0
        expected = int(marker)
        while position < len(text) and units < expected:
            units += 2 if ord(text[position]) > 0xFFFF else 1
            position += 1
        if units != expected:
            raise ValueError()
        envelope = decoder.decode(text[start:position])
        if not isinstance(envelope, list):
            raise ValueError()
        for part in envelope:
            # The library treats this path as fatal, even after earlier parts
            # contained candidates. Inspect it before releasing any output.
            try:
                code = part[5][2][0][1][0]
            except (IndexError, KeyError, TypeError):
                code = None
            if code:
                if type(code) is not int or not 1 <= code <= 99_999_999:
                    raise ValueError()
                errors.append(code)
            if not isinstance(part, list) or len(part) < 3 or part[0] != "wrb.fr" or not isinstance(part[2], str):
                continue
            inner = json.loads(part[2])
            if isinstance(inner, list) and len(inner) > 39 and inner[39] is not None:
                if not isinstance(inner[39], str) or not inner[39]:
                    raise ValueError()
                ids.append(inner[39])
    return ids, errors


def response_model_ids(raw):
    return response_metadata(raw)[0]


class ModelGuard:
    """Buffer the bounded wire response before the library can emit any text.

    Google may put the served model in the final frame. Checking just the first
    delta would allow an HTTP-200 downgrade to escape, including tool calls.
    """
    def __init__(self, expected):
        if not isinstance(expected, str) or not expected:
            raise WorkerError(502, "Gemini Web Argon model identifier is unavailable")
        self.expected, self.verified, self.error = expected, False, None

    def check(self):
        if self.error:
            raise self.error
        if self.verified and (self.client.client is not self.original or self.original.stream is not self.stream):
            raise WorkerError(502, "Gemini Web generation transport changed; response discarded")
        if not self.verified:
            raise WorkerError(502, "Gemini Web response model could not be verified; response discarded")

    def inspect(self, raw):
        try:
            ids, errors = response_metadata(raw)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            self.error = ModelVerificationError("invalid response metadata")
        else:
            if any(model_id != self.expected for model_id in ids):
                self.error = WorkerError(429, "Gemini Web RESOURCE_EXHAUSTED: Google returned a different model; response discarded", 60)
            elif errors:
                # A permanent error in the same response prevents a retry,
                # even if an earlier frame reported temporary error 1013.
                self.error = GoogleStreamError(next((code for code in errors if code != 1013), errors[0]))
            elif not ids:
                self.error = ModelVerificationError("missing model identifier")
            else:
                self.verified = True

    @contextlib.contextmanager
    def transport(self, client):
        original = client.client
        original_stream = original.stream
        guard = self

        class Response:
            def __init__(self, response):
                self.response = response

            def __getattr__(self, name):
                return getattr(self.response, name)

            async def aiter_content(self, *args, **kwargs):
                raw = bytearray()
                async for chunk in self.response.aiter_content(*args, **kwargs):
                    if len(raw) + len(chunk) > MAX_UPSTREAM_BYTES:
                        guard.error = WorkerError(502, "Gemini Web response exceeds the verification limit")
                        raise guard.error
                    raw.extend(chunk)
                guard.inspect(raw)
                if guard.error and not isinstance(guard.error, ModelVerificationError):
                    raise guard.error
                # For unverifiable metadata, let the library identify other
                # explicit failures; consume_stream still checks before ready.
                yield bytes(raw)

        @contextlib.asynccontextmanager
        async def stream(method, url, **kwargs):
            generate = method == "POST" and str(url) == GENERATE_ENDPOINT
            if generate:
                if guard.error:
                    raise guard.error
                guard.verified = False
            async with original_stream(method, url, **kwargs) as response:
                yield Response(response) if generate and response.status_code == 200 else response

        self.client, self.original, self.stream = client, original, stream
        original.stream = stream
        try:
            yield self
        finally:
            original.stream = original_stream


def usage_snapshot(client):
    """Expose only quota metrics; never pass arbitrary library metadata to TS."""
    source = getattr(client, "usage_info", None)
    result = {}
    if not isinstance(source, dict):
        return result
    for key in ("current_5h", "weekly"):
        window = source.get(key)
        if not isinstance(window, dict):
            continue
        row = {}
        for field in ("remaining_credits", "usage_level"):
            value = window.get(field)
            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                row[field] = value
        reset = window.get("reset_at")
        if isinstance(reset, str):
            try:
                date = datetime.fromisoformat(reset)
                if date.tzinfo is not None:
                    row["reset_at"] = date.isoformat()
            except ValueError:
                pass
        if row:
            result[key] = row
    return result


def exhausted_retry_after(usage):
    waits = []
    now = datetime.now(timezone.utc)
    for window in usage.values():
        if window.get("remaining_credits", 1) > 0 and window.get("usage_level", 0) < 1:
            continue
        reset = window.get("reset_at")
        seconds = (datetime.fromisoformat(reset) - now).total_seconds() if reset else 60
        if seconds > 0:
            waits.append(min(604800, max(1, math.ceil(seconds))))
    return max(waits, default=None)


def error_event(error):
    status, message = safe_error(error)
    event = {"type": "error", "status": status, "message": message}
    retry = getattr(error, "retry_after", None)
    if status == 429 and type(retry) is int and 1 <= retry <= 604800:
        event["retryAfterSeconds"] = retry
    return event


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
            # init() is a no-op for a persistent client; refresh its budget too.
            refresh_usage = getattr(client, "_fetch_usage_info", None)
            if callable(refresh_usage):
                await refresh_usage()
            usage = usage_snapshot(client)
            if mode == "probe":
                identity = None
                if payload.get("includeIdentity") is True:
                    from browser_login import parse_identity
                    response = await client.client.get("https://gemini.google.com/app", timeout=45)
                    try:
                        if (response.status_code != 200 or urlsplit(str(response.url)).hostname != "gemini.google.com"
                                or len(response.text) > 8_000_000):
                            raise ValueError()
                        identity = parse_identity(response.text)
                    except ValueError:
                        raise WorkerError(401, "Cannot identify the authenticated Gemini account; reconnect the web session") from None
                emit_event({"type": "ready"})
                completed = {"type": "done", "usage": usage}
                if identity is not None:
                    completed["identity"] = identity
            else:
                # Validate upstream before sending HTTP 200 to the downstream client.
                retry_after = exhausted_retry_after(usage)
                if retry_after is not None:
                    raise WorkerError(429, "Gemini Web RESOURCE_EXHAUSTED: account usage limit reached", retry_after)
                with thinking_transport(client, level) if level is not None else contextlib.nullcontext():
                    completed = await generate_verified(client, payload, model, emit_event, attachments)
        finally:
            if not keep_open:
                with contextlib.suppress(Exception):
                    await client.close()
    # Flush refreshed cookies and release the session lock before acknowledging
    # completion, so the next conversation turn can start immediately.
    emit_event(completed)


async def generate_verified(client, payload, model, emit_event, attachments=()):
    started = False

    def forward_event(event):
        nonlocal started
        started = True
        emit_event(event)

    for attempt in range(2):
        guard = ModelGuard(getattr(model, "model_id", None))
        try:
            with guard.transport(client):
                return await generate(client, payload, model, forward_event, attachments, guard)
        except Exception as error:
            if type(error).__name__ in ("UsageLimitExceededError", "AuthError", "ModelInvalidError"):
                raise
            failure = guard.error or error
            # Both attempts require the same Argon ID. No replay is allowed
            # after ready/text/tool output, or for quota/auth/model mismatches.
            temporary = isinstance(failure, GoogleStreamError) and failure.google_code == 1013
            if attempt == 0 and not started and (isinstance(failure, ModelVerificationError) or temporary):
                if temporary:
                    await asyncio.sleep(1)
                continue
            if failure is error:
                raise
            raise failure from None


async def generate(client, payload, model, emit_event, attachments=(), guard=None):
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
        return await consume_stream(client, payload, model, emit_event, kwargs, guard)


async def consume_stream(client, payload, model, emit_event, kwargs, guard=None):
    image_mode = payload.get("output") in ("image", "image-or-text")
    image = None
    citations = CitationText()
    emitted_chars = 0
    async with contextlib.aclosing(
        client.generate_content_stream(payload["prompt"], model=model, temporary=True, **kwargs)
    ) as stream:
        first = await anext(stream, None)
        if guard is not None:
            guard.check()
        if first is None:
            raise WorkerError(502, "Gemini Web returned no response")
        emit_event({"type": "ready"})
        count = 0
        truncated = False

        def send(output):
            nonlocal count, truncated, image, emitted_chars
            if guard is not None:
                guard.check()
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
            count += len(text)
            candidates = getattr(output, "candidates", [])
            chosen = getattr(output, "chosen", 0)
            sources = getattr(candidates[chosen], "citations", []) if isinstance(chosen, int) and 0 <= chosen < len(candidates) else []
            text = citations.feed(text, sources)
            if text:
                emit_event({"type": "delta", "text": text})
                emitted_chars += len(text)
            truncated = len(delta) > remaining or count >= MAX_OUTPUT_CHARS

        send(first)
        if not truncated:
            async for output in stream:
                send(output)
                if truncated:
                    break
    if guard is not None:
        guard.check()
    tail = citations.finish()
    remaining = MAX_OUTPUT_CHARS - emitted_chars
    if tail:
        if len(tail) > remaining:
            truncated = True
        if remaining:
            emit_event({"type": "delta", "text": tail[:remaining]})
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
    if name == "APIError":
        status = getattr(error, "status_code", None)
        detail = f"HTTP {status}" if type(status) is int and 400 <= status <= 599 else "APIError"
        return 502, f"Gemini Web upstream API error ({detail}); request failed"
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
        emit(error_event(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.modules["worker"] = sys.modules[__name__]
    raise SystemExit(main())
