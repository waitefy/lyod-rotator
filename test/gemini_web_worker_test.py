"""Contract tests using an in-memory Gemini App, without browser credentials."""
import asyncio
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
    return SimpleNamespace(model_name=name, display_name=name, aliases=[], is_available=available)


class Client:
    def __init__(self, models, deltas):
        self.models, self.deltas = models, deltas
        self.generated = False
        self.closed = False

    async def init(self, **kwargs):
        pass

    def list_models(self):
        return self.models

    async def generate_content_stream(self, prompt, *, model, temporary):
        self.generated = True
        self.selection, self.temporary, self.prompt = model, temporary, prompt
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

    def test_invalid_cookies_and_oversized_utf8_never_generate(self):
        client = Client([model("argon")], [])
        self.cookies.write_text("[]")
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client)
        self.assertEqual(caught.exception.status, 401)
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client, {**self.payload, "prompt": "🌍" * 12001})
        self.assertEqual(caught.exception.status, 400)
        self.assertFalse(client.generated)

    def test_empty_upstream_fails_before_ready(self):
        client = Client([model("argon")], [])
        with self.assertRaises(worker.WorkerError) as caught:
            self.run_client(client)
        self.assertEqual(caught.exception.status, 502)


if __name__ == "__main__":
    unittest.main()
