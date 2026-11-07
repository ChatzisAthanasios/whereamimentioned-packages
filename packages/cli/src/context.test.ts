import { describe, expect, it } from "vitest";
import { ApiError } from "@whereamimentioned/api-client";
import { createContext, defaultExec, type ContextOverrides } from "./context";
import { makeCredentialRecord } from "./credentials";
import { CliError } from "./errors";
import { FAKE_TOKEN, FIXED_NOW, fakePrimitives, fakeStream, type FakeStream } from "./test-support";
import { VERSION } from "./version";

const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Wam-Api-Version": "1", "X-Request-Id": REQUEST_ID, ...headers },
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(...queue: Response[]): { fetchImpl: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = queue.shift();
    if (!next) throw new Error("fetch stub queue exhausted");
    return next;
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function make(overrides: ContextOverrides = {}): ReturnType<typeof createContext> & { io: { stdout: FakeStream; stderr: FakeStream } } {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const base = fakePrimitives({ stdout, stderr, fileMode: () => 0o600 });
  const ctx = createContext({ ...base, ...overrides, flags: overrides.flags });
  return Object.assign(ctx, { io: { stdout, stderr } });
}

describe("decisions made once", () => {
  it("non-TTY stdout is non-interactive and colourless; a TTY with --color is coloured", () => {
    const plain = make();
    expect(plain.nonInteractive).toBe(true);
    expect(plain.interactive).toBe(false);
    expect(plain.color).toBe(false);
    const forced = make({ isTTY: { stdout: true, stdin: true }, flags: { color: true } });
    expect(forced.interactive).toBe(true);
    expect(forced.color).toBe(true);
    const ci = make({ isTTY: { stdout: true, stdin: true }, env: { CI: "1" } });
    expect(ci.nonInteractive).toBe(true);
  });

  it("confirmDeps reflects interactivity, --yes and the stdin TTY", () => {
    const ctx = make({ isTTY: { stdout: true, stdin: false }, flags: { yes: true } });
    expect(ctx.confirmDeps()).toMatchObject({ interactive: true, yes: true, stdinIsTTY: false });
  });
});

describe("defaultExec", () => {
  it("reports a command that could not be started as spawnError, never as an exit code it did not produce", async () => {
    // Nothing is spawned: the lookup fails before a process exists.
    const result = await defaultExec("wam-no-such-command-4f2a", ["--version"]);
    expect(result).toEqual({ stdout: "", stderr: "", code: 1, spawnError: "ENOENT" });
  });
});

describe("the client", () => {
  it("is built once with the WAM_TOKEN credential, the wam-cli user agent and X-Wam-Org from --org", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, { ok: true }), json(200, { ok: true }));
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, fetch: fetchImpl, flags: { org: "acme" } });
    const a = await ctx.client();
    const b = await ctx.client();
    expect(a).toBe(b);
    await a.me();
    expect(calls[0]!.url).toBe("https://whereamimentioned.com/api/v1/me");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls[0]!.headers["User-Agent"]).toBe(`wam-cli/${VERSION}`);
    expect(calls[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it("uses --api-url as the origin", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, {}));
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, fetch: fetchImpl, flags: { apiUrl: "https://staging.example/" } });
    await (await ctx.client()).credits();
    expect(calls[0]!.url).toBe("https://staging.example/api/v1/credits");
  });

  it("without any credential is exit 3 with the Not signed in copy, and makes no request", async () => {
    const { fetchImpl, calls } = stubFetch();
    const ctx = make({ fetch: fetchImpl });
    const err = await ctx.client().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("no_credential");
    expect((err as CliError).exitCode).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("--token beats WAM_TOKEN and warns on stderr, never printing either token", async () => {
    const flagToken = `wam_test_${"F".repeat(43)}`;
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, flags: { token: flagToken, debug: true } });
    const cred = await ctx.requireCredential();
    expect(cred.token).toBe(flagToken);
    expect(cred.source).toBe("--token");
    expect(ctx.io.stderr.text).toContain("Both --token and WAM_TOKEN are set. Using --token.");
    expect(ctx.io.stderr.text).not.toContain(flagToken);
    expect(ctx.io.stderr.text).not.toContain(FAKE_TOKEN);
    expect(ctx.io.stderr.text).toContain(`${flagToken.slice(0, 17)}...${flagToken.slice(-4)}`);
  });

  it("stops with the API version mismatch copy when the server answers with a higher version", async () => {
    const { fetchImpl } = stubFetch(json(200, { ok: true }, { "X-Wam-Api-Version": "2" }));
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, fetch: fetchImpl });
    const client = await ctx.client();
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("api_version_mismatch");
    expect((err as CliError).exitCode).toBe(1);
    expect((err as CliError).lines[0]).toBe("This server speaks API version 2 and this CLI understands version 1.");
    // The response metadata stays plain data through the guard.
    expect(client.lastApiVersion).toBe(2);
    expect(client.lastResponse?.headers.get("X-Wam-Api-Version")).toBe("2");
    expect(client.lastRequestId).toBe(REQUEST_ID);
  });

  it("proceeds when the header is absent (an older server)", async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const { fetchImpl } = stubFetch(res);
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, fetch: fetchImpl });
    await expect((await ctx.client()).me()).resolves.toEqual({ ok: true });
  });

  it("the anonymous client sends no Authorization, reads no credential and hits /api/site", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, { ok: true }));
    const ctx = make({ fetch: fetchImpl });
    await ctx.anonymousClient().site.checkCrawlers("https://acme.com");
    expect(calls[0]!.url).toMatch(/^https:\/\/whereamimentioned\.com\/api\/site\//);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[0]!.headers["User-Agent"]).toBe(`wam-cli/${VERSION}`);
  });

  it("--debug logs method, path, status and request id on stderr, and never the token", async () => {
    const { fetchImpl } = stubFetch(json(200, { ok: true }));
    const ctx = make({ env: { WAM_TOKEN: FAKE_TOKEN }, fetch: fetchImpl, flags: { debug: true } });
    await (await ctx.client()).me();
    expect(ctx.io.stderr.text).toContain(`[debug] GET /api/v1/me -> 200 (${REQUEST_ID})`);
    expect(ctx.io.stderr.text).not.toContain(FAKE_TOKEN);
    expect(ctx.io.stdout.text).toBe("");
  });
});

