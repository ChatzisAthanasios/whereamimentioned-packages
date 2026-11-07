/**
 * The `wam` CLI end to end against the REAL server routes (10-CLI section 13, checkpoints 3 to 6,
 * the CI workflow of section 7.2, and the exit codes of section 3.1).
 *
 * A real node:http server on 127.0.0.1:0 adapts every incoming request to a NextRequest and hands
 * it to the exported handler of the matching `route.ts` under app/api/v1, app/api/site and
 * app/api/cli, against the in-memory database of src/test/pglite-db.ts. The CLI runs IN PROCESS
 * through `main(argv, primitives)` with the real `fetch` and `WAM_API_URL` pointing at that
 * server, so every byte crosses HTTP exactly as it would against a deployment: the api-client's
 * headers, the routes' envelopes, the idempotency replay, the 402, the tier gate. Nothing spawns.
 *
 * What is stubbed, and only this: net-guard (the fixture internet of src/lib/tools), the limiter
 * (always allows, records), Inngest (no event leaves), the Supabase cookie session (so the fake
 * browser of the sign-in case can post the authorize form as a signed-in human), and
 * `followClock.sleep` (so nothing waits on a wall clock).
 *
 * The cases are ONE ordered flow over one database, like the workflow of section 7.2: the scan
 * that case 6 starts is the scan case 9 marks done and reads back. Each case still asserts on
 * before/after deltas, never on absolute counts another case could move.
 *
 * The public mirror (10-CLI section 10.2) carries packages/** without app/ or src/. There this
 * file skips as a whole: the check below feeds `describe.skipIf`, and every app, src, next and
 * drizzle module is loaded through a dynamic import inside `beforeAll`, which never runs in a
 * skipped suite. For the same reason this file is excluded from packages/cli/tsconfig.json; the
 * root tsconfig typechecks it.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_SCOPES,
  competitor as competitorSchema,
  crawlerAccessResult,
  createOrganizationResult,
  createScanResult,
  organizationSummary,
  page,
  prompt as promptSchema,
  reportData,
  scanEstimate,
  scanStatus,
} from "@whereamimentioned/api-client";
import { followClock } from "./commands/follow";
import { CredentialStore, makeCredentialRecord } from "./credentials";
import { main } from "./index";
import { FIXED_NOW, fakePrimitives, fakeStream, mkdirp, tempDir, type TempDir } from "./test-support";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** False in the public mirror, which has packages/** and nothing else. */
const APP_PRESENT =
  existsSync(path.join(REPO_ROOT, "app", "api", "v1")) && existsSync(path.join(REPO_ROOT, "src", "test", "pglite-db.ts"));

// --- Stubs (registered always, reached only when the app modules load) ---------------------------

const world = vi.hoisted(() => {
  // resolveKey() reads OPENROUTER_API_KEY through requireEnv, whose snapshot is taken when
  // src/lib/env.ts loads. Nothing here ever calls OpenRouter.
  const env = process.env as Record<string, string | undefined>;
  if (!env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = "sk-or-test-placeholder-never-used";
  return {
    /** The human the mocked cookie session resolves to. Set only by the fake browser. */
    sessionUser: null as { id: string } | null,
    events: [] as Array<{ name: string; data: unknown }>,
    limiterCalls: [] as Array<{ prefix: string; identifier: string }>,
  };
});

vi.mock("@/src/lib/net-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/net-guard")>();
  const { createNetGuardMock } = await import("@/src/lib/tools/site-test-fixtures");
  return { ...actual, ...createNetGuardMock(actual) };
});

vi.mock("@/src/lib/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ratelimit")>();
  return {
    ...actual,
    rateLimit: async (spec: { prefix: string; limit: number }, identifier: string) => {
      world.limiterCalls.push({ prefix: spec.prefix, identifier });
      return { success: true, limit: spec.limit, remaining: spec.limit - 1, reset: Date.now() + 3_600_000 };
    },
  };
});

vi.mock("@/src/inngest/client", () => ({
  inngest: {
    send: async (event: { name: string; data: unknown }) => {
      world.events.push(event);
      return { ids: [] };
    },
  },
}));

vi.mock("@/src/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: world.sessionUser }, error: null }) },
  }),
}));

vi.setConfig({ testTimeout: 60_000 });

// --- The dispatcher: Next's file-system routes, as a table ---------------------------------------

type RouteModule = Record<string, unknown>;

/**
 * Every route.ts under app/api/v1, app/api/site and app/api/cli, by its file-system pattern
 * (`find app/api/v1 app/api/site app/api/cli -name route.ts`). Listed explicitly so a new route
 * that is not added here answers 404 and fails loudly.
 */
const ROUTE_TABLE: ReadonlyArray<{ pattern: string; load: () => Promise<unknown> }> = [
  { pattern: "/api/v1/credits", load: () => import("@/app/api/v1/credits/route") },
  { pattern: "/api/v1/keys/self", load: () => import("@/app/api/v1/keys/self/route") },
  { pattern: "/api/v1/me", load: () => import("@/app/api/v1/me/route") },
  { pattern: "/api/v1/openapi.json", load: () => import("@/app/api/v1/openapi.json/route") },
  { pattern: "/api/v1/organizations", load: () => import("@/app/api/v1/organizations/route") },
  { pattern: "/api/v1/scans/[scanId]", load: () => import("@/app/api/v1/scans/[scanId]/route") },
  { pattern: "/api/v1/scans/[scanId]/answers", load: () => import("@/app/api/v1/scans/[scanId]/answers/route") },
  { pattern: "/api/v1/scans/[scanId]/report", load: () => import("@/app/api/v1/scans/[scanId]/report/route") },
  { pattern: "/api/v1/workspaces", load: () => import("@/app/api/v1/workspaces/route") },
  { pattern: "/api/v1/workspaces/[workspaceSlug]", load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/route") },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/citations",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/citations/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/competitors",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/competitors/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/prompts",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/prompts/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/prompts/[promptId]",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/prompts/[promptId]/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/recommendations",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/recommendations/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/scans",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/scans/route"),
  },
  {
    pattern: "/api/v1/workspaces/[workspaceSlug]/scans/estimate",
    load: () => import("@/app/api/v1/workspaces/[workspaceSlug]/scans/estimate/route"),
  },
  { pattern: "/api/site/analyze-chunks", load: () => import("@/app/api/site/analyze-chunks/route") },
  { pattern: "/api/site/check-crawlers", load: () => import("@/app/api/site/check-crawlers/route") },
  { pattern: "/api/site/check-meta", load: () => import("@/app/api/site/check-meta/route") },
  { pattern: "/api/site/generate-llms-txt", load: () => import("@/app/api/site/generate-llms-txt/route") },
  { pattern: "/api/site/generate-sitemap", load: () => import("@/app/api/site/generate-sitemap/route") },
  { pattern: "/api/site/validate-llms-txt", load: () => import("@/app/api/site/validate-llms-txt/route") },
  {
    pattern: "/api/site/validate-structured-data",
    load: () => import("@/app/api/site/validate-structured-data/route"),
  },
  { pattern: "/api/cli/device/start", load: () => import("@/app/api/cli/device/start/route") },
  { pattern: "/api/cli/device/token", load: () => import("@/app/api/cli/device/token/route") },
  { pattern: "/api/cli/token", load: () => import("@/app/api/cli/token/route") },
];

