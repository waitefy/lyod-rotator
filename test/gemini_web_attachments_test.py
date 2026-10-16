"""Upload byte fidelity and cleanup without Google or real credentials."""
import asyncio
import base64
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gemini_web_worker_test import Client, model, worker


class AttachmentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cookies = Path(self.temp.name) / "cookies.json"
        self.cookies.write_text(json.dumps({"__Secure-1PSID": "fixture"}))
        self.payload = {"mode": "generate", "cookiesFile": str(self.cookies), "prompt": "Read the attachments"}

    def run_client(self, client, payload):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(worker.run(payload, lambda *args, **kwargs: client))
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_uploads_have_mime_extensions_private_permissions_and_exact_bytes(self):
        raw_files = [("image/png", b"\x89PNG\r\n\x1a\nfixture"),
                     ("application/pdf", b"%PDF-1.4\nfixture"),
                     ("text/plain", "Привет 🌍".encode())]
        paths = []
        owner = self

        class UploadClient(Client):
            async def generate_content_stream(self, prompt, *, model, temporary, files):
                paths.extend(files)
                owner.assertEqual([p.suffix for p in files], [".png", ".pdf", ".txt"])
                owner.assertEqual([p.read_bytes() for p in files], [raw for _, raw in raw_files])
                owner.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in files))
                owner.assertEqual(files[0].parent.stat().st_mode & 0o777, 0o700)
                async for output in super().generate_content_stream(prompt, model=model, temporary=temporary):
                    yield output

        payload = {**self.payload, "attachments": [{"mimeType": mime, "data": base64.b64encode(raw).decode()} for mime, raw in raw_files]}
        client = UploadClient([model("argon")], ["ok"])
        events = self.run_client(client, payload)
        self.assertEqual(events[-1]["type"], "done")
        self.assertTrue(client.closed)
        self.assertTrue(paths and all(not p.exists() for p in paths))
        self.assertFalse(paths[0].parent.exists())

    def test_uploads_are_removed_after_upstream_failure_and_cancellation(self):
        async def check(cancel):
            started = asyncio.Event()
            paths = []

            class FailedUpload(Client):
                async def generate_content_stream(self, prompt, *, model, temporary, files):
                    paths.extend(files)
                    started.set()
                    if cancel:
                        await asyncio.Event().wait()
                    raise RuntimeError("upload failed")
                    yield

            client = FailedUpload([model("argon")], [])
            payload = {**self.payload, "attachments": [{"mimeType": "text/plain", "data": "YQ=="}]}
            task = asyncio.create_task(worker.run(payload, lambda *args, **kwargs: client, emit_event=lambda event: None))
            await asyncio.wait_for(started.wait(), 1)
            if cancel:
                task.cancel()
            with self.assertRaises(asyncio.CancelledError if cancel else RuntimeError):
                await task
            self.assertTrue(client.closed)
            self.assertTrue(paths and all(not p.exists() for p in paths))
            self.assertFalse(paths[0].parent.exists())

        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                asyncio.run(check(cancel))

    def test_bad_attachments_fail_before_creating_a_google_client(self):
        invalid = [None, {}, ["/etc/passwd"], [{"path": "/etc/passwd"}],
                   [{"mimeType": [], "data": "YQ=="}],
                   [{"mimeType": "audio/mp3", "data": "YQ=="}],
                   [{"mimeType": "image/png", "data": "YR=="}],
                   [{"mimeType": "text/plain", "data": "YQ=\n="}],
                   [{"mimeType": "text/plain", "data": ""}],
                   [{"mimeType": "text/plain", "data": "YQ=="}] * (worker.MAX_ATTACHMENTS + 1)]
        for attachments in invalid:
            with self.subTest(attachments=type(attachments).__name__):
                client = Client([model("argon")], [])
                with self.assertRaises(worker.WorkerError) as caught:
                    self.run_client(client, {**self.payload, "attachments": attachments})
                self.assertEqual(caught.exception.status, 400)
                self.assertFalse(client.closed)  # Rejected before factory/init.
                self.assertFalse(client.generated)

    def test_per_file_and_total_decoded_byte_limits(self):
        with patch.object(worker, "MAX_ATTACHMENT_BYTES", 4), patch.object(worker, "MAX_TOTAL_ATTACHMENT_BYTES", 6):
            for raws in ([b"12345"], [b"1234", b"5678"]):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.decode_attachments([{"mimeType": "text/plain", "data": base64.b64encode(raw).decode()} for raw in raws])
                self.assertEqual(caught.exception.status, 400)
            self.assertEqual(worker.decode_attachments([{"mimeType": "text/plain", "data": "MTIzNA=="}]), [("text/plain", b"1234")])


if __name__ == "__main__":
    unittest.main()
