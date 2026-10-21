import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DashboardAccount } from "../../dashboard-types.js";
import { providerIds, providerLabel } from "../lib/status.js";
import { api } from "../state/api.js";
import { masker, refreshSnapshot } from "../state/store.js";
import { toast } from "../state/actions.js";
import { AsyncButton } from "../components/ui.js";

export function AccountBinding({ account, accounts, onLinked }: {
  account: DashboardAccount; accounts: DashboardAccount[]; onLinked: () => void;
}): JSX.Element | null {
  const providers = providerIds(account).filter((id) => id === "deepseek-app" || id === "qwen-app");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  if (!providers.length) return null;
  return <section class="detail-section">
    <h3>Link to an existing account</h3>
    <p class="muted">Move a provider connection to your existing account card. The verified provider ID stays unchanged.
      An empty source card is removed. Other provider connections stay where they are.</p>
    <label class="field"><span class="field-label">Account</span>
      <select class="input" value={target} onChange={(event) => setTarget(event.currentTarget.value)}>
        <option value="">Choose an account</option>
        {accounts.filter((entry) => entry.email !== account.email && entry.id).map((entry) =>
          <option key={entry.id} value={entry.id}>{masker.value.email(entry.email)}</option>)}
      </select>
    </label>
    <div class="detail-actions">{providers.map((provider) => <AsyncButton key={provider} disabled={!target || !account.id}
      onClick={async () => {
        setError("");
        try {
          await api.linkWebAccount(account.id!, target, provider);
          await refreshSnapshot();
          toast("Provider connection linked", "success");
          onLinked();
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      }}>Link {providerLabel(provider)}</AsyncButton>)}</div>
    {error && <p role="alert" class="tone-text-danger">{error}</p>}
  </section>;
}
