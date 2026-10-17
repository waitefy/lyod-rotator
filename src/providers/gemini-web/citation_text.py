"""Render Gemini's prose citations without changing code or client tool calls."""

import re
from urllib.parse import quote, urlsplit


_TOKENS = re.compile(
    r"(?P<code>(?P<fence>`{3,}|~{3,})[\s\S]*?(?:(?P=fence)|\Z)"
    r"|(?P<ticks>`+)[\s\S]*?(?P=ticks))"
    r"|\[cite:\s*(?P<ids>\d+(?:\s*,\s*\d+)*)\s*\]"
)
_TOOL_CALL = re.compile(r"^\s*ROTATOR_TOOL_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\{")


def render_citations(text, citations, *, single_image=False):
    if _TOOL_CALL.match(text):
        return text
    sources = {}
    for citation in citations:
        url = getattr(citation, "url", None)
        number = getattr(citation, "id", None)
        if not isinstance(url, str) or len(url) > 4096 or not isinstance(number, int):
            continue
        try:
            parsed = urlsplit(url)
            if (parsed.scheme not in ("http", "https") or not parsed.hostname
                    or parsed.username is not None or parsed.password is not None
                    or any(ord(c) < 32 for c in url)
                    or parsed.hostname == "gemini.google.com"
                    or parsed.hostname.endswith((".googleusercontent.com", ".usercontent.google.com"))):
                continue
        except ValueError:
            continue
        title = getattr(citation, "title", None)
        title = title if isinstance(title, str) and title.strip() else parsed.hostname
        label = re.sub(r"([\\\[\]`*_])", r"\\\1", " ".join(title.split())[:256])
        target = quote(url, safe=":/?#@!$&'*+,;=%-._~")
        sources[number] = f"[{label}]({target})"

    def replace(match):
        if match.group("code") is not None:
            return match.group()
        numbers = [int(number.strip()) for number in match.group("ids").split(",")]
        if all(number in sources for number in numbers):
            return " ".join(sources[number] for number in dict.fromkeys(numbers))
        # An unresolvable reference adds nothing to a one-image description.
        # The numeric marker is not a reliable attachment index. Keep source
        # metadata authoritative; never invent a URL for a missing source.
        if single_image and not citations:
            return ""
        return match.group()

    return _TOKENS.sub(replace, text)


class CitationText:
    """Keep ordinary deltas streaming; hold a possible marker for late metadata."""

    def __init__(self, *, single_image=False):
        self.single_image = single_image
        self.raw = ""
        self.emitted = 0
        self.held = False
        self.citations = {}

    def feed(self, text, citations=()):
        for citation in citations:
            number = getattr(citation, "id", None)
            if isinstance(number, int):
                self.citations[number] = citation
        self.raw += text
        if self.held:
            return ""
        # A '[' at the end of a delta may become '[cite:' in the next one.
        match = re.search(r"\[(?:cite:|(?:c|ci|cit|cite)?$)", text)
        if match:
            self.held = True
            text = text[:match.start()]
        self.emitted += len(text)
        return text

    def finish(self):
        rendered = render_citations(self.raw, list(self.citations.values()), single_image=self.single_image)
        return rendered[self.emitted:]
