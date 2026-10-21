# Local request budgets

Open an account in **Dashboard → Accounts → Local request budgets**. For each
provider, set a positive number of requests and a window in hours (1–8760).
Budgets are disabled until configured; no service limits are guessed.

- One successful rotator API request consumes one unit. An agent conversation
  can make many API requests, including a new request after each tool result.
- All models on the same account/provider share the budget. Other providers and
  accounts keep separate counters.
- Pending requests reserve capacity; failed/cancelled requests release it without
  incrementing the successful-request counter.
- The window starts on the first successful request. At exhaustion the account
  is excluded from that provider's routing until the window expires. A routable
  sibling account is selected. If none is available, normal queue/retry handling
  applies; the reset time is included in the retry calculation.
- Limits, usage and window start survive a normal restart. State writes are
  debounced, as with existing rotator counters; a hard crash can lose the latest
  unflushed updates.
- Changing the request limit preserves usage. Changing window length starts a
  new window. Disabling removes the restriction but retains prior state until
  its window expires (so toggling the switch does not refill an active budget).

This is an **operator budget**, not the provider's real remaining quota. Requests
made directly on the provider website or through another gateway are invisible.
Services may charge failed or interrupted requests too. Official quota reports
remain unchanged and their restrictions continue to apply independently.

Configuration lives on each account:

```json
{
  "customQuotas": {
    "qwen-app": { "requests": 100, "windowHours": 24 },
    "deepseek-app": { "requests": 200, "windowHours": 24 }
  }
}
```

These numbers are examples, not claims about Qwen or DeepSeek limits. Counters
are keyed by provider credential identity, so adding a sibling provider does not
reset a budget. Replacing credentials with a new identity starts separate usage.

Admin API: `PUT /api/custom-quota/<encoded account id>` with
`{"providerId":"qwen-app","rule":{"requests":100,"windowHours":24}}`.
Pass `"rule": null` to disable. The exact account ID comes from the dashboard
status API. Authentication is required; session credentials are not sent by the
budget editor.
