"""Request-local, allowlisted diagnostics. Never serialize exception messages."""
import contextlib
import contextvars
import time


CURRENT = contextvars.ContextVar("gemini_web_telemetry", default=None)
ERROR_KINDS = frozenset({
    "WorkerError", "GoogleStreamError", "ModelVerificationError", "AuthError",
    "UsageLimitExceededError", "TemporarilyBlockedError", "ModelInvalidError",
    "APIError", "TimeoutError", "CancelledError", "ConnectionError", "OSError",
    "CurlError", "ImportError", "ModuleNotFoundError",
})


class Trace:
    def __init__(self):
        self.started = time.monotonic()
        self.timings = {}
        self.failed_stage = None
        self.attempts = 0
        self.google_requests = 0

    @contextlib.contextmanager
    def phase(self, name):
        started = time.monotonic()
        try:
            yield
        except BaseException:
            if self.failed_stage is None:
                self.failed_stage = name
            raise
        finally:
            self.timings[name] = self.timings.get(name, 0) + max(0, round((time.monotonic() - started) * 1000))

    def event(self, error=None):
        result = {"type": "diagnostic", "timingsMs": dict(self.timings),
                  "sessionMs": max(0, round((time.monotonic() - self.started) * 1000)),
                  "attempts": self.attempts, "googleRequests": self.google_requests}
        if error is not None:
            name = type(error).__name__
            result["errorKind"] = name if name in ERROR_KINDS else "unknown"
            result["failedStage"] = self.failed_stage or "session"
            code = getattr(error, "google_code", None)
            if type(code) is int and 1 <= code <= 99_999_999:
                result["googleCode"] = code
        return result


def phase(name):
    trace = CURRENT.get()
    return trace.phase(name) if trace is not None else contextlib.nullcontext()
