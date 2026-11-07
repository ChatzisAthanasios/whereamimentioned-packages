import type { CitationBucket } from "./enums";

/**
 * The canonical response schema of a visibility report (08 section 4.8). Served VERBATIM by
 * GET /api/v1/scans/{scanId}/report?format=json, built by the app's `buildReportData`
 * (src/reports/report-data.ts, which imports this type and so cannot drift from it), mirrored
 * field for field by the `reportData` zod schema in contract.ts (a type-level assertion there
 * fails typecheck on drift), and never re-shaped by the MCP server or the CLI.
 *
 * It lives in the package rather than the app because the package must build on its own in the
 * public mirror (10-CLI section 10.2), where `src/` does not exist.
 */
export interface ReportData {
  /** The scan this report describes (08 section 4.8). buildReportData already receives it as arg 1. */
  scanId: string;
  brandName: string;
  workspaceName: string;
  scanDate: string;
  score: number;
  presenceRate: number;
  presenceCiLow: number;
  presenceCiHigh: number;
  sov: number;
  sentimentScore: number | null;
  brandCitationShare: number;
  perModel: Array<{ model: string; score: number }>;
  /** Top REPORT_COMPETITORS_MAX (20) by mentions; the cap is applied by the app. */
  competitors: Array<{ name: string; mentions: number; sov: number; isTarget: boolean }>;
  /** Top REPORT_CITATIONS_MAX (25) by count. `bucket` is exactly CITATION_BUCKETS, never a wider string. */
  citations: Array<{ domain: string; count: number; share: number; bucket: CitationBucket }>;
  /** Top REPORT_RECOMMENDATIONS_MAX (10) by priority. */
  recommendations: Array<{ title: string; body: string; priority: number }>;
  methodologyVersion: string;
}