type Segment = { literal: string } | { param: string };

interface CompiledRoute {
  pattern: string;
  segments: Segment[];
  /** How many segments are static: the more specific route wins, as in Next. */
  statics: number;
  module: RouteModule;
}

function compileRoute(pattern: string, module: RouteModule): CompiledRoute {
  const segments = pattern
    .split("/")
    .filter((s) => s !== "")
    .map((s): Segment => (s.startsWith("[") && s.endsWith("]") ? { param: s.slice(1, -1) } : { literal: s }));
  return { pattern, segments, statics: segments.filter((s) => "literal" in s).length, module };
}

function matchRoute(
  routes: readonly CompiledRoute[],
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter((s) => s !== "");
  let best: { route: CompiledRoute; params: Record<string, string> } | null = null;
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const segment = route.segments[i]!;
      const part = parts[i]!;
      if ("literal" in segment) {
        if (segment.literal !== part) {
          ok = false;
          break;
        }
      } else {
        params[segment.param] = decodeURIComponent(part);
      }
    }
    if (ok && (best === null || route.statics > best.route.statics)) best = { route, params };
  }
  return best;
}

// --- The loopback server ---------------------------------------------------------------------------

/** What the server saw of one request. Never the bearer itself: only whether there was one. */
interface SeenRequest {
  method: string;
  path: string;
  search: string;
  authorization: boolean;
  org: string | null;
  idempotencyKey: string | null;
  status: number;
}

