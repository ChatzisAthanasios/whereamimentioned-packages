/**
 * Contract-shaped fixtures and an in-process fake of /api/v1 for the command tests. Not a test
 * file itself (vitest only collects `*.test.ts`).
 *
 * Every body below is parsed with its schema from the contract package AT LOAD, so a fixture that
 * drifts from the wire contract fails the import and not some assertion far away. Names are
 * deliberately neutral: no fixture spells a real model name, and no test compares one for equality
 * (10-CLI section 15 item 7).
 */
import { join } from "node:path";
import {
  competitor,
  credits,
  meResponse,
  organizationSummary,
  page,
  promptListResponse,
  reportData,
  scanAnswer,
  scanStatus,
  scanSummary,
  workspaceDetail,
  workspaceSummary,
  type ApiKeyKind,
} from "@whereamimentioned/api-client";
import { CredentialStore, makeCredentialRecord } from "../credentials";
import { main } from "../index";
import { FAKE_TOKEN, FIXED_NOW, fakePrimitives, fakeStream, mkdirp, tempDir, type TempDir } from "../test-support";

export const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const API_ORIGIN = "https://whereamimentioned.com";

export const SCAN_ID = "3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb";
export const ACTIVE_SCAN_ID = "9c4f1a70-5b1e-4d0a-8f6e-2a7b3c4d5e6f";
export const OLD_SCAN_ID = "b21a77c0-1111-4222-8333-444455556666";

// --- Bodies --------------------------------------------------------------------------------------

const KEY_BASE = {
  id: "key_01",
  name: "MBP-16 CLI",
  // The SAME prefix on both kinds: the environment says nothing about the kind (section 3.2).
  prefix: FAKE_TOKEN.slice(0, 17),
  last4: FAKE_TOKEN.slice(-4),
  env: "test" as const,
  roleCeiling: "member" as const,
  expiresAt: "2026-12-08T12:00:00.000Z",
};

export const ME_ORG_KEY = meResponse.parse({
  key: { ...KEY_BASE, kind: "org", scopes: ["workspaces:read", "scans:read", "scans:write", "reports:read", "prompts:read", "competitors:read"] },
  org: { id: "org_acme", slug: "acme", name: "Acme Ltd", type: "brand" },
  actor: { userId: "user_1", role: "admin", effectiveRole: "member" },
  plan: { tier: "pro", label: "Pro", mcp: true, exportFormats: ["csv", "pdf"], promptsPerWorkspace: 150, maxScanPrompts: 6 },
  credits: { balance: 312, unit: "One credit is one prompt asked of one model once." },
});

export const ME_USER_KEY_ACME = meResponse.parse({
  ...ME_ORG_KEY,
  key: {
    ...KEY_BASE,
    kind: "user",
    scopes: ["workspaces:read", "workspaces:write", "scans:read", "scans:write", "reports:read", "prompts:read", "competitors:read", "orgs:write"],
  },
});

export const ME_USER_KEY_NORTHWIND = meResponse.parse({
  ...ME_USER_KEY_ACME,
  org: { id: "org_northwind", slug: "northwind", name: "Northwind", type: "brand" },
  actor: { userId: "user_1", role: "member", effectiveRole: "member" },
  plan: { tier: "single", label: "Single Brand", mcp: false, exportFormats: ["csv"], promptsPerWorkspace: 15, maxScanPrompts: 6 },
  credits: { balance: 40, unit: "One credit is one prompt asked of one model once." },
});

export const CREDITS_ACME = credits.parse({
  balance: 312,
  tier: "pro",
  monthlyCredits: 1000,
  unit: "One credit is one prompt asked of one model once.",
  // Deliberately not balance / anything a client could derive: the test asserts it is printed verbatim.
  estimatedScansRemaining: 7,
});

export const CREDITS_NORTHWIND = credits.parse({
  balance: 40,
  tier: "single",
  monthlyCredits: 100,
  unit: "One credit is one prompt asked of one model once.",
  estimatedScansRemaining: 1,
});

