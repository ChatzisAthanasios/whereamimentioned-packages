import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeoutError, MAX_GET_RETRIES, createWamClient } from "./client";

const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BASE = "https://api.example.test";

type Queued = Response | Error | (() => Response | Error);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "X-Wam-Api-Version": "1",
      "X-Request-Id": REQUEST_ID,
      ...headers,
    },
  });
}

function envelope(status: number, code: string, message: string, extra: Record<string, string> = {}, details?: Record<string, unknown>) {
  return json(status, { error: { code, message, requestId: REQUEST_ID, ...(details ? { details } : {}) } }, extra);
}

/** A fetch stub that answers from a queue and records every call. */
function stubFetch(...queue: Queued[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch stub queue exhausted");
    const value = typeof next === "function" ? next() : next;
    if (value instanceof Error) throw value;
    return value;
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function makeClient(fetchImpl: typeof globalThis.fetch, extra: Partial<Parameters<typeof createWamClient>[0]> = {}) {
  return createWamClient({
    baseUrl: BASE,
    token: "wam_test_" + "a".repeat(43),
    org: "acme",
    userAgent: "wam-cli/0.1.0-test",
    fetch: fetchImpl,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("headers", () => {
  it("attaches the bearer, the API version, the user agent and X-Wam-Org on an org-scoped call", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, { key: {} }));
    const client = makeClient(fetchImpl);
    await client.me();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/v1/me`);
    expect(calls[0].init.method).toBe("GET");
    const h = headersOf(calls[0]);
    expect(h.Authorization).toBe("Bearer wam_test_" + "a".repeat(43));
    expect(h["X-Wam-Api-Version"]).toBe("1");
    expect(h["User-Agent"]).toBe("wam-cli/0.1.0-test");
    expect(h["X-Wam-Org"]).toBe("acme");
    expect(h.Accept).toBe("application/json");
  });

  it("sends no Authorization when no token is configured", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, {}));
    const client = makeClient(fetchImpl, { token: undefined });
    await client.credits();
    expect(headersOf(calls[0])).not.toHaveProperty("Authorization");
  });

  it("suppresses X-Wam-Org on organizations.list, organizations.create and keys.revokeSelf", async () => {
    const { fetchImpl, calls } = stubFetch(
      json(200, { data: [], pagination: { nextCursor: null, hasMore: false, limit: 25 } }),
      json(201, { id: "o1" }),
      json(200, { revoked: 1, self: true }),
    );
    const client = makeClient(fetchImpl);
    await client.organizations.list();
    await client.organizations.create({ name: "Acme Labs", type: "brand" }, "idem-1");
    await client.keys.revokeSelf();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(headersOf(call)).not.toHaveProperty("X-Wam-Org");
      expect(headersOf(call).Authorization).toMatch(/^Bearer /);
    }
    expect(calls[0].url).toBe(`${BASE}/api/v1/organizations`);
    expect(calls[1].url).toBe(`${BASE}/api/v1/organizations`);
    expect(calls[2].url).toBe(`${BASE}/api/v1/keys/self`);
    expect(calls[2].init.method).toBe("DELETE");
  });

  it("keys.revokeSelf('cli') sends ?all=cli and nothing else", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, { revoked: 3, self: true, scope: "cli" }));
    await makeClient(fetchImpl).keys.revokeSelf("cli");
    expect(calls[0].url).toBe(`${BASE}/api/v1/keys/self?all=cli`);
    expect(calls[0].init.body).toBeUndefined();
  });

  it("workspaces.create sends the org slug as X-Wam-Org, overriding opts.org, and never in the body", async () => {
    const { fetchImpl, calls } = stubFetch(json(201, { id: "w1" }));
    await makeClient(fetchImpl).workspaces.create("other-org", { name: "Acme EU" });
    expect(calls[0].url).toBe(`${BASE}/api/v1/workspaces`);
    expect(headersOf(calls[0])["X-Wam-Org"]).toBe("other-org");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: "Acme EU" });
    expect(headersOf(calls[0])).not.toHaveProperty("Idempotency-Key");
  });

  it("sends Idempotency-Key on scans.create and organizations.create, and on no other write", async () => {
    const { fetchImpl, calls } = stubFetch(
      json(201, { id: "s1" }),
      json(201, { id: "o1" }),
      json(201, { id: "p1" }),
      json(201, { id: "c1" }),
    );
    const client = makeClient(fetchImpl);
    await client.scans.create("acme-eu", { quote: "q_x.y" }, "gh:123:acme-eu");
    await client.organizations.create({ name: "Acme Labs", type: "agency" }, "gh:123:org");
    await client.prompts.create("acme-eu", { text: "Which CRM suits a ten-person agency?" });
    await client.competitors.create("acme-eu", { name: "Globex" });
    expect(headersOf(calls[0])["Idempotency-Key"]).toBe("gh:123:acme-eu");
    expect(calls[0].url).toBe(`${BASE}/api/v1/workspaces/acme-eu/scans`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quote: "q_x.y" });
    expect(headersOf(calls[1])["Idempotency-Key"]).toBe("gh:123:org");
    expect(headersOf(calls[2])).not.toHaveProperty("Idempotency-Key");
    expect(headersOf(calls[3])).not.toHaveProperty("Idempotency-Key");
    for (const call of calls) expect(headersOf(call)["Content-Type"]).toBe("application/json");
  });

  it("serialises list queries as sorted query parameters and encodes path segments", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, {}), json(200, {}), json(200, {}));
    const client = makeClient(fetchImpl);
    await client.scans.list("acme eu", { limit: 10, status: "done", from: "2026-08-01" });
    await client.scans.answers("3f9c", { modelId: "openai/gpt-5.5", mentioned: false, lowConfidence: true, limit: 20 });
    await client.workspaces.list({ fields: ["id", "slug"], cursor: "eyJ0cyI6" });
    expect(calls[0].url).toBe(`${BASE}/api/v1/workspaces/acme%20eu/scans?from=2026-08-01&limit=10&status=done`);
    expect(calls[1].url).toBe(
      `${BASE}/api/v1/scans/3f9c/answers?limit=20&lowConfidence=true&mentioned=false&modelId=openai%2Fgpt-5.5`,
    );
    expect(calls[2].url).toBe(`${BASE}/api/v1/workspaces?cursor=eyJ0cyI6&fields=id%2Cslug`);
  });

  it("site.* posts to /api/site/<name> with no Authorization, no X-Wam-Org and no API version header", async () => {
    const result = { origin: "https://example.com" };
    const { fetchImpl, calls } = stubFetch(
      json(200, result),
      json(200, {}),
      json(200, {}),
      json(200, {}),
      json(200, {}),
      json(200, {}),
      json(200, {}),
    );
    const client = makeClient(fetchImpl);
    expect(await client.site.checkCrawlers("https://example.com")).toEqual(result);
    await client.site.validateLlmsTxt("https://example.com");
    await client.site.generateLlmsTxt("https://example.com", { full: true });
    await client.site.generateSitemap("https://example.com");
    await client.site.validateStructuredData("https://example.com");
    await client.site.checkMeta("https://example.com", "crm");
    await client.site.analyzeChunks("https://example.com");
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/site/check-crawlers`,
      `${BASE}/api/site/validate-llms-txt`,
      `${BASE}/api/site/generate-llms-txt`,
      `${BASE}/api/site/generate-sitemap`,
      `${BASE}/api/site/validate-structured-data`,
      `${BASE}/api/site/check-meta`,
      `${BASE}/api/site/analyze-chunks`,
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      const h = headersOf(call);
      expect(h).not.toHaveProperty("Authorization");
      expect(h).not.toHaveProperty("X-Wam-Org");
      expect(h).not.toHaveProperty("X-Wam-Api-Version");
      expect(h["User-Agent"]).toBe("wam-cli/0.1.0-test");
    }
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ url: "https://example.com", depth: "full" });
    expect(JSON.parse(String(calls[5].init.body))).toEqual({ url: "https://example.com", keyword: "crm" });
    expect(JSON.parse(String(calls[6].init.body))).toEqual({ url: "https://example.com" });
  });

  it("reads X-Wam-Api-Version and X-Request-Id from every response, including failures", async () => {
    const { fetchImpl } = stubFetch(
      json(200, {}, { "X-Wam-Api-Version": "1" }),
      envelope(401, "unauthorized", "Bad key", { "X-Wam-Api-Version": "2" }),
    );
    const client = makeClient(fetchImpl);
    expect(client.lastApiVersion).toBeNull();
    await client.me();
    expect(client.lastApiVersion).toBe(1);
    expect(client.lastRequestId).toBe(REQUEST_ID);
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(client.lastApiVersion).toBe(2);
  });
});

