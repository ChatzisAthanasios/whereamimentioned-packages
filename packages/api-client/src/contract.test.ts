import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { ReportData } from "./report-data";
import {
  API_ERROR_CODES,
  API_ERROR_DETAILS,
  API_SCOPES,
  INTENT_STAGES,
  READ_ONLY_SCOPES,
  SCAN_STATUSES,
  SITE_ROUTES,
  answerListQuery,
  apiErrorBody,
  conflictDetails,
  featureNotAvailableDetails,
  parseErrorDetails,
  reportNotFoundDetails,
  scanAlreadyRunningDetails,
  validationFailedDetails,
  chunkAnalysisResult,
  citation,
  citationListQuery,
  competitor,
  crawlerAccessResult,
  createCompetitorBody,
  createOrganizationBody,
  createOrganizationResult,
  createPromptBody,
  createScanBody,
  createScanResult,
  createWorkspaceBody,
  credits,
  deletePromptResult,
  estimateScanBody,
  generateLlmsTxtInput,
  idempotencyKey,
  insufficientCreditsDetails,
  llmsTxtGeneration,
  llmsTxtValidation,
  meResponse,
  metaAnalysisResult,
  organizationSummary,
  page,
  pageQuery,
  pagination,
  patchPromptBody,
  prompt,
  promptListQuery,
  promptListResponse,
  quotePayload,
  rateLimitedDetails,
  recommendation,
  recommendationListQuery,
  reportData,
  requestId,
  revokeSelfResult,
  scanAnswer,
  scanEstimate,
  scanListQuery,
  scanStatus,
  scanSummary,
  sitemapGeneration,
  structuredDataValidation,
  workspaceDetail,
  workspaceSummary,
} from "./contract";
import * as enums from "./enums";

const REQUEST_ID = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UUID = "3f9c1e2a-7b4d-4c8e-9a1f-2b3c4d5e6f70";
const ISO = "2026-08-27T09:14:02.000Z";
const UNIT = "1 credit = 1 answer (one prompt × one model × one run)";

const workspaceFixture = {
  id: UUID,
  slug: "acme-eu",
  name: "Acme EU",
  brandName: "Acme",
  defaultRegion: "eu",
  defaultLanguage: "en",
  usesOwnKey: false,
  promptCount: 14,
  enabledPromptCount: 6,
  latestScan: { id: UUID, status: "done", finishedAt: ISO, score: 61 },
  activeScanId: null,
  createdAt: ISO,
  updatedAt: ISO,
};

const promptFixture = {
  id: UUID,
  text: "What is the best CRM for a small agency?",
  intentStage: "research",
  persona: "agency owner",
  type: "category",
  topic: null,
  isBranded: false,
  tags: ["crm"],
  source: "custom",
  enabled: true,
  createdAt: ISO,
};

const scanSummaryFixture = {
  id: UUID,
  status: "done",
  mode: "grounded",
  repetitions: 1,
  modelCount: 4,
  promptCount: 6,
  creditsSpent: 24,
  score: 61,
  createdAt: ISO,
  startedAt: ISO,
  finishedAt: ISO,
  error: null,
};

const reportFixture: ReportData = {
  scanId: UUID,
  brandName: "Acme",
  workspaceName: "Acme EU",
  scanDate: "2026-08-27",
  score: 61,
  presenceRate: 0.5,
  presenceCiLow: 0.31,
  presenceCiHigh: 0.69,
  sov: 0.22,
  sentimentScore: 0.4,
  brandCitationShare: 0.1,
  perModel: [{ model: "openai/gpt-5.5", score: 70 }],
  competitors: [{ name: "Globex", mentions: 3, sov: 0.3, isTarget: false }],
  citations: [{ domain: "acme.com", count: 4, share: 0.2, bucket: "owned" }],
  recommendations: [{ title: "Publish a comparison page", body: "Globex wins comparison prompts.", priority: 9 }],
  methodologyVersion: "2026-08",
};

const pageEnvelope = { nextCursor: null, hasMore: false, limit: 25 };

