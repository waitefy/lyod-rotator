"""One persistent Gemini client per cookie file, shared through a private Unix socket."""
import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

import worker
from telemetry import CURRENT, Trace, phase

# Leave time for cleanup before the stdio worker's 480-second watchdog fires.
SESSION_REQUEST_TIMEOUT_SECONDS = 450
CLIENT_CLOSE_TIMEOUT_SECONDS = 5
DIAGNOSTIC_INTERVAL_SECONDS = 1


def session_paths(payload):
    value = payload.get("cookiesFile")
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise worker.WorkerError(401, "Gemini Web requires an absolute cookie file path")
    cookies = Path(value).resolve()
    key = hashlib.sha256(str(cookies).encode()).hexdigest()[:24]
    cache = cookies.parent / ".gemini-web-cache" / key
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    sockets = Path(tempfile.gettempdir()) / f"tuxevil-gemini-{os.getuid()}"
    sockets.mkdir(mode=0o700, exist_ok=True)
    if sockets.is_symlink() or sockets.stat().st_uid != os.getuid():
        raise worker.WorkerError(503, "Unsafe Gemini Web socket directory")
    sockets.chmod(0o700)
    # Use the mounted session directory in containers, including rolling probes.
    socket = cache / "session.sock"
    if len(os.fsencode(socket)) > 100:
        socket = sockets / (key + ".sock")
    return cookies, cache, socket


class Session:
    def __init__(self, payload, client_factory=None, save=None):
        self.payload = payload
        self.cookies, self.cache, self.socket = session_paths(payload)
        self.client_factory = client_factory
        self.save = save
        self.client = None
        self.fingerprint = None
        self.base_psid = None
        self.lock = asyncio.Lock()
        self.handlers = set()

    def factory(self, psid, psidts, **kwargs):
        if self.client is None:
            factory = self.client_factory
            if factory is None:
                from gemini_webapi import GeminiClient, set_log_level
                set_log_level("CRITICAL")
                factory = GeminiClient
            self.client = factory(psid, psidts, **kwargs)
            self.base_psid = psid
        return self.client

    async def close_client(self):
        if self.client is not None:
            try:
                await asyncio.wait_for(self.client.close(), CLIENT_CLOSE_TIMEOUT_SECONDS)
            finally:
                self.client = None

    def persist(self):
        if self.client is None:
            return
        if self.save:
            self.save(self.client)
        else:
            from gemini_webapi.utils import save_cookies
            save_cookies(self.client.cookies, base_psid=self.base_psid, verbose=False)

    async def execute(self, payload, send):
        if payload.get("diagnostics") is not True:
            return await self._execute(payload, send)
        trace = Trace()
        token = CURRENT.set(trace)
        def emit(event):
            if event["type"] == "done":
                send(trace.event())
            send(event)
        async def report_progress():
            while True:
                await asyncio.sleep(DIAGNOSTIC_INTERVAL_SECONDS)
                send(trace.event())
        reporter = asyncio.create_task(report_progress())
        try:
            return await self._execute(payload, emit)
        except BaseException as error:
            send(trace.event(error))
            raise
        finally:
            reporter.cancel()
            await asyncio.gather(reporter, return_exceptions=True)
            CURRENT.reset(token)

    async def _execute(self, payload, send):
        if payload.get("cookiesFile") != self.payload.get("cookiesFile") or payload.get("proxy") != self.payload.get("proxy"):
            raise worker.WorkerError(400, "Gemini Web session settings changed; reconnect the session")
        deadline = asyncio.get_running_loop().time() + SESSION_REQUEST_TIMEOUT_SECONDS
        try:
            with phase("sessionWait"):
                await asyncio.wait_for(self.lock.acquire(), worker.SESSION_LOCK_WAIT_SECONDS)
        except TimeoutError:
            raise worker.WorkerError(409, "Gemini Web session remained busy for 60 seconds; retry the request") from None
        generation = None
        try:
            try:
                fingerprint = hashlib.sha256(self.cookies.read_bytes()).digest()
            except OSError:
                raise worker.WorkerError(401, "Cannot read Gemini Web cookie JSON; reconnect the web session") from None
            if fingerprint != self.fingerprint:
                await self.close_client()
                self.fingerprint = fingerprint
            # The final done event is sent only after cookies have been saved.
            completed = []
            def emit(event):
                if event["type"] == "done":
                    completed.append(event)
                else:
                    send(event)
            generation = asyncio.create_task(
                worker.run(payload, self.factory, keep_open=True, emit_event=emit)
            )
            finished, _ = await asyncio.wait(
                {generation}, timeout=max(0, deadline - asyncio.get_running_loop().time())
            )
            if not finished:
                raise TimeoutError()
            await generation
            with phase("persist"):
                self.persist()
            for event in completed:
                send(event)
        except BaseException:
            if generation is not None and not generation.done():
                generation.cancel()
            # Stream cleanup can wait for the HTTP transport to close. Do not
            # await the cancelled generation before closing that transport.
            with contextlib.suppress(Exception):
                await self.close_client()
            if generation is not None:
                await asyncio.gather(generation, return_exceptions=True)
            raise
        finally:
            self.lock.release()

    async def handle(self, reader, writer):
        handler = asyncio.current_task()
        self.handlers.add(handler)
        task = disconnect = None
        def send(event):
            writer.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
        try:
            raw = await asyncio.wait_for(reader.readline(), 10)
            if len(raw) > worker.MAX_INPUT_BYTES:
                raise worker.WorkerError(400, "Gemini Web worker request is too large")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise worker.WorkerError(400, "Invalid Gemini Web worker request")
            task = asyncio.create_task(self.execute(payload, send))
            disconnect = asyncio.create_task(reader.read(1))
            await asyncio.wait([task, disconnect], return_when=asyncio.FIRST_COMPLETED)
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                return
            await task
        except Exception as error:
            send(worker.error_event(error))
        finally:
            for pending in (task, disconnect):
                if pending and not pending.done():
                    pending.cancel()
            await asyncio.gather(*(pending for pending in (task, disconnect) if pending), return_exceptions=True)
            self.handlers.discard(handler)
            with contextlib.suppress(ConnectionError):
                await writer.drain()
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()


