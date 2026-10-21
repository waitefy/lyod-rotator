import type { AccountConfig, Config } from "../../types.js";
import { getAccountIdentity } from "../../account-identity.js";
import { getCredential } from "../credential-helpers.js";
import { readSession, type WebAppProvider } from "./credentials.js";

/** Move one verified provider connection, retaining all unrelated credentials. */
export function bindWebAppAccount(config: Config, sourceId: string, targetId: string,
  provider: WebAppProvider, verified: AccountConfig): Config {
  const source = config.accounts.find((account) => getAccountIdentity(account) === sourceId);
  const target = config.accounts.find((account) => getAccountIdentity(account) === targetId);
  const credential = getCredential(verified, provider);
  if (!source || !target || source === target || !credential?.providerAccountId ||
      getCredential(source, provider)?.sessionFile !== credential.sessionFile) throw new Error("Invalid account binding");
  const previous = getCredential(target, provider);
  if (previous && readSession(previous.sessionFile, provider).accountId !== credential.providerAccountId) {
    throw new Error("Target already has a different provider account");
  }
  const remaining = source.credentials?.filter((entry) => entry.provider !== provider) ?? [];
  const sourceQuotas = { ...source.customQuotas };
  delete sourceQuotas[provider];
  return { ...config, accounts: config.accounts.flatMap((account) => {
    if (account === source) return remaining.length ? [{ ...source, credentials: remaining, customQuotas: sourceQuotas }] : [];
    if (account !== target) return [account];
    return [{ ...target, credentials: [...(target.credentials ?? []).filter((entry) => entry.provider !== provider), credential],
      customQuotas: { ...(source.customQuotas?.[provider] ? { [provider]: source.customQuotas[provider] } : {}),
        ...target.customQuotas } }];
  }) };
}
