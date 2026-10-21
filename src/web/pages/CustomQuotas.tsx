import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DashboardAccount } from "../../dashboard-types.js";
import { providerIds, providerLabel } from "../lib/status.js";
import { api } from "../state/api.js";
import { toast } from "../state/actions.js";
import { refreshSnapshot } from "../state/store.js";
import { AsyncButton, Countdown, Meter } from "../components/ui.js";

export function CustomQuotas({ account }: { account: DashboardAccount }): JSX.Element {
  return <section class="detail-section">
    <h3>Local request budgets</h3>
    <p class="muted">Optional limits per account and provider. These are your budgets, not reported service quotas.
      Count successful API requests through this rotator, including each agent tool round trip. Usage in the provider website is not counted.</p>
    {providerIds(account).map((providerId) => <Budget key={providerId} account={account} providerId={providerId} />)}
  </section>;
}

function Budget({ account, providerId }: { account: DashboardAccount; providerId: string }): JSX.Element {
  const budget = account.customQuotas?.find((entry) => entry.providerId === providerId);
  const [requests, setRequests] = useState(budget ? String(budget.requests) : "");
  const [hours, setHours] = useState(String(budget?.windowHours ?? 24));
  const [error, setError] = useState<string | null>(null);
  const save = async (disable = false) => {
    setError(null);
    try {
      await api.setCustomQuota(account.id!, providerId, disable ? null : { requests: Number(requests), windowHours: Number(hours) });
      toast(disable ? "Local budget disabled" : "Local budget saved", "success");
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return <div class="form">
    <strong>{providerLabel(providerId)}</strong>
    {budget && <>
      <span class="num">{budget.used} / {budget.requests} requests · {budget.percentRemaining}% remaining</span>
      <Meter value={budget.percentRemaining} label={`${providerLabel(providerId)} local request budget`} />
      <p class="muted">{budget.resetAt ? <>Resets in <Countdown until={budget.resetAt} /></> : "Window starts on the first successful request."}</p>
    </>}
    <div class="form-grid">
      <label class="field"><span class="field-label">Requests</span>
        <input class="input" type="number" min="1" step="1" value={requests} onInput={(event) => setRequests(event.currentTarget.value)} placeholder="Disabled" />
      </label>
      <label class="field"><span class="field-label">Window (hours)</span>
        <input class="input" type="number" min="1" max="8760" step="1" value={hours} onInput={(event) => setHours(event.currentTarget.value)} />
      </label>
    </div>
    <div class="detail-actions">
      <AsyncButton disabled={!account.id || !requests} onClick={() => save()}>Save budget</AsyncButton>
      {budget && <AsyncButton onClick={() => save(true)}>Disable</AsyncButton>}
    </div>
    <p class="muted">Switches to another account when exhausted; resumes after reset. Changing the window length starts a new window. Changing the limit keeps current usage.</p>
    {error && <p role="alert" class="tone-text-danger">{error}</p>}
  </div>;
}