async def serve(payload):
    session = Session(payload)
    with (session.cache / "broker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # Another request has already started this account's broker.
        session.socket.unlink(missing_ok=True)
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stopped.set)
        server = await asyncio.start_unix_server(session.handle, path=session.socket, limit=worker.MAX_INPUT_BYTES + 1)
        session.socket.chmod(0o600)
        try:
            async with server:
                await stopped.wait()
        finally:
            handlers = list(session.handlers)
            for handler in handlers:
                handler.cancel()
            await asyncio.gather(*handlers, return_exceptions=True)
            await session.close_client()
            session.socket.unlink(missing_ok=True)


async def request(payload):
    _, _, socket = session_paths(payload)
    # One bootstrap attempt; concurrent starters are serialized by broker.lock.
    launched = False
    for _ in range(100):
        try:
            reader, writer = await asyncio.open_unix_connection(socket, limit=worker.MAX_OUTPUT_EVENT_BYTES)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if not launched:
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve())], stdin=subprocess.PIPE,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                if child.stdin and not child.stdin.closed:
                    child.stdin.write(json.dumps({k: payload[k] for k in ("cookiesFile", "proxy") if k in payload}).encode())
                    child.stdin.close()
                launched = True
            await asyncio.sleep(0.05)
    else:
        raise worker.WorkerError(503, "Gemini Web session service did not start")
    try:
        writer.write((json.dumps(payload) + "\n").encode())
        await writer.drain()
        while raw := await reader.readline():
            event = json.loads(raw)
            worker.emit(event)
            if event.get("type") in ("done", "error"):
                return
        raise worker.WorkerError(502, "Gemini Web session ended without completing the response")
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(worker.MAX_INPUT_BYTES + 1)
        if len(raw) > worker.MAX_INPUT_BYTES:
            raise ValueError()
        asyncio.run(serve(json.loads(raw)))
    except Exception:
        raise SystemExit(1) from None