describe("error mapping", () => {
  it("maps the 08 section 4.2 envelope to ApiError, with Retry-After read into retryAfterSeconds", async () => {
    const { fetchImpl } = stubFetch(
      envelope(
        429,
        "rate_limited",
        "Too many requests",
        { "Retry-After": "17" },
        { retryAfterSeconds: 17, scope: "key" },
      ),
    );
    const err = await makeClient(fetchImpl)
      .me()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe("rate_limited");
    expect(apiErr.message).toBe("Too many requests");
    expect(apiErr.requestId).toBe(REQUEST_ID);
    expect(apiErr.details).toEqual({ retryAfterSeconds: 17, scope: "key" });
    expect(apiErr.retryAfterSeconds).toBe(17);
  });

  it("falls back to details.retryAfterSeconds when the Retry-After header is absent", async () => {
    const { fetchImpl } = stubFetch(envelope(429, "rate_limited", "Slow down", {}, { retryAfterSeconds: 5 }));
    const err = (await makeClient(fetchImpl).credits().catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterSeconds).toBe(5);
  });

  it("carries the 402 details through untouched", async () => {
    const details = { required: 24, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" };
    const { fetchImpl } = stubFetch(envelope(402, "insufficient_credits", "This scan needs 24 credits and the organization has 11.", {}, details));
    const err = (await makeClient(fetchImpl)
      .scans.create("acme-eu", {}, "k")
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(402);
    expect(err.code).toBe("insufficient_credits");
    expect(err.details).toEqual(details);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it("does not invent an envelope code for a non-JSON failure", async () => {
    const { fetchImpl } = stubFetch(
      new Response("<html>Sign in</html>", { status: 502, headers: { "content-type": "text/html", "X-Request-Id": REQUEST_ID } }),
    );
    const err = (await makeClient(fetchImpl)
      .scans.estimate("acme-eu")
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("unknown");
    expect(err.requestId).toBe(REQUEST_ID);
    expect(err.details).toMatchObject({ contentType: "text/html" });
  });

  it("prompts.remove treats a 404 as success, and rethrows anything else", async () => {
    const { fetchImpl, calls } = stubFetch(
      envelope(404, "not_found", "Gone"),
      envelope(403, "insufficient_scope", "Nope"),
    );
    const client = makeClient(fetchImpl);
    await expect(client.prompts.remove("acme-eu", "p1")).resolves.toBeUndefined();
    await expect(client.prompts.remove("acme-eu", "p1")).rejects.toMatchObject({ status: 403 });
    expect(calls[0].init.method).toBe("DELETE");
  });
});

describe("retries", () => {
  it("retries an idempotent GET on 503, honouring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = stubFetch(
      envelope(503, "internal_error", "Upstream", { "Retry-After": "2" }),
      json(200, { balance: 48 }),
    );
    const client = makeClient(fetchImpl);
    const pending = client.credits();
    // The first attempt failed; the retry must wait for the Retry-After window, not fire at once.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toEqual({ balance: 48 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  it("retries a GET on a network-level failure with backoff", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = stubFetch(new TypeError("fetch failed"), json(200, { ok: true }));
    const pending = makeClient(fetchImpl).workspaces.get("acme-eu");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up after MAX_GET_RETRIES retries on persistent 5xx", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = stubFetch(
      envelope(502, "internal_error", "Bad gateway"),
      envelope(502, "internal_error", "Bad gateway"),
      envelope(502, "internal_error", "Bad gateway"),
      json(200, { never: "reached" }),
    );
    const pending = makeClient(fetchImpl).me();
    const assertion = expect(pending).rejects.toMatchObject({ status: 502, code: "internal_error" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls).toHaveLength(MAX_GET_RETRIES + 1);
  });

  it("never retries a 429, even on a GET", async () => {
    const { fetchImpl, calls } = stubFetch(
      envelope(429, "rate_limited", "Stop", { "Retry-After": "1" }, { retryAfterSeconds: 1 }),
      json(200, { never: "reached" }),
    );
    const err = (await makeClient(fetchImpl).me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("never retries a POST, not even on 503 or a network failure", async () => {
    const { fetchImpl, calls } = stubFetch(envelope(503, "internal_error", "Upstream"), json(201, {}));
    await expect(makeClient(fetchImpl).scans.create("acme-eu", {}, "k")).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);

    const network = stubFetch(new TypeError("fetch failed"), json(201, {}));
    await expect(makeClient(network.fetchImpl).site.checkCrawlers("https://example.com")).rejects.toBeInstanceOf(TypeError);
    expect(network.calls).toHaveLength(1);
  });

  it("does not retry a 404 or a 422", async () => {
    const { fetchImpl, calls } = stubFetch(envelope(404, "not_found", "No such scan"), json(200, {}));
    await expect(makeClient(fetchImpl).scans.get("nope")).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(1);
  });
});

describe("timeouts", () => {
  it("aborts a request after timeoutMs and throws ApiTimeoutError without retrying", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const hanging = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push(Date.now());
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = makeClient(hanging, { timeoutMs: 50 });
    const pending = client.me();
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });
});

describe("report", () => {
  it("returns the parsed body for format=json and raw bytes for csv or pdf", async () => {
    const report = { brandName: "Acme", score: 61 };
    const { fetchImpl, calls } = stubFetch(
      json(200, report),
      new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const client = makeClient(fetchImpl);
    expect(await client.scans.report("s1", "json")).toEqual(report);
    const bytes = await client.scans.report("s1", "pdf");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes as Uint8Array)).toEqual([37, 80, 68, 70]);
    expect(calls[0].url).toBe(`${BASE}/api/v1/scans/s1/report?format=json`);
    expect(calls[1].url).toBe(`${BASE}/api/v1/scans/s1/report?format=pdf`);
    expect(headersOf(calls[1]).Accept).toBe("*/*");
  });
});

describe("lastResponse", () => {
  const SCAN_BODY = { id: "s1", status: "queued", credits: 24, prompts: 6, models: 4, balanceAfter: 24, pollUrl: "/api/v1/scans/s1" };
  const ORG_BODY = {
    id: "o1",
    slug: "acme-labs",
    name: "Acme Labs",
    type: "brand",
    tier: "free",
    usable: false,
    subscribeUrl: "https://whereamimentioned.com/acme-labs/billing",
    message: "The organization was created on the free floor and cannot run scans yet.",
  };

  it("is null before the first request", () => {
    const { fetchImpl } = stubFetch();
    expect(makeClient(fetchImpl).lastResponse).toBeNull();
  });

  it("scans.create: a 201 is not a replay, a 200 + X-Idempotent-Replay: true is, and the body is untouched either way", async () => {
    const { fetchImpl } = stubFetch(json(201, SCAN_BODY), json(200, SCAN_BODY, { "X-Idempotent-Replay": "true" }));
    const client = makeClient(fetchImpl);

    const fresh = await client.scans.create("acme-eu", { quote: "q_x.y" }, "gh:1:acme-eu");
    expect(fresh).toEqual(SCAN_BODY);
    expect(client.lastResponse?.status).toBe(201);
    expect(client.lastResponse?.replayed).toBe(false);

    const replay = await client.scans.create("acme-eu", { quote: "q_x.y" }, "gh:1:acme-eu");
    expect(replay).toEqual(SCAN_BODY);
    // No `replayed` key is spliced into the wire body: `--json` stays byte-identical to the API.
    expect(Object.keys(replay)).toEqual(Object.keys(SCAN_BODY));
    expect(client.lastResponse?.status).toBe(200);
    expect(client.lastResponse?.replayed).toBe(true);
    expect(client.lastResponse?.headers.get("X-Idempotent-Replay")).toBe("true");
  });

  it("organizations.create: the same 201 versus 200 + header pair", async () => {
    const { fetchImpl } = stubFetch(json(201, ORG_BODY), json(200, ORG_BODY, { "X-Idempotent-Replay": "true" }));
    const client = makeClient(fetchImpl);
    await client.organizations.create({ name: "Acme Labs", type: "brand" }, "deploy-1");
    expect(client.lastResponse).toMatchObject({ status: 201, replayed: false });
    await client.organizations.create({ name: "Acme Labs", type: "brand" }, "deploy-1");
    expect(client.lastResponse).toMatchObject({ status: 200, replayed: true });
  });

  it("is replaced by the next response, so a replay flag never survives into a later call", async () => {
    const { fetchImpl } = stubFetch(
      json(200, SCAN_BODY, { "X-Idempotent-Replay": "true" }),
      json(200, { id: "s1", status: "running" }),
    );
    const client = makeClient(fetchImpl);
    await client.scans.create("acme-eu", {}, "k");
    expect(client.lastResponse?.replayed).toBe(true);
    await client.scans.get("s1");
    expect(client.lastResponse).toMatchObject({ status: 200, replayed: false });
  });

  it("exposes the response headers of a failure too, so a 429's X-RateLimit-Limit is readable (10 section 9)", async () => {
    const { fetchImpl } = stubFetch(
      envelope(429, "rate_limited", "Too many requests", { "Retry-After": "17", "X-RateLimit-Limit": "60" }, { retryAfterSeconds: 17 }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(client.lastResponse?.status).toBe(429);
    expect(client.lastResponse?.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(client.lastResponse?.replayed).toBe(false);
  });

  it("is null again after a network-level failure, never a stale earlier response", async () => {
    const { fetchImpl } = stubFetch(json(201, SCAN_BODY), new TypeError("fetch failed"));
    const client = makeClient(fetchImpl);
    await client.scans.create("acme-eu", {}, "k");
    expect(client.lastResponse?.status).toBe(201);
    await expect(client.scans.create("acme-eu", {}, "k2")).rejects.toBeInstanceOf(TypeError);
    expect(client.lastResponse).toBeNull();
  });
});

describe("guards", () => {
  it("workspaces.create rejects an empty or whitespace orgSlug before any request is made", async () => {
    const { fetchImpl, calls } = stubFetch(json(201, { id: "w1" }));
    const client = makeClient(fetchImpl);
    // An empty slug would fall through to opts.org: the ambient default the explicit parameter exists to refuse.
    await expect(client.workspaces.create("", { name: "Acme EU" })).rejects.toBeInstanceOf(TypeError);
    await expect(client.workspaces.create("   ", { name: "Acme EU" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("a 2xx whose body is not JSON becomes an ApiError with code unknown, not a raw SyntaxError", async () => {
    const { fetchImpl } = stubFetch(
      new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html", "X-Request-Id": REQUEST_ID } }),
    );
    const err = (await makeClient(fetchImpl).me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(200);
    expect(err.code).toBe("unknown");
    expect(err.requestId).toBe(REQUEST_ID);
    expect(err.details).toEqual({ contentType: "text/html", bodyPreview: "<html>captive portal</html>" });
  });
});
