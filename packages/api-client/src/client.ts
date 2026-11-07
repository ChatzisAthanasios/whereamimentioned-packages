/**
 * The typed fetch wrapper every machine client of whereamimentioned goes through (10-CLI section
 * 12.1). Neither the CLI nor the MCP server calls `fetch` against /api/v1 directly.
 *
 * What it does, and nothing more:
 *  - attaches `Authorization: Bearer` and `X-Wam-Api-Version` on every /api/v1 call;
 *  - sends `X-Wam-Org` on org-scoped calls and SUPPRESSES it on the three routes that resolve no
 *    organization (`organizations.list`, `organizations.create`, `keys.revokeSelf`);
 *  - sends `Idempotency-Key` on the two routes that require it (`scans.create`,
 *    `organizations.create`) and on no other;
 *  - maps the 08 section 4.2 error envelope to a typed `ApiError`, reading `X-Request-Id` and
 *    `Retry-After`; a 2xx whose body is not JSON becomes the same `ApiError` (code `unknown`);
 *  - exposes the last response's status and headers as `lastResponse`, including whether it was an
 *    idempotent replay (`X-Idempotent-Replay`), because the 08 bodies deliberately carry no replay
 *    flag and the status plus that header are the only signal (08 sections 7.1 and 7.3);
 *  - retries idempotent GETs only, at most twice, with exponential backoff, on 502/503/504 and on
 *    network-level failures. A POST is never retried. A 429 is never retried: the server has
 *    already said stop, and `retryAfterSeconds` on the error tells the caller when.
 *  - aborts any request after `timeoutMs` (default 30 s).
 *
 * It does not validate response bodies against the contract at runtime: the routes are asserted
 * against the contract schemas in the server's own tests, and a client that re-serialised a parsed
 * copy could never promise "byte-identical to the API body" to `--json` consumers.
 */
import {
  API_VERSION,
  API_VERSION_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  SITE_ROUTES,
  type AnswerListQuery,
  type ApiErrorCode,
  type ChunkAnalysisResult,
  type CitationListQuery,
  type Citation,
  type Competitor,
  type CrawlerAccessResult,
  type CreateCompetitorBody,
  type CreateOrganizationBody,
  type CreateOrganizationResult,
  type CreatePromptBody,
  type CreateScanBody,
  type CreateScanResult,
  type CreateWorkspaceBody,
  type Credits,
  type LlmsTxtGeneration,
  type LlmsTxtValidation,
  type Me,
  type MetaAnalysisResult,
  type OrganizationSummary,
  type Page,
  type PageQuery,
  type PatchPromptBody,
  type Prompt,
  type PromptListQuery,
  type PromptListResponse,
  type Recommendation,
  type RecommendationListQuery,
  type ReportData,
  type ReportFormat,
  type RevokeSelfResult,
  type ScanAnswer,
  type ScanEstimate,
  type ScanListQuery,
  type ScanStatus,
  type ScanSummary,
  type SitemapGeneration,
  type StructuredDataValidation,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "./contract";

export const DEFAULT_BASE_URL = "https://whereamimentioned.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The /api/v1 surface version this client was built against (08 section 4.3, 10 section 9.1). */
export const SUPPORTED_API_VERSION: number = API_VERSION;

/** Idempotent GETs only: at most this many retries, so three attempts in total. */
export const MAX_GET_RETRIES = 2;
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_BASE_MS = 500;
const RETRY_MAX_WAIT_MS = 30_000;

export interface WamClientOptions {
  baseUrl: string; // default https://whereamimentioned.com
  token?: string; // absent is legal: the /api/site/* routes need no key
  org?: string; // sent as X-Wam-Org on every org-scoped call (08 section 4.1)
  fetch?: typeof globalThis.fetch;
  userAgent: string; // "wam-cli/0.2.0" or "wam-mcp/0.2.0"
  timeoutMs?: number; // default 30_000
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode | string;
    message: string;
    requestId: string | null;
    details?: Record<string, unknown>;
    retryAfterSeconds: number | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The request exceeded `timeoutMs`. Not retried: the caller set that budget deliberately. */
export class ApiTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, timeoutMs: number) {
    super(`${method} ${path} timed out after ${timeoutMs} ms`);
    this.name = "ApiTimeoutError";
    this.timeoutMs = timeoutMs;
    this.method = method;
    this.path = path;
  }
}

