/**
 * The wire contract of the whereamimentioned public API (08-PUBLIC-API section 4) and of the
 * no-account site tools (09-MCP-SERVER section 6.1, served at POST /api/site/*).
 *
 * Single source of truth, shared by the REST routes, the MCP tools and the CLI (10-CLI section 12).
 * Rules:
 *  - The const tuples live in ./enums.ts, and the app's src/types/enums.ts re-exports them from
 *    there by identity. Never retype them, and never import them from the app: this package must
 *    build alone in the public mirror (10-CLI section 10.2), which has no src/.
 *  - `ReportData` is declared in ./report-data.ts and never redeclared: the app's buildReportData
 *    imports it, and the `reportData` schema below is pinned to it by a type-level assertion, so
 *    any drift between the two fails `pnpm typecheck` instead of a customer's CI.
 *  - Every object schema that is a REQUEST body is `.strict()`, per 08 section 4.8.
 */
import { z } from "zod";
import {
  API_SCOPES,
  CITATION_BUCKETS,
  INTENT_STAGES,
  ORG_ROLES,
  ORG_TYPES,
  PROMPT_SOURCES,
  PROMPT_TYPES,
  READ_ONLY_SCOPES,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
  REPORT_FORMATS,
  SCAN_MODES,
  SCAN_STATUSES,
  SENTIMENTS,
  TIERS,
} from "./enums";
import type { ReportData } from "./report-data";

// ─── Const tuples that appear on the wire (re-exported, never retyped) ───────────────────────────

export {
  API_SCOPES,
  CITATION_BUCKETS,
  INTENT_STAGES,
  ORG_ROLES,
  ORG_TYPES,
  PROMPT_SOURCES,
  PROMPT_TYPES,
  READ_ONLY_SCOPES,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TYPES,
  REPORT_FORMATS,
  SCAN_MODES,
  SCAN_STATUSES,
  SENTIMENTS,
  TIERS,
};
export type {
  ApiScope,
  CitationBucket,
  IntentStage,
  OrgRole,
  OrgType,
  PromptSource,
  PromptType,
  RecommendationStatus,
  RecommendationType,
  ReportFormat,
  ScanMode,
  ScanStatus as ScanStatusValue,
  Sentiment,
  Tier,
} from "./enums";
export type { ReportData };

