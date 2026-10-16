"""Generated-image downloads: no Google requests, no real credentials."""
import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gemini_web_worker_test import Client, model, worker

PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-image" * 100
URL = "https://lh3.googleusercontent.com/generated-test"


class Transport:
    def __init__(self, responses):
        self.responses, self.calls, self.closed = responses, [], 0

    @asynccontextmanager
    async def stream(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        status, headers, chunks = self.responses[len(self.calls) - 1]
        async def content():
            for chunk in chunks:
                yield chunk
        try:
            yield SimpleNamespace(status_code=status, headers=headers, aiter_content=content)
        finally:
            self.closed += 1


class ImageOutputTest(unittest.IsolatedAsyncioTestCase):
    async def test_downloads_exact_png_jpeg_webp_bytes_without_exposing_a_url(self):
        for raw, mime in [(PNG, "image/png"), (b"\xff\xd8\xfffixture", "image/jpeg"),
                          (b"RIFF\x00\x00\x00\x00WEBPfixture", "image/webp")]:
            transport = Transport([(200, {}, [raw[:4], raw[4:]])])
            result = await worker.download_generated_image(transport, URL)
            self.assertEqual(result, {"mimeType": mime, "data": base64.b64encode(raw).decode()})
            self.assertEqual(transport.calls[0][0], "GET")
            self.assertFalse(transport.calls[0][2]["allow_redirects"])
            self.assertEqual(transport.closed, 1)

    async def test_only_https_googleusercontent_addresses_and_checked_redirects(self):
        bad_urls = ["http://lh3.googleusercontent.com/x", "https://googleusercontent.com.evil.test/x",
                    "https://localhost/x", "file:///etc/passwd", "https://127.0.0.1/x",
                    "https://user:pass@lh3.googleusercontent.com/x", "https://lh3.googleusercontent.com:8080/x",
                    "https://lh3.googleusercontent.com/x\n", "https://lh3.googleusercontent.com/x#secret",
                    "https://work.fife.usercontent.google.com.evil.test/x", "https://other.usercontent.google.com/x"]
        for url in bad_urls:
            transport = Transport([])
            with self.assertRaises(worker.WorkerError):
                await worker.download_generated_image(transport, url)
            self.assertFalse(transport.calls)
        for target in bad_urls:
            transport = Transport([(302, {"location": target}, [])])
            with self.assertRaises(worker.WorkerError):
                await worker.download_generated_image(transport, URL)
            self.assertEqual(len(transport.calls), 1)
            self.assertEqual(transport.closed, 1)
        transport = Transport([(302, {"location": "/actual-image"}, []), (200, {}, [PNG])])
        result = await worker.download_generated_image(transport, URL)
        self.assertEqual(base64.b64decode(result["data"]), PNG)
        self.assertEqual(transport.calls[1][1], "https://lh3.googleusercontent.com/actual-image")
        fife_url = "https://work.fife.usercontent.google.com/generated-test"
        transport = Transport([(302, {"location": fife_url}, []), (200, {}, [PNG])])
        self.assertEqual(base64.b64decode((await worker.download_generated_image(transport, URL))["data"]), PNG)
        self.assertEqual(transport.calls[1][1], fife_url)

    async def test_rejects_missing_images_http_errors_oversize_and_redirect_loops(self):
        cases = [[(200, {}, [b"<html>login</html>"])], [(403, {}, [])],
                 [(200, {"content-length": "100"}, [])], [(200, {}, [PNG[:8], PNG[8:]])],
                 [(302, {"location": URL}, [])] * 4]
        for responses in cases:
            transport = Transport(responses)
            with patch.object(worker, "MAX_IMAGE_BYTES", 16):
                with self.assertRaises(worker.WorkerError):
                    await worker.download_generated_image(transport, URL)
            self.assertEqual(transport.closed, len(transport.calls))

    async def test_cancellation_closes_download_and_propagates(self):
        started, closed = asyncio.Event(), asyncio.Event()
        class WaitingTransport:
            @asynccontextmanager
            async def stream(self, *args, **kwargs):
                async def content():
                    started.set()
                    await asyncio.Event().wait()
                    yield PNG
                try:
                    yield SimpleNamespace(status_code=200, headers={}, aiter_content=content)
                finally:
                    closed.set()
        task = asyncio.create_task(worker.download_generated_image(WaitingTransport(), URL))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(closed.is_set())

    async def test_selected_generated_image_only_and_duplicate_stream_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            cookies = Path(directory) / "cookies.json"
            cookies.write_text('{"__Secure-1PSID":"fixture"}')
            class ImageClient(Client):
                async def generate_content_stream(self, prompt, **kwargs):
                    await self.read_generation()
                    for _ in range(3):
                        yield SimpleNamespace(text_delta="description", chosen=1, candidates=[
                            SimpleNamespace(generated_images=[SimpleNamespace(url="https://evil.test/wrong-candidate")]),
                            SimpleNamespace(generated_images=[SimpleNamespace(url=URL)], web_images=[SimpleNamespace(url="https://evil.test/search")]),
                        ])
            client = ImageClient([model("argon")], [])
            downloads = Transport([(200, {}, [PNG])])
            class ImageTransport:
                def stream(self, method, url, **kwargs):
                    return client.http_stream() if method == "POST" else downloads.stream(method, url, **kwargs)
            client.client = ImageTransport()
            events = []
            await worker.run({"mode": "generate", "output": "image", "cookiesFile": str(cookies), "prompt": "Draw"},
                             lambda *args, **kwargs: client, emit_event=events.append)
            self.assertEqual([e["type"] for e in events], ["ready", "image", "done"])
            self.assertEqual(base64.b64decode(events[1]["data"]), PNG)
            self.assertEqual(len(downloads.calls), 1)
            self.assertEqual(downloads.calls[0][1], URL + "=s2048-rj")
            self.assertTrue(client.closed)

    async def test_search_images_and_text_refusals_do_not_count_as_generated_output(self):
        class SearchClient:
            async def generate_content_stream(self, *args, **kwargs):
                yield SimpleNamespace(text_delta="I cannot generate it", chosen=0, candidates=[
                    SimpleNamespace(generated_images=[], web_images=[SimpleNamespace(url=URL)])])
        with self.assertRaises(worker.WorkerError) as caught:
            await worker.consume_stream(SearchClient(), {"output": "image", "prompt": "Draw"}, model("argon"), lambda e: None, {})
        self.assertEqual(caught.exception.status, 502)

    async def test_optional_image_output_allows_text_but_downloads_only_generated_images(self):
        class OptionalClient:
            def __init__(self, images):
                self.images = images
                self.client = Transport([(200, {}, [PNG])])

            async def generate_content_stream(self, *args, **kwargs):
                yield SimpleNamespace(text_delta="A text answer", chosen=0, candidates=[
                    SimpleNamespace(generated_images=self.images, web_images=[SimpleNamespace(url=URL)])])

        for images in [[], [SimpleNamespace(url=URL)]]:
            client, events = OptionalClient(images), []
            done = await worker.consume_stream(client, {"output": "image-or-text", "prompt": "Draw"},
                                               model("argon"), events.append, {})
            self.assertFalse(done["truncated"])
            self.assertEqual(events[1], {"type": "delta", "text": "A text answer"})
            self.assertEqual([event["type"] for event in events], ["ready", "delta", "image"] if images else ["ready", "delta"])
            self.assertEqual(len(client.client.calls), 1 if images else 0)


if __name__ == "__main__":
    unittest.main()
