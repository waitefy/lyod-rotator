"""Citation formatting contracts, without Google requests or credentials."""

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gemini_web_worker_test import Client, model, worker
from citation_text import CitationText, render_citations


class CitationTest(unittest.TestCase):
    def test_single_image_dead_reference_is_removed(self):
        for marker in ("[cite: 1]", "[cite: 2]", "[cite: 27]", "[cite: 1, 2]"):
            with self.subTest(marker=marker):
                self.assertEqual(render_citations(f"Красное сердце{marker}.", [], single_image=True), "Красное сердце.")

    def test_unknown_sources_and_multiple_images_are_not_guessed(self):
        self.assertEqual(render_citations("Сравнение[cite: 2].", [], single_image=False), "Сравнение[cite: 2].")
        self.assertEqual(render_citations("Источник[cite: 1].", []), "Источник[cite: 1].")

    def test_web_sources_survive_an_image_request(self):
        sources = [SimpleNamespace(id=1, title="Reference [page]", url="https://example.org/a(b)?q=1")]
        self.assertEqual(render_citations("Сердце[cite: 1].", sources, single_image=True),
                         "Сердце[Reference \\[page\\]](https://example.org/a%28b%29?q=1).")

    def test_code_and_tool_arguments_are_untouched(self):
        text = '```python\nx = "[cite: 1]"\n```\nUse `[cite: 1]`.'
        call = 'ROTATOR_TOOL_12345678-1234-1234-1234-123456789abc{"arguments":{"content":"[cite: 1]"}}'
        for value in (text, call, '~~~\n[cite: 1]'):
            self.assertEqual(render_citations(value, [], single_image=True), value)

    def test_unsafe_links_and_unresolved_group_are_preserved(self):
        for url in ('javascript:alert(1)', 'https://user:secret@example.org', 'https://example.org/\nsecret',
                    'https://lh3.googleusercontent.com/private?token=secret', 'https://[invalid'):
            source = SimpleNamespace(id=1, title="Source", url=url)
            self.assertEqual(render_citations('[cite: 1]', [source], single_image=True), '[cite: 1]')
        self.assertEqual(render_citations('[cite: 1, 2]', [SimpleNamespace(id=1, title="Page", url="https://example.org")]), '[cite: 1, 2]')

    def test_markers_split_at_every_boundary_and_late_metadata(self):
        text = 'A[cite: 1] B'
        source = SimpleNamespace(id=1, title="Page", url="https://example.org")
        for split in range(len(text) + 1):
            stream = CitationText()
            result = stream.feed(text[:split]) + stream.feed(text[split:])
            result += stream.feed('', [source]) + stream.finish()
            self.assertEqual(result, 'A[Page](https://example.org) B', split)

    def test_ordinary_text_is_not_delayed(self):
        stream = CitationText()
        self.assertEqual(stream.feed('Hello'), 'Hello')
        self.assertEqual(stream.feed(' world'), ' world')
        self.assertEqual(stream.finish(), '')

    def test_worker_formats_chosen_candidate_after_late_metadata(self):
        class CitedClient(Client):
            async def generate_content_stream(self, *args, **kwargs):
                yield SimpleNamespace(text_delta='Heart[cite:', chosen=0, candidates=[])
                yield SimpleNamespace(text_delta=' 1].', chosen=1, candidates=[
                    SimpleNamespace(citations=[SimpleNamespace(id=1, title='Wrong', url='https://wrong.example')]),
                    SimpleNamespace(citations=[SimpleNamespace(id=1, title='Page', url='https://example.org')]),
                ])
        events = []
        asyncio.run(worker.consume_stream(CitedClient([], []), {'prompt': 'Describe'}, model('argon'), events.append, {}))
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'delta'), 'Heart[Page](https://example.org).')

    def test_worker_removes_image_reference_but_preserves_tool_file_contents(self):
        call = 'ROTATOR_TOOL_12345678-1234-1234-1234-123456789abc{"arguments":{"content":"[cite: 1]"}}'
        for text, expected in [('Heart[cite: 1].', 'Heart.'), ('House[cite: 2].', 'House.'), (call, call)]:
            events = []
            client = Client([], list(text))
            payload = {'prompt': 'Describe', 'attachments': [{'mimeType': 'image/png'}]}
            asyncio.run(worker.consume_stream(client, payload, model('argon'), events.append, {}))
            self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'delta'), expected)

    def test_expanding_links_still_obey_worker_output_limit(self):
        class CitedClient(Client):
            async def generate_content_stream(self, *args, **kwargs):
                yield SimpleNamespace(text_delta='A[cite: 1]', chosen=0, candidates=[
                    SimpleNamespace(citations=[SimpleNamespace(id=1, title='Page', url='https://example.org/long')]),
                ])
        events = []
        with patch.object(worker, 'MAX_OUTPUT_CHARS', 20):
            done = asyncio.run(worker.consume_stream(CitedClient([], []), {'prompt': 'Describe'}, model('argon'), events.append, {}))
        self.assertEqual(len(''.join(e['text'] for e in events if e['type'] == 'delta')), 20)
        self.assertTrue(done['truncated'])


if __name__ == '__main__':
    unittest.main()