export const ORGANIZATIONS_PAGE = page(organizationSummary).parse({
  data: [
    { id: "org_acme", slug: "acme", name: "Acme Ltd", tier: "pro", effectiveRole: "member", workspaceCount: 3 },
    { id: "org_northwind", slug: "northwind", name: "Northwind", tier: "single", effectiveRole: "member", workspaceCount: 1 },
    { id: "org_labs", slug: "acme-labs", name: "Acme Labs", tier: "free", effectiveRole: "member", workspaceCount: 0 },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
});

const WORKSPACE_BASE = {
  defaultLanguage: "en",
  usesOwnKey: false,
  createdAt: "2026-06-01T08:00:00.000Z",
  updatedAt: "2026-08-24T08:30:00.000Z",
};

export const WORKSPACES_PAGE = page(workspaceSummary).parse({
  data: [
    {
      ...WORKSPACE_BASE,
      id: "ws_eu",
      slug: "acme-eu",
      name: "Acme EU",
      brandName: "Acme",
      defaultRegion: "eu",
      promptCount: 14,
      enabledPromptCount: 12,
      latestScan: { id: SCAN_ID, status: "done", finishedAt: "2026-08-24T08:30:00.000Z", score: 61 },
      activeScanId: null,
    },
    {
      ...WORKSPACE_BASE,
      id: "ws_nw",
      slug: "northwind",
      name: "Northwind",
      brandName: "Northwind",
      defaultRegion: "eu",
      promptCount: 30,
      enabledPromptCount: 28,
      latestScan: null,
      activeScanId: ACTIVE_SCAN_ID,
    },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
});

export const WORKSPACE_DETAIL = workspaceDetail.parse({
  ...WORKSPACES_PAGE.data[0]!,
  competitorCount: 3,
});

const SCAN_BASE = {
  id: SCAN_ID,
  workspaceSlug: "acme-eu",
  mode: "grounded" as const,
  repetitions: 1,
  creditsReserved: 42,
  createdAt: "2026-09-10T11:57:40.000Z",
  startedAt: "2026-09-10T11:57:48.000Z",
};

export const SCAN_RUNNING = scanStatus.parse({
  ...SCAN_BASE,
  status: "running",
  progress: { done: 25, total: 42, totalIsFinal: false },
  creditsSpent: null,
  score: null,
  finishedAt: null,
  error: null,
});

export const SCAN_RUNNING_LATER = scanStatus.parse({
  ...SCAN_RUNNING,
  // The total GREW between two polls, which is why a percentage is never drawn.
  progress: { done: 40, total: 48, totalIsFinal: false },
});

export const SCAN_DONE = scanStatus.parse({
  ...SCAN_BASE,
  status: "done",
  progress: { done: 48, total: 48, totalIsFinal: true },
  creditsSpent: 42,
  score: 61,
  finishedAt: "2026-09-10T11:59:58.000Z",
  error: null,
});

export const SCAN_FAILED = scanStatus.parse({
  ...SCAN_BASE,
  status: "failed",
  progress: { done: 3, total: 42, totalIsFinal: true },
  creditsSpent: 0,
  score: null,
  finishedAt: "2026-09-10T11:58:30.000Z",
  error: "extraction returned no usable answers.",
});

export const SCANS_PAGE = page(scanSummary).parse({
  data: [
    {
      id: SCAN_ID,
      status: "done",
      mode: "grounded",
      repetitions: 1,
      modelCount: 7,
      promptCount: 6,
      creditsSpent: 42,
      score: 61,
      createdAt: "2026-08-28T09:14:02.000Z",
      startedAt: "2026-08-28T09:14:10.000Z",
      finishedAt: "2026-08-28T09:17:00.000Z",
      error: null,
    },
    {
      id: OLD_SCAN_ID,
      status: "failed",
      mode: "grounded",
      repetitions: 1,
      modelCount: 7,
      promptCount: 6,
      creditsSpent: 0,
      score: null,
      createdAt: "2026-08-07T08:03:00.000Z",
      startedAt: "2026-08-07T08:03:05.000Z",
      finishedAt: "2026-08-07T08:04:00.000Z",
      error: "extraction returned no usable answers.",
    },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
});

const LONG_ANSWER = `For teams that want a breakdown per model, Acme is a reasonable option in the middle of the market. ${"It compares well on coverage and on price. ".repeat(12)}`.trim();

export const ANSWERS_PAGE = page(scanAnswer).parse({
  data: [
    {
      answerId: "ans_1",
      promptId: "a3f0c1d2-0000-4000-8000-000000000001",
      promptText: "best AI visibility tracking tools for SaaS",
      intentStage: "research",
      modelId: "vendor/model-one",
      modelName: "Model One",
      grounded: true,
      brandMentioned: true,
      brandPosition: 3,
      sentiment: "positive",
      brandsPresent: [
        { name: "Rival A", is_target: false, rank: 1 },
        { name: "Rival B", is_target: false, rank: 2 },
        { name: "Acme", is_target: true, rank: 3 },
      ],
      citations: [
        { url: "https://reviews.example/tools", domain: "reviews.example" },
        { url: "https://reviews.example/other", domain: "reviews.example" },
        { url: "https://acme.example/pricing", domain: "acme.example" },
      ],
      confidence: 0.91,
      lowConfidence: false,
      answerText: LONG_ANSWER,
      answerTextTruncated: false,
    },
    {
      answerId: "ans_2",
      promptId: "a3f0c1d2-0000-4000-8000-000000000002",
      promptText: "how do I know if an assistant recommends my brand",
      intentStage: "awareness",
      modelId: "vendor/model-two",
      modelName: "Model Two",
      grounded: true,
      brandMentioned: false,
      brandPosition: null,
      sentiment: "not_present",
      brandsPresent: [{ name: "Rival A", is_target: false, rank: 1 }],
      citations: [],
      confidence: 0.4,
      lowConfidence: true,
      answerText: "Several tools now measure this.",
      answerTextTruncated: false,
    },
  ],
  pagination: { nextCursor: "eyJ0cyI6IjIwMjYifQ", hasMore: true, limit: 2 },
});

export const REPORT = reportData.parse({
  scanId: SCAN_ID,
  brandName: "Acme",
  workspaceName: "Acme EU",
  scanDate: "2026-08-28",
  score: 61,
  presenceRate: 0.58,
  presenceCiLow: 0.41,
  presenceCiHigh: 0.74,
  sov: 0.22,
  sentimentScore: 0.34,
  brandCitationShare: 0.14,
  perModel: [
    { model: "Model One", score: 68 },
    { model: "Model Two", score: 49 },
  ],
  competitors: [
    { name: "Rival A", mentions: 18, sov: 0.31, isTarget: false },
    { name: "Acme", mentions: 13, sov: 0.22, isTarget: true },
  ],
  citations: [
    { domain: "reviews.example", count: 12, share: 0.094, bucket: "third_party" },
    { domain: "acme.example", count: 8, share: 0.063, bucket: "owned" },
  ],
  recommendations: [{ title: "Win back the research prompts", body: "Details.", priority: 88 }],
  methodologyVersion: "1.0.0",
});

export const REPORT_ALL_ZERO = reportData.parse({
  ...REPORT,
  score: 0,
  presenceRate: 0,
  presenceCiLow: 0,
  presenceCiHigh: 0,
  sov: 0,
  sentimentScore: null,
  brandCitationShare: 0,
});

export const PROMPTS_PAGE = promptListResponse.parse({
  data: [
    {
      id: "a3f0c1d2-0000-4000-8000-000000000001",
      text: "best AI visibility tracking tools for SaaS",
      intentStage: "research",
      persona: "marketer",
      type: "category",
      topic: null,
      isBranded: false,
      tags: [],
      source: "generated",
      enabled: true,
      createdAt: "2026-06-01T08:00:00.000Z",
    },
    {
      id: "d411bb02-0000-4000-8000-000000000002",
      text: "Acme pricing compared to Rival A",
      intentStage: "purchase",
      persona: "buyer",
      type: "category",
      topic: null,
      isBranded: true,
      tags: [],
      source: "custom",
      enabled: true,
      createdAt: "2026-06-02T08:00:00.000Z",
    },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
  promptsPerWorkspace: 150,
  maxScanPrompts: 6,
});

export const COMPETITORS_PAGE = page(competitor).parse({
  data: [
    { id: "cmp_1", name: "rival a", domain: "rival-a.example", aliases: ["Rival A Inc"], createdAt: "2026-06-01T08:00:00.000Z" },
    { id: "cmp_2", name: "rival b", domain: null, aliases: [], createdAt: "2026-06-01T08:00:00.000Z" },
  ],
  pagination: { nextCursor: null, hasMore: false, limit: 25 },
});

// --- The fake API --------------------------------------------------------------------------------

const BASE_HEADERS = { "content-type": "application/json", "X-Wam-Api-Version": "1", "X-Request-Id": REQUEST_ID };

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** The 08 section 4.2 envelope. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message, requestId: REQUEST_ID, ...(details ? { details } : {}) } }, headers);
}