/** `api_keys.kind` (08 section 2.3). A server-side property of the row, never encoded in the token. */
export const API_KEY_KINDS = ["org", "user"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/** The environment a key was minted against (08 section 2.1): `wam_live_` or `wam_test_`. */
export const API_KEY_ENVS = ["live", "test"] as const;
export type ApiKeyEnv = (typeof API_KEY_ENVS)[number];

/** The API surface version carried in `X-Wam-Api-Version` (08 section 4.3). One integer, not semver. */
export const API_VERSION = 1 as const;
export const API_VERSION_HEADER = "X-Wam-Api-Version";
/**
 * `true` on the 200 an idempotent replay returns (08 section 7.1 step 4, section 7.3 step 1). The
 * replay body carries no flag of its own: the status and this header are the signal.
 */
export const IDEMPOTENT_REPLAY_HEADER = "X-Idempotent-Replay";

// ─── Error envelope (08 section 4.2) ─────────────────────────────────────────────────────────────

export const API_ERROR_CODES = [
  "bad_request", // 400 (body not parseable as JSON at all)
  "unauthorized", // 401
  "insufficient_role", // 403
  "insufficient_scope", // 403
  "feature_not_available", // 403 (tier gate)
  "not_found", // 404
  "conflict", // 409
  "scan_already_running", // 409
  "validation_failed", // 422
  "insufficient_credits", // 402
  "rate_limited", // 429
  "internal_error", // 500
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** `req_` plus a 26-character Crockford base32 ULID (08 section 4.2). */
export const requestId = z.string().regex(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);

export const apiErrorBody = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Correlates with Sentry and with the server log line. Always present. */
    requestId: z.string(),
    /** Code-specific structured payload. Never free-form prose. */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;

/** `details` of the 402 on scan creation (08 sections 4.8 and 6.4). */
export const insufficientCreditsDetails = z.object({
  required: z.number().int(),
  available: z.number().int(),
  billingUrl: z.string().url(),
});
export type InsufficientCreditsDetails = z.infer<typeof insufficientCreditsDetails>;

/** `details` of every 429 (08 section 5.4). */
export const rateLimitedDetails = z.object({
  retryAfterSeconds: z.number().int().nonnegative(),
});
export type RateLimitedDetails = z.infer<typeof rateLimitedDetails>;

/** `details` of the 409 `scan_already_running` (08 section 7.2). An adoption signal: poll `scanId`. */
export const scanAlreadyRunningDetails = z.object({
  scanId: z.string(),
  pollUrl: z.string(),
});
export type ScanAlreadyRunningDetails = z.infer<typeof scanAlreadyRunningDetails>;

/**
 * `details` of a 409 `conflict`, one arm per cause (08 sections 4.8, 6.5, 7.1 and 7.3):
 *  - `originalScanId`: the same `Idempotency-Key` replayed with different scan terms;
 *  - `originalOrgId`: the same `Idempotency-Key` replayed with a different org `name` or `type`.
 *    10-CLI section 3.1 branches on its presence (exit 9) against the ceiling (exit 10);
 *  - `limit`, `current`, `tier`, `billingUrl`: the plan's workspace cap;
 *  - `fields`: the priced terms of a scan quote that moved since it was minted.
 */
export const conflictDetails = z.object({
  originalScanId: z.string().optional(),
  originalOrgId: z.string().optional(),
  limit: z.number().int().optional(),
  current: z.number().int().optional(),
  tier: z.enum(TIERS).optional(),
  billingUrl: z.string().url().optional(),
  fields: z.array(z.string()).optional(),
});
export type ConflictDetails = z.infer<typeof conflictDetails>;

/**
 * `details` of a 403 `feature_not_available` (08 sections 4.8 and 6.2): `billingUrl` when a human
 * with no paid org creates an organization, `limit` and `current` at the prompt cap,
 * `allowedFormats` on a report format the tier does not export.
 */
export const featureNotAvailableDetails = z.object({
  billingUrl: z.string().url().optional(),
  limit: z.number().int().optional(),
  current: z.number().int().optional(),
  allowedFormats: z.array(z.enum(REPORT_FORMATS)).optional(),
});
export type FeatureNotAvailableDetails = z.infer<typeof featureNotAvailableDetails>;

/**
 * `details` of a 422 `validation_failed` (08 sections 3.4 rule 2 and 4.3): `hint` names
 * `GET /api/v1/organizations` when a user key named no org; `issues` carries the Zod issues of a
 * body, query or cursor that failed its schema.
 */
export const validationFailedDetails = z.object({
  hint: z.string().optional(),
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
});
export type ValidationFailedDetails = z.infer<typeof validationFailedDetails>;

/** `details` of the 404 on GET /api/v1/scans/{scanId}/report while the scan is not `done` (08 section 4.8). */
export const reportNotFoundDetails = z.object({
  status: z.enum(SCAN_STATUSES),
});
export type ReportNotFoundDetails = z.infer<typeof reportNotFoundDetails>;

/**
 * The `details` schema per error code, for the codes 08 defines one for. `not_found` is deliberately
 * absent: a plain 404 carries no details, and only the report route's (`reportNotFoundDetails`) does.
 */
export const API_ERROR_DETAILS = {
  insufficient_credits: insufficientCreditsDetails,
  rate_limited: rateLimitedDetails,
  scan_already_running: scanAlreadyRunningDetails,
  conflict: conflictDetails,
  feature_not_available: featureNotAvailableDetails,
  validation_failed: validationFailedDetails,
} as const satisfies Partial<Record<ApiErrorCode, z.ZodTypeAny>>;

/**
 * Narrow an envelope's `details` by its `code`. Undefined when the payload does not match the shape
 * 08 defines for that code: a client branches on what the API defines, never on a locally guessed
 * shape (10-CLI section 12.2 rule 2).
 */
export function parseErrorDetails<C extends keyof typeof API_ERROR_DETAILS>(
  code: C,
  details: unknown,
): z.infer<(typeof API_ERROR_DETAILS)[C]> | undefined {
  const parsed = API_ERROR_DETAILS[code].safeParse(details);
  return parsed.success ? (parsed.data as z.infer<(typeof API_ERROR_DETAILS)[C]>) : undefined;
}

// ─── Pagination (08 section 4.4) ─────────────────────────────────────────────────────────────────

export const pagination = z.object({
  /** Opaque. `null` on the last page, and that (never an empty `data`) is the end signal. */
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().min(1).max(100),
});
export type Pagination = z.infer<typeof pagination>;

/** The `{ data, pagination }` envelope every list endpoint returns. */
export function page<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), pagination });
}
export type Page<T> = { data: T[]; pagination: Pagination };

