# Antigravity slow-stream trial

Antigravity has a 120-second response-header deadline and a **600-second idle
budget** after upstream SSE headers. Actual nonempty thinking resets the startup
budget; comments, usage and empty placeholders do not. This is an observation
window, not a measured maximum or a promise that Google will answer in ten minutes.

A startup silence deadline returns HTTP 504 without another endpoint/account
attempt, provider cooldown or credential/quota penalty. Explicit account errors
and genuine connection failures retain their existing recovery. An established
stream also allows a 600-second gap and is never replayed after output commits.
Client cancellation still cancels upstream and releases the account.

The Antigravity Undici agent uses a 660-second body timeout; other providers keep
their existing agent and stream settings. Frontend proxies and clients need a
larger first-response budget. Client-level retries are independent of the
rotator's retry policy and must be disabled for a strict single-attempt measurement.

Safe stream diagnostics include header latency, time to first model/output event,
maximum byte/model-event gap, end outcome and cancellation category. Wait notices
at 30 and 120 seconds go to server logs, not assistant text. EOF is transport
completion, not proof that the model completed the task; inspect finish/error flags.
Payloads, tool arguments and credentials are excluded.

Use one ordinary continuation to collect observations; do not start parallel
load tests or intentionally exhaust accounts. Samples cancelled by any deadline
are censored observations and cannot establish the natural maximum latency.