export function bytesResponse(bytes: Uint8Array, contentType: string): Response {
  // Copied into a plain ArrayBuffer: a Uint8Array over ArrayBufferLike is not a BodyInit in TS 5.9.
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType, "X-Wam-Api-Version": "1", "X-Request-Id": REQUEST_ID },
  });
}

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

type Handler = (call: RecordedCall) => Response;

export interface FakeApi {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  /** One handler per `METHOD /path`. An array is served in order, its last entry repeating. */
  on(method: string, path: string, handler: Handler | Response | Array<Handler | Response>): FakeApi;
  paths(): string[];
}

/** Records method, URL and headers of every request. An unrouted request fails the test loudly. */
export function fakeApi(): FakeApi {
  const routes = new Map<string, Array<Handler | Response>>();
  const served = new Map<string, number>();
  const calls: RecordedCall[] = [];
  const api: FakeApi = {
    calls,
    on(method, path, handler) {
      routes.set(`${method} ${path}`, Array.isArray(handler) ? handler : [handler]);
      return api;
    },
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: RecordedCall = {
        method: init?.method ?? "GET",
        url: url.href,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const queue = routes.get(key);
      if (!queue || queue.length === 0) {
        // A 501 with the envelope, so the CLI fails without the api-client's network retries.
        return errorResponse(501, "internal_error", `no fake route for ${key}`);
      }
      const n = served.get(key) ?? 0;
      served.set(key, n + 1);
      const entry = queue[Math.min(n, queue.length - 1)]!;
      // A Response body is single use, so a shared one is cloned per request.
      return typeof entry === "function" ? entry(call) : entry.clone();
    }) as typeof globalThis.fetch,
  };
  return api;
}

