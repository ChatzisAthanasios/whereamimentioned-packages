/**
 * `wam auth login` and `wam auth logout` (10-CLI sections 3.2 and 4, checkpoint 6, and the auth
 * row of section 14).
 *
 * Every test runs in process with a fake Context: an injected fetch that records each request
 * (method, URL, headers, body) and answers from a route table, a temp home, and a fake
 * `openBrowser` that immediately performs the callback request against the REAL loopback server
 * the command bound. Nothing here reaches the network beyond 127.0.0.1, and nothing spawns.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, get as httpGet, type Server } from "node:http";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meResponse, organizationSummary, page as pageOf } from "@whereamimentioned/api-client";
import { createContext, type Context, type GlobalFlags } from "../context";
import { CredentialStore, makeCredentialRecord } from "../credentials";
import { CliError } from "../errors";
import {
  FAKE_TOKEN,
  FIXED_NOW,
  fakePrimitives,
  fakeStdin,
  fakeStream,
  mkdirp,
  tempDir,
  type FakeStream,
  type TempDir,
} from "../test-support";
import {
  ACCOUNT_WIDE_WARNING,
  CONTINUE_QUESTION,
  LOGIN_CANCELLED,
  LOOPBACK_HOST,
  LOOPBACK_TIMEOUT_MS,
  TIMED_OUT_COPY,
  authorizeUrl,
  defaultLoginScopes,
  registerAuthLoginCommands,
  runLogin,
  runLogout,
  type LoginDeps,
} from "./auth-login";

const API_ORIGIN = "https://whereamimentioned.com";
const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EM_DASH = String.fromCharCode(0x2014);

/** Shaped like a real key, never a real one. Distinct from FAKE_TOKEN, which plays the OLD key. */
const MINTED_TOKEN = `wam_test_${"Qr7".repeat(14)}K`;
const MINTED_PREFIX = MINTED_TOKEN.slice(0, 17);
const MINTED_LAST4 = MINTED_TOKEN.slice(-4);
const MINTED_DISPLAY = `${MINTED_PREFIX}...${MINTED_LAST4}`;
const ONE_TIME_CODE = "one-time-code-9d2f1c7a";
const DEFAULT_SCOPES_CSV = "workspaces:read,scans:read,scans:write,reports:read,prompts:read,competitors:read";

const TOKEN_REPLY_ORG = {
  token: MINTED_TOKEN,
  prefix: MINTED_PREFIX,
  last4: MINTED_LAST4,
  kind: "org",
  org: "acme",
  expiresAt: "2026-12-09T12:00:00.000Z",
};
const TOKEN_REPLY_USER = { ...TOKEN_REPLY_ORG, kind: "user", org: null };

const ME = meResponse.parse({
  key: {
    id: "key_01",
    name: "MBP-16 CLI",
    prefix: MINTED_PREFIX,
    last4: MINTED_LAST4,
    kind: "org",
    env: "test",
    scopes: ["workspaces:read", "scans:read", "scans:write", "reports:read", "prompts:read", "competitors:read"],
    roleCeiling: "member",
    expiresAt: "2026-12-09T12:00:00.000Z",
  },
  org: { id: "org_acme", slug: "acme", name: "Acme Ltd", type: "brand" },
  actor: { userId: "user_1", role: "admin", effectiveRole: "member" },
  plan: { tier: "pro", label: "Pro", mcp: true, exportFormats: ["csv", "pdf"], promptsPerWorkspace: 150, maxScanPrompts: 6 },
  credits: { balance: 312, unit: "One credit is one prompt asked of one model once." },
});

const ORGANIZATIONS = pageOf(organizationSummary).parse({
  data: [
    { id: "org_acme", slug: "acme", name: "Acme Ltd", tier: "pro", effectiveRole: "member", workspaceCount: 3 },
    { id: "org_nw", slug: "northwind", name: "Northwind", tier: "single", effectiveRole: "viewer", workspaceCount: 1 },
    { id: "org_labs", slug: "acme-labs", name: "Acme Labs", tier: "free", effectiveRole: "member", workspaceCount: 0 },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
});

// --- The fake API -----------------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Wam-Api-Version": "1", "X-Request-Id": REQUEST_ID, ...headers },
  });
}

function envelope(
  status: number,
  code: string,
  message: string,
  extra: { details?: Record<string, unknown>; interval?: number; headers?: Record<string, string> } = {},
): Response {
  const body: Record<string, unknown> = {
    error: { code, message, requestId: REQUEST_ID, ...(extra.details ? { details: extra.details } : {}) },
  };
  if (extra.interval !== undefined) body.interval = extra.interval;
  return json(status, body, extra.headers);
}

const ORG_KEY_REFUSAL: Route = () =>
  envelope(403, "insufficient_scope", "This route requires an account-wide API key.", { details: { requiredKind: "user" } });

interface FakeApi {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  paths(): string[];
}

/** `METHOD /path` to a route, or to several served in order with the last one repeating. */
function fakeApi(routes: Record<string, Route | Route[]> = {}): FakeApi {
  const calls: Call[] = [];
  const served = new Map<string, number>();
  return {
    calls,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init?.method ?? "GET",
        url: url.href,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const route = routes[key];
      if (!route) return envelope(501, "internal_error", `no fake route for ${key}`);
      if (!Array.isArray(route)) return route(call);
      const n = served.get(key) ?? 0;
      served.set(key, n + 1);
      return route[Math.min(n, route.length - 1)]!(call);
    }) as typeof globalThis.fetch,
  };
}

// --- The fake browser and the server spy ----------------------------------------------------------------

