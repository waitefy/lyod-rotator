"""Dedicated Firefox extraction and SSH receiver rollback, using synthetic cookies."""
import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "src/providers/gemini-web"))
import browser_login


class BrowserTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_only_extracts_secure_unexpired_google_cookies_from_normal_profile(self):
        with sqlite3.connect(self.root / "cookies.sqlite") as connection:
            connection.execute("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, originAttributes TEXT, expiry INTEGER)")
            rows = [("__Secure-1PSID", "fixture", ".google.com", "/", 1, "", time.time() + 3600),
                    ("__Secure-1PSIDTS", "expired", ".google.com", "/", 1, "", 1),
                    ("__Secure-1PSID", "other-domain", ".example.com", "/", 1, "", time.time() + 3600),
                    ("__Secure-1PSID", "container", ".google.com", "/", 1, "^userContextId=2", time.time() + 3600),
                    ("__Secure-1PSID", "insecure", ".google.com", "/", 0, "", time.time() + 3600)]
            connection.executemany("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?)", rows)
        self.assertEqual(browser_login.read_cookies(self.root), {"__Secure-1PSID": "fixture"})
        destination = self.root / "session.json"
        browser_login.save_private(destination, browser_login.read_cookies(self.root))
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_ssh_sends_cookies_only_over_stdin(self):
        path = self.root / "cookies.json"
        path.write_text(json.dumps({"__Secure-1PSID": "private-test-value"}))
        args = argparse.Namespace(cookies_file=str(path), remote_cookie_file="/sessions/c.json", server_cookie_file="/sessions/c.json",
                                  remote_state_dir="/state", email="web@local", server="root@example.test")
        def run(command, *, input, **kwargs):
            self.assertNotIn("private-test-value", repr(command))
            self.assertEqual(json.loads(input)["cookies"]["__Secure-1PSID"], "private-test-value")
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.object(browser_login.subprocess, "run", run), contextlib.redirect_stdout(io.StringIO()) as output:
            browser_login.install_remote(args)
        self.assertNotIn("private-test-value", output.getvalue())

    def test_receiver_registers_session_and_restores_old_file_on_rejection(self):
        status = [200]
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(status[0])
                self.end_headers()
                self.wfile.write(json.dumps({"ok": status[0] == 200}).encode())
            def log_message(self, *args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            (self.root / "accounts.json").write_text(json.dumps({"proxyPort": server.server_port}))
            (self.root / ".admin-token").write_text("fixture-admin-token")
            destination = self.root / "cookies.json"
            payload = {"destination": str(destination), "stateDir": str(self.root), "cookies": {"__Secure-1PSID": "private-new"},
                       "apiCookiePath": "/sessions/c.json", "email": "web@local"}
            for code in (200, 401):
                status[0] = code
                destination.write_text("old-cookie-content")
                reply = subprocess.run([sys.executable, "-c", browser_login.REMOTE_INSTALL], input=json.dumps(payload).encode(), capture_output=True, timeout=5)
                self.assertEqual(reply.returncode, 0 if code == 200 else 1)
                self.assertNotIn(b"private-new", reply.stdout + reply.stderr)
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
                if code == 200:
                    self.assertEqual(json.loads(destination.read_text()), payload["cookies"])
                else:
                    self.assertEqual(destination.read_text(), "old-cookie-content")
            self.assertEqual(requests[-1], ("/api/cli-login", {"provider": "gemini-web", "email": "web@local", "cookiesFile": "/sessions/c.json"}))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
