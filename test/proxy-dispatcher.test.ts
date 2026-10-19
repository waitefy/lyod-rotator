import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from "node:net";
import { once } from "node:events";
import { getAccountProxyDispatcher, closeProxyDispatchers } from "../src/providers/proxy-dispatcher.js";
import { validateAccountConfig } from "../src/validators.js";
import { fetchWithRetry } from "../src/fetch-with-retry.js";
import { normalizeAccountConfig } from "../src/config-normalize.js";
import type { AccountRuntime } from "../src/types.js";

function account(proxyUrl?: string): AccountRuntime {
	return {
		config: {
			email: "proxy@example.com",
			credentials: [{ provider: "google-antigravity", refreshToken: "refresh", projectId: "project", proxyUrl }],
		},
		accessToken: "access",
		tokenExpires: Date.now() + 60_000,
		requestsSinceRotation: 0,
		totalRequests: 0,
		cooldownsByModel: {},
		quotaExhaustedAt: 0,
		quota: [],
		lastQuotaPoll: 0,
		lastUsed: 0,
		lastError: null,
		consecutiveErrors: 0,
		disabled: false,
		flagged: false,
		inFlightRequests: 0,
		inFlightByModel: {},
		allowFreshWindowStartsOverride: false,
		dailyRequestCount: 0,
		dailyRequestDay: "2026-08-11",
		healthScore: 1,
		tokenBucket: { tokens: 1, lastRefillAt: Date.now() },
	};
}

async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as { port: number }).port;
}

async function listenNet(server: NetServer): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as { port: number }).port;
}

function startSocks5Proxy(): NetServer {
	return createNetServer((client) => {
		let buffer = Buffer.alloc(0);
		let stage: "greeting" | "request" | "forwarding" = "greeting";

		const fail = () => client.destroy();
		const processBuffer = () => {
			if (stage === "greeting") {
				if (buffer.length < 2) return;
				const methodLength = buffer[1];
				if (buffer.length < 2 + methodLength) return;
				buffer = buffer.subarray(2 + methodLength);
				client.write(Buffer.from([5, 0]));
				stage = "request";
				return;
			}
			if (stage !== "request" || buffer.length < 5) return;
			const addressType = buffer[3];
			let addressLength: number;
			let addressStart = 4;
			if (addressType === 1) addressLength = 4;
			else if (addressType === 3) {
				addressLength = buffer[4];
				addressStart = 5;
			} else if (addressType === 4) addressLength = 16;
			else return fail();
			const requestLength = addressStart + addressLength + 2;
			if (buffer.length < requestLength) return;
			const host = addressType === 1
				? [...buffer.subarray(addressStart, addressStart + addressLength)].join(".")
				: addressType === 3
					? buffer.subarray(addressStart, addressStart + addressLength).toString()
					: "::1";
			const portOffset = addressStart + addressLength;
			const port = buffer.readUInt16BE(portOffset);
			buffer = buffer.subarray(requestLength);
			const upstream = netConnect({ host, port }, () => {
				client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
				client.pipe(upstream);
				upstream.pipe(client);
			});
			upstream.once("error", fail);
			stage = "forwarding";
		};

		client.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			processBuffer();
		});
		client.on("error", () => undefined);
	});
}