function getPage(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

interface ServerSpy {
  createServer: LoginDeps["createServer"];
  servers: Server[];
  listens: unknown[][];
}

/** The real node:http server, with every `listen` call recorded. */
function serverSpy(): ServerSpy {
  const servers: Server[] = [];
  const listens: unknown[][] = [];
  return {
    servers,
    listens,
    createServer: (listener) => {
      const server = createServer(listener);
      const real = server.listen.bind(server) as (...args: unknown[]) => Server;
      (server as unknown as { listen: (...args: unknown[]) => Server }).listen = (...args: unknown[]) => {
        listens.push(args);
        return real(...args);
      };
      servers.push(server);
      return server;
    },
  };
}

interface Snapshot {
  stderr: string;
  stdout: string;
  calls: number;
  address: unknown;
}

interface FakeBrowser {
  open: (url: string) => Promise<void>;
  opened: URL[];
  pages: Array<{ status: number; body: string }>;
  snapshots: Snapshot[];
  /** Resolves once every callback request this browser started has been answered. */
  settled(): Promise<void>;
}

/**
 * Opens nothing. It reads the authorize URL the way the approval page would, and immediately
 * requests the loopback callback with whatever `answer` returns (null: the human never came back).
 */
function fakeBrowser(
  answer: (authorize: URL) => Record<string, string> | null,
  observe: () => Snapshot = () => ({ stderr: "", stdout: "", calls: 0, address: null }),
): FakeBrowser {
  const pending: Array<Promise<void>> = [];
  const browser: FakeBrowser = {
    opened: [],
    pages: [],
    snapshots: [],
    settled: async () => {
      await Promise.all(pending);
    },
    open: async (url) => {
      const authorize = new URL(url);
      browser.opened.push(authorize);
      browser.snapshots.push(observe());
      const params = answer(authorize);
      if (params === null) return;
      const redirect = authorize.searchParams.get("redirect_uri") ?? "";
      const target = `${redirect}?${new URLSearchParams(params).toString()}`;
      const request = getPage(target).then((p) => {
        browser.pages.push(p);
      });
      pending.push(request);
      await request;
    },
  };
  return browser;
}

const approve = (authorize: URL) => ({ code: ONE_TIME_CODE, state: authorize.searchParams.get("state") ?? "" });

// --- The harness ------------------------------------------------------------------------------------------

let tmp: TempDir;
let home: string;
let cwd: string;

beforeEach(() => {
  tmp = tempDir("wam-auth-");
  home = mkdirp(join(tmp.dir, "home"));
  cwd = mkdirp(join(tmp.dir, "repo"));
  mkdirp(join(cwd, ".git"));
});

afterEach(() => {
  tmp.cleanup();
});

interface Harness {
  ctx: Context;
  stdout: FakeStream;
  stderr: FakeStream;
  api: FakeApi;
  spy: ServerSpy;
  browser: FakeBrowser;
  deps: Partial<LoginDeps>;
  sleeps: number[];
}

function credentialsPath(): string {
  return join(home, ".config", "whereamimentioned", "credentials.json");
}

function storedProfiles(): Record<string, Record<string, unknown>> {
  if (!existsSync(credentialsPath())) return {};
  return (JSON.parse(readFileSync(credentialsPath(), "utf8")) as { profiles: Record<string, Record<string, unknown>> }).profiles;
}

async function storeCredential(token: string, kind: "org" | "user" | null, org: string | null): Promise<void> {
  const store = new CredentialStore({
    env: {},
    cwd,
    homedir: home,
    platform: "linux",
    keyring: async () => null,
    fileMode: () => 0o600,
  });
  await store.set("default", makeCredentialRecord({ token, kind, apiUrl: API_ORIGIN, org, expiresAt: null, now: FIXED_NOW }));
}

function harness(
  opts: {
    routes?: Record<string, Route | Route[]>;
    flags?: Partial<GlobalFlags>;
    env?: Record<string, string>;
    stdin?: string | null;
    tty?: { stdout: boolean; stdin: boolean };
    answer?: (authorize: URL) => Record<string, string> | null;
    deps?: Partial<LoginDeps>;
  } = {},
): Harness {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const api = fakeApi(opts.routes);
  const spy = serverSpy();
  const browser = fakeBrowser(opts.answer ?? approve, () => ({
    stderr: stderr.text,
    stdout: stdout.text,
    calls: api.calls.length,
    address: spy.servers[0]?.address() ?? null,
  }));
  const sleeps: number[] = [];
  const ctx = createContext({
    ...fakePrimitives({
      homedir: home,
      cwd,
      env: opts.env ?? {},
      stdout,
      stderr,
      stdin: fakeStdin(opts.stdin ?? null),
      isTTY: opts.tty ?? { stdout: false, stdin: false },
      fetch: api.fetch,
      openBrowser: browser.open,
      fileMode: () => 0o600,
    }),
    flags: opts.flags,
  });
  const deps: Partial<LoginDeps> = {
    createServer: spy.createServer,
    hostname: () => "MBP-16",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts.deps,
  };
  return { ctx, stdout, stderr, api, spy, browser, deps, sleeps };
}

async function failure(run: Promise<unknown>): Promise<CliError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error("expected the command to fail, and it resolved");
}

function expectNoSecret(h: Harness, ...secrets: string[]): void {
  for (const secret of [MINTED_TOKEN, FAKE_TOKEN, ONE_TIME_CODE, ...secrets]) {
    expect(h.stdout.text).not.toContain(secret);
    expect(h.stderr.text).not.toContain(secret);
  }
}

const ORG_ROUTES: Record<string, Route> = {
  "POST /api/cli/token": () => json(200, TOKEN_REPLY_ORG),
  "GET /api/v1/me": () => json(200, ME),
};

const USER_ROUTES: Record<string, Route> = {
  "POST /api/cli/token": () => json(200, TOKEN_REPLY_USER),
  "GET /api/v1/organizations": () => json(200, ORGANIZATIONS),
};

// --- Loopback ------------------------------------------------------------------------------------------------