type RouteHandler = (req: unknown, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

let server: Server;
let origin = "";
let routes: CompiledRoute[] = [];
const seen: SeenRequest[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function unrouted(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId: "req_e2e_unrouted" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- App modules, loaded in beforeAll (never in the mirror) ------------------------------------------

let NextRequestCtor: typeof import("next/server").NextRequest;
let orm: typeof import("drizzle-orm");
let db: typeof import("@/src/db").db;
let schema: typeof import("@/src/db/schema");
let factories: typeof import("@/src/test/factories");
let fixtures: typeof import("@/src/lib/tools/site-test-fixtures");
let credits: typeof import("@/src/billing/credits");
let constants: typeof import("@/src/api/constants");
let orgService: typeof import("@/src/api/services/organizations");
let workspaceService: typeof import("@/src/api/services/workspaces");
let cliActions: typeof import("@/app/(app)/cli/actions");
let apiKeyAuth: typeof import("@/src/auth/api-key");
let testDb: import("@/src/test/pglite-db").TestDb;

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", origin);
  const method = (req.method ?? "GET").toUpperCase();
  const body = await readBody(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  const entry: SeenRequest = {
    method,
    path: url.pathname,
    search: url.search,
    authorization: headers.has("authorization"),
    org: headers.get("x-wam-org"),
    idempotencyKey: headers.get("idempotency-key"),
    status: 0,
  };
  seen.push(entry);

  let out: Response;
  const match = matchRoute(routes, url.pathname);
  if (match === null) {
    out = unrouted(404, "not_found", `No route matches ${url.pathname}.`);
  } else {
    const handler = match.route.module[method];
    if (typeof handler !== "function") {
      out = unrouted(405, "bad_request", `${method} is not allowed on ${match.route.pattern}.`);
    } else {
      const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
      // A fresh Uint8Array over its own ArrayBuffer: the BodyInit type does not admit a Node Buffer.
      const nreq = new NextRequestCtor(url.toString(), {
        method,
        headers,
        body: hasBody ? new Uint8Array(body) : undefined,
      });
      out = await (handler as RouteHandler)(nreq, { params: Promise.resolve(match.params) });
    }
  }
  entry.status = out.status;
  res.statusCode = out.status;
  out.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await out.arrayBuffer()));
}

// --- Running the CLI in process -------------------------------------------------------------------

interface Box {
  tmp: TempDir;
  home: string;
  cwd: string;
}

const boxes: Box[] = [];

/** A temp home and a temp repo, as commands/fixtures.ts builds them. Removed in afterAll. */
function newBox(): Box {
  const tmp = tempDir("wam-e2e-");
  const home = mkdirp(path.join(tmp.dir, "home"));
  const cwd = mkdirp(path.join(tmp.dir, "repo"));
  mkdirp(path.join(cwd, ".git"));
  const box = { tmp, home, cwd };
  boxes.push(box);
  return box;
}

/** The file backend in `box`: no keyring, and a mode the POSIX check accepts on any host. */
function storeIn(box: Box): CredentialStore {
  return new CredentialStore({
    env: {},
    cwd: box.cwd,
    homedir: box.home,
    platform: "linux",
    keyring: async () => null,
    fileMode: () => 0o600,
  });
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** The requests the loopback server saw DURING this invocation, in order. */
  requests: SeenRequest[];
}

interface RunOptions {
  /** Added to `WAM_API_URL`. Nothing else is inherited: no credential unless a case sets one. */
  env?: Record<string, string>;
  /** Reuse a home across invocations (the stored-credential cases). Default: a fresh one. */
  box?: Box;
  openBrowser?: (url: string) => Promise<void>;
  /** Wraps the real fetch, to read a response the CLI itself never prints. */
  tapFetch?: (url: string, res: Response) => Promise<void>;
}

const realFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

async function wam(argv: string[], opts: RunOptions = {}): Promise<CliRun> {
  const box = opts.box ?? newBox();
  const stdout = fakeStream();
  const stderr = fakeStream();
  const tap = opts.tapFetch;
  const fetchImpl: typeof globalThis.fetch = tap
    ? async (input, init) => {
        const res = await realFetch(input, init);
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        await tap(href, res.clone());
        return res;
      }
    : realFetch;
  const from = seen.length;
  const code = await main(
    argv,
    fakePrimitives({
      homedir: box.home,
      cwd: box.cwd,
      env: { WAM_API_URL: origin, ...(opts.env ?? {}) },
      stdout,
      stderr,
      fetch: fetchImpl,
      keyring: async () => null,
      fileMode: () => 0o600,
      ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
    }),
  );
  return { code, stdout: stdout.text, stderr: stderr.text, requests: seen.slice(from) };
}

function expectNoToken(run: CliRun, ...tokens: string[]): void {
  for (const token of tokens) {
    expect(run.stdout).not.toContain(token);
    expect(run.stderr).not.toContain(token);
  }
}

const trail = (run: CliRun): string[] => run.requests.map((r) => `${r.method} ${r.path}`);

/** A request made by the TEST, not by the CLI: the oracle a command's output is compared with. */
async function direct(method: string, pathname: string, bearer: string, org?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${bearer}` };
  if (org !== undefined) headers["x-wam-org"] = org;
  const res = await realFetch(`${origin}${pathname}`, { method, headers });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

function visit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).on("error", reject);
  });
}

function ndjson(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- The suite ---------------------------------------------------------------------------------------

describe.skipIf(!APP_PRESENT)("wam, end to end against the real routes (10-CLI section 13)", () => {
  type Key = { raw: string; row: import("@/src/db/schema").ApiKey };
  type Workspace = import("@/src/db/schema").Workspace;
  type Org = import("@/src/test/factories").CreatedOrg;

  const WRITE_SCOPES = [...READ_ONLY_SCOPES, "scans:write", "prompts:write", "competitors:write", "workspaces:write"];
  const SCORE = 41;

  let human: string;
  let acme: Org;
  let solo: Org;
  let main_: Workspace;
  let ci: Workspace;
  let only: Workspace;
  let orgKey: Key;
  let userKey: Key;
  let soloKey: Key;
  let logoutKey: Key;
  /** The scan case 6 starts; case 9 marks it done and reads it back. */
  let firstScanId = "";

  const orgEnv = (workspace = "main"): Record<string, string> => ({
    WAM_TOKEN: orgKey.raw,
    WAM_ORG: "acme",
    WAM_WORKSPACE: workspace,
  });

  const scansIn = (workspaceId: string) => db.select().from(schema.scans).where(orm.eq(schema.scans.workspaceId, workspaceId));
  const debitsFor = (orgId: string) =>
    db
      .select()
      .from(schema.creditLedger)
      .where(orm.and(orm.eq(schema.creditLedger.orgId, orgId), orm.eq(schema.creditLedger.reason, "scan_debit")));
  const ledgerRows = async (): Promise<number> => (await db.select({ id: schema.creditLedger.id }).from(schema.creditLedger)).length;

  /** What run-scan writes when a scan finishes, reduced to what the two read routes serve. */
  async function markScanDone(scanId: string, workspaceId: string): Promise<void> {
    const [row] = await db.select().from(schema.scans).where(orm.eq(schema.scans.id, scanId)).limit(1);
    if (!row) throw new Error(`scan ${scanId} not found`);
    const finishedAt = new Date();
    await db
      .update(schema.scans)
      .set({
        status: "done",
        startedAt: new Date(finishedAt.getTime() - 60_000),
        finishedAt,
        creditsSpent: row.creditsReserved,
      })
      .where(orm.eq(schema.scans.id, scanId));
    await factories.createReportRows(acme.id, workspaceId, scanId, { overall: { aiVisibilityScore: SCORE } });
  }

  beforeAll(async () => {
    ({ NextRequest: NextRequestCtor } = await import("next/server"));
    orm = await import("drizzle-orm");
    const harness = await import("@/src/test/pglite-db");
    testDb = await harness.installTestDb();
    await harness.seedModels(testDb.db);
    ({ db } = await import("@/src/db"));
    schema = await import("@/src/db/schema");
    factories = await import("@/src/test/factories");
    fixtures = await import("@/src/lib/tools/site-test-fixtures");
    credits = await import("@/src/billing/credits");
    constants = await import("@/src/api/constants");
    orgService = await import("@/src/api/services/organizations");
    workspaceService = await import("@/src/api/services/workspaces");
    apiKeyAuth = await import("@/src/auth/api-key");
    cliActions = await import("@/app/(app)/cli/actions");
    const { MAX_SCAN_PROMPTS } = await import("@/src/probe/config");

    routes = [];
    for (const entry of ROUTE_TABLE) routes.push(compileRoute(entry.pattern, (await entry.load()) as RouteModule));

    // Pro: the paid org the human OWNS, which is what lets the account-wide key create another.
    human = factories.newUserId();
    acme = await factories.createOrg({ slug: "acme", name: "Acme Ltd", tier: "pro", credits: 1000 });
    await factories.addMember(acme.id, human, "owner");
    main_ = await factories.createWorkspace(acme.id, { slug: "main", name: "Main" });
    await factories.createPrompts(main_.id, MAX_SCAN_PROMPTS);
    // A second scan target, so the one-scan-in-flight guard of `main` never decides another case.
    ci = await factories.createWorkspace(acme.id, { slug: "ci", name: "CI" });
    await factories.createPrompts(ci.id, MAX_SCAN_PROMPTS);
    orgKey = await factories.insertApiKey({ kind: "org", orgId: acme.id, userId: human, scopes: WRITE_SCOPES });
    logoutKey = await factories.insertApiKey({ kind: "org", orgId: acme.id, userId: human, scopes: WRITE_SCOPES });
    userKey = await factories.insertApiKey({ kind: "user", userId: human, scopes: [...WRITE_SCOPES, "orgs:write"] });

    // Single tier, 11 credits, at its one-workspace cap: the 402 and the ceiling.
    solo = await factories.createOrg({ slug: "solo", name: "Solo Brand", tier: "single", credits: 11 });
    await factories.addMember(solo.id, human, "admin");
    only = await factories.createWorkspace(solo.id, { slug: "only", name: "Only" });
    await factories.createPrompts(only.id, MAX_SCAN_PROMPTS);
    soloKey = await factories.insertApiKey({ kind: "org", orgId: solo.id, userId: human, scopes: WRITE_SCOPES });

    server = createServer((req, res) => {
      serve(req, res).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (testDb) await testDb.close();
    for (const box of boxes) box.tmp.cleanup();
  });

  beforeEach(() => {
    fixtures.resetFixtures();
    fixtures.installFixtureSite();
    seen.length = 0;
    world.limiterCalls.length = 0;
    world.sessionUser = null;
  });

  // --- Checkpoint 3 ---------------------------------------------------------------------------------

  it("1. site check-crawlers works with no credential at all, and only /api/site/ is touched", async () => {
    const run = await wam(["site", "check-crawlers", fixtures.FIXTURE_ORIGIN, "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const result = crawlerAccessResult.parse(JSON.parse(run.stdout));
    expect(result.origin).toBe(fixtures.FIXTURE_ORIGIN);
    expect(result.bots.length).toBeGreaterThan(0);
    // The SERVER fetched the site (from the fixture internet), never the CLI.
    expect(fixtures.fetchLog.some((u) => u.startsWith(fixtures.FIXTURE_ORIGIN))).toBe(true);
    expect(trail(run)).toEqual(["POST /api/site/check-crawlers"]);
    for (const r of run.requests) {
      expect(r.path.startsWith("/api/site/"), r.path).toBe(true);
      expect(r.authorization).toBe(false);
    }
  });

  // --- Checkpoint 4 ---------------------------------------------------------------------------------

  it("2. auth status prints the kind the server reports, never the token, and only the reach table with no org", async () => {
    const keyKindRow = (run: CliRun) => run.stdout.split("\n").find((l) => l.trimStart().startsWith("Key kind")) ?? "";

    const asOrg = await wam(["auth", "status"], { env: orgEnv() });
    expect(asOrg.code, asOrg.stderr).toBe(0);
    expect(keyKindRow(asOrg)).toContain("Organization key, bound to acme");
    expect(asOrg.stdout).toContain("Acme Ltd (acme)");
    expect(asOrg.stdout).toContain(`${orgKey.row.prefix}...${orgKey.row.last4}`);

    // A bare WAM_TOKEN says nothing about its kind, so GET /api/v1/organizations is the
    // discriminator: the real route's 403 (details.requiredKind "user") proves an org key.
    const bareOrg = await wam(["auth", "status"], { env: { WAM_TOKEN: orgKey.raw } });
    expect(bareOrg.code, bareOrg.stderr).toBe(0);
    expect(bareOrg.requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
      "GET /api/v1/organizations 403",
      "GET /api/v1/me 200",
      "GET /api/v1/credits 200",
    ]);
    expect(keyKindRow(bareOrg)).toBe(keyKindRow(asOrg));

    const asUser = await wam(["auth", "status", "--org", "acme"], { env: { WAM_TOKEN: userKey.raw } });
    expect(asUser.code, asUser.stderr).toBe(0);
    expect(keyKindRow(asUser)).toMatch(/Account-wide key, reaches \d+ organizations/);
    // Both tokens carry the same wam_test_ prefix: the kind is key.kind from GET /api/v1/me.
    expect(orgKey.raw.slice(0, 9)).toBe(userKey.raw.slice(0, 9));
    expect(keyKindRow(asUser)).not.toBe(keyKindRow(asOrg));
    expect(trail(asUser)).toEqual(["GET /api/v1/me", "GET /api/v1/credits", "GET /api/v1/organizations"]);

    const noOrg = await wam(["auth", "status"], { env: { WAM_TOKEN: userKey.raw } });
    expect(noOrg.code, noOrg.stderr).toBe(0);
    // No GET /api/v1/me without X-Wam-Org: the one request is the reach table's.
    expect(trail(noOrg)).toEqual(["GET /api/v1/organizations"]);
    expect(noOrg.stdout).toContain("Reaches");
    expect(noOrg.stdout).toContain("acme");
    expect(noOrg.stdout).toContain("solo");
    for (const label of ["Organization", "Role", "Plan", "Credits"]) {
      expect(noOrg.stdout.split("\n").some((l) => l.startsWith(`  ${label} `)), label).toBe(false);
    }

    for (const run of [asOrg, bareOrg, asUser, noOrg]) expectNoToken(run, orgKey.raw, userKey.raw);
  });

  it("3. org list lists every org on the account-wide key, and is exit 3 after one request on an org key", async () => {
    const asUser = await wam(["org", "list", "--json"], { env: { WAM_TOKEN: userKey.raw } });
    expect(asUser.code, asUser.stderr).toBe(0);
    const listed = page(organizationSummary).parse(JSON.parse(asUser.stdout));
    expect(listed.data.map((o) => o.slug)).toEqual(expect.arrayContaining(["acme", "solo"]));

    const human_ = await wam(["org", "list"], { env: { WAM_TOKEN: userKey.raw } });
    expect(human_.code, human_.stderr).toBe(0);
    expect(human_.stdout).toContain("acme");
    expect(human_.stdout).toContain("solo");

    const asOrg = await wam(["org", "list"], { env: { WAM_TOKEN: orgKey.raw } });
    expect(asOrg.code).toBe(3);
    expect(asOrg.stderr).toContain("This key is bound to one organization, so it cannot list or create organizations.");
    expect(asOrg.stderr).toContain("Sign in again with an account-wide key: wam auth login --account-wide");
    expect(trail(asOrg)).toEqual(["GET /api/v1/organizations"]);
    expect(asOrg.stdout).toBe("");
  });

  it("4. workspace list makes exactly three requests for a one-page list", async () => {
    const run = await wam(["workspace", "list"], { env: { WAM_TOKEN: orgKey.raw, WAM_ORG: "acme" } });
    expect(run.code, run.stderr).toBe(0);
    expect(run.requests).toHaveLength(3);
    expect(trail(run)).toEqual(["GET /api/v1/me", "GET /api/v1/workspaces", "GET /api/v1/credits"]);
    expect(run.stdout).toContain("main");
    expect(run.stdout).toContain("ci");
    // The denominator is plan.promptsPerWorkspace as served, never typed here.
    const me = (await direct("GET", "/api/v1/me", orgKey.raw)).body as { plan: { promptsPerWorkspace: number } };
    expect(run.stdout).toContain(`/${me.plan.promptsPerWorkspace}`);
  });

  it("4b. a key for one org never sees another's workspace, and an account-wide key with no org never leaves the machine", async () => {
    // A STORED org key of solo, so the CLI knows its kind and its org (section 4.5), pointed at a
    // workspace slug that exists only in acme. 404, never 403, and the section 9 mismatch copy.
    const soloBox = newBox();
    await storeIn(soloBox).set(
      "default",
      makeCredentialRecord({ token: soloKey.raw, kind: "org", apiUrl: origin, org: "solo", expiresAt: null, now: FIXED_NOW }),
    );
    const crossed = await wam(["scan", "list", "--workspace", "main"], { box: soloBox });
    expect(crossed.code).toBe(3);
    expect(crossed.stderr).toContain("Workspace main was not found, or this key cannot see it.");
    expect(crossed.stderr).toContain("This key is bound to the organization solo. Check wam auth status.");
    expect(crossed.requests.map((r) => `${r.org} ${r.status}`)).toEqual(["solo 404"]);
    expect(crossed.stdout).toBe("");

    // Claiming the other org outright is the same 404, although the human belongs to both: an
    // org key's X-Wam-Org is a claim the server verifies, never a selector (08 section 3.4 rule 2).
    const claimed = await wam(["workspace", "list", "--org", "acme", "--json"], { box: soloBox });
    expect(claimed.code).toBe(3);
    expect(claimed.requests.map((r) => `${r.org} ${r.status}`)).toEqual(["acme 404"]);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ ok: false, exitCode: 3, error: { code: "not_found" } });

    // A STORED account-wide key with no org resolved: exit 2 locally, and NO request at all.
    const userBox = newBox();
    await storeIn(userBox).set(
      "default",
      makeCredentialRecord({ token: userKey.raw, kind: "user", apiUrl: origin, org: null, expiresAt: null, now: FIXED_NOW }),
    );
    const local = await wam(["workspace", "list"], { box: userBox });
    expect(local.code).toBe(2);
    expect(local.stderr).toContain("No organization selected. This key reaches several, so it cannot guess.");
    expect(local.requests).toEqual([]);

    // The same key as a bare WAM_TOKEN carries no kind, so the server's 422 answers instead, and
    // it is still a usage error: exit 2, with the API's own sentence.
    const bare = await wam(["workspace", "list"], { env: { WAM_TOKEN: userKey.raw } });
    expect(bare.code).toBe(2);
    expect(bare.requests.map((r) => `${r.org} ${r.status}`)).toEqual(["null 422"]);
    expect(bare.stderr).toContain("This key is account-wide");
    for (const run of [crossed, claimed, local, bare]) expectNoToken(run, soloKey.raw, userKey.raw);
  });

  // --- Checkpoint 5: money --------------------------------------------------------------------------

  it("5. scan estimate prices the scan and spends nothing", async () => {
    const rowsBefore = await ledgerRows();
    const balanceBefore = await credits.getBalance(acme.id);
    const scansBefore = (await scansIn(main_.id)).length;
    const eventsBefore = world.events.length;

    const run = await wam(["scan", "estimate", "--json"], { env: { ...orgEnv(), CI: "1" } });
    expect(run.code, run.stderr).toBe(0);
    const estimate = scanEstimate.parse(JSON.parse(run.stdout));
    expect(estimate.credits).toBeGreaterThan(0);
    expect(estimate.balance).toBe(balanceBefore);
    expect(estimate.sufficient).toBe(true);
    expect(trail(run)).toEqual(["POST /api/v1/workspaces/main/scans/estimate"]);

    expect(await ledgerRows()).toBe(rowsBefore);
    expect(await credits.getBalance(acme.id)).toBe(balanceBefore);
    expect((await scansIn(main_.id)).length).toBe(scansBefore);
    expect(world.events.length).toBe(eventsBefore);
  });

  it("6. scan run --yes starts one scan and debits once; the same run id replays it", async () => {
    const env = { ...orgEnv(), CI: "1", GITHUB_RUN_ID: "run-1" };
    const balanceBefore = await credits.getBalance(acme.id);
    const scanIdsBefore = (await scansIn(main_.id)).map((r) => r.id);
    const debitIdsBefore = (await debitsFor(acme.id)).map((d) => d.id);
    const eventsBefore = world.events.length;
    const newScans = async () => (await scansIn(main_.id)).filter((r) => !scanIdsBefore.includes(r.id));
    const newDebits = async () => (await debitsFor(acme.id)).filter((d) => !debitIdsBefore.includes(d.id));

    const first = await wam(["scan", "run", "--yes", "--json"], { env });
    expect(first.code, first.stderr).toBe(0);
    const created = createScanResult.parse(JSON.parse(first.stdout));
    expect(created.status).toBe("queued");
    // Section 8.1 rule 1: the cost is on stderr even with --yes and --json.
    expect(first.stderr).toMatch(new RegExp(`Cost\\s+${created.credits} credits`));
    expect(first.stderr).not.toContain("already exists");
    firstScanId = created.id;

    expect((await newScans()).map((r) => r.id)).toEqual([created.id]);
    let debits = await newDebits();
    expect(debits).toHaveLength(1);
    expect(debits[0]!.delta).toBe(-created.credits);
    expect(await credits.getBalance(acme.id)).toBe(balanceBefore - created.credits);
    expect(created.balanceAfter).toBe(balanceBefore - created.credits);
    expect(world.events.length).toBe(eventsBefore + 1);

    const second = await wam(["scan", "run", "--yes", "--json"], { env });
    expect(second.code, second.stderr).toBe(0);
    const replayed = createScanResult.parse(JSON.parse(second.stdout));
    expect(replayed.id).toBe(created.id);
    expect(second.stderr).toContain(`A scan for this run already exists (${created.id}).`);

    expect((await newScans()).map((r) => r.id)).toEqual([created.id]);
    debits = await newDebits();
    expect(debits).toHaveLength(1);
    expect(await credits.getBalance(acme.id)).toBe(balanceBefore - created.credits);
    expect(world.events.length).toBe(eventsBefore + 1);

    // One derived Idempotency-Key for both attempts, and without --wait nothing ever polls.
    const posts = [...first.requests, ...second.requests].filter((r) => r.method === "POST" && r.path.endsWith("/scans"));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey);
    for (const run of [first, second]) {
      expect(trail(run)).toEqual([
        "POST /api/v1/workspaces/main/scans/estimate",
        "POST /api/v1/workspaces/main/scans",
      ]);
    }
  });

  it("7. scan run --yes against 11 credits is exit 4 with the section 8.2 copy, and nothing is charged", async () => {
    const env = { WAM_TOKEN: soloKey.raw, WAM_ORG: "solo", WAM_WORKSPACE: "only", CI: "1", GITHUB_RUN_ID: "run-solo" };
    const eventsBefore = world.events.length;
    const idsBefore = (await scansIn(only.id)).map((r) => r.id);
    const estimate = scanEstimate.parse(
      (await direct("POST", "/api/v1/workspaces/only/scans/estimate", soloKey.raw)).body,
    );
    expect(estimate.sufficient).toBe(false);

    const run = await wam(["scan", "run", "--yes"], { env });
    expect(run.code).toBe(4);
    expect(run.stderr).toContain(
      `Not enough credits. This scan needs ${estimate.credits} credits and the organization has 11.`,
    );
    // `billingUrl` is the API's details.billingUrl, printed as received.
    expect(run.stderr).toContain(`Add credits or change plan: ${constants.billingUrlFor("solo")}`);
    expect(run.stdout).toBe("");

    expect(await credits.getBalance(solo.id)).toBe(11);
    expect(await debitsFor(solo.id)).toEqual([]);
    expect(world.events.length).toBe(eventsBefore);
    // No scan was STARTED. What the server actually keeps of the refused attempt is one TERMINAL
    // row (src/probe/trigger.ts inserts before it reserves): failed, nothing reserved, never
    // enqueued, and its idempotency key released so a retry after a top-up starts a fresh scan.
    const rows = await scansIn(only.id);
    expect(rows.filter((r) => !idsBefore.includes(r.id)).map((r) => ({
      status: r.status,
      creditsReserved: r.creditsReserved,
      error: r.error,
      idempotencyKey: r.idempotencyKey,
    }))).toEqual([{ status: "failed", creditsReserved: 0, error: "Insufficient credits", idempotencyKey: null }]);
    expect(rows.filter((r) => r.status === "queued" || r.status === "running")).toEqual([]);
  });

  it("8. CI=1 scan run without --yes is exit 2, still prints the cost, and creates nothing", async () => {
    const scansBefore = (await scansIn(ci.id)).length;
    const rowsBefore = await ledgerRows();
    const estimate = scanEstimate.parse((await direct("POST", "/api/v1/workspaces/ci/scans/estimate", orgKey.raw)).body);

    const run = await wam(["scan", "run"], { env: { ...orgEnv("ci"), CI: "1", GITHUB_RUN_ID: "run-no-yes" } });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(new RegExp(`Cost\\s+${estimate.credits} credits`));
    expect(run.stderr).toContain("Pass --yes to confirm");
    expect(trail(run)).toEqual(["POST /api/v1/workspaces/ci/scans/estimate"]);

    expect((await scansIn(ci.id)).length).toBe(scansBefore);
    expect(await ledgerRows()).toBe(rowsBefore);
  });

  // --- Checkpoint 4 again, on the scan case 6 started ------------------------------------------------

  it("9. a finished scan reads back: status equals the route body, the report parses, --fail-under 99 is exit 7", async () => {
    expect(firstScanId, "case 6 must have started a scan").not.toBe("");
    await markScanDone(firstScanId, main_.id);

    const status = await wam(["scan", "status", firstScanId, "--json"], { env: orgEnv() });
    expect(status.code, status.stderr).toBe(0);
    const oracle = await direct("GET", `/api/v1/scans/${firstScanId}`, orgKey.raw);
    expect(oracle.status).toBe(200);
    expect(JSON.parse(status.stdout)).toEqual(oracle.body);
    const parsed = scanStatus.parse(JSON.parse(status.stdout));
    expect(parsed.status).toBe("done");
    expect(parsed.score).toBe(SCORE);
    expect(parsed.progress.totalIsFinal).toBe(true);

    // No --scan: the latest completed scan of the workspace, as the workflow of section 7.2 reads it.
    const report = await wam(["report", "get", "--json"], { env: orgEnv() });
    expect(report.code, report.stderr).toBe(0);
    const data = reportData.parse(JSON.parse(report.stdout));
    expect(data.scanId).toBe(firstScanId);
    expect(data.score).toBe(SCORE);
    expect(data.methodologyVersion).not.toBe("");

    // The "Fetch the full report" step of the section 7.2 workflow, as written there.
    const box = newBox();
    const saved = await wam(["report", "get", "--json", "-o", "report.json"], { env: orgEnv(), box });
    expect(saved.code, saved.stderr).toBe(0);
    expect(reportData.parse(JSON.parse(readFileSync(path.join(box.cwd, "report.json"), "utf8")))).toEqual(data);

    const gated = await wam(["report", "get", "--json", "--fail-under", "99"], { env: orgEnv() });
    expect(gated.code).toBe(7);
    expect(reportData.parse(JSON.parse(gated.stdout)).scanId).toBe(firstScanId);
    expect(gated.stderr).toContain(`AI visibility score ${SCORE} is below the threshold of 99.`);

    const gatedHuman = await wam(["report", "get", "--fail-under", "99"], { env: orgEnv() });
    expect(gatedHuman.code).toBe(7);
    expect(gatedHuman.stdout).toContain(`${SCORE} / 100`);
    expect(gatedHuman.stdout).not.toContain("below the threshold");
    expect(gatedHuman.stderr).toContain(`AI visibility score ${SCORE} is below the threshold of 99.`);
  });

  it("10a. scan status --wait --json is NDJSON ending in exactly one result object", async () => {
    expect(firstScanId).not.toBe("");
    const run = await wam(["scan", "status", firstScanId, "--wait", "--json"], { env: orgEnv() });
    expect(run.code, run.stderr).toBe(0);
    const lines = ndjson(run.stdout);
    const terminal = lines.filter((l) => l.type === "result" || l.type === "error");
    expect(terminal).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe(terminal[0]);
    expect(terminal[0]).toMatchObject({ type: "result", id: firstScanId, status: "done", score: SCORE });
  });

  it("10b. scan run --wait --yes --fail-under 99 --json streams progress, ends in one result object and exits 7", async () => {
    const env = { ...orgEnv("ci"), CI: "1", GITHUB_RUN_ID: "run-2" };
    const scansBefore = (await scansIn(ci.id)).map((r) => r.id);
    const realSleep = followClock.sleep;
    let sleeps = 0;
    // The worker, played from the one place the follow loop waits: the first wait finishes the scan.
    followClock.sleep = async () => {
      sleeps += 1;
      const live = (await scansIn(ci.id)).filter((r) => r.status === "queued" || r.status === "running");
      for (const row of live) await markScanDone(row.id, ci.id);
    };
    let run: CliRun;
    try {
      run = await wam(["scan", "run", "--wait", "--yes", "--fail-under", "99", "--json"], { env });
    } finally {
      followClock.sleep = realSleep;
    }

    expect(run.code, run.stderr).toBe(7);
    expect(sleeps).toBe(1);
    const created = (await scansIn(ci.id)).filter((r) => !scansBefore.includes(r.id));
    expect(created).toHaveLength(1);

    const lines = ndjson(run.stdout);
    const terminal = lines.filter((l) => l.type === "result" || l.type === "error");
    expect(terminal).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe(terminal[0]);
    expect(terminal[0]).toMatchObject({ type: "result", id: created[0]!.id, status: "done", score: SCORE });
    expect(lines.slice(0, -1).every((l) => l.type === "progress")).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
    // The gate goes to stderr: the result object stays the last thing on stdout (section 7.4).
    expect(run.stderr).toContain(`AI visibility score ${SCORE} is below the threshold of 99.`);
    expect(trail(run)).toEqual([
      "POST /api/v1/workspaces/ci/scans/estimate",
      "POST /api/v1/workspaces/ci/scans",
      `GET /api/v1/scans/${created[0]!.id}`,
      `GET /api/v1/scans/${created[0]!.id}`,
      `GET /api/v1/scans/${created[0]!.id}/report`,
      "GET /api/v1/credits",
    ]);
  });

  // --- Checkpoint 5: the two creates ------------------------------------------------------------------

  it("11. org create makes one unusable org on the free floor, replays it, and the tier gate answers for it", async () => {
    const env = { WAM_TOKEN: userKey.raw, CI: "1", GITHUB_RUN_ID: "run-org-1" };
    const named = () => db.select().from(schema.organizations).where(orm.eq(schema.organizations.name, "E2E Labs"));
    const rowsBefore = await ledgerRows();
    expect(await named()).toEqual([]);

    const run = await wam(["org", "create", "E2E Labs", "--type", "brand", "--yes"], { env });
    expect(run.code, run.stderr).toBe(0);
    const made = await named();
    expect(made).toHaveLength(1);
    const org = made[0]!;
    expect(org.type).toBe("brand");
    expect(org.createdBy).toBe(human);

    // The API's own sentence and URL, byte for byte, and never a cheerier word than "no".
    expect(run.stdout).toContain(orgService.ORGANIZATION_CREATED_MESSAGE);
    expect(run.stdout).toContain(constants.billingUrlFor(org.slug));
    expect(run.stdout).toMatch(/Usable\s+no/);
    expect(run.stdout).toContain(`Created E2E Labs (${org.slug}), type brand, tier free.`);
    expectNoToken(run, userKey.raw);

    const members = await db.select().from(schema.memberships).where(orm.eq(schema.memberships.orgId, org.id));
    expect(members.map((m) => ({ userId: m.userId, role: m.role }))).toEqual([{ userId: human, role: "owner" }]);
    const subs = await db.select().from(schema.subscriptions).where(orm.eq(schema.subscriptions.orgId, org.id));
    expect(subs.map((s) => s.tier)).toEqual(["free"]);
    expect(await credits.getBalance(org.id)).toBe(0);
    expect(await ledgerRows()).toBe(rowsBefore);

    // The same run id: the same organization back (200 + X-Idempotent-Replay), not a second one.
    const again = await wam(["org", "create", "E2E Labs", "--type", "brand", "--yes", "--json"], { env });
    expect(again.code, again.stderr).toBe(0);
    const replayed = createOrganizationResult.parse(JSON.parse(again.stdout));
    expect(replayed.id).toBe(org.id);
    expect(replayed.usable).toBe(false);
    expect(again.stderr).toContain(`An organization for this run already exists (${org.slug}).`);
    expect(await named()).toHaveLength(1);
    const creates = [...run.requests, ...again.requests].filter((r) => r.method === "POST");
    expect(creates.map((r) => r.path)).toEqual(["/api/v1/organizations", "/api/v1/organizations"]);
    expect(creates[1]!.idempotencyKey).toBe(creates[0]!.idempotencyKey);
    // Neither organization route is sent an X-Wam-Org.
    expect(creates.map((r) => r.org)).toEqual([null, null]);

    // REACHING the new org needs no new credential: the same key lists it on the very next request.
    const reach = await wam(["org", "list", "--json"], { env: { WAM_TOKEN: userKey.raw } });
    expect(reach.code, reach.stderr).toBe(0);
    const row = page(organizationSummary)
      .parse(JSON.parse(reach.stdout))
      .data.find((o) => o.slug === org.slug);
    expect(row).toMatchObject({ tier: "free", workspaceCount: 0 });

    // USING it needs a subscription. What the server actually does for a free org on every
    // org-scoped route is the paid-tier gate of 08 section 6.2 (403 feature_not_available), so
    // `wam workspace list --org <new slug>` is exit 3 with the section 9 tier copy, not a list.
    // The credential is accepted (this is not a 401 and not the 404 of an unreachable org).
    const gated = await wam(["workspace", "list", "--org", org.slug], { env: { WAM_TOKEN: userKey.raw } });
    expect(gated.code).toBe(3);
    expect(gated.stderr).toContain(
      "The API and the CLI are available on paid plans. This organization is on the free floor, which means there is no active subscription.",
    );
    expect(gated.stderr).toContain(`Choose a plan: ${constants.billingUrlFor(org.slug)}`);
    expect(gated.requests.map((r) => r.status)).toEqual([403]);
    expect(gated.requests[0]!.org).toBe(org.slug);
  });

  it("12. workspace create at the plan's cap is exit 10 with the API's message verbatim", async () => {
    const before = (await db.select().from(schema.workspaces).where(orm.eq(schema.workspaces.orgId, solo.id))).length;
    expect(before).toBe(1);

    const run = await wam(["workspace", "create", "Second", "--yes"], {
      env: { WAM_TOKEN: soloKey.raw, WAM_ORG: "solo", CI: "1" },
    });
    expect(run.code).toBe(10);
    expect(run.stderr).toContain(workspaceService.workspaceCapMessage("single", 1));
    expect(run.stderr).toContain(`This organization already has 1. Change plan: ${constants.billingUrlFor("solo")}`);

    const post = run.requests.filter((r) => r.method === "POST");
    expect(post.map((r) => r.path)).toEqual(["/api/v1/workspaces"]);
    // No Idempotency-Key on this route, ever (08 section 7.1).
    expect(post[0]!.idempotencyKey).toBeNull();
    expect((await db.select().from(schema.workspaces).where(orm.eq(schema.workspaces.orgId, solo.id))).length).toBe(before);
  });

  it("13. prompt add, disable, remove and competitor add change the rows they say they change", async () => {
    const env = { ...orgEnv(), CI: "1" };
    const text = "which tools track brand mentions in AI answers";
    const promptRow = async (id: string) =>
      (await db.select().from(schema.prompts).where(orm.eq(schema.prompts.id, id)).limit(1))[0] ?? null;

    const added = await wam(["prompt", "add", text, "--json"], { env });
    expect(added.code, added.stderr).toBe(0);
    const created = promptSchema.parse(JSON.parse(added.stdout));
    expect(created.text).toBe(text);
    let row = await promptRow(created.id);
    expect(row).toMatchObject({ workspaceId: main_.id, orgId: acme.id, text, source: "custom", enabled: true });

    const disabled = await wam(["prompt", "disable", created.id], { env });
    expect(disabled.code, disabled.stderr).toBe(0);
    row = await promptRow(created.id);
    expect(row?.enabled).toBe(false);

    const removed = await wam(["prompt", "remove", created.id, "--yes"], { env });
    expect(removed.code, removed.stderr).toBe(0);
    expect(await promptRow(created.id)).toBeNull();

    const rival = await wam(["competitor", "add", "Rival", "--domain", "rival.example", "--json"], { env });
    expect(rival.code, rival.stderr).toBe(0);
    const competitor = competitorSchema.parse(JSON.parse(rival.stdout));
    const stored = await db.select().from(schema.competitors).where(orm.eq(schema.competitors.id, competitor.id));
    // Stored normalized (trimmed and lowercased), in this workspace, and nothing was fetched from it.
    expect(stored.map((c) => ({ workspaceId: c.workspaceId, orgId: c.orgId, name: c.name, domain: c.domain }))).toEqual([
      { workspaceId: main_.id, orgId: acme.id, name: "rival", domain: "rival.example" },
    ]);
    expect(fixtures.fetchLog.filter((u) => u.includes("rival.example"))).toEqual([]);
  });

  // --- Checkpoint 6 ---------------------------------------------------------------------------------

  it("14. auth logout revokes the stored key on the server, clears it locally, and the key is dead afterwards", async () => {
    const box = newBox();
    const store = storeIn(box);
    await store.set(
      "default",
      makeCredentialRecord({ token: logoutKey.raw, kind: "org", apiUrl: origin, org: "acme", expiresAt: null, now: FIXED_NOW }),
    );
    expect(readFileSync(store.filePath, "utf8")).toContain(logoutKey.row.prefix);

    // No WAM_TOKEN: the credential is the stored one.
    const run = await wam(["auth", "logout"], { box });
    expect(run.code, run.stderr).toBe(0);
    expect(trail(run)).toEqual(["DELETE /api/v1/keys/self"]);
    expect(run.requests[0]!.search).toBe("");
    expectNoToken(run, logoutKey.raw);

    const [row] = await db.select().from(schema.apiKeys).where(orm.eq(schema.apiKeys.id, logoutKey.row.id)).limit(1);
    expect(row?.revokedAt).toBeInstanceOf(Date);
    // Only that key: the org's other key still authenticates.
    const [other] = await db.select().from(schema.apiKeys).where(orm.eq(schema.apiKeys.id, orgKey.row.id)).limit(1);
    expect(other?.revokedAt).toBeNull();

    expect(await storeIn(box).get("default")).toBeNull();
    if (existsSync(store.filePath)) expect(readFileSync(store.filePath, "utf8")).not.toContain(logoutKey.row.prefix);

    const after = await wam(["auth", "status"], { env: { WAM_TOKEN: logoutKey.raw } });
    expect(after.code).toBe(3);
    expect(after.stderr).toContain("This API key is no longer valid.");
    expect(after.requests.map((r) => r.status)).toEqual([401]);
    expectNoToken(after, logoutKey.raw);
  });

  it("15. auth login completes the loopback PKCE exchange against POST /api/cli/token, with a fake browser", async () => {
    const box = newBox();
    let browserError: unknown = null;
    let authorizePath = "";
    let tokenReply: Record<string, unknown> | null = null;

    // The approving human. It reads the authorize URL the CLI built, posts the form the approval
    // page would render from it to the REAL server action as a signed-in member of acme, and then
    // follows the action's redirect to the CLI's own loopback callback.
    const openBrowser = async (href: string): Promise<void> => {
      const url = new URL(href);
      const q = url.searchParams;
      const callback = q.get("redirect_uri") ?? "";
      try {
        expect(url.origin).toBe(origin);
        authorizePath = url.pathname;
        expect(q.get("kind")).toBeNull();
        const form = new FormData();
        for (const name of ["code_challenge", "code_challenge_method", "redirect_uri", "state", "name"]) {
          form.append(name, q.get(name) ?? "");
        }
        form.append("kind", "org");
        form.append("requested_expires", q.get("expires") ?? "");
        for (const scope of (q.get("scopes") ?? "").split(",")) form.append("scopes", scope);
        // The three things the human chooses on the page: the org, the expiry, and Authorize.
        form.append("orgSlug", "acme");
        form.append("expires", q.get("expires") ?? "");
        form.append("decision", "authorize");

        world.sessionUser = { id: human };
        let target = "";
        try {
          const state = await cliActions.authorizeCli({}, form);
          throw new Error(`the authorize action returned instead of redirecting: ${JSON.stringify(state)}`);
        } catch (err) {
          // A Next redirect is a thrown error whose digest carries the destination.
          const digest = String((err as { digest?: unknown } | null)?.digest ?? "");
          if (!digest.startsWith("NEXT_REDIRECT;")) throw err;
          target = digest.split(";").slice(2, -2).join(";");
        } finally {
          world.sessionUser = null;
        }
        // The key itself never appears in the browser (10 section 4.2 step 5).
        expect(target).not.toContain("wam_");
        expect(target.startsWith(`${callback}?`)).toBe(true);
        expect(await visit(target)).toBe(200);
      } catch (err) {
        browserError = err;
        // End the CLI's wait now instead of at its 300 second timeout.
        await visit(`${callback}?error=access_denied&state=${encodeURIComponent(q.get("state") ?? "")}`).catch(() => 0);
      }
    };

    const run = await wam(["auth", "login", "--name", "e2e laptop"], {
      box,
      openBrowser,
      tapFetch: async (href, res) => {
        if (new URL(href).pathname === "/api/cli/token") tokenReply = (await res.json()) as Record<string, unknown>;
      },
    });

    expect(browserError).toBeNull();
    expect(run.code, run.stderr).toBe(0);
    expect(authorizePath).toBe("/cli/authorize");
    // One exchange, then the key's own details. Nothing was asked of the API before the mint.
    expect(trail(run)).toEqual(["POST /api/cli/token", "GET /api/v1/me"]);
    expect(run.requests[0]!.authorization).toBe(false);
    expect(run.stdout).toContain("Signed in.");
    expect(run.stdout).toContain("Organization key, bound to acme");

    const reply = tokenReply as { token: string; prefix: string; last4: string; kind: string; org: string | null; expiresAt: string | null } | null;
    expect(reply).not.toBeNull();
    expect(reply!.token).toMatch(/^wam_test_[0-9A-Za-z]{43}$/);
    expectNoToken(run, reply!.token);

    // The stored credential is the token response, field for field.
    const stored = await storeIn(box).get("default");
    expect(stored?.storage).toBe("file");
    expect(stored?.record).toMatchObject({
      token: reply!.token,
      prefix: reply!.prefix,
      last4: reply!.last4,
      kind: "org",
      org: "acme",
      expiresAt: reply!.expiresAt,
      apiUrl: origin,
    });
    expect(reply).toMatchObject({ kind: "org", org: "acme" });

    // The key row the action minted: this human, this org, the CLI's name, capped at member.
    const principal = await apiKeyAuth.resolveApiKey(reply!.token);
    expect(principal).not.toBeNull();
    const [keyRow] = await db.select().from(schema.apiKeys).where(orm.eq(schema.apiKeys.id, principal!.keyId)).limit(1);
    expect(keyRow).toMatchObject({
      kind: "org",
      orgId: acme.id,
      userId: human,
      name: "e2e laptop",
      prefix: reply!.prefix,
      roleCeiling: "member",
      createdVia: "cli_loopback",
      revokedAt: null,
    });

    // Consumed exactly once, and the ciphertext is gone with it (10 section 4.4).
    const codes = await db.select().from(schema.cliAuthCodes).where(orm.eq(schema.cliAuthCodes.apiKeyId, keyRow!.id));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.kind).toBe("loopback");
    expect(codes[0]!.consumedAt).toBeInstanceOf(Date);
    expect(codes[0]!.tokenCiphertext).toBeNull();
    const leftovers = await db
      .select({ id: schema.cliAuthCodes.id })
      .from(schema.cliAuthCodes)
      .where(orm.isNotNull(schema.cliAuthCodes.tokenCiphertext));
    expect(leftovers).toEqual([]);

    // And the stored key works: the next command needs no WAM_TOKEN.
    const status = await wam(["auth", "status"], { box });
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${reply!.prefix}...${reply!.last4}`);
    expectNoToken(status, reply!.token);
  });
});