describe("account proxy dispatchers", () => {
	afterEach(async () => {
		await closeProxyDispatchers();
	});

	it("caches an HTTP dispatcher per configured proxy and isolates different accounts", () => {
		const first = getAccountProxyDispatcher(account("http://proxy-a.example:8080"), "google-antigravity");
		const same = getAccountProxyDispatcher(account("http://proxy-a.example:8080"), "google-antigravity");
		const different = getAccountProxyDispatcher(account("http://proxy-b.example:8080"), "google-antigravity");

		assert.ok(first);
		assert.strictEqual(first, same);
		assert.notStrictEqual(first, different);
		assert.equal(getAccountProxyDispatcher(account("http://proxy-a.example:8080"), "ollama"), undefined);
	});

  it("isolates long-generation transport budgets from default direct and proxy agents", () => {
    for (const proxyUrl of [undefined, "http://proxy-a.example:8080", "socks5://proxy-a.example:1080"]) {
      const current = account(proxyUrl);
      const normal = getAccountProxyDispatcher(current, "google-antigravity");
      const slow = getAccountProxyDispatcher(current, "google-antigravity", 660_000);
      assert.ok(slow);
      assert.notStrictEqual(normal, slow);
      assert.strictEqual(slow, getAccountProxyDispatcher(current, "google-antigravity", 660_000));
      assert.notStrictEqual(slow, getAccountProxyDispatcher(current, "google-antigravity", 720_000));
    }
  });

  it("isolates header budgets while retaining the body budget for direct, HTTP and SOCKS agents", () => {
    for (const proxyUrl of [undefined, "http://proxy-a.example:8080", "socks5://proxy-a.example:1080"]) {
      const current = account(proxyUrl);
      const slow = getAccountProxyDispatcher(current, "google-antigravity", 660_000, 660_000);
      assert.ok(slow);
      assert.strictEqual(slow, getAccountProxyDispatcher(current, "google-antigravity", 660_000, 660_000));
      assert.notStrictEqual(slow, getAccountProxyDispatcher(current, "google-antigravity", 660_000));
      assert.notStrictEqual(slow, getAccountProxyDispatcher(current, "google-antigravity", 660_000, 720_000));
      assert.ok(getAccountProxyDispatcher(current, "google-antigravity", undefined, 660_000));
    }
  });

	it("rejects unsupported proxy schemes without exposing proxy credentials", () => {
		const result = validateAccountConfig({
			email: "proxy@example.com",
			credentials: [{
				provider: "google-antigravity",
				refreshToken: "refresh",
				projectId: "project",
				proxyUrl: "file://proxy-user:super-secret@proxy.example",
			}],
		});

		assert.equal(result.ok, false);
		assert.ok(result.errors.some((error) => error.includes("proxyUrl")));
		assert.ok(!result.errors.some((error) => error.includes("super-secret")));
	});

	it("keeps a legacy flat Ollama proxy when normalizing credentials", () => {
		const normalized = normalizeAccountConfig({
			email: "ollama@example.com",
			provider: "ollama",
			apiKey: "ollama-key",
			proxyUrl: "http://127.0.0.1:8080",
		});
		assert.equal(normalized.credentials?.[0]?.proxyUrl, "http://127.0.0.1:8080");
	});

	it("sends account traffic through its HTTP proxy", async () => {
		const upstream = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("upstream-via-http-proxy");
		});
		let upstreamPort = 0;
		const proxy = createServer((req, res) => {
			if (!req.url) {
				res.writeHead(400);
				res.end();
				return;
			}
			const forwarded = request({
				hostname: "127.0.0.1",
				port: upstreamPort,
				path: req.url,
				method: req.method,
				headers: req.headers,
			}, (response: IncomingMessage) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			});
			forwarded.on("error", () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			req.pipe(forwarded);
		});
		const servers = [upstream, proxy];
		try {
			upstreamPort = await listen(upstream);
			const proxyPort = await listen(proxy);
			const dispatcher = getAccountProxyDispatcher(
				account(`http://127.0.0.1:${proxyPort}`),
				"google-antigravity",
			);
			const response = await fetchWithRetry(`http://127.0.0.1:${upstreamPort}/answer`, {
				dispatcher,
				timeoutMs: 2_000,
				retries: 0,
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "upstream-via-http-proxy");
		} finally {
			await Promise.all(servers.map(async (server) => {
				if (server.listening) {
					server.close();
					await once(server, "close");
				}
			}));
		}
	});

	it("sends account traffic through its SOCKS5 proxy", async () => {
		const upstream = createServer((_req, res) => res.end("upstream-via-socks5"));
		const proxy = startSocks5Proxy();
		const servers = [upstream, proxy];
		try {
			const upstreamPort = await listen(upstream);
			const proxyPort = await listenNet(proxy);
			const dispatcher = getAccountProxyDispatcher(
				account(`socks5://127.0.0.1:${proxyPort}`),
				"google-antigravity",
			);
			const response = await fetchWithRetry(`http://127.0.0.1:${upstreamPort}/answer`, {
				dispatcher,
				timeoutMs: 2_000,
				retries: 0,
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "upstream-via-socks5");
		} finally {
			await Promise.all(servers.map(async (server) => {
				if (server.listening) {
					server.close();
					await once(server, "close");
				}
			}));
		}
	});
});