describe("wam auth login, the loopback PKCE flow", () => {
  it("binds 127.0.0.1 on an ephemeral port, sends the exact authorize query, and exchanges the code with the matching verifier", async () => {
    const h = harness({ routes: ORG_ROUTES });
    await runLogin(h.ctx, {}, h.deps);
    await h.browser.settled();

    // The listen host is asserted, not assumed: loopback only, never 0.0.0.0, and port 0.
    expect(h.spy.listens).toHaveLength(1);
    expect(h.spy.listens[0]!.slice(0, 2)).toEqual([0, "127.0.0.1"]);
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    const bound = h.browser.snapshots[0]!.address as { address: string; port: number };
    expect(bound.address).toBe("127.0.0.1");

    const authorize = h.browser.opened[0]!;
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${API_ORIGIN}/cli/authorize`);
    expect([...authorize.searchParams.keys()]).toEqual([
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "state",
      "name",
      "scopes",
      "expires",
    ]);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${bound.port}/callback`);
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("name")).toBe("MBP-16 CLI");
    expect(authorize.searchParams.get("scopes")).toBe(DEFAULT_SCOPES_CSV);
    expect(authorize.searchParams.get("expires")).toBe("90");
    // Nothing sends `kind` without --account-wide, and no ceiling parameter exists at all.
    expect(authorize.searchParams.has("kind")).toBe(false);
    expect(authorize.href).not.toMatch(/ceiling|role/i);
    expect(authorize.href).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A");

    // One exchange, carrying the code the browser brought back and the verifier of THIS challenge,
    // computed exactly as app/api/cli/token/route.ts recomputes it.
    expect(h.api.paths()).toEqual(["POST /api/cli/token", "GET /api/v1/me"]);
    const exchange = h.api.calls[0]!;
    expect(exchange.url).toBe(`${API_ORIGIN}/api/cli/token`);
    const body = exchange.body as { code: string; code_verifier: string };
    expect(Object.keys(body).sort()).toEqual(["code", "code_verifier"]);
    expect(body.code).toBe(ONE_TIME_CODE);
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(body.code_verifier, "utf8").digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(exchange.headers.Authorization).toBeUndefined();
    expect(h.api.calls[1]!.headers.Authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(h.api.calls[1]!.headers["X-Wam-Org"]).toBeUndefined();

    // The callback served the small page, and the server is gone.
    expect(h.browser.pages).toHaveLength(1);
    expect(h.browser.pages[0]!.status).toBe(200);
    expect(h.browser.pages[0]!.body).toContain("You can close this tab");
    expect(h.browser.pages[0]!.body).not.toContain(ONE_TIME_CODE);
    expect(h.spy.servers[0]!.listening).toBe(false);

    expectNoSecret(h, body.code_verifier);
  });

  it("stores the record of section 4.5 and prints the summary of section 3.2", async () => {
    const h = harness({ routes: ORG_ROUTES });
    await runLogin(h.ctx, {}, h.deps);

    expect(storedProfiles().default).toEqual({
      token: MINTED_TOKEN,
      prefix: MINTED_PREFIX,
      last4: MINTED_LAST4,
      kind: "org",
      apiUrl: API_ORIGIN,
      org: "acme",
      expiresAt: "2026-12-09T12:00:00.000Z",
      createdAt: FIXED_NOW.toISOString(),
    });

    expect(h.stdout.text.split("\n")).toEqual([
      "Signed in.",
      "  Key kind      Organization key, bound to acme",
      "  Organization  Acme Ltd (acme)",
      "  Role          admin, capped to member by this key",
      `  Key           ${MINTED_DISPLAY}  "MBP-16 CLI"`,
      "  Scopes        workspaces:read, scans:read, scans:write, reports:read, prompts:read,",
      "                competitors:read",
      "  Expires       2026-12-09",
      `  Stored in     credentials.json (${credentialsPath()})`,
      "",
    ]);
    const bound = h.browser.opened[0]!.searchParams.get("redirect_uri");
    expect(h.stderr.text).toContain(`Opening ${API_ORIGIN}/cli/authorize in your browser.`);
    expect(h.stderr.text).toContain("If it did not open, paste this URL:");
    expect(h.stderr.text).toContain(`  ${h.browser.opened[0]!.href.split("?")[0]}?code_challenge=`);
    expect(h.stderr.text).toContain("Waiting for approval...");
    expect(h.stderr.text).toContain("Set a default workspace with:  wam workspace use acme/<workspace>");
    expect(bound).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expectNoSecret(h);
  });

  it("--json prints exactly one document in the section 3.2 shape, with no invented field", async () => {
    const h = harness({ routes: ORG_ROUTES, flags: { json: true } });
    await runLogin(h.ctx, {}, h.deps);

    expect(h.stdout.text.trim().split("\n")).toHaveLength(1);
    const doc = JSON.parse(h.stdout.text);
    expect(Object.keys(doc)).toEqual(["ok", "org", "actor", "key", "storage"]);
    expect(doc).toEqual({
      ok: true,
      org: { slug: "acme", name: "Acme Ltd" },
      actor: ME.actor,
      key: {
        prefix: MINTED_PREFIX,
        last4: MINTED_LAST4,
        name: "MBP-16 CLI",
        kind: "org",
        scopes: ME.key.scopes,
        expiresAt: "2026-12-09T12:00:00.000Z",
      },
      storage: "file",
    });
    expect(doc.actor.email).toBeUndefined();
    expectNoSecret(h);
  });

  it("a state that does not match aborts with exit 3, before any request and with nothing stored", async () => {
    const h = harness({ routes: ORG_ROUTES, answer: () => ({ code: ONE_TIME_CODE, state: "not-the-state-this-cli-sent" }) });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    await h.browser.settled();

    expect(err.exitCode).toBe(3);
    expect(err.lines[0]).toBe("The sign-in callback did not carry the state this CLI sent, so it was rejected.");
    expect(h.browser.pages[0]!.status).toBe(400);
    expect(h.api.calls).toHaveLength(0);
    expect(storedProfiles()).toEqual({});
    expect(h.spy.servers[0]!.listening).toBe(false);
  });

  it("a callback with no state at all is rejected the same way", async () => {
    const h = harness({ routes: ORG_ROUTES, answer: () => ({ code: ONE_TIME_CODE }) });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    expect(err.exitCode).toBe(3);
    expect(h.api.calls).toHaveLength(0);
  });

  it("Deny in the browser is exit 3, names the role requirement, and exchanges nothing", async () => {
    const h = harness({
      routes: ORG_ROUTES,
      answer: (authorize) => ({ error: "access_denied", state: authorize.searchParams.get("state") ?? "" }),
    });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    await h.browser.settled();

    expect(err.exitCode).toBe(3);
    expect(err.lines.join("\n")).toContain("denied");
    expect(err.lines.join("\n")).toContain("member role or higher");
    expect(h.browser.pages[0]!.body).toContain("Sign-in denied");
    expect(h.api.calls).toHaveLength(0);
    expect(storedProfiles()).toEqual({});
  });

  it("no callback within the timeout is exit 3 with the exact copy, and the server is shut down", async () => {
    expect(LOOPBACK_TIMEOUT_MS).toBe(300_000);
    const h = harness({ routes: ORG_ROUTES, answer: () => null, deps: { loopbackTimeoutMs: 40 } });
    const err = await failure(runLogin(h.ctx, {}, h.deps));

    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("timed_out");
    expect(err.lines).toEqual(["Sign-in timed out. Run wam auth login again, or use wam auth login --token."]);
    expect(TIMED_OUT_COPY).toBe(err.lines[0]);
    expect(h.api.calls).toHaveLength(0);
    expect(h.spy.servers[0]!.listening).toBe(false);
  });

  it("--no-browser prints the URL and opens nothing", async () => {
    const h = harness({ routes: ORG_ROUTES, answer: () => null, deps: { loopbackTimeoutMs: 40 } });
    await failure(runLogin(h.ctx, { browser: false }, h.deps));
    expect(h.browser.opened).toHaveLength(0);
    expect(h.stderr.text).toContain("Open this URL in your browser to sign in:");
    expect(h.stderr.text).toContain(`  ${API_ORIGIN}/cli/authorize?code_challenge=`);
    expect(h.stderr.text).not.toContain("Opening ");
  });

  it("a code the server refuses is exit 3 with its message and the request id, and nothing is stored", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/token": () =>
          envelope(400, "invalid_grant", "The code verifier does not match this sign-in. Run wam auth login again."),
      },
    });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    expect(err.exitCode).toBe(3);
    expect(err.lines).toEqual([
      `The code verifier does not match this sign-in. Run wam auth login again. (request ${REQUEST_ID})`,
    ]);
    // The route's own codes never reach a --json error object (section 6.2).
    expect(err.toJsonObject().error.code).toBe("unauthorized");
    expect(h.api.paths()).toEqual(["POST /api/cli/token"]);
    expect(storedProfiles()).toEqual({});
  });

  it("a 429 on the exchange is exit 5 and is never retried", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/token": () =>
          envelope(429, "rate_limited", "Too many sign-in attempts. Retry after 30 seconds.", {
            headers: { "Retry-After": "30", "X-RateLimit-Limit": "30" },
          }),
      },
    });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    expect(err.exitCode).toBe(5);
    expect(err.lines[0]).toBe("Rate limited. Try again in 30 seconds.");
    expect(err.lines[1]).toBe(`Limit: 30 requests per window for this key. (request ${REQUEST_ID})`);
    expect(h.api.paths()).toEqual(["POST /api/cli/token"]);
  });

  it("a token reply the CLI cannot read fails closed and never echoes the body", async () => {
    const h = harness({ routes: { "POST /api/cli/token": () => json(200, { token: MINTED_TOKEN, kind: "superuser" }) } });
    const err = await failure(runLogin(h.ctx, {}, h.deps));
    expect(err.exitCode).toBe(1);
    expect(err.lines.join("\n")).not.toContain(MINTED_TOKEN);
    expect(storedProfiles()).toEqual({});
  });

  it("when the key's details cannot be read, the key is still stored and the command still succeeds", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/token": () => json(200, TOKEN_REPLY_ORG),
        "GET /api/v1/me": () =>
          envelope(403, "feature_not_available", "The API is available on paid plans.", {
            details: { tier: "free", billingUrl: `${API_ORIGIN}/acme/billing` },
          }),
      },
    });
    await runLogin(h.ctx, {}, h.deps);

    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
    expect(h.stderr.text).toContain("Signed in and stored the key, but could not read its details from the API:");
    expect(h.stderr.text).toContain(`Choose a plan: ${API_ORIGIN}/acme/billing`);
    expect(h.stdout.text).toContain("  Key kind      Organization key, bound to acme");
    expect(h.stdout.text).toContain(`  Key           ${MINTED_DISPLAY}  "MBP-16 CLI"`);
    expect(h.stdout.text).not.toContain("  Role ");
    expectNoSecret(h);
  });

  it("says so when the profile already holds a key, and replaces it only locally", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({ routes: ORG_ROUTES });
    await runLogin(h.ctx, {}, h.deps);
    expect(h.stderr.text).toContain(`Profile "default" already holds ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)}.`);
    expect(h.api.paths()).toEqual(["POST /api/cli/token", "GET /api/v1/me"]);
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
    expectNoSecret(h);
  });
});

