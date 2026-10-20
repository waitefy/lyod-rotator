"""Single-account ChatGPT transport. No public listener or arbitrary upstream URLs."""
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from curl_cffi import requests

MAX_BODY = 16 * 1024 * 1024
UPSTREAM = "https://chatgpt.com"
DROP_HEADERS = {
    "host", "connection", "content-length", "transfer-encoding", "accept-encoding",
    "user-agent", "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile", "cookie",
    "proxy-authorization", "proxy-connection", "upgrade", "te", "trailer",
    "origin", "referer",
}


def load_token(path):
    config = yaml.safe_load(Path(path).read_text())
    accounts = config.get("chatgpts", [])
    if len(accounts) != 1:
        raise ValueError("Transport requires exactly one web account")
    token = str(accounts[0].get("access_token", "")).removeprefix("Bearer ").strip()
    if not token or not token.isascii():
        raise ValueError("Transport requires a web access token")
    return "Bearer " + token


def allowed_path(path):
    parsed = urlsplit(path)
    return (not parsed.scheme and not parsed.netloc and not parsed.fragment
            and path.startswith("/") and not path.startswith("//")
            and (parsed.path == "/" or parsed.path.startswith("/backend-api/"))
            and not any(part in (".", "..") for part in parsed.path.split("/"))
            and "%" not in parsed.path and "\\" not in path)


def handler_for(session, expected_token):
    # One account/session per process. Keep cookies across requirements/generation,
    # and avoid concurrent mutation of curl's session or account state.
    lock = threading.Lock()

    class Relay(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass  # URLs, credentials, prompts and upstream errors must not enter logs.

        def fail(self, status):
            body = json.dumps({"error": {"message": "ChatGPT transport rejected request"}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(body)

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            self.connection.settimeout(620)
            auth = self.headers.get("authorization", "")
            if (len(self.headers.get_all("authorization", [])) != 1 or not auth.isascii()
                    or not hmac.compare_digest(auth, expected_token)):
                self.fail(401)
                return
            if not allowed_path(self.path):
                self.fail(404)
                return
            lengths = self.headers.get_all("content-length", [])
            if self.headers.get("transfer-encoding") or len(lengths) > 1:
                self.fail(400)
                return
            try:
                length = int(lengths[0]) if lengths else 0
            except ValueError:
                self.fail(400)
                return
            if length < 0 or length > MAX_BODY:
                self.fail(413)
                return
            body = self.rfile.read(length) if length else None
            if body is not None and len(body) != length:
                self.fail(400)
                return
            headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP_HEADERS}
            # Let curl_cffi supply matching UA/client hints and TLS/HTTP2 fingerprint.
            headers["Origin"] = UPSTREAM
            headers["Referer"] = UPSTREAM + "/"
            started = False
            try:
                with lock:
                    response = session.request(
                        self.command, UPSTREAM + self.path, headers=headers, data=body,
                        stream=True, timeout=600, allow_redirects=False,
                    )
                    try:
                        # Never follow or pass upstream redirects to the caller.
                        if 300 <= response.status_code < 400:
                            self.fail(502)
                            return
                        self.send_response(response.status_code)
                        for name in ("content-type", "retry-after", "cf-mitigated"):
                            value = response.headers.get(name)
                            if value:
                                self.send_header(name, value)
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.close_connection = True
                        started = True
                        for chunk in response.iter_content():
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    finally:
                        response.close()
            except Exception:
                # A partial SSE response must end, not acquire a second HTTP response.
                if not started:
                    self.fail(502)
                self.close_connection = True

    return Relay


def main():
    try:
        token = load_token(os.environ.get("CHATGPT_TRANSPORT_CONFIG", "/app/conf/app.prod.yaml"))
    except Exception:
        raise SystemExit("ChatGPT transport: invalid single-account configuration") from None
    proxy = os.environ.get("CHATGPT_TRANSPORT_PROXY") or None
    with requests.Session(impersonate="chrome", proxy=proxy, trust_env=False) as session:
        server = ThreadingHTTPServer(
            (os.environ.get("CHATGPT_TRANSPORT_BIND", "0.0.0.0"), 3041),
            handler_for(session, token),
        )
        server.daemon_threads = True
        # BaseServer's default handler prints tracebacks, including request data.
        server.handle_error = lambda *_args: None
        server.serve_forever()


if __name__ == "__main__":
    main()