/**
 * What the last completed request answered with, beyond its body. The 08 bodies deliberately carry
 * no replay flag (the signal is the status and `X-Idempotent-Replay`), so this is where a caller
 * reads it: `scans.create` or `organizations.create` resolves with the body, and `lastResponse.replayed`
 * then says whether it was the original 201 or the 200 of 08 sections 7.1 and 7.3. It is per client
 * instance and describes the most recent completed request (null before the first, and null again
 * while a request is in flight or after one failed at the network level), so a caller running
 * concurrent requests on one instance must read it before issuing the next call. The CLI is
 * sequential (estimate, confirm, create); the MCP server reads `replayed` in-process instead.
 */
export interface WamResponseMeta {
  status: number;
  headers: Headers;
  /** `X-Idempotent-Replay: true` was present. Always false on a 201. */
  replayed: boolean;
}

export interface WamClient {
  /** The integer from the last `X-Wam-Api-Version` response header seen, success or failure. */
  readonly lastApiVersion: number | null;
  /** The last `X-Request-Id` seen. For `--debug` output and support tickets. */
  readonly lastRequestId: string | null;
  /** Status, headers and the replay flag of the last completed request, success or failure. */
  readonly lastResponse: WamResponseMeta | null;
  me(): Promise<Me>;
  credits(): Promise<Credits>;
  organizations: {
    list(q?: PageQuery): Promise<Page<OrganizationSummary>>;
    create(body: CreateOrganizationBody, idempotencyKey: string): Promise<CreateOrganizationResult>;
  };
  workspaces: {
    list(q?: PageQuery): Promise<Page<WorkspaceSummary>>;
    get(slug: string): Promise<WorkspaceDetail>;
    create(orgSlug: string, body: CreateWorkspaceBody): Promise<WorkspaceDetail>;
  };
  scans: {
    list(ws: string, q?: ScanListQuery): Promise<Page<ScanSummary>>;
    estimate(ws: string): Promise<ScanEstimate>;
    create(ws: string, body: CreateScanBody, idempotencyKey: string): Promise<CreateScanResult>;
    get(scanId: string): Promise<ScanStatus>;
    answers(scanId: string, q?: AnswerListQuery): Promise<Page<ScanAnswer>>;
    report(scanId: string, format: ReportFormat): Promise<ReportData | Uint8Array>;
  };
  prompts: {
    list(ws: string, q?: PromptListQuery): Promise<PromptListResponse>;
    create(ws: string, body: CreatePromptBody): Promise<Prompt>;
    patch(ws: string, promptId: string, body: PatchPromptBody): Promise<Prompt>;
    /** A 404 here is success: the prompt is already gone (08 section 4.8). */
    remove(ws: string, promptId: string): Promise<void>;
  };
  competitors: {
    list(ws: string, q?: PageQuery): Promise<Page<Competitor>>;
    create(ws: string, body: CreateCompetitorBody): Promise<Competitor>;
  };
  recommendations: {
    list(ws: string, q?: RecommendationListQuery): Promise<Page<Recommendation>>;
  };
  citations: {
    list(ws: string, q?: CitationListQuery): Promise<Page<Citation>>;
  };
  site: {
    checkCrawlers(url: string): Promise<CrawlerAccessResult>;
    validateLlmsTxt(url: string): Promise<LlmsTxtValidation>;
    generateLlmsTxt(url: string, opts?: { full?: boolean }): Promise<LlmsTxtGeneration>;
    generateSitemap(url: string): Promise<SitemapGeneration>;
    validateStructuredData(url: string): Promise<StructuredDataValidation>;
    checkMeta(url: string, keyword?: string): Promise<MetaAnalysisResult>;
    analyzeChunks(url: string): Promise<ChunkAnalysisResult>;
  };
  // `all` is the literal string "cli" or nothing. Not a boolean: the server accepts no other value
  // and 422s on one, so the client type mirrors the wire contract (08 section 4.8).
  keys: { revokeSelf(all?: "cli"): Promise<RevokeSelfResult> };
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * `undefined`: an org-scoped call, send `opts.org` if set.
   * `null`: a route that resolves no organization, never send the header.
   * a string: an explicit override of `opts.org` for this one request.
   */
  org?: string | null;
  /** false for the unauthenticated /api/site/* routes. */
  auth?: boolean;
  idempotencyKey?: string;
  /** "bytes" for csv/pdf report downloads; "json" otherwise. */
  as?: "json" | "bytes";
}