// --- Flag validation ---------------------------------------------------------------------------------------------

describe("wam auth login, flags refused locally", () => {
  it("--scopes orgs:write without --account-wide exits 2, opens no browser, binds no port and sends nothing", async () => {
    const h = harness({ routes: ORG_ROUTES });
    const err = await failure(runLogin(h.ctx, { scopes: "orgs:write,workspaces:read" }, h.deps));

    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("usage_error");
    expect(err.lines).toEqual([
      "The orgs:write scope can only be carried by an account-wide key.",
      "Add --account-wide: wam auth login --account-wide --scopes orgs:write,workspaces:read",
    ]);
    expect(h.browser.opened).toHaveLength(0);
    expect(h.spy.servers).toHaveLength(0);
    expect(h.api.calls).toHaveLength(0);
  });

  it("the same refusal holds on the device flow", async () => {
    const h = harness();
    const err = await failure(runLogin(h.ctx, { device: true, scopes: "orgs:write" }, h.deps));
    expect(err.exitCode).toBe(2);
    expect(h.api.calls).toHaveLength(0);
  });

  it("an unknown scope, an empty list, a bad expiry and an over-long name are all exit 2 with no side effect", async () => {
    const cases: Array<[Parameters<typeof runLogin>[1], string]> = [
      [{ scopes: "scans:read,scans:delete" }, "--scopes has an unknown scope: scans:delete."],
      [{ scopes: " , " }, "--scopes needs at least one scope."],
      [{ expires: "45" }, "--expires must be one of: 30, 90, 365, never."],
      [{ name: "x".repeat(65) }, "--name must be 1 to 64 characters."],
      [{ name: "   " }, "--name must be 1 to 64 characters."],
    ];
    for (const [opts, firstLine] of cases) {
      const h = harness({ routes: ORG_ROUTES });
      const err = await failure(runLogin(h.ctx, opts, h.deps));
      expect(err.exitCode).toBe(2);
      expect(err.lines[0]).toBe(firstLine);
      expect(h.browser.opened).toHaveLength(0);
      expect(h.spy.servers).toHaveLength(0);
      expect(h.api.calls).toHaveLength(0);
    }
  });

  it("the default scopes are READ_ONLY_SCOPES plus scans:write, and never orgs:write", () => {
    expect(defaultLoginScopes().join(",")).toBe(DEFAULT_SCOPES_CSV);
  });

  it("--device together with --token is a usage error", async () => {
    const h = harness();
    const err = await failure(runLogin(h.ctx, { device: true, token: true }, h.deps));
    expect(err.exitCode).toBe(2);
    expect(h.api.calls).toHaveLength(0);
  });

  it("--expires 0 is the alias of never, which asks first and cannot ask here without --yes", async () => {
    const h = harness({ routes: ORG_ROUTES });
    const err = await failure(runLogin(h.ctx, { expires: "0" }, h.deps));
    expect(err.exitCode).toBe(2);
    expect(err.lines[0]).toBe("This asks for a key that never expires and cannot prompt for confirmation here.");
    expect(h.browser.opened).toHaveLength(0);

    const yes = harness({ routes: ORG_ROUTES, flags: { yes: true } });
    await runLogin(yes.ctx, { expires: "0" }, yes.deps);
    expect(yes.browser.opened[0]!.searchParams.get("expires")).toBe("never");
    expect(yes.browser.snapshots[0]!.stderr).toContain("This asks for a key that never expires.");
  });

  it("the requested name, scopes and expiry travel on the URL as given", () => {
    const url = new URL(
      authorizeUrl(API_ORIGIN, {
        challenge: "c".repeat(43),
        redirectUri: "http://127.0.0.1:51234/callback",
        state: "s".repeat(43),
        request: { name: "CI & staging box", scopes: ["scans:read", "reports:read"], expires: "365", accountWide: false },
      }),
    );
    expect(url.searchParams.get("name")).toBe("CI & staging box");
    expect(url.searchParams.get("scopes")).toBe("scans:read,reports:read");
    expect(url.searchParams.get("expires")).toBe("365");
    expect(url.search).toContain("name=CI%20%26%20staging%20box");
    expect(url.search).toContain("scopes=scans%3Aread%2Creports%3Aread");
  });
});

