"""Contract tests using an in-memory Gemini App, without browser credentials."""
import asyncio
from datetime import datetime, timedelta, timezone
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "worker", Path(__file__).parents[1] / "src/providers/gemini-web/worker.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def model(name, available=True):
    return SimpleNamespace(model_name=name, display_name=name, aliases=[], is_available=available, model_id="95a4c0abcba24364")


class Client:
    def __init__(self, models, deltas):
        self.models, self.deltas = models, deltas
        self.generated = False
        self.closed = False
        self.served_model_id = "95a4c0abcba24364"
        self.usage_info = {}
        self.raw_response = None
        self.client = SimpleNamespace(stream=self.http_stream)

    @contextlib.asynccontextmanager
    async def http_stream(self, *args, **kwargs):
        async def content():
            inner = [None] * 43
            inner[39] = self.served_model_id
            inner[42] = "4 Argon"  # A name alone must not pass identity verification.
            envelope = json.dumps([["wrb.fr", None, json.dumps(inner)]], ensure_ascii=False)
            # Google counts both surrounding newlines in the UTF-16 length.
            raw = (")]}'\n" + str(len(envelope.encode("utf-16-le")) // 2 + 2) + "\n" + envelope + "\n").encode()
            if self.raw_response is not None:
                raw = self.raw_response
            for offset in range(0, len(raw), 7):
                yield raw[offset:offset + 7]
        yield SimpleNamespace(status_code=200, aiter_content=content)

    async def read_generation(self):
        async with self.client.stream("POST", "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate") as response:
            async for _ in response.aiter_content():
                pass

    async def init(self, **kwargs):
        pass

    def list_models(self):
        return self.models

    async def generate_content_stream(self, prompt, *, model, temporary):
        self.generated = True
        self.selection, self.temporary, self.prompt = model, temporary, prompt
        await self.read_generation()
        cumulative = ""
        for delta in self.deltas:
            cumulative += delta
            yield SimpleNamespace(text=cumulative, text_delta=delta)

    async def close(self):
        self.closed = True


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cookies = Path(self.temp.name) / "cookies.json"
        self.cookies.write_text(json.dumps({"__Secure-1PSID": "fixture-not-a-secret"}))
        self.payload = {"mode": "generate", "cookiesFile": str(self.cookies), "prompt": "Привет"}

    def run_client(self, client, payload=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(worker.run(payload or self.payload, lambda *args, **kwargs: client))
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_discovers_argon_and_sends_only_new_unicode_text(self):
        argon = model("Gemini 4 Argon")
        client = Client([model("Gemini Pro"), argon], ["При", "вет 🌍"])
        events = self.run_client(client)
        self.assertIs(client.selection, argon)
        self.assertTrue(client.temporary)
        self.assertTrue(client.closed)
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "delta"), "Привет 🌍")
        self.assertEqual(events[0]["type"], "ready")
        self.assertEqual(events[-1], {"type": "done", "truncated": False})

    def test_never_falls_back_to_pro_or_unavailable_argon(self):
        for models in (None, [model("Gemini Pro")], [model("Gemini 4 Argon", False)]):
            client = Client(models, ["wrong model"])
            with self.assertRaises(worker.WorkerError) as caught:
                self.run_client(client)
            self.assertEqual(caught.exception.status, 404)
            self.assertFalse(client.generated)
            self.assertTrue(client.closed)

    def test_exhausted_five_hour_or_weekly_budget_never_generates(self):
        for window in ("current_5h", "weekly"):
            client = Client([model("argon")], ["must not generate"])
            client.usage_info = {window: {"remaining_credits": 0, "usage_level": 1,
                "reset_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()}}
            with self.assertRaises(worker.WorkerError) as caught:
                self.run_client(client)
            self.assertEqual(caught.exception.status, 429)
            self.assertIn("RESOURCE_EXHAUSTED", caught.exception.message)
            self.assertFalse(client.generated)
            self.assertTrue(client.closed)

    def test_wrong_or_missing_server_model_is_rejected_before_any_event(self):
        for served, status in (("8c46e95b1a07cecc", 429), (None, 502), ([], 502)):
            client = Client([model("argon")], ["must not escape"])
            client.served_model_id = served
            events = []
            with self.assertRaises(worker.WorkerError) as caught:
                asyncio.run(worker.run(self.payload, lambda *a, **k: client, emit_event=events.append))
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(events, [])
            self.assertTrue(client.closed)

    def test_wire_guard_checks_final_frames_not_names_or_user_text(self):
        def frame(identity, user_text=""):
            inner = [None] * 43
            inner[0], inner[39], inner[42] = user_text, identity, "4 Argon"
            envelope = json.dumps([["wrb.fr", None, json.dumps(inner, ensure_ascii=False)]], ensure_ascii=False)
            return (str(len(envelope.encode("utf-16-le")) // 2 + 2) + "\n" + envelope + "\n").encode()
        valid = frame("95a4c0abcba24364", "Я🌍")
        cases = [(valid + frame("8c46e95b1a07cecc"), 429),
                 (frame(None, "95a4c0abcba24364 4 Argon"), 502),
                 (b"999999\n" + valid.split(b"\n", 1)[1], 502),
                 (valid[:-2], 502)]
        for raw, status in cases:
            client = Client([model("argon")], ["tool call must not escape"])
            client.raw_response = b")]}'\n" + raw
            original = client.client.stream
            events = []
            with self.assertRaises(worker.WorkerError) as caught:
                asyncio.run(worker.run(self.payload, lambda *a, **k: client, emit_event=events.append))
            self.assertEqual(caught.exception.status, status)
            self.assertEqual(events, [])
            self.assertEqual(client.client.stream, original)
        client = Client([model("argon")], ["Unicode frame accepted"])
        client.raw_response = b")]}'\n" + valid + valid
        self.assertEqual(self.run_client(client)[1]["text"], "Unicode frame accepted")

    def test_wire_guard_bounds_buffer_without_leaking_or_succeeding(self):
        client = Client([model("argon")], ["must not escape"])
        events = []
        with patch.object(worker, "MAX_UPSTREAM_BYTES", 16), self.assertRaises(worker.WorkerError) as caught:
            asyncio.run(worker.run(self.payload, lambda *a, **k: client, emit_event=events.append))
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(events, [])
        self.assertTrue(client.closed)

    def test_probe_refreshes_usage_and_only_exports_whitelisted_metrics(self):
        client = Client([model("argon")], [])
        async def refresh():
            client.usage_info = {"private": "SECRET", "current_5h": {"remaining_credits": 0,
                "usage_level": 1, "reset_at": "2026-10-20T20:00:00+00:00", "private": "SECRET"}}
        client._fetch_usage_info = refresh
        events = self.run_client(client, {**self.payload, "mode": "probe"})
        self.assertEqual(events[-1]["usage"], {"current_5h": {"remaining_credits": 0,
            "usage_level": 1, "reset_at": "2026-10-20T20:00:00+00:00"}})
        self.assertNotIn("SECRET", json.dumps(events))
        self.assertFalse(client.generated)

    def test_expired_budget_and_rounded_usage_do_not_permanently_block_generation(self):
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        for quota in ({"usage_level": .999, "remaining_credits": 1, "reset_at": future},
                      {"usage_level": 1, "remaining_credits": 0, "reset_at": past}):
            client = Client([model("argon")], ["OK"])
            client.usage_info = {"current_5h": quota}
            self.assertEqual(self.run_client(client)[1]["text"], "OK")

    def test_error_event_only_includes_bounded_retry_after_for_quota(self):
        for retry, expected in ((7200, 7200), (None, None), (-1, None), (604801, None), ("SECRET", None)):
            event = worker.error_event(worker.WorkerError(429, "safe", retry))
            self.assertEqual(event.get("retryAfterSeconds"), expected)
            self.assertNotIn("SECRET", json.dumps(event))
        self.assertNotIn("retryAfterSeconds", worker.error_event(worker.WorkerError(502, "safe", 60)))

    def test_probe_makes_no_generation_request(self):
        client = Client([model("argon")], [])
        events = self.run_client(client, {**self.payload, "mode": "probe"})
        self.assertFalse(client.generated)
        self.assertEqual([e["type"] for e in events], ["ready", "done"])

    def test_guest_session_is_an_auth_error_even_if_argon_is_listed(self):
        for models in ([model("Gemini Flash-Lite")], [model("argon")]):
            client = Client(models, ["must not generate"])
            client.account_status = SimpleNamespace(name="UNAUTHENTICATED")
            with self.assertRaises(worker.WorkerError) as caught:
                self.run_client(client)
            self.assertEqual(caught.exception.status, 401)
            self.assertFalse(client.generated)
            self.assertTrue(client.closed)

    def test_output_bound_closes_upstream(self):
        client = Client([model("Gemini-4-Argon")], ["abcd", "efgh", "unread"])
        with patch.object(worker, "MAX_OUTPUT_CHARS", 6):
            events = self.run_client(client)
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "delta"), "abcdef")
        self.assertTrue(events[-1]["truncated"])
        self.assertTrue(client.closed)

    def test_session_lock_prevents_concurrent_google_requests(self):
        cache = self.cookies.parent / ".gemini-web-cache" / hashlib.sha256(str(self.cookies).encode()).hexdigest()[:24]
        cache.mkdir(parents=True)
        with (cache / "session.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            client = Client([model("argon")], ["should not happen"])
            with patch.object(worker, "SESSION_LOCK_WAIT_SECONDS", 0), self.assertRaises(worker.WorkerError) as caught:
                self.run_client(client)
            self.assertEqual(caught.exception.status, 409)
            self.assertFalse(client.generated)

    def test_overlapping_requests_wait_until_first_client_is_closed(self):
        async def check():
            started, release = asyncio.Event(), asyncio.Event()
            first = Client([model("argon")], ["first"])
            second = Client([model("argon")], ["second"])
            original_init = first.init

            async def slow_init(**kwargs):
                started.set()
                await release.wait()
                await original_init(**kwargs)

            first.init = slow_init
            factory_calls = []

            def second_factory(*args, **kwargs):
                self.assertTrue(first.closed)
                factory_calls.append(True)
                return second

            a = asyncio.create_task(worker.run(self.payload, lambda *args, **kwargs: first))
            await asyncio.wait_for(started.wait(), 1)
            b = asyncio.create_task(worker.run(self.payload, second_factory))
            await asyncio.sleep(0.02)
            self.assertEqual(factory_calls, [])
            self.assertFalse(b.done())
            release.set()
            await asyncio.wait_for(asyncio.gather(a, b), 2)
            self.assertTrue(second.generated)
            self.assertTrue(second.closed)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(check())
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([e["type"] for e in events], ["ready", "delta", "done"] * 2)

    def test_waiting_for_session_lock_is_cancellable(self):
        async def check():
            path = Path(self.temp.name) / "cancel.lock"
            with path.open("a") as held, path.open("a") as waiting:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                task = asyncio.create_task(worker.acquire_session_lock(waiting))
                await asyncio.sleep(0.01)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                fcntl.flock(held, fcntl.LOCK_UN)
                await asyncio.wait_for(worker.acquire_session_lock(waiting), 1)

        asyncio.run(check())

    def test_auth_errors_are_sanitized(self):
        AuthError = type("AuthError", (Exception,), {})
        status, message = worker.safe_error(AuthError("__Secure-1PSID=PRIVATE"))
        self.assertEqual(status, 401)
        self.assertNotIn("PRIVATE", message)
        self.assertEqual(worker.safe_error(RuntimeError("PRIVATE"))[0], 502)

    def test_large_unicode_prompt_reaches_client_intact(self):
        prompt = "Я🌍" * 80000 + "LARGE_PROMPT_END"
        client = Client([model("argon")], ["LARGE_OK"])
        events = self.run_client(client, {**self.payload, "prompt": prompt})
        self.assertEqual(client.prompt, prompt)
        self.assertEqual(events[-1]["type"], "done")

    def test_utf8_prompt_boundary_and_json_escaping_budget(self):
        prompt = "🌍" * (worker.MAX_PROMPT_BYTES // 4)
        client = Client([model("argon")], ["OK"])
        self.run_client(client, {**self.payload, "prompt": prompt})
        self.assertEqual(client.prompt, prompt)
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client, {**self.payload, "prompt": prompt + "x"})
        self.assertEqual(caught.exception.status, 400)
        escaped = json.dumps({**self.payload, "prompt": "\x01" * worker.MAX_PROMPT_BYTES}).encode()
        self.assertLess(len(escaped), worker.MAX_INPUT_BYTES)

    def test_invalid_cookies_and_oversized_utf8_never_generate(self):
        client = Client([model("argon")], [])
        self.cookies.write_text("[]")
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client)
        self.assertEqual(caught.exception.status, 401)
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client, {**self.payload, "prompt": "🌍" * (worker.MAX_PROMPT_BYTES // 4 + 1)})
        self.assertEqual(caught.exception.status, 400)
        self.assertFalse(client.generated)

    def test_empty_upstream_fails_before_ready(self):
        client = Client([model("argon")], [])
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client)
        self.assertEqual(caught.exception.status, 502)

    def test_each_level_changes_both_wire_selectors_without_changing_other_fields(self):
        body = [None] * 81
        body[0], body[79], body[80] = ["fixture prompt"], 9, 1
        header = [None] * 17
        header[4], header[14], header[15], header[16] = "discovered-argon", 9, 1, "session-fixture"
        kwargs = {"data": {"at": "token-fixture", "f.req": json.dumps([None, json.dumps(body)])},
                  "headers": {worker.MODEL_HEADER: json.dumps(header), "other": "unchanged"}}
        for level, value in (("low", 1), ("medium", 4), ("high", 2)):
            captured = []
            transport = SimpleNamespace(stream=lambda *args, **kw: captured.append((args, kw)))
            wrapper = worker.ThinkingTransport(transport, level)
            wrapper.stream("POST", "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", **kwargs)
            sent = captured[0][1]
            actual_body = json.loads(json.loads(sent["data"]["f.req"])[1])
            actual_header = json.loads(sent["headers"][worker.MODEL_HEADER])
            self.assertEqual(actual_body[80], value)
            self.assertEqual(actual_header[15], value)
            actual_body[80] = actual_header[15] = 1
            self.assertEqual(actual_body, body)
            self.assertEqual(actual_header, header)
            self.assertEqual(sent["data"]["at"], "token-fixture")
            self.assertEqual(sent["headers"]["other"], "unchanged")
            self.assertEqual(json.loads(json.loads(kwargs["data"]["f.req"])[1])[80], 1)

    def test_changed_protocol_never_sends_or_exposes_secrets(self):
        called = []
        wrapper = worker.ThinkingTransport(SimpleNamespace(stream=lambda *a, **k: called.append(True)), "medium")
        with self.assertRaises(worker.WorkerError) as caught:
            wrapper.stream("POST", "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
                           data={"f.req": "private-cookie-fixture"}, headers={})
        self.assertEqual(called, [])
        self.assertEqual(caught.exception.status, 502)
        self.assertNotIn("private-cookie", caught.exception.message)

    def test_transport_restores_on_cancellation_but_never_resurrects_closed_client(self):
        original = SimpleNamespace(cookies={"fixture": "cookie"}, stream=lambda *args, **kwargs: None)
        client = SimpleNamespace(client=original)
        with self.assertRaises(asyncio.CancelledError):
            with worker.thinking_transport(client, "medium"):
                self.assertIs(client.client, original)
                self.assertIs(client.client.cookies, original.cookies)
                raise asyncio.CancelledError()
        self.assertIs(client.client, original)
        with worker.thinking_transport(client, "high"):
            client.client = None
        self.assertIsNone(client.client)

    def test_thinking_adapter_preserves_upload_client_type_and_stream_method(self):
        class TypedTransport:
            def stream(self, method, url, **kwargs):
                return method, url, kwargs
        original = TypedTransport()
        stream = original.stream
        client = SimpleNamespace(client=original)
        with worker.thinking_transport(client, "medium"):
            # The pinned upload_file's validate_call requires an AsyncSession,
            # so a proxy object breaks uploads before any HTTP request is sent.
            self.assertIsInstance(client.client, TypedTransport)
            self.assertIs(client.client, original)
            self.assertEqual(client.client.stream("POST", "https://content-push.googleapis.com/upload"),
                             ("POST", "https://content-push.googleapis.com/upload", {}))
        self.assertEqual(original.stream, stream)

    def test_unknown_level_rejected_before_client_initialization(self):
        for value in ("ultra", 3, []):
            with self.assertRaises(worker.WorkerError) as caught:
                self.run_client(Client([model("argon")], []), {**self.payload, "thinkingLevel": value})
            self.assertEqual(caught.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
