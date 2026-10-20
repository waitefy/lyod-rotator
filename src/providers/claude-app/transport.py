#!/usr/bin/env python3
"""Run ClewdR behind an account-private Firefox HTTP transport."""
import argparse
import hmac
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import tomllib


def inline_conversation(body):
    """Move ClewdR's synthetic transcript into the actual prompt, not paste.txt."""
    payload = json.loads(body)
    attachments = payload.get("attachments", [])
    if (len(attachments) == 1 and attachments[0].get("file_name") == "paste.txt"
            and isinstance(attachments[0].get("extracted_content"), str)):
        payload["prompt"] = attachments[0]["extracted_content"] + "\n\nAssistant: "
        payload["attachments"] = []
        return json.dumps(payload).encode()
    return body


class FirefoxTransport:
    """Keep HTTP state within a generation, never carry it into the next one."""
    def __init__(self, config):
        from curl_cffi import requests
        self.factory = requests.Session
        self.config = config
        self.client = self.create_client()
        self.started = False

    def create_client(self):
        # The server uses a different thread for each request. The account lock
        # serializes access, so reuse one handle instead of unrelated thread-local handles.
        client = self.factory(impersonate="firefox147", proxy=self.config.get("proxy"),
                              trust_env=False, use_thread_local_curl=False)
        client.cookies.set("sessionKey", self.config["cookie_array"][0]["cookie"], domain=".claude.ai", path="/")
        return client

    def request(self, method, url, **kwargs):
        bootstrap = method == "GET" and url.endswith("/api/bootstrap")
        if bootstrap:
            if self.started:
                self.client.close()
                self.client = self.create_client()
            self.started = True
        response = self.client.request(method, url, **kwargs)
        if bootstrap and response.status_code == 403 and "text/html" in response.headers.get("Content-Type", "").lower():
            # A single fresh connection for an intermediary HTML refusal, before
            # any chat is created. Do not replay generations or JSON auth errors.
            response.close()
            self.client.close()
            self.client = self.create_client()
            time.sleep(1)
            return self.client.request(method, url, **kwargs)
        return response

    def close(self):
        self.client.close()


def serve(config):
    cookie = config["cookie_array"][0]["cookie"]
    client = FirefoxTransport(config)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Request URLs and headers must never enter service logs.

        def handle_request(self):
            cookies = SimpleCookie()
            try:
                cookies.load(self.headers.get("Cookie", ""))
                authenticated = "sessionKey" in cookies and hmac.compare_digest(cookies["sessionKey"].value, cookie)
                size = int(self.headers.get("Content-Length", "0"))
            except (ValueError, TypeError):
                authenticated, size = False, -1
            if not authenticated or not self.path.startswith("/api/") or "Transfer-Encoding" in self.headers:
                self.send_error(403); return
            if size < 0 or size > 8 * 1024 * 1024:
                self.send_error(413); return
            body = self.rfile.read(size) if size else None
            if self.command == "POST" and self.path.endswith("/completion") and body:
                try:
                    body = inline_conversation(body)
                except (ValueError, TypeError, AttributeError):
                    self.send_error(400, "Invalid completion body"); return
            headers = {key: self.headers[key] for key in ("Accept", "Content-Type") if key in self.headers}
            headers.update(Origin="https://claude.ai", Referer="https://claude.ai/new?incognito")
            started = False
            try:
                with lock:
                    streaming = self.path.endswith("/completion")
                    response = client.request(self.command, "https://claude.ai" + self.path, data=body,
                                              headers=headers, allow_redirects=False, stream=streaming, timeout=600)
                    try:
                        self.send_response(response.status_code)
                        for key in ("Content-Type", "Retry-After", "anthropic-ratelimit-unified-reset"):
                            value = response.headers.get(key)
                            if value is not None:
                                self.send_header(key, value)
                        self.send_header("Connection", "close")
                        self.end_headers(); started = True
                        chunks = response.iter_content() if streaming else [response.content]
                        for chunk in chunks:
                            if chunk:
                                self.wfile.write(chunk); self.wfile.flush()
                    finally:
                        response.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                if not started:
                    self.send_error(502, "Claude transport unavailable")
            finally:
                self.close_connection = True

        do_GET = handle_request
        do_POST = handle_request
        do_PUT = handle_request
        do_DELETE = handle_request

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    args = parser.parse_args()
    config = tomllib.loads(args.config.read_text())
    relay, client = serve(config)
    child = None
    try:
        with tempfile.TemporaryDirectory(prefix="lyod-claude-transport-") as folder:
            # Keep secrets out of argv/env and preserve the original on-disk account config.
            text = args.config.read_text()
            lines = [line for line in text.splitlines() if not line.startswith(("rproxy =", "proxy ="))]
            lines.insert(0, 'rproxy = ' + json.dumps(f"http://127.0.0.1:{relay.server_port}/"))
            path = Path(folder) / "clewdr.toml"
            fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write("\n".join(lines) + "\n")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith("CLEWDR_") and key.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
            child = subprocess.Popen([str(args.binary), "--config", str(path)], env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def stop(_signum, _frame):
                if child.poll() is None:
                    child.terminate()
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            raise SystemExit(child.wait())
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        relay.shutdown(); relay.server_close(); client.close()


if __name__ == "__main__":
    main()
