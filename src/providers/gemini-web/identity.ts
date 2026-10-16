import type { AccountConfig } from "../../types.js";

/** Identity comes from the authenticated Google bootstrap, never a login label. */
export function webAccountFromIdentity(value: unknown, cookiesFile: string): AccountConfig {
  const identity = value as { email?: unknown; id?: unknown } | null;
  if (!identity || typeof identity.email !== "string" || identity.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email) ||
      typeof identity.id !== "string" || !/^[0-9]{6,32}$/.test(identity.id)) {
    throw new Error("Cannot identify an authenticated Gemini account; reconnect the browser session");
  }
  const email = identity.email.toLowerCase();
  return { email, label: email.split("@")[0], credentials: [
    { provider: "gemini-web", cookiesFile, providerAccountId: identity.id },
  ] };
}