// --- --account-wide -------------------------------------------------------------------------------------------------

describe("wam auth login --account-wide", () => {
  it("sends kind=user on the authorize URL, and nothing sends it without the flag", async () => {
    const wide = harness({ routes: USER_ROUTES, flags: { yes: true } });
    await runLogin(wide.ctx, { accountWide: true }, wide.deps);
    expect(wide.browser.opened[0]!.searchParams.get("kind")).toBe("user");
    expect([...wide.browser.opened[0]!.searchParams.keys()].pop()).toBe("kind");

    const narrow = harness({ routes: ORG_ROUTES, flags: { yes: true } });
    await runLogin(narrow.ctx, {}, narrow.deps);
    expect(narrow.browser.opened[0]!.searchParams.has("kind")).toBe(false);
    for (const call of narrow.api.calls) expect(JSON.stringify(call.body ?? {})).not.toContain("kind");
  });

  it("prints the warning BEFORE the browser opens, makes zero requests while it holds no credential, and lists the organizations only AFTER the mint", async () => {
    const h = harness({ routes: USER_ROUTES, flags: { yes: true } });
    await runLogin(h.ctx, { accountWide: true, scopes: "orgs:write,workspaces:read" }, h.deps);

    // At the moment the browser opened: the whole warning was already on stderr, no request had
    // been made, and no organization had been named.
    const atOpen = h.browser.snapshots[0]!;
    expect(atOpen.calls).toBe(0);
    for (const line of ACCOUNT_WIDE_WARNING) expect(atOpen.stderr).toContain(line);
    expect(atOpen.stderr.indexOf("This mints an account-wide key.")).toBeLessThan(atOpen.stderr.indexOf("Opening "));
    expect(atOpen.stdout).toBe("");
    expect(`${atOpen.stderr}${atOpen.stdout}`).not.toContain("Acme Ltd");

    // The first request is the exchange, and the organization list comes after it, authenticated.
    expect(h.api.paths()).toEqual(["POST /api/cli/token", "GET /api/v1/organizations"]);
    expect(h.api.calls[0]!.headers.Authorization).toBeUndefined();
    expect(h.api.calls[1]!.headers.Authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(h.api.calls[1]!.headers["X-Wam-Org"]).toBeUndefined();
    // GET /api/v1/me is never sent: it would need an organization nobody picked.
    expect(h.api.calls.some((c) => c.path === "/api/v1/me")).toBe(false);

    expect(h.stdout.text.split("\n")).toEqual([
      "Signed in.",
      "  Key kind      Account-wide key, reaches 3 organizations",
      "  Organizations Acme Ltd (acme)        acts as member",
      "                Northwind (northwind)  acts as viewer",
      "                Acme Labs (acme-labs)  acts as member",
      `  Key           ${MINTED_DISPLAY}  "MBP-16 CLI"`,
      "  Scopes        orgs:write, workspaces:read",
      "  Expires       2026-12-09",
      `  Stored in     credentials.json (${credentialsPath()})`,
      "",
    ]);
    expect(h.stderr.text).toContain("Pick an organization for this shell:  wam config set org acme");
    expect(storedProfiles().default).toMatchObject({ kind: "user", org: null, token: MINTED_TOKEN });
    expectNoSecret(h);
  });

  it("--json carries the organizations verbatim, and neither org nor actor", async () => {
    const h = harness({ routes: USER_ROUTES, flags: { json: true, yes: true } });
    await runLogin(h.ctx, { accountWide: true }, h.deps);
    const doc = JSON.parse(h.stdout.text);
    expect(Object.keys(doc)).toEqual(["ok", "key", "organizations", "storage"]);
    expect(doc.organizations).toEqual(ORGANIZATIONS.data);
    expect(doc.key.kind).toBe("user");
    expectNoSecret(h);
  });

  it("asks Continue? (y/N) at a terminal, and y proceeds", async () => {
    const h = harness({ routes: USER_ROUTES, tty: { stdout: true, stdin: false }, stdin: "y\n" });
    await runLogin(h.ctx, { accountWide: true }, h.deps);
    expect(h.stderr.text).toContain(CONTINUE_QUESTION);
    expect(h.browser.opened).toHaveLength(1);
    expect(h.stderr.text.indexOf(CONTINUE_QUESTION)).toBeLessThan(h.stderr.text.indexOf("Opening "));
  });

  it("anything but yes cancels: no browser, no port, no request, nothing stored", async () => {
    for (const answer of ["n\n", "\n", null]) {
      const h = harness({ routes: USER_ROUTES, tty: { stdout: true, stdin: false }, stdin: answer });
      await runLogin(h.ctx, { accountWide: true }, h.deps);
      expect(h.stderr.text).toContain(LOGIN_CANCELLED);
      expect(h.browser.opened).toHaveLength(0);
      expect(h.spy.servers).toHaveLength(0);
      expect(h.api.calls).toHaveLength(0);
      expect(storedProfiles()).toEqual({});
    }
  });

  it("cannot prompt when it is not interactive, so it exits 2 naming --yes and does nothing", async () => {
    const h = harness({ routes: USER_ROUTES });
    const err = await failure(runLogin(h.ctx, { accountWide: true }, h.deps));
    expect(err.exitCode).toBe(2);
    expect(err.lines).toEqual([
      "This asks for an account-wide key and cannot prompt for confirmation here.",
      "Pass --yes to confirm, or run it in an interactive terminal.",
    ]);
    expect(h.browser.opened).toHaveLength(0);
    expect(h.api.calls).toHaveLength(0);
  });
});

// --- --device ------------------------------------------------------------------------------------------------------------

const DEVICE_START = {
  device_code: "dc_5f0c9e3b7a",
  user_code: "BQDX-7F2M",
  verification_uri: `${API_ORIGIN}/cli/device`,
  verification_uri_complete: `${API_ORIGIN}/cli/device?code=BQDX-7F2M`,
  expires_in: 600,
  interval: 5,
};

const pendingReply: Route = () => envelope(400, "authorization_pending", "Waiting for approval in the browser.");
const slowDownReply: Route = () =>
  envelope(400, "slow_down", "Polling too fast. Wait 10 seconds between polls.", { details: { interval: 10 }, interval: 10 });

describe("wam auth login --device", () => {
  it("honours interval and slow_down, and stores the key the approved poll returns", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, DEVICE_START),
        "POST /api/cli/device/token": [pendingReply, slowDownReply, pendingReply, slowDownReply, () => json(200, TOKEN_REPLY_ORG)],
        "GET /api/v1/me": () => json(200, ME),
      },
    });
    await runLogin(h.ctx, { device: true, name: "build box", expires: "30" }, h.deps);

    // 5 s as advertised, then +5 s after each slow_down, for that poll and every one after it.
    expect(h.sleeps).toEqual([5000, 5000, 10000, 10000, 15000]);
    expect(h.api.paths()).toEqual([
      "POST /api/cli/device/start",
      "POST /api/cli/device/token",
      "POST /api/cli/device/token",
      "POST /api/cli/device/token",
      "POST /api/cli/device/token",
      "POST /api/cli/device/token",
      "GET /api/v1/me",
    ]);
    // The start body is a request: name, scopes, expires, and no kind without --account-wide.
    expect(h.api.calls[0]!.body).toEqual({
      name: "build box",
      scopes: DEFAULT_SCOPES_CSV.split(","),
      expires: "30",
    });
    for (const poll of h.api.calls.slice(1, 6)) expect(poll.body).toEqual({ device_code: DEVICE_START.device_code });

    expect(h.stderr.text).toContain(
      [`To sign in, open  ${API_ORIGIN}/cli/device`, "and enter the code:", "", "    BQDX-7F2M", "", "Waiting (expires in 10 minutes)..."].join("\n"),
    );
    expect(h.browser.opened).toHaveLength(0);
    expect(h.spy.servers).toHaveLength(0);
    expect(storedProfiles().default).toMatchObject({ token: MINTED_TOKEN, kind: "org", org: "acme" });
    expect(h.stdout.text).toContain("Signed in.");
    expectNoSecret(h, DEVICE_START.device_code);
  });

  it("--account-wide carries kind: user in the start body, after the warning", async () => {
    const h = harness({
      flags: { yes: true },
      routes: {
        "POST /api/cli/device/start": (call) => {
          expect(h.stderr.text).toContain("This mints an account-wide key.");
          expect(call.body).toMatchObject({ kind: "user" });
          return json(200, DEVICE_START);
        },
        "POST /api/cli/device/token": () => json(200, TOKEN_REPLY_USER),
        "GET /api/v1/organizations": () => json(200, ORGANIZATIONS),
      },
    });
    await runLogin(h.ctx, { device: true, accountWide: true }, h.deps);
    expect(h.api.paths()).toEqual(["POST /api/cli/device/start", "POST /api/cli/device/token", "GET /api/v1/organizations"]);
    expect(storedProfiles().default).toMatchObject({ kind: "user", org: null });
  });

  it("expiry and denial are both exit 3", async () => {
    const expired = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, DEVICE_START),
        "POST /api/cli/device/token": [pendingReply, () => envelope(400, "expired_token", "The device code has expired.")],
      },
    });
    const e1 = await failure(runLogin(expired.ctx, { device: true }, expired.deps));
    expect(e1.exitCode).toBe(3);
    expect(e1.lines[0]).toBe("The sign-in code expired before it was approved.");

    const denied = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, DEVICE_START),
        "POST /api/cli/device/token": () => envelope(400, "access_denied", "The sign-in was denied."),
      },
    });
    const e2 = await failure(runLogin(denied.ctx, { device: true }, denied.deps));
    expect(e2.exitCode).toBe(3);
    expect(e2.lines.join("\n")).toContain("member role or higher");
    expect(storedProfiles()).toEqual({});
  });

  it("stops on its own once the advertised lifetime has been waited out", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, { ...DEVICE_START, expires_in: 12 }),
        "POST /api/cli/device/token": pendingReply,
      },
    });
    const err = await failure(runLogin(h.ctx, { device: true }, h.deps));
    expect(err.exitCode).toBe(3);
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
  });

  it("a real 429 on the poll is exit 5 and ends the loop: the poll is a long poll, not a retry", async () => {
    const h = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, DEVICE_START),
        "POST /api/cli/device/token": [
          pendingReply,
          () => envelope(429, "rate_limited", "Too many sign-in attempts.", { headers: { "Retry-After": "12" } }),
        ],
      },
    });
    const err = await failure(runLogin(h.ctx, { device: true }, h.deps));
    expect(err.exitCode).toBe(5);
    expect(h.api.paths().filter((p) => p === "POST /api/cli/device/token")).toHaveLength(2);
  });
});

