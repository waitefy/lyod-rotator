import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

spec = importlib.util.spec_from_file_location(
    "chatgpt_transport", Path(__file__).resolve().parents[1] / "scripts/chatgpt-app-transport/relay.py"
)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class TransportTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.release = threading.Event()
        self.upstream_finished = threading.Event()
        self.streaming = False
        self.status = 200
        test = self

        class Response:
            status_code = test.status
            headers = {"content-type": "text/event-stream"}

            def iter_content(self):
                yield b"data: first\n\n"
                if test.streaming:
                    test.release.wait(3)
                test.upstream_finished.set()
                yield b"data: [DONE]\n\n"

            def close(self):
                pass

        class Session:
            def request(self, *args, **kwargs):
                test.calls.append((args, kwargs))
                response = Response()
                response.status_code = test.status
                return response

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), relay.handler_for(Session(), "Bearer private-test-token"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, auth="Bearer private-test-token", **headers):
        return self.opener.open(Request(self.url + path, data=b"{}", headers={
            "Authorization": auth, "Content-Type": "application/json", **headers,
        }), timeout=3)

    def test_auth_rejected_before_upstream(self):
        with self.assertRaises(HTTPError) as result:
            self.request("/backend-api/models", auth="Bearer wrong")
        self.assertEqual(result.exception.code, 401)
        self.assertEqual(self.calls, [])
        self.assertNotIn(b"private-test-token", result.exception.read())

    def test_paths_and_guest_rejected(self):
        for path in ["https://evil.example/", "//evil.example/", "/backend-anon/conversation",
                     "/backend-api/../admin", "/backend-api/%2e%2e/admin", "/assets/foo"]:
            self.assertFalse(relay.allowed_path(path), path)
        with self.assertRaises(HTTPError) as result:
            self.request("/backend-anon/conversation")
        self.assertEqual(result.exception.code, 404)
        self.assertEqual(self.calls, [])

    def test_body_limit_before_upstream(self):
        with self.assertRaises(HTTPError) as result:
            self.request("/backend-api/models", **{"Content-Length": str(relay.MAX_BODY + 1)})
        self.assertEqual(result.exception.code, 413)
        self.assertEqual(self.calls, [])

    def test_rewrites_origin_and_removes_mismatched_fingerprint(self):
        with self.request("/backend-api/models", Cookie="secret-browser-cookie", **{
            "User-Agent": "Chrome/124", "Sec-CH-UA": "wrong", "Origin": "http://local",
        }) as response:
            self.assertEqual(response.status, 200)
            response.read()
        args, kwargs = self.calls[0]
        self.assertEqual(args, ("POST", "https://chatgpt.com/backend-api/models"))
        self.assertEqual(kwargs["data"], b"{}")
        self.assertFalse(kwargs["allow_redirects"])
        headers = {k.lower(): v for k, v in kwargs["headers"].items()}
        self.assertEqual(headers["origin"], relay.UPSTREAM)
        self.assertEqual(headers["referer"], relay.UPSTREAM + "/")
        for name in ["cookie", "user-agent", "sec-ch-ua"]:
            self.assertNotIn(name, headers)

    def test_stream_delivers_before_upstream_finishes(self):
        self.streaming = True
        with self.request("/backend-api/f/conversation") as response:
            self.assertEqual(response.readline(), b"data: first\n")
            self.assertFalse(self.upstream_finished.is_set())
            self.assertFalse(self.release.is_set())
            self.release.set()
            self.assertIn(b"[DONE]", response.read())

    def test_upstream_redirect_rejected(self):
        self.status = 302
        with self.assertRaises(HTTPError) as result:
            self.request("/backend-api/models")
        self.assertEqual(result.exception.code, 502)
        self.assertEqual(len(self.calls), 1)

    def test_single_account_config_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"chatgpts": [{"access_token": "test"}]}))
            self.assertEqual(relay.load_token(path), "Bearer test")
            for accounts in [[], [{"access_token": ""}], [{"access_token": "a"}, {"access_token": "b"}]]:
                path.write_text(json.dumps({"chatgpts": accounts}))
                with self.assertRaises(ValueError):
                    relay.load_token(path)


if __name__ == "__main__":
    unittest.main()
