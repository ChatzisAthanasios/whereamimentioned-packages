/**
 * The const tuples that appear on the wire of the public API (08-PUBLIC-API section 4), each a
 * `const` tuple so one value serves Zod `z.enum(...)`, the TypeScript union and, in the app, the
 * Drizzle `pgEnum(...)` of the same column.
 *
 * This file is the single source of truth for these fifteen. The app's `src/types/enums.ts`
 * re-exports them from here BY IDENTITY (never a copy), so the database enum, the API contract
 * and every client agree by construction. The direction matters: the package must build on its
 * own in the public mirror (10-CLI section 10.2), which carries `packages/**` and nothing of
 * `src/`, so nothing in this package may import from the app. App-only enums (subscription
 * statuses, credit reasons, alert channels) stay in the app.
 */

export const ORG_TYPES = ["agency", "brand"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ORG_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

// `free` is retained as the internal locked floor for any org without an active paid subscription
// (it is never sold, see the app's plans.ts). `single` is the entry plan. Keep the DB pgEnum in sync.
export const TIERS = ["free", "single", "pro", "agency", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

export const INTENT_STAGES = ["awareness", "research", "comparison", "purchase", "branded"] as const;
export type IntentStage = (typeof INTENT_STAGES)[number];

export const PROMPT_TYPES = [
  "category",
  "competitor_comparison",
  "use_case",
  "persona_need",
  "branded",
] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export const PROMPT_SOURCES = ["generated", "template", "custom"] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

export const SENTIMENTS = ["positive", "neutral", "negative", "not_present"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SCAN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_MODES = ["grounded", "raw", "both"] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

export const CITATION_BUCKETS = ["owned", "competitor", "third_party"] as const;
export type CitationBucket = (typeof CITATION_BUCKETS)[number];

export const RECOMMENDATION_STATUSES = ["open", "done", "dismissed"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export const RECOMMENDATION_TYPES = [
  "losing_prompt",
  "power_source",
  "low_prominence",
  "reputation_risk",
  "citation_gap",
  "ai_readiness",
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const REPORT_FORMATS = ["pdf", "csv", "json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** API key scopes (08 section 2.5). A scope RESTRICTS the minting member, it never grants. */
export const API_SCOPES = [
  "workspaces:read",
  "workspaces:write",
  "scans:read",
  "scans:write",
  "reports:read",
  "prompts:read",
  "prompts:write",
  "competitors:read",
  "competitors:write",
  "orgs:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** The default set offered as "Read only" in the dashboard. */
export const READ_ONLY_SCOPES = [
  "workspaces:read",
  "scans:read",
  "reports:read",
  "prompts:read",
  "competitors:read",
] as const satisfies readonly ApiScope[];