// --- --token ---------------------------------------------------------------------------------------------------------------

describe("wam auth login --token", () => {
  it("reads the key from stdin, verifies it against the API, and only then stores it", async () => {
    const h = harness({
      stdin: `\n  ${MINTED_TOKEN}  \n`,
      routes: {
        "GET /api/v1/organizations": (call) => {
          // Not stored yet: a key the server has not accepted never reaches the store.
          expect(storedProfiles()).toEqual({});
          expect(call.headers.Authorization).toBe(`Bearer ${MINTED_TOKEN}`);
          return ORG_KEY_REFUSAL(call);
        },
        "GET /api/v1/me": () => json(200, ME),
      },
    });
    await runLogin(h.ctx, { token: true }, h.deps);

    expect(h.api.paths()).toEqual(["GET /api/v1/organizations", "GET /api/v1/me"]);
    expect(h.browser.opened).toHaveLength(0);
    expect(h.spy.servers).toHaveLength(0);
    expect(storedProfiles().default).toMatchObject({
      token: MINTED_TOKEN,
      prefix: MINTED_PREFIX,
      last4: MINTED_LAST4,
      kind: "org",
      org: "acme",
      expiresAt: "2026-12-09T12:00:00.000Z",
    });
    expect(h.stdout.text).toContain("  Key kind      Organization key, bound to acme");
    expect(h.stdout.text).toContain(`  Key           ${MINTED_DISPLAY}  "MBP-16 CLI"`);
    expectNoSecret(h);
  });

  it("learns that a pasted key is account-wide from the organization list, and invents no expiry for it", async () => {
    const h = harness({ stdin: `${MINTED_TOKEN}\n`, routes: { "GET /api/v1/organizations": () => json(200, ORGANIZATIONS) } });
    await runLogin(h.ctx, { token: true }, h.deps);

    expect(h.api.paths()).toEqual(["GET /api/v1/organizations"]);
    expect(storedProfiles().default).toMatchObject({ token: MINTED_TOKEN, kind: "user", org: null });
    expect(h.stdout.text).toContain("  Key kind      Account-wide key, reaches 3 organizations");
    expect(h.stdout.text).not.toContain("  Expires ");
    expect(h.stdout.text).not.toContain("  Scopes ");
    expectNoSecret(h);
  });

  it("a key the server does not accept is exit 3 and is not stored", async () => {
    const h = harness({
      stdin: `${MINTED_TOKEN}\n`,
      routes: { "GET /api/v1/organizations": () => envelope(401, "unauthorized", "Missing or invalid API key.") },
    });
    const err = await failure(runLogin(h.ctx, { token: true }, h.deps));
    expect(err.exitCode).toBe(3);
    expect(err.lines[0]).toBe("This API key is no longer valid.");
    expect(storedProfiles()).toEqual({});
    expect(err.lines.join("\n")).not.toContain(MINTED_TOKEN);
  });

  it("takes the key from the flag's value when one was given, by either route commander delivers it", async () => {
    const asOption = harness({ routes: { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) } });
    await runLogin(asOption.ctx, { token: MINTED_TOKEN }, asOption.deps);
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);

    const asGlobal = harness({
      flags: { token: MINTED_TOKEN, profile: "work" },
      routes: { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) },
    });
    await runLogin(asGlobal.ctx, {}, asGlobal.deps);
    expect(storedProfiles().work!.token).toBe(MINTED_TOKEN);
    expectNoSecret(asGlobal);
  });

  it("an empty stdin is exit 2, and so is a terminal it may not prompt at", async () => {
    const empty = harness({ stdin: "\n\n" });
    expect((await failure(runLogin(empty.ctx, { token: true }, empty.deps))).exitCode).toBe(2);
    expect(empty.api.calls).toHaveLength(0);

    const noPrompt = harness({ tty: { stdout: false, stdin: true } });
    const err = await failure(runLogin(noPrompt.ctx, { token: true }, noPrompt.deps));
    expect(err.exitCode).toBe(2);
    expect(err.lines[0]).toBe("wam auth login --token reads the key from stdin and cannot prompt for it here.");
  });

  it("prompts for the key at an interactive terminal", async () => {
    const asked: string[] = [];
    const h = harness({
      tty: { stdout: true, stdin: true },
      routes: { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) },
      deps: {
        promptSecret: async (message) => {
          asked.push(message);
          return MINTED_TOKEN;
        },
      },
    });
    await runLogin(h.ctx, { token: true }, h.deps);
    expect(asked).toEqual(["Paste your API key"]);
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
  });

  it("refuses the mint flags, which do not apply to a key that already exists", async () => {
    const h = harness({ stdin: `${MINTED_TOKEN}\n` });
    const err = await failure(runLogin(h.ctx, { token: true, accountWide: true }, h.deps));
    expect(err.exitCode).toBe(2);
    expect(h.api.calls).toHaveLength(0);
  });
});

