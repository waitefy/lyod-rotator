"""Persistent session and disconnect tests; no Google requests or real credentials."""
import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
import sys
import signal
import subprocess
import time
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers/gemini-web"))
import session
from gemini_web_worker_test import Client, model


class SessionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gw-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.cookies = Path(self.temp.name) / "c.json"
        self.cookies.write_text(json.dumps({"__Secure-1PSID": "fixture"}))
        self.payload = {"mode": "generate", "cookiesFile": str(self.cookies), "prompt": "hello"}
        self.clients, self.saves = [], []
        def factory(*args, **kwargs):
            client = Client([model("argon")], ["hello"])
            self.clients.append(client)
            return client
        self.session = session.Session(self.payload, factory, self.saves.append)
        self.addAsyncCleanup(self.session.close_client)

    async def test_reuses_client_while_idle_and_reloads_changed_credentials(self):
        events = []
        await self.session.execute(self.payload, events.append)
        first = self.clients[0]
        self.assertFalse(first.closed)
        tick = asyncio.Event()
        async def background():
            await asyncio.sleep(.01)
            tick.set()
        task = asyncio.create_task(background())
        await tick.wait()
        await task
        await self.session.execute(self.payload, events.append)
        self.assertEqual(len(self.clients), 1)
        self.assertEqual(len(self.saves), 2)
        self.assertEqual([e["type"] for e in events], ["ready", "delta", "done"] * 2)
        self.cookies.write_text(json.dumps({"__Secure-1PSID": "new-fixture"}))
        await self.session.execute(self.payload, events.append)
        self.assertTrue(first.closed)
        self.assertEqual(len(self.clients), 2)

    async def test_errors_close_client_and_do_not_save_or_report_success(self):
        self.session.client_factory = lambda *args, **kwargs: Client([model("Flash")], [])
        events = []
        with self.assertRaises(session.worker.WorkerError):
            await self.session.execute(self.payload, events.append)
        self.assertIsNone(self.session.client)
        self.assertEqual(events, [])
        self.assertEqual(self.saves, [])

    async def test_large_unicode_request_crosses_socket_without_truncation(self):
        path = str(Path(self.temp.name) / "large.sock")
        prompt = "Я🌍" * 80000 + "SOCKET_PROMPT_END"
        payload = {**self.payload, "prompt": prompt}
        raw = (json.dumps(payload) + "\n").encode()
        self.assertGreater(len(raw), 256000)
        server = await asyncio.start_unix_server(
            self.session.handle, path=path, limit=session.worker.MAX_INPUT_BYTES + 1
        )
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write(raw)
            await writer.drain()
            events = []
            while line := await asyncio.wait_for(reader.readline(), 5):
                events.append(json.loads(line))
            writer.close()
            await writer.wait_closed()
            self.assertEqual([event["type"] for event in events], ["ready", "delta", "done"])
            self.assertEqual(self.clients[0].prompt, prompt)
        finally:
            server.close()
            await server.wait_closed()

    async def test_socket_disconnect_cancels_generation_and_next_request_recovers(self):
        started, released = asyncio.Event(), asyncio.Event()
        class Stalled(Client):
            async def generate_content_stream(self, *args, **kwargs):
                started.set()
                try:
                    await asyncio.sleep(60)
                    yield SimpleNamespace(text_delta="late")
                finally:
                    released.set()
        self.session.client_factory = lambda *args, **kwargs: Stalled([model("argon")], [])
        path = str(Path(self.temp.name) / "test.sock")
        server = await asyncio.start_unix_server(self.session.handle, path=path)
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write((json.dumps(self.payload) + "\n").encode())
            await writer.drain()
            await asyncio.wait_for(started.wait(), 1)
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(released.wait(), 1)
            for _ in range(20):
                if not self.session.lock.locked():
                    break
                await asyncio.sleep(.01)
            self.assertFalse(self.session.lock.locked())
            self.assertIsNone(self.session.client)
        finally:
            server.close()
            await server.wait_closed()

    async def test_image_event_larger_than_the_text_limit_crosses_the_broker_client(self):
        path = Path(self.temp.name) / "image.sock"
        raw_image = b"\x89PNG\r\n\x1a\n" + b"x" * 1024 * 1024
        event = {"type": "image", "mimeType": "image/png", "data": base64.b64encode(raw_image).decode()}
        async def handle(reader, writer):
            await reader.readline()
            writer.write((json.dumps(event) + '\n{"type":"done"}\n').encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_unix_server(handle, path=str(path))
        events = []
        try:
            with patch.object(session, "session_paths", return_value=(None, None, path)), patch.object(session.worker, "emit", events.append):
                await asyncio.wait_for(session.request({**self.payload, "output": "image"}), 5)
            self.assertEqual(events, [event, {"type": "done"}])
        finally:
            server.close()
            await server.wait_closed()

    async def test_done_is_emitted_after_persistence(self):
        order = []
        self.session.save = lambda client: order.append("save")
        await self.session.execute(self.payload, lambda event: order.append(event["type"]))
        self.assertEqual(order, ["ready", "delta", "save", "done"])

    async def test_request_deadline_releases_session_and_next_request_recovers(self):
        started = asyncio.Event()
        class Stalled(Client):
            async def generate_content_stream(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
                yield
        self.session.client_factory = lambda *args, **kwargs: Stalled([model("argon")], [])
        with patch.object(session, "SESSION_REQUEST_TIMEOUT_SECONDS", .03, create=True):
            task = asyncio.create_task(self.session.execute(self.payload, lambda event: None))
            try:
                await asyncio.wait_for(started.wait(), 1)
                completed, _ = await asyncio.wait({task}, timeout=.3)
                self.assertIn(task, completed, "request exceeded its total session deadline")
                with self.assertRaises(TimeoutError):
                    await task
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(self.session.lock.locked())
        self.assertIsNone(self.session.client)
        self.session.client_factory = lambda *args, **kwargs: Client([model("argon")], ["recovered"])
        events = []
        await self.session.execute(self.payload, events.append)
        self.assertEqual([e.get("text") for e in events if e["type"] == "delta"], ["recovered"])

    async def test_cancelled_request_does_not_hold_lock_during_stalled_close(self):
        started, closing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class Stalled(Client):
            async def generate_content_stream(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
                yield

            async def close(self):
                closing.set()
                await release.wait()
                self.closed = True
        self.session.client_factory = lambda *args, **kwargs: Stalled([model("argon")], [])
        with patch.object(session, "CLIENT_CLOSE_TIMEOUT_SECONDS", .03, create=True):
            task = asyncio.create_task(self.session.execute(self.payload, lambda event: None))
            try:
                await asyncio.wait_for(started.wait(), 1)
                task.cancel()
                await asyncio.wait_for(closing.wait(), 1)
                completed, _ = await asyncio.wait({task}, timeout=.3)
                self.assertIn(task, completed, "cancelled request is stuck closing the client")
                self.assertTrue(task.cancelled())
                self.assertFalse(self.session.lock.locked())
                self.assertIsNone(self.session.client)
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)

    async def test_cancelled_and_timed_out_waiters_leave_active_generation_running(self):
        started = asyncio.Event()
        class Stalled(Client):
            async def generate_content_stream(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
                yield
        client = Stalled([model("argon")], [])
        self.session.client_factory = lambda *args, **kwargs: client
        active = asyncio.create_task(self.session.execute(self.payload, lambda event: None))
        try:
            await asyncio.wait_for(started.wait(), 1)
            waiting = asyncio.create_task(self.session.execute(self.payload, lambda event: None))
            await asyncio.sleep(0)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            with patch.object(session.worker, "SESSION_LOCK_WAIT_SECONDS", .03):
                with self.assertRaises(session.worker.WorkerError) as caught:
                    await self.session.execute(self.payload, lambda event: None)
            self.assertEqual(caught.exception.status, 409)
            self.assertFalse(active.done())
            self.assertFalse(client.closed)
            self.assertTrue(self.session.lock.locked())
        finally:
            active.cancel()
            await asyncio.gather(active, return_exceptions=True)
        self.assertFalse(self.session.lock.locked())
        self.assertTrue(client.closed)

    async def test_closes_transport_before_waiting_for_cancelled_stream_cleanup(self):
        for kind in ("cancel", "deadline"):
            with self.subTest(kind=kind):
                started, transport_closed = asyncio.Event(), asyncio.Event()
                class TransportBlocked(Client):
                    async def generate_content_stream(self, *args, **kwargs):
                        started.set()
                        try:
                            await asyncio.Event().wait()
                            yield
                        finally:
                            # curl_cffi Response.aclose() waits for the streaming
                            # request; closing the transport lets it finish.
                            await transport_closed.wait()

                    async def close(self):
                        transport_closed.set()
                        await super().close()
                client = TransportBlocked([model("argon")], [])
                self.session.client_factory = lambda *args, **kwargs: client
                timeout = .03 if kind == "deadline" else 450
                with patch.object(session, "SESSION_REQUEST_TIMEOUT_SECONDS", timeout):
                    task = asyncio.create_task(self.session.execute(self.payload, lambda event: None))
                    try:
                        await asyncio.wait_for(started.wait(), 1)
                        if kind == "cancel":
                            task.cancel()
                        completed, _ = await asyncio.wait({task}, timeout=.3)
                        self.assertIn(task, completed, "stream cleanup is waiting for an open transport")
                        with self.assertRaises(TimeoutError if kind == "deadline" else asyncio.CancelledError):
                            await task
                        self.assertTrue(client.closed)
                        self.assertFalse(self.session.lock.locked())
                        self.assertIsNone(self.session.client)
                    finally:
                        transport_closed.set()
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)


class ProcessTest(unittest.TestCase):
    def test_worker_restarts_reuse_live_broker_and_broker_restart_restores_saved_state(self):
        with tempfile.TemporaryDirectory(prefix="gw-proc-", dir="/tmp") as directory:
            root = Path(directory)
            package = root / "gemini_webapi"
            package.mkdir()
            (package / "__init__.py").write_text('''import asyncio,json,os
from pathlib import Path
from types import SimpleNamespace
from .utils import save_cookies
def set_log_level(level): pass
class GeminiClient:
 def __init__(self,*args,**kwargs):
  self.task=None
  path=Path(os.environ['GEMINI_COOKIE_PATH'])/'fixture-state.json'
  self.cookies=json.loads(path.read_text()) if path.exists() else {'ticks':0}
  self.cookies.update(pid=os.getpid(),initializations=0,closed=False)
 async def init(self,**kwargs):
  if self.task: return
  self.cookies['initializations']+=1
  self.task=asyncio.create_task(self.refresh())
 async def refresh(self):
  while True:
   await asyncio.sleep(.02)
   self.cookies['ticks']+=1
   save_cookies(self.cookies)
 def list_models(self): return [SimpleNamespace(model_name='argon',display_name='Argon',aliases=[],is_available=True)]
 async def generate_content_stream(self,*args,**kwargs):
  yield SimpleNamespace(text_delta='fixture answer')
 async def close(self):
  if self.task:
   self.task.cancel()
   try: await self.task
   except asyncio.CancelledError: pass
  self.cookies['closed']=True
  save_cookies(self.cookies)
''')
            (package / "utils.py").write_text('''import json,os
from pathlib import Path
def save_cookies(cookies,**kwargs):
 p=Path(os.environ['GEMINI_COOKIE_PATH'])/'fixture-state.json'
 tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(cookies));tmp.replace(p)
''')
            cookies = root / "c.json"
            cookies.write_text(json.dumps({"__Secure-1PSID": "fixture"}))
            payload = {"mode": "generate", "cookiesFile": str(cookies), "prompt": "hello"}
            _, cache, socket = session.session_paths(payload)
            environment = dict(os.environ, PYTHONPATH=str(root))
            worker_path = Path(__file__).parents[1] / "src/providers/gemini-web/worker.py"
            def call():
                response = subprocess.run([sys.executable, str(worker_path)], input=json.dumps(payload).encode(),
                                          capture_output=True, env=environment, timeout=10)
                self.assertEqual(response.returncode, 0, response.stderr.decode())
                events = [json.loads(line) for line in response.stdout.splitlines()]
                self.assertEqual([event["type"] for event in events], ["ready", "delta", "done"], events)
                return json.loads((cache / "fixture-state.json").read_text())
            def stop(pid):
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)
                for _ in range(100):
                    if not socket.exists():
                        return
                    time.sleep(.01)
                self.fail("broker did not stop")
            active = None
            try:
                first = call()
                active = first["pid"]
                time.sleep(.1)
                second = call()
                self.assertEqual(second["pid"], first["pid"])
                self.assertEqual(second["initializations"], 1)
                self.assertGreater(second["ticks"], first["ticks"])
                stop(active)
                active = None
                self.assertTrue(json.loads((cache / "fixture-state.json").read_text())["closed"])
                third = call()
                active = third["pid"]
                self.assertNotEqual(third["pid"], first["pid"])
                self.assertGreaterEqual(third["ticks"], second["ticks"])
            finally:
                if active is not None:
                    stop(active)


if __name__ == "__main__":
    unittest.main()