/**
 * One row per schema: a realistic payload that must parse, and a malformed one that must not.
 * The malformed case breaks exactly one thing, so a schema that is accidentally permissive on
 * that field fails here rather than in a customer's CI.
 */
const cases: Array<{ name: string; schema: z.ZodTypeAny; valid: unknown; invalid: unknown }> = [
  {
    name: "requestId",
    schema: requestId,
    valid: REQUEST_ID,
    // I, L, O and U are not in the Crockford alphabet, and 25 chars is a truncated fixture.
    invalid: "req_01ARZ3NDEKTSV4RRFFQ69G5FA",
  },
  {
    name: "apiErrorBody",
    schema: apiErrorBody,
    valid: {
      error: {
        code: "insufficient_credits",
        message: "This scan needs 24 credits and the organization has 11.",
        requestId: REQUEST_ID,
        details: { required: 24, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" },
      },
    },
    invalid: { error: { code: "forbidden_tier", message: "x", requestId: REQUEST_ID } },
  },
  {
    name: "insufficientCreditsDetails",
    schema: insufficientCreditsDetails,
    valid: { required: 24, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" },
    invalid: { required: 24, available: 11 },
  },
  {
    name: "rateLimitedDetails",
    schema: rateLimitedDetails,
    valid: { retryAfterSeconds: 42 },
    invalid: { retryAfterSeconds: -1 },
  },
  {
    name: "pagination",
    schema: pagination,
    valid: { nextCursor: "eyJ0cyI6", hasMore: true, limit: 25 },
    invalid: { nextCursor: "eyJ0cyI6", hasMore: true, limit: 101 },
  },
  {
    name: "page(workspaceSummary)",
    schema: page(workspaceSummary),
    valid: { data: [workspaceFixture], pagination: pageEnvelope },
    invalid: { data: [workspaceFixture], pagination: { nextCursor: null, hasMore: false } },
  },
  {
    name: "pageQuery",
    schema: pageQuery,
    valid: { limit: 100, cursor: "eyJ0cyI6", fields: ["id", "slug"] },
    invalid: { limit: 0 },
  },
  {
    name: "scanListQuery",
    schema: scanListQuery,
    valid: { limit: 10, status: "done", from: "2026-08-01", to: "2026-08-31T23:59:59Z" },
    invalid: { status: "finished" },
  },
  {
    name: "promptListQuery",
    schema: promptListQuery,
    valid: { enabled: true, source: "custom", stage: "comparison" },
    invalid: { enabled: "yes" },
  },
  {
    name: "answerListQuery",
    schema: answerListQuery,
    valid: { limit: 20, modelId: "openai/gpt-5.5", mentioned: false, lowConfidence: true },
    invalid: { filter: "mentioned" },
  },
  {
    name: "recommendationListQuery",
    schema: recommendationListQuery,
    valid: { scanId: UUID, status: "open", type: "citation_gap" },
    invalid: { status: "closed" },
  },
  {
    name: "citationListQuery",
    schema: citationListQuery,
    valid: { scanId: UUID, bucket: "third_party" },
    invalid: { bucket: "thirdparty" },
  },
  {
    name: "meResponse",
    schema: meResponse,
    valid: {
      key: {
        id: UUID,
        name: "CI deploy",
        prefix: "wam_live_7Ka3Qp2m",
        last4: "9fQz",
        kind: "org",
        env: "live",
        scopes: ["scans:read", "reports:read"],
        roleCeiling: "member",
        expiresAt: "2026-11-26T00:00:00.000Z",
      },
      org: { id: UUID, slug: "acme", name: "Acme Ltd", type: "brand" },
      actor: { userId: UUID, role: "admin", effectiveRole: "member" },
      plan: {
        tier: "single",
        label: "Single Brand",
        mcp: true,
        exportFormats: ["csv"],
        promptsPerWorkspace: 15,
        maxScanPrompts: 6,
      },
      credits: { balance: 48, unit: UNIT },
    },
    invalid: {
      key: {
        id: UUID,
        name: "CI deploy",
        prefix: "wam_live_7Ka3Qp2m",
        last4: "9fQz",
        kind: "service",
        env: "live",
        scopes: [],
        roleCeiling: "member",
        expiresAt: null,
      },
      org: { id: UUID, slug: "acme", name: "Acme Ltd", type: "brand" },
      actor: { userId: UUID, role: "admin", effectiveRole: "member" },
      plan: { tier: "single", label: "Single Brand", mcp: true, exportFormats: [], promptsPerWorkspace: 15, maxScanPrompts: 6 },
      credits: { balance: 48, unit: UNIT },
    },
  },
  {
    name: "organizationSummary",
    schema: organizationSummary,
    valid: { id: UUID, slug: "acme", name: "Acme Ltd", tier: "single", effectiveRole: "member", workspaceCount: 1 },
    invalid: { id: UUID, slug: "acme", name: "Acme Ltd", tier: "single", role: "member", workspaceCount: 1 },
  },
  {
    name: "createOrganizationBody",
    schema: createOrganizationBody,
    valid: { name: "Acme Labs", type: "agency" },
    invalid: { name: "Acme Labs" },
  },
  {
    name: "createOrganizationResult",
    schema: createOrganizationResult,
    valid: {
      id: UUID,
      slug: "acme-labs",
      name: "Acme Labs",
      type: "brand",
      tier: "free",
      usable: false,
      subscribeUrl: "https://whereamimentioned.com/acme-labs/billing",
      message: "The organization was created on the free floor and cannot run scans yet.",
    },
    invalid: { id: UUID, slug: "acme-labs", name: "Acme Labs", type: "brand", tier: "free", usable: "no", subscribeUrl: "x", message: "" },
  },
  {
    // 08 section 7.3: a replay after a human subscribed reports usable: true and carries no message.
    name: "createOrganizationResult (usable replay)",
    schema: createOrganizationResult,
    valid: {
      id: UUID,
      slug: "acme-labs",
      name: "Acme Labs",
      type: "brand",
      tier: "single",
      usable: true,
      subscribeUrl: "https://whereamimentioned.com/acme-labs/billing",
    },
    // The 201 shape with its message dropped: message is required while usable is false.
    invalid: {
      id: UUID,
      slug: "acme-labs",
      name: "Acme Labs",
      type: "brand",
      tier: "free",
      usable: false,
      subscribeUrl: "https://whereamimentioned.com/acme-labs/billing",
    },
  },
  {
    name: "scanAlreadyRunningDetails",
    schema: scanAlreadyRunningDetails,
    valid: { scanId: UUID, pollUrl: `/api/v1/scans/${UUID}` },
    invalid: { scanId: UUID },
  },
  {
    name: "conflictDetails (workspace cap)",
    schema: conflictDetails,
    valid: { limit: 1, current: 1, tier: "single", billingUrl: "https://whereamimentioned.com/acme/billing" },
    invalid: { limit: 1, current: 1, tier: "gold", billingUrl: "https://whereamimentioned.com/acme/billing" },
  },
  {
    name: "conflictDetails (idempotency replay with different terms)",
    schema: conflictDetails,
    valid: { originalOrgId: UUID },
    invalid: { originalScanId: 42 },
  },
  {
    name: "featureNotAvailableDetails",
    schema: featureNotAvailableDetails,
    valid: { allowedFormats: ["csv"] },
    invalid: { allowedFormats: ["xlsx"] },
  },
  {
    name: "validationFailedDetails",
    schema: validationFailedDetails,
    valid: { hint: "Set X-Wam-Org to one of the slugs from GET /api/v1/organizations." },
    invalid: { hint: 42 },
  },
  {
    name: "reportNotFoundDetails",
    schema: reportNotFoundDetails,
    valid: { status: "running" },
    invalid: { status: "complete" },
  },
  {
    name: "workspaceSummary",
    schema: workspaceSummary,
    valid: workspaceFixture,
    invalid: { ...workspaceFixture, latestScan: { id: UUID, status: "done" } },
  },
  {
    name: "workspaceDetail",
    schema: workspaceDetail,
    valid: { ...workspaceFixture, competitorCount: 3 },
    invalid: workspaceFixture,
  },
  {
    name: "createWorkspaceBody",
    schema: createWorkspaceBody,
    valid: { name: "Acme EU" },
    invalid: { name: "" },
  },
  {
    name: "competitor",
    schema: competitor,
    valid: { id: UUID, name: "Globex", domain: "globex.com", aliases: ["Globex Corp"], createdAt: ISO },
    invalid: { id: UUID, name: "Globex", domain: "globex.com", aliases: "Globex Corp", createdAt: ISO },
  },
  {
    name: "createCompetitorBody",
    schema: createCompetitorBody,
    valid: { name: "Globex", domain: "globex.com" },
    invalid: { name: "Globex", aliases: new Array(21).fill("a") },
  },
  {
    name: "prompt",
    schema: prompt,
    valid: promptFixture,
    invalid: { ...promptFixture, intentStage: "discovery" },
  },
  {
    name: "promptListResponse",
    schema: promptListResponse,
    valid: { data: [promptFixture], pagination: pageEnvelope, promptsPerWorkspace: 15, maxScanPrompts: 6 },
    invalid: { data: [promptFixture], pagination: pageEnvelope },
  },
  {
    name: "createPromptBody",
    schema: createPromptBody,
    valid: { text: "Which CRM suits a ten-person agency?", intentStage: "comparison" },
    // Seven characters: one under the min(8) floor.
    invalid: { text: "Too sho" },
  },
  {
    name: "patchPromptBody",
    schema: patchPromptBody,
    valid: { enabled: false },
    invalid: { enabled: false, text: "cannot change this" },
  },
  {
    name: "deletePromptResult",
    schema: deletePromptResult,
    valid: { deleted: true, id: UUID },
    invalid: { deleted: false, id: UUID },
  },
  {
    name: "scanSummary",
    schema: scanSummary,
    valid: scanSummaryFixture,
    invalid: { ...scanSummaryFixture, status: "complete" },
  },
  {
    name: "scanStatus",
    schema: scanStatus,
    valid: {
      id: UUID,
      workspaceSlug: "acme-eu",
      status: "running",
      mode: "grounded",
      repetitions: 1,
      progress: { done: 14, total: 24, totalIsFinal: false },
      creditsReserved: 24,
      creditsSpent: null,
      score: null,
      createdAt: ISO,
      startedAt: ISO,
      finishedAt: null,
      error: null,
    },
    invalid: {
      id: UUID,
      workspaceSlug: "acme-eu",
      status: "running",
      mode: "grounded",
      repetitions: 1,
      progress: { done: 14, total: 24 },
      creditsReserved: 24,
      creditsSpent: null,
      score: null,
      createdAt: ISO,
      startedAt: ISO,
      finishedAt: null,
      error: null,
    },
  },
  {
    name: "scanEstimate",
    schema: scanEstimate,
    valid: {
      credits: 24,
      prompts: 6,
      models: [{ id: "openai/gpt-5.5", displayName: "GPT-5.5" }],
      repetitions: 1,
      mode: "grounded",
      balance: 48,
      sufficient: true,
      usesOwnKey: false,
      quote: { token: "q_abc.def", expiresAt: "2026-08-28T14:35:00.000Z" },
    },
    invalid: {
      credits: 24,
      prompts: 6,
      models: 4,
      repetitions: 1,
      mode: "grounded",
      balance: 48,
      sufficient: true,
      usesOwnKey: false,
      quote: { token: "q_abc.def", expiresAt: "2026-08-28T14:35:00.000Z" },
    },
  },
  {
    name: "estimateScanBody",
    schema: estimateScanBody,
    valid: {},
    invalid: { mode: "both" },
  },
  {
    name: "createScanBody",
    schema: createScanBody,
    valid: { quote: "q_abc.def" },
    invalid: { repetitions: 3 },
  },
  {
    name: "createScanResult",
    schema: createScanResult,
    valid: { id: UUID, status: "queued", credits: 24, prompts: 6, models: 4, balanceAfter: 24, pollUrl: `/api/v1/scans/${UUID}` },
    invalid: { id: UUID, status: "queued", credits: 24, prompts: 6, models: 4, balanceAfter: 24 },
  },
  {
    name: "idempotencyKey",
    schema: idempotencyKey,
    valid: "gh:1234567890:acme-eu",
    invalid: "has spaces",
  },
  {
    name: "scanAnswer",
    schema: scanAnswer,
    valid: {
      answerId: UUID,
      promptId: UUID,
      promptText: "What is the best CRM for a small agency?",
      intentStage: "research",
      modelId: "openai/gpt-5.5",
      modelName: "GPT-5.5",
      grounded: true,
      brandMentioned: true,
      brandPosition: 2,
      sentiment: "positive",
      brandsPresent: [{ name: "Acme", is_target: true, rank: 2 }],
      citations: [{ url: "https://acme.com/pricing", domain: "acme.com" }],
      confidence: 0.92,
      lowConfidence: false,
      answerText: "x".repeat(1200),
      answerTextTruncated: true,
    },
    invalid: {
      answerId: UUID,
      promptId: UUID,
      promptText: "What is the best CRM for a small agency?",
      intentStage: "research",
      modelId: "openai/gpt-5.5",
      modelName: "GPT-5.5",
      grounded: true,
      brandMentioned: true,
      brandPosition: 2,
      sentiment: "positive",
      brandsPresent: [],
      citations: [],
      confidence: 0.92,
      lowConfidence: false,
      answerText: "x".repeat(1201),
      answerTextTruncated: true,
    },
  },
  {
    name: "recommendation",
    schema: recommendation,
    valid: {
      id: UUID,
      type: "citation_gap",
      title: "Get cited by the sources GPT-5.5 already trusts",
      body: "Three of the top sources never mention Acme.",
      impact: 4,
      effort: 2,
      priority: 8,
      status: "open",
      scanId: UUID,
      createdAt: ISO,
    },
    invalid: { id: UUID, type: "quick_win", title: "x", body: "", impact: 4, effort: 2, priority: 8, status: "open", scanId: null, createdAt: ISO },
  },
  {
    name: "citation",
    schema: citation,
    valid: { domain: "acme.com", count: 4, share: 0.2, bucket: "owned" },
    invalid: { domain: "acme.com", count: 4, share: 0.2, bucket: "ours" },
  },
  {
    name: "credits",
    schema: credits,
    valid: { balance: 48, tier: "single", monthlyCredits: 48, unit: UNIT, estimatedScansRemaining: 2 },
    invalid: { balance: 48, tier: "single", monthlyCredits: 48, unit: UNIT, estimatedScansRemaining: 2.5 },
  },
  {
    name: "revokeSelfResult",
    schema: revokeSelfResult,
    valid: { revoked: 3, self: true, scope: "cli" },
    invalid: { revoked: 3, self: true, scope: "all" },
  },
  {
    name: "quotePayload",
    schema: quotePayload,
    valid: {
      v: 1,
      orgId: UUID,
      workspaceId: UUID,
      keyId: UUID,
      promptCount: 6,
      modelIds: ["anthropic/claude-sonnet-5", "openai/gpt-5.5"],
      repetitions: 1,
      mode: "grounded",
      creditCost: 24,
      byok: false,
      iat: 1756392000,
      exp: 1756392300,
    },
    invalid: {
      v: 2,
      orgId: UUID,
      workspaceId: UUID,
      keyId: UUID,
      promptCount: 6,
      modelIds: [],
      repetitions: 1,
      mode: "grounded",
      creditCost: 24,
      byok: false,
      iat: 1756392000,
      exp: 1756392300,
    },
  },
  {
    name: "reportData",
    schema: reportData,
    valid: reportFixture,
    invalid: { ...reportFixture, perModel: [{ model: "openai/gpt-5.5" }] },
  },
  {
    name: "crawlerAccessResult",
    schema: crawlerAccessResult,
    valid: {
      origin: "https://example.com",
      robotsStatus: 200,
      robotsMissing: false,
      robotsServerError: false,
      truncated: false,
      sitemaps: ["https://example.com/sitemap.xml"],
      bots: [
        {
          token: "GPTBot",
          operator: "OpenAI",
          category: "training",
          respectsRobots: "yes",
          allowed: false,
          via: "named",
          matchedLine: 12,
          note: "Blocking GPTBot does not remove you from ChatGPT search results.",
          untrusted: { matchedRule: "Disallow: /" },
        },
      ],
      summary: { allowed: 32, blocked: 3 },
    },
    invalid: {
      origin: "https://example.com",
      robotsStatus: 200,
      robotsMissing: false,
      robotsServerError: false,
      truncated: false,
      sitemaps: [],
      bots: [
        {
          token: "GPTBot",
          operator: "OpenAI",
          category: "training",
          // A boolean here destroys the three-valued reputation field (10 section 3.9).
          respectsRobots: true,
          allowed: false,
          via: "named",
          matchedLine: 12,
          note: null,
          untrusted: { matchedRule: "Disallow: /" },
        },
      ],
      summary: { allowed: 32, blocked: 3 },
    },
  },
  {
    name: "llmsTxtValidation",
    schema: llmsTxtValidation,
    valid: {
      origin: "https://example.com",
      status: 200,
      missing: false,
      score: 72,
      findings: [{ severity: "error", message: "Missing H1 title", line: 1 }],
      stats: { lines: 40, bytes: 3100, sections: 5, entries: 28, entriesWithDescription: 20 },
      linksChecked: 28,
      brokenLinks: [{ url: "https://example.com/gone", status: 404 }],
      hasLlmsFullTxt: false,
    },
    invalid: {
      origin: "https://example.com",
      status: 200,
      missing: false,
      score: 101,
      findings: [],
      stats: null,
      linksChecked: 0,
      brokenLinks: [],
      hasLlmsFullTxt: false,
    },
  },
  {
    name: "generateLlmsTxtInput",
    schema: generateLlmsTxtInput,
    valid: { url: "https://example.com", depth: "full" },
    invalid: { url: "not a url" },
  },
  {
    name: "llmsTxtGeneration",
    schema: llmsTxtGeneration,
    valid: {
      untrusted: { content: "# Example\n\n> A site.\n" },
      depth: "index",
      pageCount: 28,
      skippedCount: 2,
      discoveredVia: "sitemap+links",
      timedOut: false,
      notices: ["2 skipped (robots)"],
    },
    invalid: { content: "# Example", depth: "index", pageCount: 28, skippedCount: 2, discoveredVia: "sitemap", timedOut: false, notices: [] },
  },
  {
    name: "sitemapGeneration",
    schema: sitemapGeneration,
    valid: { untrusted: { xml: "<?xml version=\"1.0\"?><urlset/>" }, urlCount: 12, skipped: 1, discoveredVia: "links", timedOut: false },
    invalid: { untrusted: { xml: "<urlset/>" }, urlCount: 12, skipped: 1, discoveredVia: "crawl", timedOut: false },
  },
  {
    name: "chunkAnalysisResult",
    schema: chunkAnalysisResult,
    valid: {
      url: "https://example.com/guide",
      mode: "html",
      score: 64,
      errors: 1,
      warnings: 2,
      strengthCount: 3,
      totalWords: 1800,
      totalTokens: 2400,
      topFixes: ["Split the 900-word section under 'Setup'"],
      docFindings: [{ severity: "warning", message: "No H2 in the first 300 words" }],
      chunks: [
        {
          level: 2,
          untrusted: { heading: "Setup" },
          words: 900,
          tokens: 1200,
          paragraphs: 9,
          longestParagraphWords: 210,
          findings: [{ severity: "error", message: "Section exceeds 600 words" }],
          strengths: ["Starts with a definition"],
        },
      ],
    },
    invalid: {
      url: "https://example.com/guide",
      mode: "html",
      score: 64,
      errors: 1,
      warnings: 2,
      strengthCount: 3,
      totalWords: 1800,
      totalTokens: 2400,
      topFixes: ["a", "b", "c", "d", "e", "f"],
      docFindings: [],
      chunks: [],
    },
  },
  {
    name: "structuredDataValidation",
    schema: structuredDataValidation,
    valid: {
      url: "https://example.com",
      score: 80,
      entityCount: 2,
      errors: 0,
      warnings: 1,
      passes: 5,
      microdataCount: 0,
      rdfaCount: 0,
      blocks: [
        {
          index: 0,
          entities: [
            {
              type: "Organization",
              untrusted: { name: "Example Ltd" },
              aiNote: "Organization is how assistants confirm who you are.",
              findings: [{ severity: "pass", message: "name present" }],
            },
          ],
        },
      ],
    },
    invalid: {
      url: "https://example.com",
      score: 80,
      entityCount: 2,
      errors: 0,
      warnings: 1,
      passes: 5,
      microdataCount: 0,
      rdfaCount: 0,
      blocks: [{ index: 0, raw: "{\"@type\":\"Organization\"}", entities: [{ type: "Organization", untrusted: {}, findings: [{ severity: "fatal", message: "x" }] }] }],
    },
  },
  {
    name: "metaAnalysisResult",
    schema: metaAnalysisResult,
    valid: {
      url: "https://example.com",
      untrusted: {
        title: "Example",
        description: "An example site.",
        ogDescription: null,
        firstParagraph: "Example is a site.",
      },
      score: 55,
      chars: 16,
      pixels: 98,
      desktopCutoff: null,
      mobileCutoff: null,
      checks: [{ level: "warning", message: "Description is short" }],
      openingParagraphChecks: [{ level: "pass", message: "Opens with the subject" }],
    },
    invalid: {
      url: "https://example.com",
      title: "Example",
      description: "An example site.",
      score: 55,
      chars: 16,
      pixels: 98,
      desktopCutoff: null,
      mobileCutoff: null,
      checks: [],
      openingParagraphChecks: [],
    },
  },
];

describe("contract schemas", () => {
  it.each(cases)("$name parses a realistic payload and rejects a malformed one", ({ schema, valid, invalid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it("createWorkspaceBody is strict: an orgSlug field is a 422, never a silent drop", () => {
    const result = createWorkspaceBody.safeParse({ name: "Acme EU", orgSlug: "acme" });
    expect(result.success).toBe(false);
  });

  it("createScanBody refuses mode and repetitions (08 section 6.3)", () => {
    expect(createScanBody.safeParse({ mode: "both" }).success).toBe(false);
    expect(createScanBody.safeParse({ repetitions: 2 }).success).toBe(false);
    expect(createScanBody.safeParse({}).success).toBe(true);
  });

  it("createPromptBody applies its defaults and refuses server-forced columns", () => {
    const parsed = createPromptBody.parse({ text: "Which CRM suits a ten-person agency?" });
    expect(parsed).toEqual({
      text: "Which CRM suits a ten-person agency?",
      intentStage: "research",
      enabled: true,
    });
    expect(createPromptBody.safeParse({ text: "Which CRM suits a ten-person agency?", source: "custom" }).success).toBe(false);
  });

  it("page() wraps any item schema in the {data, pagination} envelope", () => {
    const schema = page(competitor);
    expect(schema.safeParse({ data: [], pagination: { nextCursor: "abc", hasMore: true, limit: 1 } }).success).toBe(true);
    expect(schema.safeParse({ data: [], pagination: pageEnvelope, extra: 1 }).success).toBe(true);
    expect(schema.safeParse({ items: [], pagination: pageEnvelope }).success).toBe(false);
  });

  it("createOrganizationResult ties message to usable in both directions (08 section 7.3)", () => {
    const base = { id: UUID, slug: "acme-labs", name: "Acme Labs", type: "brand", subscribeUrl: "https://whereamimentioned.com/acme-labs/billing" };
    const copy = "The organization was created on the free floor and cannot run scans yet.";
    expect(createOrganizationResult.safeParse({ ...base, tier: "free", usable: false, message: copy }).success).toBe(true);
    expect(createOrganizationResult.safeParse({ ...base, tier: "single", usable: true }).success).toBe(true);
    // Required while usable is false...
    const missing = createOrganizationResult.safeParse({ ...base, tier: "free", usable: false });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path.join("."))).toEqual(["message"]);
    // ...and absent once it is true: "present only while usable is false".
    expect(createOrganizationResult.safeParse({ ...base, tier: "single", usable: true, message: copy }).success).toBe(false);
  });

  it("API_ERROR_DETAILS names a details schema per code 08 defines one for, and parseErrorDetails fails closed", () => {
    expect(Object.keys(API_ERROR_DETAILS).sort()).toEqual([
      "conflict",
      "feature_not_available",
      "insufficient_credits",
      "rate_limited",
      "scan_already_running",
      "validation_failed",
    ]);
    for (const code of Object.keys(API_ERROR_DETAILS)) expect(API_ERROR_CODES).toContain(code);
    expect(parseErrorDetails("conflict", { originalOrgId: UUID })).toEqual({ originalOrgId: UUID });
    expect(parseErrorDetails("scan_already_running", { scanId: UUID, pollUrl: `/api/v1/scans/${UUID}` })?.scanId).toBe(UUID);
    expect(parseErrorDetails("scan_already_running", { scanId: 7 })).toBeUndefined();
    expect(parseErrorDetails("rate_limited", undefined)).toBeUndefined();
  });

  it("scanAnswer caps citations at 25 per answer", () => {
    const valid = cases.find((c) => c.name === "scanAnswer")!.valid as Record<string, unknown>;
    const tooMany = { ...valid, citations: new Array(26).fill({ url: "https://a.com/x", domain: "a.com" }) };
    expect(scanAnswer.safeParse(tooMany).success).toBe(false);
    const exactly = { ...valid, citations: new Array(25).fill({ url: "https://a.com/x", domain: "a.com" }) };
    expect(scanAnswer.safeParse(exactly).success).toBe(true);
  });
});

describe("re-exports", () => {
  it("re-exports the const tuples from ./enums.ts by identity, never a copy", () => {
    expect(API_SCOPES).toBe(enums.API_SCOPES);
    expect(READ_ONLY_SCOPES).toBe(enums.READ_ONLY_SCOPES);
    expect(INTENT_STAGES).toBe(enums.INTENT_STAGES);
    expect(SCAN_STATUSES).toBe(enums.SCAN_STATUSES);
  });

  it("carries the twelve error codes of 08 section 4.2", () => {
    expect(API_ERROR_CODES).toHaveLength(12);
    expect(API_ERROR_CODES).toContain("bad_request");
    expect(API_ERROR_CODES).toContain("rate_limited");
    expect(new Set(API_ERROR_CODES).size).toBe(12);
  });

  it("names the seven /api/site/* routes", () => {
    expect(Object.values(SITE_ROUTES)).toEqual([
      "check-crawlers",
      "validate-llms-txt",
      "generate-llms-txt",
      "generate-sitemap",
      "validate-structured-data",
      "check-meta",
      "analyze-chunks",
    ]);
  });

  it("reportData is pinned to the imported ReportData interface, in both directions", () => {
    // Type identity: a second declaration that merely looks the same fails here at typecheck.
    expectTypeOf<z.infer<typeof reportData>>().toEqualTypeOf<ReportData>();
    expectTypeOf(reportFixture).toMatchTypeOf<z.infer<typeof reportData>>();
    expect(reportData.parse(reportFixture)).toEqual(reportFixture);
  });

  it("the imported ReportData carries scanId, and bucket is CITATION_BUCKETS, not string (08 section 4.8)", () => {
    // scanId lives on the interface itself (src/reports/report-data.ts), not on a client wrapper.
    expectTypeOf<ReportData["scanId"]>().toEqualTypeOf<string>();
    expectTypeOf<ReportData["citations"][number]["bucket"]>().toEqualTypeOf<enums.CitationBucket>();
    expect(reportData.safeParse({ ...reportFixture, scanId: undefined }).success).toBe(false);
    expect(reportData.safeParse({ ...reportFixture, scanId: 42 }).success).toBe(false);
    expect(
      reportData.safeParse({
        ...reportFixture,
        citations: [{ domain: "acme.com", count: 4, share: 0.2, bucket: "ours" }],
      }).success,
    ).toBe(false);
    expect(reportData.parse(reportFixture).scanId).toBe(UUID);
  });
});
