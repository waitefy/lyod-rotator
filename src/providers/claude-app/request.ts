import { setTimeout as delay } from "node:timers/promises";
import { fetchWithHeadersTimeout, type FetchWithHeadersTimeoutOptions } from "../../fetch-with-retry.js";

/** Retry only an explicitly short, pre-stream rate limit. Never replay a started answer. */
export async function fetchClaudeMessage(
  endpoint: string,
  options: FetchWithHeadersTimeoutOptions & { body: string },
  fetchImpl = fetchWithHeadersTimeout,
  sleepImpl: (ms: number, signal?: AbortSignal | null) => Promise<unknown> =
    (ms, signal) => delay(ms, undefined, { signal: signal ?? undefined }),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(endpoint, options);
    const retry = response.headers.get("retry-after");
    if (response.status !== 429 || attempt === 2 || retry === null || !/^\d+$/.test(retry) || Number(retry) > 10) return response;
    await response.body?.cancel();
    await sleepImpl(Math.max(Number(retry) * 1000, 2000 * 2 ** attempt), options.signal);
    options.signal?.throwIfAborted();
  }
}