// --- logout -------------------------------------------------------------------------------------------------------------------

describe("wam auth logout", () => {
  it("revokes on the server BEFORE it clears local state, and prints the locally held prefix", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const seen: Array<Record<string, unknown> | undefined> = [];
    const h = harness({
      flags: { org: "acme" },
      routes: {
        "DELETE /api/v1/keys/self": () => {
          // The credential is still in the store at the moment the revoke request is made.
          seen.push(storedProfiles().default);
          return json(200, { revoked: 1, self: true });
        },
      },
    });
    await runLogout(h.ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(FAKE_TOKEN);
    expect(storedProfiles()).toEqual({});

    expect(h.api.calls).toHaveLength(1);
    const call = h.api.calls[0]!;
    expect(`${call.method} ${call.path}`).toBe("DELETE /api/v1/keys/self");
    expect(call.query).toEqual({});
    expect(call.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // The route resolves no organization, so the header is suppressed even with --org set.
    expect(call.headers["X-Wam-Org"]).toBeUndefined();

    expect(h.stdout.text).toBe("");
    expect(h.stderr.lines()).toEqual([
      `Revoked ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)} on the server.`,
      "Cleared the local credential (credentials.json).",
    ]);
    expectNoSecret(h);
  });

  it("--all sends exactly ?all=cli and prints the count the server returned", async () => {
    await storeCredential(FAKE_TOKEN, "user", null);
    const h = harness({ routes: { "DELETE /api/v1/keys/self": () => json(200, { revoked: 3, self: true, scope: "cli" }) } });
    await runLogout(h.ctx, { all: true });
    expect(h.api.calls[0]!.query).toEqual({ all: "cli" });
    expect(h.stderr.lines()[0]).toBe(
      `Revoked 3 keys on the server, ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)} among them.`,
    );
    expect(storedProfiles()).toEqual({});
  });

  it("--json is one document with the server's body verbatim", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({
      flags: { json: true },
      routes: { "DELETE /api/v1/keys/self": () => json(200, { revoked: 1, self: true }) },
    });
    await runLogout(h.ctx);
    expect(JSON.parse(h.stdout.text)).toEqual({
      ok: true,
      key: `${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)}`,
      server: { revoked: 1, self: true },
      cleared: "file",
    });
    expectNoSecret(h);
  });

  it("a failed revoke still clears the local credential, warns, and exits 1", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({ routes: { "DELETE /api/v1/keys/self": () => envelope(500, "internal_error", "boom") } });
    const err = await failure(runLogout(h.ctx));

    expect(err.exitCode).toBe(1);
    expect(err.lines[0]).toBe(
      `Could not revoke ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)} on the server, so that key may still be live.`,
    );
    expect(err.lines[err.lines.length - 1]).toBe("Cleared the local credential (credentials.json) anyway.");
    expect(err.requestId).toBe(REQUEST_ID);
    // A DELETE is never retried.
    expect(h.api.calls).toHaveLength(1);
    expect(storedProfiles()).toEqual({});
  });

  it("a key the server no longer accepts is still exit 1, with copy that does not claim it is live", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({ routes: { "DELETE /api/v1/keys/self": () => envelope(401, "unauthorized", "Missing or invalid API key.") } });
    const err = await failure(runLogout(h.ctx));
    expect(err.exitCode).toBe(1);
    expect(err.lines[0]).toContain("so this command revoked nothing there.");
    expect(storedProfiles()).toEqual({});
  });

  it("with no credential it is exit 3 and sends nothing", async () => {
    const h = harness();
    const err = await failure(runLogout(h.ctx));
    expect(err.exitCode).toBe(3);
    expect(err.lines[0]).toBe("Not signed in.");
    expect(h.api.calls).toHaveLength(0);
  });

  it("revokes a WAM_TOKEN key without touching a different stored key, and says so", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({
      env: { WAM_TOKEN: MINTED_TOKEN },
      routes: { "DELETE /api/v1/keys/self": () => json(200, { revoked: 1, self: true }) },
    });
    await runLogout(h.ctx);
    expect(h.api.calls[0]!.headers.Authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(storedProfiles().default!.token).toBe(FAKE_TOKEN);
    expect(h.stderr.text).toContain("is a different key and was left in place.");
    expect(h.stderr.text).toContain("WAM_TOKEN is still set in this environment and no longer works. Unset it.");
    expectNoSecret(h);
  });
});

