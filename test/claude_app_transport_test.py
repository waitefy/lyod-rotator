"""Private relay contracts with synthetic cookies and a mocked upstream."""
import http.client
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("claude_transport", Path(__file__).parents[1] / "src/providers/claude-app/transport.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class TransportTest(unittest.TestCase):
    def test_retries_only_initial_html_refusal_once_before_generation(self):
        from curl_cffi import requests
        for method, path, status, content_type, expected_calls in [
            ("GET", "/api/bootstrap", 403, "text/html; charset=utf-8", 2),
            ("GET", "/api/bootstrap", 403, "application/json", 1),
            ("GET", "/api/bootstrap", 401, "text/html", 1),
            ("POST", "/api/organizations/fixture/completion", 403, "text/html", 1),
        ]:
            with self.subTest(method=method, status=status, content_type=content_type):
                session = Mock()
                session.request.return_value = Mock(status_code=status, headers={"Content-Type": content_type})
                with patch.object(requests, "Session", return_value=session), patch.object(transport.time, "sleep") as sleep:
                    client = transport.FirefoxTransport({"cookie_array": [{"cookie": "fixture-cookie"}]})
                    client.request(method, "https://claude.ai" + path)
                self.assertEqual(session.request.call_count, expected_calls)
                self.assertEqual(sleep.call_count, expected_calls - 1)
                client.close()

    def test_next_generation_gets_fresh_http_state_without_changing_account(self):
        from curl_cffi import requests
        first, second = Mock(), Mock()
        with patch.object(requests, "Session", side_effect=[first, second]):
            client = transport.FirefoxTransport({"cookie_array": [{"cookie": "fixture-cookie"}]})
        client.request("GET", "https://claude.ai/api/bootstrap")
        client.request("POST", "https://claude.ai/api/organizations/fixture/chat_conversations/fixture/completion")
        first.close.assert_not_called()
        client.request("GET", "https://claude.ai/api/bootstrap")
        first.close.assert_called_once()
        self.assertEqual(second.request.call_count, 1)
        for session in (first, second):
            session.cookies.set.assert_called_once_with("sessionKey", "fixture-cookie", domain=".claude.ai", path="/")
        client.close()
        second.close.assert_called_once()

    def test_transcript_is_the_prompt_and_other_payload_fields_are_preserved(self):
        original = {"prompt": "static", "attachments": [{"file_name": "paste.txt", "extracted_content": "Human: Read a file\nAssistant: tool\nHuman: result"}],
                    "model": "fixture", "max_tokens_to_sample": 4096, "files": []}
        data = json.loads(transport.inline_conversation(json.dumps(original).encode()))
        self.assertEqual(data["prompt"], original["attachments"][0]["extracted_content"] + "\n\nAssistant: ")
        self.assertEqual(data["attachments"], [])
        self.assertEqual(data["model"], original["model"])
        self.assertEqual(data["max_tokens_to_sample"], 4096)
        untouched = b'{"attachments":[{"file_name":"other.txt"}],"prompt":"hello"}'
        self.assertEqual(transport.inline_conversation(untouched), untouched)

    def setUp(self):
        from curl_cffi import requests
        self.client = Mock()
        self.response = Mock(status_code=200, headers={"Content-Type": "text/event-stream"})
        self.response.iter_content.return_value = iter([b'data: {"type":"message_stop"}\n\n'])
        self.client.request.return_value = self.response
        with patch.object(requests, "Session", return_value=self.client) as factory:
            self.server, _ = transport.serve({"cookie_array": [{"cookie": "fixture-cookie"}], "proxy": "http://127.0.0.1:9999"})
            self.assertEqual(factory.call_args.kwargs["impersonate"], "firefox147")
            self.assertFalse(factory.call_args.kwargs["trust_env"])
            self.assertFalse(factory.call_args.kwargs["use_thread_local_curl"])
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.client.close)

    def request(self, path, cookie="fixture-cookie", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.request("POST", path, body=b"{}", headers={"Cookie": "sessionKey=" + cookie, **(headers or {})})
        response = connection.getresponse()
        return response, response.read()

    def test_preserves_native_events_and_uses_browser_headers_without_forwarding_client_secrets(self):
        response, body = self.request("/api/organizations/fixture/completion", headers={"Authorization": "private-api-key", "User-Agent": "wrong-agent", "Origin": "https://wrong.example"})
        self.assertEqual(response.status, 200)
        self.assertIn(b"message_stop", body)
        args, kwargs = self.client.request.call_args
        self.assertEqual(args, ("POST", "https://claude.ai/api/organizations/fixture/completion"))
        self.assertEqual(kwargs["headers"]["Origin"], "https://claude.ai")
        self.assertNotIn("Authorization", kwargs["headers"])
        self.assertNotIn("User-Agent", kwargs["headers"])
        self.assertFalse(kwargs["allow_redirects"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["data"], b"{}")

    def test_rejects_other_accounts_and_arbitrary_destinations(self):
        for path, cookie in [("/api/bootstrap", "another-cookie"), ("http://evil.example/api/bootstrap", "fixture-cookie"), ("/v1/messages", "fixture-cookie")]:
            response, _ = self.request(path, cookie)
            self.assertEqual(response.status, 403)
        self.client.request.assert_not_called()

    def test_preserves_explicit_rate_limit_and_retry_after(self):
        self.response.status_code = 429
        self.response.headers = {"Content-Type": "application/json", "Retry-After": "0", "anthropic-ratelimit-unified-reset": "1234567890"}
        self.response.iter_content.return_value = iter([b'{"error":{"type":"rate_limit_error"}}'])
        self.response.content = b'{"error":{"type":"rate_limit_error"}}'
        response, body = self.request("/api/bootstrap")
        self.assertEqual(response.status, 429)
        self.assertEqual(body, self.response.content)
        self.assertFalse(self.client.request.call_args.kwargs["stream"])
        self.assertEqual(response.getheader("Retry-After"), "0")
        self.assertEqual(response.getheader("anthropic-ratelimit-unified-reset"), "1234567890")


if __name__ == "__main__":
    unittest.main()