/** Client-side query for a paginated list. The 1..100 bound is fixed on every endpoint. */
export const pageQuery = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    /** 08 section 4.6: list endpoints only, intersected with the serializer allowlist. */
    fields: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuery>;

export const scanListQuery = pageQuery
  .extend({
    status: z.enum(SCAN_STATUSES).optional(),
    /** ISO 8601 date or date-time, inclusive, against `created_at`. */
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();
export type ScanListQuery = z.infer<typeof scanListQuery>;

export const promptListQuery = pageQuery
  .extend({
    enabled: z.boolean().optional(),
    source: z.enum(PROMPT_SOURCES).optional(),
    stage: z.enum(INTENT_STAGES).optional(),
  })
  .strict();
export type PromptListQuery = z.infer<typeof promptListQuery>;

/** The three filters of GET /api/v1/scans/{scanId}/answers, applied server side in SQL. */
export const answerListQuery = pageQuery
  .extend({
    modelId: z.string().optional(),
    mentioned: z.boolean().optional(),
    lowConfidence: z.boolean().optional(),
  })
  .strict();
export type AnswerListQuery = z.infer<typeof answerListQuery>;

export const recommendationListQuery = pageQuery
  .extend({
    scanId: z.string().optional(),
    status: z.enum(RECOMMENDATION_STATUSES).optional(),
    type: z.enum(RECOMMENDATION_TYPES).optional(),
  })
  .strict();
export type RecommendationListQuery = z.infer<typeof recommendationListQuery>;

export const citationListQuery = pageQuery
  .extend({
    scanId: z.string().optional(),
    bucket: z.enum(CITATION_BUCKETS).optional(),
  })
  .strict();
export type CitationListQuery = z.infer<typeof citationListQuery>;

// ─── GET /api/v1/me ──────────────────────────────────────────────────────────────────────────────

export const meResponse = z.object({
  key: z.object({
    id: z.string(),
    name: z.string(),
    /** Display only, e.g. "wam_live_7Ka3Qp2m". Never sufficient to authenticate. */
    prefix: z.string(),
    last4: z.string(),
    kind: z.enum(API_KEY_KINDS),
    env: z.enum(API_KEY_ENVS),
    scopes: z.array(z.enum(API_SCOPES)),
    roleCeiling: z.enum(ORG_ROLES),
    expiresAt: z.string().nullable(),
  }),
  org: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    type: z.enum(ORG_TYPES),
  }),
  actor: z.object({
    userId: z.string(),
    role: z.enum(ORG_ROLES),
    effectiveRole: z.enum(ORG_ROLES),
  }),
  plan: z.object({
    tier: z.enum(TIERS),
    /** TIER_FEATURES[tier].label verbatim. */
    label: z.string(),
    mcp: z.boolean(),
    /** File download formats only; format=json on the report route is never gated. */
    exportFormats: z.array(z.enum(REPORT_FORMATS)),
    promptsPerWorkspace: z.number().int(),
    maxScanPrompts: z.number().int(),
  }),
  credits: z.object({
    balance: z.number().int(),
    /** CREDIT_UNIT_DESCRIPTION served verbatim. Never paraphrase it in a client or a fixture. */
    unit: z.string(),
  }),
});
export type Me = z.infer<typeof meResponse>;

// ─── Organizations ───────────────────────────────────────────────────────────────────────────────

export const organizationSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  tier: z.enum(TIERS),
  /** min(live role, roleCeiling): the power the caller actually gets, not the raw membership. */
  effectiveRole: z.enum(ORG_ROLES),
  workspaceCount: z.number().int(),
});
export type OrganizationSummary = z.infer<typeof organizationSummary>;

export const createOrganizationBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(ORG_TYPES),
  })
  .strict();
export type CreateOrganizationBody = z.infer<typeof createOrganizationBody>;