describe("org and workspace resolution", () => {
  async function storeUserKey(ctx: ReturnType<typeof make>, kind: "org" | "user", org: string | null): Promise<void> {
    await ctx
      .credentialStore()
      .set(
        "default",
        makeCredentialRecord({ token: FAKE_TOKEN, kind, apiUrl: "https://whereamimentioned.com", org, expiresAt: null, now: FIXED_NOW }),
      );
  }

  it("requireOrg on a stored account-wide key with no org is the local no_org error, exit 2", async () => {
    const ctx = make();
    await storeUserKey(ctx, "user", null);
    const err = await ctx.requireOrg().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("no_org");
    expect((err as CliError).exitCode).toBe(2);
  });

  it("requireOrg returns the resolved org, and null on an org key with none", async () => {
    const flagged = make({ flags: { org: "acme" } });
    await storeUserKey(flagged, "user", null);
    expect(await flagged.requireOrg()).toBe("acme");
    const orgKey = make();
    await storeUserKey(orgKey, "org", "northwind");
    expect(await orgKey.requireOrg()).toBeNull();
  });

  it("the stored default org travels as X-Wam-Org when nothing higher supplies one", async () => {
    const { fetchImpl, calls } = stubFetch(json(200, {}));
    const ctx = make({ fetch: fetchImpl });
    await storeUserKey(ctx, "org", "northwind");
    await (await ctx.client()).me();
    expect(calls[0]!.headers["X-Wam-Org"]).toBe("northwind");
  });

  it("requireWorkspace is the no_workspace error when none resolved", () => {
    const ctx = make();
    expect(() => ctx.requireWorkspace()).toThrow(CliError);
    expect(make({ flags: { workspace: "acme-eu" } }).requireWorkspace()).toBe("acme-eu");
  });
});

describe("errorContext and mapError", () => {
  it("carries the credential kind, the expiry and the X-RateLimit-Limit of the failing response", async () => {
    const { fetchImpl } = stubFetch(
      json(
        429,
        { error: { code: "rate_limited", message: "slow down", requestId: REQUEST_ID, details: { retryAfterSeconds: 42 } } },
        { "Retry-After": "42", "X-RateLimit-Limit": "120" },
      ),
    );
    const ctx = make({ fetch: fetchImpl });
    await ctx
      .credentialStore()
      .set(
        "default",
        makeCredentialRecord({
          token: FAKE_TOKEN,
          kind: "org",
          apiUrl: "https://whereamimentioned.com",
          org: "acme",
          expiresAt: "2026-05-26T00:00:00.000Z",
          now: FIXED_NOW,
        }),
      );
    const client = await ctx.client();
    const err = await client.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const mapped = ctx.mapError(err, "scan run");
    expect(mapped.exitCode).toBe(5);
    expect(mapped.lines).toEqual([
      "Rate limited. Try again in 42 seconds.",
      `Limit: 120 requests per window for this key. (request ${REQUEST_ID})`,
    ]);
    const ec = ctx.errorContext();
    expect(ec.credential).toEqual({ kind: "org", org: "acme", expiresAt: "2026-05-26T00:00:00.000Z" });
    expect(ec.org).toBe("acme");
    expect(ec.now).toBe(FIXED_NOW);
  });
});