// --- Registration on an existing `auth` group --------------------------------------------------------------------------------------

function programFor(h: Harness, configure: (program: Command) => void = () => {}): { program: Command; help: string[] } {
  const help: string[] = [];
  const program = new Command("wam").exitOverride();
  program.configureOutput({ writeOut: (s) => help.push(s), writeErr: () => {}, outputError: () => {} });
  configure(program);
  const auth = program.command("auth");
  registerAuthLoginCommands(auth, () => h.ctx, h.deps);
  return { program, help };
}

describe("registerAuthLoginCommands", () => {
  it("adds login and logout to the group it is given, and to nothing else", () => {
    const h = harness();
    const { program } = programFor(h);
    const auth = program.commands.find((c) => c.name() === "auth")!;
    expect(auth.commands.map((c) => c.name())).toEqual(["login", "logout"]);
    expect(program.commands.map((c) => c.name())).toEqual(["auth"]);
    const login = auth.commands[0]!;
    expect(login.options.map((o) => o.long)).toEqual([
      "--device",
      "--token",
      "--account-wide",
      "--name",
      "--scopes",
      "--expires",
      "--no-browser",
    ]);
  });

  it("runs the loopback flow with the parsed flags", async () => {
    const h = harness({ routes: USER_ROUTES, flags: { yes: true } });
    const { program } = programFor(h);
    await program.parseAsync(
      ["auth", "login", "--account-wide", "--name", "laptop", "--scopes", "orgs:write,scans:read", "--expires", "365"],
      { from: "user" },
    );
    const q = h.browser.opened[0]!.searchParams;
    expect(q.get("name")).toBe("laptop");
    expect(q.get("scopes")).toBe("orgs:write,scans:read");
    expect(q.get("expires")).toBe("365");
    expect(q.get("kind")).toBe("user");
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
  });

  it("refuses orgs:write without --account-wide through the parser too, opening no browser", async () => {
    const h = harness({ routes: ORG_ROUTES });
    const { program } = programFor(h);
    const err = await failure(program.parseAsync(["auth", "login", "--scopes", "orgs:write"], { from: "user" }));
    expect(err.exitCode).toBe(2);
    expect(h.browser.opened).toHaveLength(0);
    expect(h.api.calls).toHaveLength(0);
  });

  it("--no-browser and --device reach the action", async () => {
    const quiet = harness({ routes: ORG_ROUTES, answer: () => null, deps: { loopbackTimeoutMs: 40 } });
    await failure(programFor(quiet).program.parseAsync(["auth", "login", "--no-browser"], { from: "user" }));
    expect(quiet.browser.opened).toHaveLength(0);
    expect(quiet.stderr.text).toContain("Open this URL in your browser to sign in:");

    const device = harness({
      routes: {
        "POST /api/cli/device/start": () => json(200, DEVICE_START),
        "POST /api/cli/device/token": () => json(200, TOKEN_REPLY_ORG),
        "GET /api/v1/me": () => json(200, ME),
      },
    });
    await programFor(device).program.parseAsync(["auth", "login", "--device"], { from: "user" });
    expect(device.api.paths()[0]).toBe("POST /api/cli/device/start");
  });

  it("the bare --token flag reads stdin", async () => {
    const h = harness({
      stdin: `${MINTED_TOKEN}\n`,
      routes: { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) },
    });
    await programFor(h).program.parseAsync(["auth", "login", "--token"], { from: "user" });
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
    expect(h.browser.opened).toHaveLength(0);
  });

  it("under a program-level --token [token], as in the assembled CLI, both the bare flag and a value still work", async () => {
    const withGlobal = (program: Command) => {
      program.option("--token [token]", "Override the credential").option("--json", "JSON output");
    };
    const routes = { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) };

    const bare = harness({ stdin: `${MINTED_TOKEN}\n`, routes });
    await programFor(bare, withGlobal).program.parseAsync(["auth", "login", "--token", "--json"], { from: "user" });
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);

    // A second profile, so this half cannot pass on what the first half stored.
    const valued = harness({ routes, flags: { profile: "valued" } });
    await programFor(valued, withGlobal).program.parseAsync(["auth", "login", "--token", MINTED_TOKEN], { from: "user" });
    expect(storedProfiles().valued!.token).toBe(MINTED_TOKEN);
    expectNoSecret(valued);
  });

  it("an empty --token= under a program-level --token <token> is the bare flag, so it reads stdin", async () => {
    const h = harness({
      stdin: `${MINTED_TOKEN}\n`,
      routes: { "GET /api/v1/organizations": ORG_KEY_REFUSAL, "GET /api/v1/me": () => json(200, ME) },
    });
    const withRequired = (program: Command) => {
      program.option("--token <token>", "Override the credential");
    };
    await programFor(h, withRequired).program.parseAsync(["auth", "login", "--token="], { from: "user" });
    expect(storedProfiles().default!.token).toBe(MINTED_TOKEN);
    expectNoSecret(h);
  });

  it("logout --all goes through the parser to ?all=cli", async () => {
    await storeCredential(FAKE_TOKEN, "org", "acme");
    const h = harness({ routes: { "DELETE /api/v1/keys/self": () => json(200, { revoked: 2, self: true, scope: "cli" }) } });
    await programFor(h).program.parseAsync(["auth", "logout", "--all"], { from: "user" });
    expect(h.api.calls[0]!.query).toEqual({ all: "cli" });
    expect(storedProfiles()).toEqual({});
  });

  it("each help ends with a copy-pasteable example and never names npx wam", async () => {
    const h = harness();
    for (const [name, last] of [
      ["login", "  $ wam auth login"],
      ["logout", "  $ wam auth logout"],
    ] as const) {
      const { program, help } = programFor(h);
      try {
        await program.parseAsync(["auth", name, "--help"], { from: "user" });
      } catch (err) {
        if (!(err instanceof CommanderError)) throw err;
      }
      const text = help.join("");
      expect(text.trimEnd().split("\n").pop()).toBe(last);
      expect(text).not.toContain("npx wam ");
      expect(text).not.toContain(EM_DASH);
    }
  });
});

// --- Copy discipline ---------------------------------------------------------------------------------------------------------------

describe("the source files of this task", () => {
  it("are pure ASCII, so they hold no em dash and no smart quote", () => {
    for (const file of ["commands/auth-login.ts", "commands/auth-login.test.ts", "pkce.ts", "pkce.test.ts"]) {
      const text = readFileSync(join(__dirname, "..", file), "utf8");
      const bad = [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 126);
      expect({ file, bad }).toEqual({ file, bad: [] });
    }
  });
});