export const createOrganizationResult = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    type: z.enum(ORG_TYPES),
    tier: z.enum(TIERS),
    /** Always false on a fresh create; recomputed as tier !== "free" on an idempotent replay (08 section 7.3). */
    usable: z.boolean(),
    subscribeUrl: z.string().url(),
    /** User-visible copy. Print it verbatim. Present only while `usable` is false (08 section 7.3). */
    message: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.usable && v.message === undefined) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "message is required while usable is false" });
    }
    if (v.usable && v.message !== undefined) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "message must be absent when usable is true" });
    }
  });
export type CreateOrganizationResult = z.infer<typeof createOrganizationResult>;

// ─── Workspaces ──────────────────────────────────────────────────────────────────────────────────

export const latestScanRef = z.object({
  id: z.string(),
  status: z.enum(SCAN_STATUSES),
  finishedAt: z.string().nullable(),
  score: z.number().nullable(),
});
export type LatestScanRef = z.infer<typeof latestScanRef>;

/** Exactly WORKSPACE_FIELDS (08 section 4.7), in that order. */
export const workspaceSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  brandName: z.string().nullable(),
  defaultRegion: z.string(),
  defaultLanguage: z.string(),
  /** Boolean only. The key itself, encrypted or not, never leaves the server. */
  usesOwnKey: z.boolean(),
  promptCount: z.number().int(),
  enabledPromptCount: z.number().int(),
  /** null when the workspace has never completed a scan. */
  latestScan: latestScanRef.nullable(),
  /** null when nothing is queued or running. */
  activeScanId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummary>;

/** Exactly WORKSPACE_DETAIL_FIELDS: the list entry plus `competitorCount`. */
export const workspaceDetail = workspaceSummary.extend({
  competitorCount: z.number().int(),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetail>;

/**
 * Only `name`. The org is never read from the body (08 section 3.5(a)): it travels as
 * `X-Wam-Org`, and `.strict()` makes an `orgSlug` field a 422.
 */
export const createWorkspaceBody = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBody>;

// ─── Competitors ─────────────────────────────────────────────────────────────────────────────────

export const competitor = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  aliases: z.array(z.string()),
  createdAt: z.string(),
});
export type Competitor = z.infer<typeof competitor>;

export const createCompetitorBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    domain: z.string().trim().max(253).optional(),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  })
  .strict();
export type CreateCompetitorBody = z.input<typeof createCompetitorBody>;

// ─── Prompts ─────────────────────────────────────────────────────────────────────────────────────