// --- Running the CLI in process -------------------------------------------------------------------

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  home: string;
  cwd: string;
  tmp: TempDir;
  /** Stores a credential for the default profile in the file backend, with a known kind. */
  storeCredential(kind: ApiKeyKind | null, org: string | null): Promise<void>;
  run(argv: string[], opts?: { env?: Record<string, string>; api?: FakeApi }): Promise<CliRun>;
  userConfigPath(): string;
}

/** A temp home and cwd. `env` defaults to none, so a test opts into WAM_TOKEN explicitly. */
export function sandbox(): Sandbox {
  const tmp = tempDir("wam-cmd-");
  const home = mkdirp(join(tmp.dir, "home"));
  const cwd = mkdirp(join(tmp.dir, "repo"));
  mkdirp(join(cwd, ".git"));
  const configEnv = { env: {}, cwd, homedir: home, platform: "linux" };
  return {
    home,
    cwd,
    tmp,
    async storeCredential(kind, org) {
      const store = new CredentialStore({ ...configEnv, keyring: async () => null, fileMode: () => 0o600 });
      await store.set(
        "default",
        makeCredentialRecord({ token: FAKE_TOKEN, kind, apiUrl: API_ORIGIN, org, expiresAt: null, now: FIXED_NOW }),
      );
    },
    async run(argv, opts = {}) {
      const stdout = fakeStream();
      const stderr = fakeStream();
      const api = opts.api ?? fakeApi();
      const code = await main(
        argv,
        fakePrimitives({ homedir: home, cwd, env: opts.env ?? {}, stdout, stderr, fetch: api.fetch, fileMode: () => 0o600 }),
      );
      return { code, stdout: stdout.text, stderr: stderr.text };
    },
    userConfigPath: () => join(home, ".config", "whereamimentioned", "config.json"),
  };
}

export const TOKEN_ENV = { WAM_TOKEN: FAKE_TOKEN };
export { FAKE_TOKEN };