/** A fully consumed response: the body was read inside the timeout window. */
interface Settled {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  bytes: ArrayBuffer | null;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function parseApiVersion(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : null;
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  // Sorted, so the same query always yields the same URL whatever order the caller wrote it in.
  for (const [key, value] of Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export function createWamClient(opts: WamClientOptions): WamClient {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: typeof globalThis.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const state: { apiVersion: number | null; requestId: string | null; lastResponse: WamResponseMeta | null } = {
    apiVersion: null,
    requestId: null,
    lastResponse: null,
  };

  function noteHeaders(res: Response): void {
    const v = parseApiVersion(res.headers.get(API_VERSION_HEADER));
    if (v !== null) state.apiVersion = v;
    const rid = res.headers.get("X-Request-Id");
    if (rid) state.requestId = rid;
    // Set on every response, so a replay flag can never survive into the next call.
    state.lastResponse = {
      status: res.status,
      headers: res.headers,
      replayed: res.headers.get(IDEMPOTENT_REPLAY_HEADER) === "true",
    };
  }

  /**
   * Not the envelope: a proxy page, a middleware redirect, a captive portal, an empty body. Do not
   * invent a code the caller might branch on; say what arrived. Shared by the non-2xx and the 2xx
   * paths so a non-JSON body is one error type whatever its status.
   */
  function nonJsonError(res: Settled): ApiError {
    return new ApiError({
      status: res.status,
      code: "unknown",
      message: `Unexpected non-JSON response (HTTP ${res.status})`,
      requestId: res.headers.get("X-Request-Id"),
      details: { contentType: res.headers.get("content-type"), bodyPreview: res.text.slice(0, 200) },
      retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
    });
  }

  function toApiError(res: Settled): ApiError {
    const retryAfterHeader = parseRetryAfter(res.headers.get("Retry-After"));
    const headerRequestId = res.headers.get("X-Request-Id");
    const text = res.text;
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const env =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (parsed as { error?: unknown }).error
        : undefined;
    if (typeof env === "object" && env !== null && typeof (env as { code?: unknown }).code === "string") {
      const e = env as {
        code: string;
        message?: unknown;
        requestId?: unknown;
        details?: unknown;
      };
      const details =
        typeof e.details === "object" && e.details !== null && !Array.isArray(e.details)
          ? (e.details as Record<string, unknown>)
          : undefined;
      const detailsRetry =
        details && typeof details.retryAfterSeconds === "number" ? details.retryAfterSeconds : null;
      return new ApiError({
        status: res.status,
        code: e.code,
        message: typeof e.message === "string" ? e.message : `HTTP ${res.status}`,
        requestId: typeof e.requestId === "string" ? e.requestId : headerRequestId,
        details,
        retryAfterSeconds: retryAfterHeader ?? detailsRetry,
      });
    }
    return nonJsonError(res);
  }

  async function attempt(spec: RequestSpec, url: string): Promise<Settled> {
    const headers: Record<string, string> = {
      Accept: spec.as === "bytes" ? "*/*" : "application/json",
      "User-Agent": opts.userAgent,
    };
    if (spec.auth !== false) {
      headers[API_VERSION_HEADER] = String(API_VERSION);
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const org = spec.org === null ? undefined : (spec.org ?? opts.org);
      if (org) headers["X-Wam-Org"] = org;
    }
    if (spec.idempotencyKey !== undefined) headers["Idempotency-Key"] = spec.idempotencyKey;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
        redirect: "manual",
      });
      noteHeaders(res);
      // Consume the body inside the timeout window so a stalled stream is also bounded.
      if (res.ok && spec.as === "bytes") {
        return { status: res.status, ok: true, headers: res.headers, text: "", bytes: await res.arrayBuffer() };
      }
      return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text(), bytes: null };
    } catch (err) {
      if (isAbortError(err)) throw new ApiTimeoutError(spec.method, spec.path, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(spec: RequestSpec): Promise<T> {
    const url = `${baseUrl}${spec.path}${buildQuery(spec.query)}`;
    const retryable = spec.method === "GET";
    let attemptNo = 0;
    // Cleared up front, so a network failure or a timeout cannot leave an earlier call's answer behind.
    state.lastResponse = null;
    for (;;) {
      let res: Settled;
      try {
        res = await attempt(spec, url);
      } catch (err) {
        // Network-level failure (DNS, reset, refused). A timeout is deliberately not one of these.
        if (retryable && attemptNo < MAX_GET_RETRIES && !(err instanceof ApiTimeoutError)) {
          await sleep(Math.min(RETRY_BASE_MS * 2 ** attemptNo, RETRY_MAX_WAIT_MS));
          attemptNo += 1;
          continue;
        }
        throw err;
      }

      if (res.ok) {
        if (spec.as === "bytes") return new Uint8Array(res.bytes ?? new ArrayBuffer(0)) as T;
        if (!res.text) return undefined as T;
        try {
          return JSON.parse(res.text) as T;
        } catch {
          // A 2xx that is not JSON (a captive portal, a middleware page served with 200) is the
          // same typed failure as a non-JSON 5xx, never a raw SyntaxError.
          throw nonJsonError(res);
        }
      }

      if (retryable && attemptNo < MAX_GET_RETRIES && RETRY_STATUSES.has(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
        const backoff = RETRY_BASE_MS * 2 ** attemptNo;
        const wait = retryAfter !== null ? Math.max(retryAfter * 1000, backoff) : backoff;
        await sleep(Math.min(wait, RETRY_MAX_WAIT_MS));
        attemptNo += 1;
        continue;
      }

      throw toApiError(res);
    }
  }

  const v1 = "/api/v1";

  const site = async <T>(route: (typeof SITE_ROUTES)[keyof typeof SITE_ROUTES], body: unknown) =>
    request<T>({ method: "POST", path: `/api/site/${route}`, body, auth: false, org: null });

  return {
    get lastApiVersion() {
      return state.apiVersion;
    },
    get lastRequestId() {
      return state.requestId;
    },
    get lastResponse() {
      return state.lastResponse;
    },

    me: () => request<Me>({ method: "GET", path: `${v1}/me` }),
    credits: () => request<Credits>({ method: "GET", path: `${v1}/credits` }),

    organizations: {
      list: (q) =>
        request<Page<OrganizationSummary>>({ method: "GET", path: `${v1}/organizations`, query: q, org: null }),
      create: (body, idempotencyKey) =>
        request<CreateOrganizationResult>({
          method: "POST",
          path: `${v1}/organizations`,
          body,
          org: null,
          idempotencyKey,
        }),
    },

    workspaces: {
      list: (q) => request<Page<WorkspaceSummary>>({ method: "GET", path: `${v1}/workspaces`, query: q }),
      get: (slug) => request<WorkspaceDetail>({ method: "GET", path: `${v1}/workspaces/${seg(slug)}` }),
      // The org travels as X-Wam-Org, overriding opts.org, and is never put in the body.
      create: async (orgSlug, body) => {
        // 10 section 12.1: the slug is explicit because this is the one write nobody can take back.
        // An empty slug would fall through to opts.org, the ambient default it exists to refuse.
        if (typeof orgSlug !== "string" || orgSlug.trim() === "") {
          throw new TypeError("workspaces.create: orgSlug is required and must not be empty");
        }
        return request<WorkspaceDetail>({ method: "POST", path: `${v1}/workspaces`, body, org: orgSlug });
      },
    },

    scans: {
      list: (ws, q) =>
        request<Page<ScanSummary>>({ method: "GET", path: `${v1}/workspaces/${seg(ws)}/scans`, query: q }),
      estimate: (ws) =>
        request<ScanEstimate>({ method: "POST", path: `${v1}/workspaces/${seg(ws)}/scans/estimate`, body: {} }),
      create: (ws, body, idempotencyKey) =>
        request<CreateScanResult>({
          method: "POST",
          path: `${v1}/workspaces/${seg(ws)}/scans`,
          body,
          idempotencyKey,
        }),
      get: (scanId) => request<ScanStatus>({ method: "GET", path: `${v1}/scans/${seg(scanId)}` }),
      answers: (scanId, q) =>
        request<Page<ScanAnswer>>({ method: "GET", path: `${v1}/scans/${seg(scanId)}/answers`, query: q }),
      report: (scanId, format) =>
        format === "json"
          ? request<ReportData>({ method: "GET", path: `${v1}/scans/${seg(scanId)}/report`, query: { format } })
          : request<Uint8Array>({
              method: "GET",
              path: `${v1}/scans/${seg(scanId)}/report`,
              query: { format },
              as: "bytes",
            }),
    },

    prompts: {
      list: (ws, q) =>
        request<PromptListResponse>({ method: "GET", path: `${v1}/workspaces/${seg(ws)}/prompts`, query: q }),
      create: (ws, body) =>
        request<Prompt>({ method: "POST", path: `${v1}/workspaces/${seg(ws)}/prompts`, body }),
      patch: (ws, promptId, body) =>
        request<Prompt>({
          method: "PATCH",
          path: `${v1}/workspaces/${seg(ws)}/prompts/${seg(promptId)}`,
          body,
        }),
      remove: async (ws, promptId) => {
        try {
          await request<unknown>({
            method: "DELETE",
            path: `${v1}/workspaces/${seg(ws)}/prompts/${seg(promptId)}`,
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return;
          throw err;
        }
      },
    },

    competitors: {
      list: (ws, q) =>
        request<Page<Competitor>>({ method: "GET", path: `${v1}/workspaces/${seg(ws)}/competitors`, query: q }),
      create: (ws, body) =>
        request<Competitor>({ method: "POST", path: `${v1}/workspaces/${seg(ws)}/competitors`, body }),
    },

    recommendations: {
      list: (ws, q) =>
        request<Page<Recommendation>>({
          method: "GET",
          path: `${v1}/workspaces/${seg(ws)}/recommendations`,
          query: q,
        }),
    },

    citations: {
      list: (ws, q) =>
        request<Page<Citation>>({ method: "GET", path: `${v1}/workspaces/${seg(ws)}/citations`, query: q }),
    },

    site: {
      checkCrawlers: (url) => site<CrawlerAccessResult>(SITE_ROUTES.checkCrawlers, { url }),
      validateLlmsTxt: (url) => site<LlmsTxtValidation>(SITE_ROUTES.validateLlmsTxt, { url }),
      generateLlmsTxt: (url, o) =>
        site<LlmsTxtGeneration>(SITE_ROUTES.generateLlmsTxt, { url, depth: o?.full ? "full" : "index" }),
      generateSitemap: (url) => site<SitemapGeneration>(SITE_ROUTES.generateSitemap, { url }),
      validateStructuredData: (url) =>
        site<StructuredDataValidation>(SITE_ROUTES.validateStructuredData, { url }),
      checkMeta: (url, keyword) =>
        site<MetaAnalysisResult>(SITE_ROUTES.checkMeta, keyword === undefined ? { url } : { url, keyword }),
      analyzeChunks: (url) => site<ChunkAnalysisResult>(SITE_ROUTES.analyzeChunks, { url }),
    },

    keys: {
      revokeSelf: (all) =>
        request<RevokeSelfResult>({
          method: "DELETE",
          path: `${v1}/keys/self`,
          query: all === undefined ? undefined : { all },
          org: null,
        }),
    },
  };
}