export const prompt = z.object({
  id: z.string(),
  text: z.string(),
  intentStage: z.enum(INTENT_STAGES),
  persona: z.string(),
  type: z.enum(PROMPT_TYPES),
  topic: z.string().nullable(),
  isBranded: z.boolean(),
  tags: z.array(z.string()),
  source: z.enum(PROMPT_SOURCES),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type Prompt = z.infer<typeof prompt>;

/** The only list envelope with extra keys: the cap is meaningless without the list beside it. */
export const promptListResponse = page(prompt).extend({
  promptsPerWorkspace: z.number().int(),
  maxScanPrompts: z.number().int(),
});
export type PromptListResponse = z.infer<typeof promptListResponse>;

export const createPromptBody = z
  .object({
    text: z.string().trim().min(8).max(400),
    intentStage: z.enum(INTENT_STAGES).default("research"),
    persona: z.string().trim().max(80).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreatePromptBody = z.input<typeof createPromptBody>;

export const patchPromptBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type PatchPromptBody = z.infer<typeof patchPromptBody>;

export const deletePromptResult = z.object({
  deleted: z.literal(true),
  id: z.string(),
});
export type DeletePromptResult = z.infer<typeof deletePromptResult>;

// ─── Scans ───────────────────────────────────────────────────────────────────────────────────────

export const scanSummary = z.object({
  id: z.string(),
  status: z.enum(SCAN_STATUSES),
  mode: z.enum(SCAN_MODES),
  repetitions: z.number().int(),
  /** modelIds.length as stored: the roster the scan actually ran with. */
  modelCount: z.number().int(),
  /** The stored prompt_count column, never recomputed. */
  promptCount: z.number().int(),
  creditsSpent: z.number().int().nullable(),
  /** The overall ai_visibility_score, null until done. */
  score: z.number().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScanSummary = z.infer<typeof scanSummary>;

export const scanProgress = z.object({
  done: z.number().int(),
  /**
   * Grows while the scan runs (adaptive re-runs are planned as it goes), so a naive done/total
   * percentage moves backwards. Render a percentage only when `totalIsFinal` is true.
   */
  total: z.number().int(),
  /** status === "done" || status === "failed". */
  totalIsFinal: z.boolean(),
});
export type ScanProgress = z.infer<typeof scanProgress>;

export const scanStatus = z.object({
  id: z.string(),
  workspaceSlug: z.string(),
  status: z.enum(SCAN_STATUSES),
  mode: z.enum(SCAN_MODES),
  repetitions: z.number().int(),
  progress: scanProgress,
  creditsReserved: z.number().int(),
  creditsSpent: z.number().int().nullable(),
  score: z.number().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScanStatus = z.infer<typeof scanStatus>;

export const scanModelRef = z.object({
  id: z.string(),
  displayName: z.string(),
});
export type ScanModelRef = z.infer<typeof scanModelRef>;

/** POST /api/v1/workspaces/{ws}/scans/estimate: free, charges nothing, touches no ledger. */
export const scanEstimate = z.object({
  /** prompts x models.length x repetitions (x2 when mode is "both"). Tier-derived, never a constant. */
  credits: z.number().int(),
  prompts: z.number().int(),
  models: z.array(scanModelRef),
  repetitions: z.number().int(),
  mode: z.enum(SCAN_MODES),
  balance: z.number().int(),
  sufficient: z.boolean(),
  /** BYOK reserves zero credits and skips the ledger. */
  usesOwnKey: z.boolean(),
  quote: z.object({
    token: z.string(),
    expiresAt: z.string(),
  }),
});
export type ScanEstimate = z.infer<typeof scanEstimate>;

/** Body of the estimate call: reserved for future options. */
export const estimateScanBody = z.object({}).strict();
export type EstimateScanBody = z.infer<typeof estimateScanBody>;

/** `mode` and `repetitions` are deliberately NOT accepted (08 section 6.3): `.strict()` 422s them. */
export const createScanBody = z
  .object({
    /** Optional here, MANDATORY on the MCP run_scan tool (08 section 6.5). */
    quote: z.string().optional(),
  })
  .strict();
export type CreateScanBody = z.infer<typeof createScanBody>;

export const createScanResult = z.object({
  id: z.string(),
  status: z.enum(SCAN_STATUSES),
  credits: z.number().int(),
  prompts: z.number().int(),
  models: z.number().int(),
  /** The balance now on an idempotent replay, the balance at creation on a 201. */
  balanceAfter: z.number().int(),
  pollUrl: z.string(),
});
export type CreateScanResult = z.infer<typeof createScanResult>;

/** `Idempotency-Key` header value: 1..128 chars of [A-Za-z0-9_.:-] (08 section 7.1). */
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

// ─── Answers (the transparency wedge) ────────────────────────────────────────────────────────────

/** 1200 characters and 25 citations are the numbers everywhere. They are not tuning knobs. */
export const ANSWER_TEXT_MAX_CHARS = 1200;
export const ANSWER_CITATIONS_MAX = 25;

export const answerCitation = z.object({
  url: z.string(),
  domain: z.string(),
});
export type AnswerCitation = z.infer<typeof answerCitation>;

export const brandPresent = z.object({
  name: z.string(),
  is_target: z.boolean(),
  rank: z.number().int().nullable(),
});
export type BrandPresent = z.infer<typeof brandPresent>;

export const scanAnswer = z.object({
  answerId: z.string(),
  promptId: z.string(),
  promptText: z.string(),
  intentStage: z.enum(INTENT_STAGES),
  modelId: z.string(),
  modelName: z.string(),
  grounded: z.boolean(),
  brandMentioned: z.boolean(),
  brandPosition: z.number().int().nullable(),
  sentiment: z.enum(SENTIMENTS),
  brandsPresent: z.array(brandPresent),
  citations: z.array(answerCitation).max(ANSWER_CITATIONS_MAX),
  confidence: z.number(),
  lowConfidence: z.boolean(),
  /** Truncated to 1200 characters. Full answer text is never returned by the API. */
  answerText: z.string().max(ANSWER_TEXT_MAX_CHARS),
  answerTextTruncated: z.boolean(),
});
export type ScanAnswer = z.infer<typeof scanAnswer>;

// ─── Recommendations and citations ───────────────────────────────────────────────────────────────

export const recommendation = z.object({
  id: z.string(),
  type: z.enum(RECOMMENDATION_TYPES),
  title: z.string(),
  body: z.string(),
  impact: z.number().int(),
  effort: z.number().int(),
  priority: z.number(),
  status: z.enum(RECOMMENDATION_STATUSES),
  scanId: z.string().nullable(),
  createdAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendation>;

export const citation = z.object({
  domain: z.string(),
  count: z.number().int(),
  share: z.number(),
  bucket: z.enum(CITATION_BUCKETS),
});
export type Citation = z.infer<typeof citation>;

// ─── Credits ─────────────────────────────────────────────────────────────────────────────────────

export const credits = z.object({
  balance: z.number().int(),
  tier: z.enum(TIERS),
  monthlyCredits: z.number().int(),
  /** CREDIT_UNIT_DESCRIPTION verbatim. */
  unit: z.string(),
  /** Scans remaining at the maximum scan size for your tier. Never "for workspace X". */
  estimatedScansRemaining: z.number().int(),
});
export type Credits = z.infer<typeof credits>;

// ─── DELETE /api/v1/keys/self ────────────────────────────────────────────────────────────────────

/** `all` is the literal string "cli" or nothing. The server 422s on any other value. */
export const revokeSelfQuery = z.object({ all: z.literal("cli").optional() }).strict();

export const revokeSelfResult = z.object({
  revoked: z.number().int(),
  self: z.literal(true),
  scope: z.literal("cli").optional(),
});
export type RevokeSelfResult = z.infer<typeof revokeSelfResult>;

// ─── The scan quote (08 section 6.5) ─────────────────────────────────────────────────────────────

/**
 * The signed payload behind `scanEstimate.quote.token`: base64url(payload) + "." + base64url(mac),
 * HMAC-SHA256 over the canonical JSON, 5 minute TTL, `modelIds` sorted lexically before signing.
 * Minting and verification live in src/api/quote.ts; this is the shape only.
 */
export const quotePayload = z.object({
  /** Payload version. Bumped if any field below changes meaning. */
  v: z.literal(1),
  orgId: z.string(),
  workspaceId: z.string(),
  /** The key this quote was minted FOR. */
  keyId: z.string(),
  promptCount: z.number().int(),
  /** The resolved roster, by id, not a count. */
  modelIds: z.array(z.string()),
  repetitions: z.number().int(),
  mode: z.enum(SCAN_MODES),
  creditCost: z.number().int(),
  /** BYOK reserves zero credits, so a BYOK quote is not interchangeable with a metered one. */
  byok: z.boolean(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type QuotePayload = z.infer<typeof quotePayload>;
export const QUOTE_TTL_SECONDS = 300;

// ─── The visibility report (GET /api/v1/scans/{scanId}/report?format=json) ───────────────────────

/**
 * Mirrors `ReportData` from ./report-data.ts field for field. That interface is the canonical
 * response schema and is served verbatim; this zod schema exists so the wire can be validated in
 * tests. The assertion below makes the two inseparable: change one and the other fails to
 * typecheck.
 */
export const reportData = z.object({
  /** The scan the report describes (08 section 4.8): on the interface itself, not added by a client. */
  scanId: z.string(),
  brandName: z.string(),
  workspaceName: z.string(),
  scanDate: z.string(),
  score: z.number(),
  presenceRate: z.number(),
  presenceCiLow: z.number(),
  presenceCiHigh: z.number(),
  sov: z.number(),
  sentimentScore: z.number().nullable(),
  brandCitationShare: z.number(),
  perModel: z.array(z.object({ model: z.string(), score: z.number() })),
  competitors: z.array(
    z.object({
      name: z.string(),
      mentions: z.number(),
      sov: z.number(),
      isTarget: z.boolean(),
    }),
  ),
  citations: z.array(
    z.object({
      domain: z.string(),
      count: z.number(),
      share: z.number(),
      /** Narrowed to CITATION_BUCKETS (08 section 4.8 change 2): one source for the filter and the OpenAPI enum. */
      bucket: z.enum(CITATION_BUCKETS),
    }),
  ),
  recommendations: z.array(
    z.object({ title: z.string(), body: z.string(), priority: z.number() }),
  ),
  methodologyVersion: z.string(),
});

/** Mutual assignability, checked at the type level. Drift in either direction fails typecheck. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
type _ReportDataSchemaMatchesInterface = Expect<
  MutuallyAssignable<z.infer<typeof reportData>, ReportData>
>;

// ─── The seven no-account site tools (09 section 6.1, served at POST /api/site/*) ────────────────

export const siteUrlInput = z.object({ url: z.string().url() }).strict();

const severityFinding = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
});

/** T1 check_ai_crawler_access / POST /api/site/check-crawlers */
export const crawlerAccessResult = z.object({
  origin: z.string(),
  robotsStatus: z.number().int(),
  /** 4xx on robots.txt: everything is allowed. */
  robotsMissing: z.boolean(),
  /** 5xx: compliant crawlers treat this as full disallow. */
  robotsServerError: z.boolean(),
  truncated: z.boolean(),
  sitemaps: z.array(z.string()),
  bots: z.array(
    z.object({
      token: z.string(),
      operator: z.string(),
      category: z.string(),
      /** Operator reputation, not a guarantee. robots.txt is voluntary. Never coerce to a boolean. */
      respectsRobots: z.enum(["yes", "no", "unverified"]),
      allowed: z.boolean(),
      via: z.enum(["named", "wildcard", "none"]),
      matchedLine: z.number().int().nullable(),
      note: z.string().nullable(),
      untrusted: z.object({
        /** The verbatim robots.txt line that decided it. Third-party text, not instructions. */
        matchedRule: z.string().nullable(),
      }),
    }),
  ),
  summary: z.object({ allowed: z.number().int(), blocked: z.number().int() }),
});
export type CrawlerAccessResult = z.infer<typeof crawlerAccessResult>;

/** T2 validate_llms_txt / POST /api/site/validate-llms-txt */
export const llmsTxtValidation = z.object({
  origin: z.string(),
  status: z.number().int(),
  missing: z.boolean(),
  score: z.number().int().min(0).max(100).nullable(),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      line: z.number().int().optional(),
    }),
  ),
  stats: z
    .object({
      lines: z.number().int(),
      bytes: z.number().int(),
      sections: z.number().int(),
      entries: z.number().int(),
      entriesWithDescription: z.number().int(),
    })
    .nullable(),
  linksChecked: z.number().int(),
  brokenLinks: z.array(z.object({ url: z.string(), status: z.number().int() })).max(30),
  hasLlmsFullTxt: z.boolean(),
});
export type LlmsTxtValidation = z.infer<typeof llmsTxtValidation>;

export const LLMS_TXT_DEPTHS = ["index", "full"] as const;
export type LlmsTxtDepth = (typeof LLMS_TXT_DEPTHS)[number];

export const generateLlmsTxtInput = z
  .object({
    url: z.string().url(),
    depth: z.enum(LLMS_TXT_DEPTHS).default("index"),
    siteName: z.string().max(120).optional(),
    description: z.string().max(400).optional(),
  })
  .strict();
export type GenerateLlmsTxtInput = z.input<typeof generateLlmsTxtInput>;

/** T3 generate_llms_txt / POST /api/site/generate-llms-txt */
export const llmsTxtGeneration = z.object({
  untrusted: z.object({
    /** The generated file. Untrusted: derived from third-party pages. */
    content: z.string(),
  }),
  depth: z.enum(LLMS_TXT_DEPTHS),
  pageCount: z.number().int(),
  skippedCount: z.number().int(),
  discoveredVia: z.enum(["sitemap", "links", "sitemap+links"]),
  timedOut: z.boolean(),
  notices: z.array(z.string()),
  totalWords: z.number().int().optional(),
  estTokens: z.number().int().optional(),
});
export type LlmsTxtGeneration = z.infer<typeof llmsTxtGeneration>;

/** T4 generate_sitemap / POST /api/site/generate-sitemap */
export const sitemapGeneration = z.object({
  untrusted: z.object({
    /** The generated sitemap. Untrusted: URLs discovered on a third-party site. */
    xml: z.string(),
  }),
  urlCount: z.number().int(),
  skipped: z.number().int(),
  discoveredVia: z.enum(["sitemap", "links", "sitemap+links"]),
  timedOut: z.boolean(),
});
export type SitemapGeneration = z.infer<typeof sitemapGeneration>;

/** T5 analyze_content_chunking / POST /api/site/analyze-chunks. Never carries `html`. */
export const chunkAnalysisResult = z.object({
  url: z.string(),
  mode: z.enum(["html", "text"]),
  score: z.number().int().min(0).max(100),
  errors: z.number().int(),
  warnings: z.number().int(),
  strengthCount: z.number().int(),
  totalWords: z.number().int(),
  totalTokens: z.number().int(),
  topFixes: z.array(z.string()).max(5),
  docFindings: z.array(severityFinding),
  chunks: z
    .array(
      z.object({
        level: z.number().int().min(0).max(6),
        untrusted: z.object({
          /** Third-party page text, not an instruction. */
          heading: z.string().nullable(),
        }),
        words: z.number().int(),
        tokens: z.number().int(),
        paragraphs: z.number().int(),
        longestParagraphWords: z.number().int(),
        findings: z.array(severityFinding),
        strengths: z.array(z.string()),
      }),
    )
    .max(150),
});
export type ChunkAnalysisResult = z.infer<typeof chunkAnalysisResult>;

/** T6 validate_structured_data / POST /api/site/validate-structured-data. Never raw JSON-LD. */
export const structuredDataValidation = z.object({
  url: z.string(),
  score: z.number().int().min(0).max(100),
  entityCount: z.number().int(),
  errors: z.number().int(),
  warnings: z.number().int(),
  passes: z.number().int(),
  microdataCount: z.number().int(),
  rdfaCount: z.number().int(),
  blocks: z
    .array(
      z.object({
        index: z.number().int(),
        syntaxError: z.string().optional(),
        entities: z.array(
          z.object({
            type: z.string(),
            untrusted: z.object({
              /** Entity name as published on the page. Data, not instructions. */
              name: z.string().optional(),
            }),
            aiNote: z.string().optional(),
            findings: z.array(
              z.object({
                severity: z.enum(["error", "warning", "pass", "info"]),
                message: z.string(),
              }),
            ),
          }),
        ),
      }),
    )
    .max(50),
});
export type StructuredDataValidation = z.infer<typeof structuredDataValidation>;

export const checkMetaInput = z
  .object({
    url: z.string().url(),
    /** Optional target keyword to check for presence and position. */
    keyword: z.string().max(100).optional(),
  })
  .strict();
export type CheckMetaInput = z.infer<typeof checkMetaInput>;

const metaCheck = z.object({
  level: z.enum(["error", "warning", "suggestion", "pass"]),
  message: z.string(),
});

/** T7 check_meta_description / POST /api/site/check-meta */
export const metaAnalysisResult = z.object({
  url: z.string(),
  /** Third-party page text. DATA, never instructions. */
  untrusted: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    ogDescription: z.string().nullable(),
    firstParagraph: z.string().nullable(),
  }),
  score: z.number().int().min(0).max(100),
  chars: z.number().int(),
  pixels: z.number().int(),
  desktopCutoff: z.number().int().nullable(),
  mobileCutoff: z.number().int().nullable(),
  checks: z.array(metaCheck),
  openingParagraphChecks: z.array(metaCheck),
});
export type MetaAnalysisResult = z.infer<typeof metaAnalysisResult>;

/**
 * The seven no-account routes, by client method name. One table so a rename happens in one place.
 * They live at /api/site/*, deliberately outside /api/v1 (08 section 1.2, 10 section 3.9).
 */
export const SITE_ROUTES = {
  checkCrawlers: "check-crawlers",
  validateLlmsTxt: "validate-llms-txt",
  generateLlmsTxt: "generate-llms-txt",
  generateSitemap: "generate-sitemap",
  validateStructuredData: "validate-structured-data",
  checkMeta: "check-meta",
  analyzeChunks: "analyze-chunks",
} as const;
export type SiteRoute = (typeof SITE_ROUTES)[keyof typeof SITE_ROUTES];
