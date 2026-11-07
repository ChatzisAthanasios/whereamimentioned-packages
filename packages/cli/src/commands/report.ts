/**
 * `wam report` (10-CLI sections 3.6 and 7.4): get.
 *
 * `--json` (and `--format json -o <file>`) is the `ReportData` object of
 * src/reports/report-data.ts as the API served it: no wrapper, no added field, ever. The human
 * summary is a rendering of that same object and nothing else.
 *
 * `--fail-under` is a gate on data the caller asked for, not a failure to produce it: the report
 * still goes to stdout (one document under `--json`), the comparison goes to stderr, and the exit
 * code is 7. It compares `ReportData.score`.
 *
 * Section 15 item 8: a report with `score === 0` and `presenceRate === 0` costs one extra
 * GET /api/v1/scans/{ReportData.scanId}, for `progress.done` and for nothing else. If answers
 * were collected, a warning goes to stderr, because an all-zero report is far more likely an
 * extraction failure than a real result.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { REPORT_FORMATS, type ReportData, type ReportFormat, type WamClient } from "@whereamimentioned/api-client";
import type { Context } from "../context";
import { CliError, EXIT, thresholdNotMetError, usageError } from "../errors";
import { zeroScoreWarning } from "./scan";
import {
  call,
  orgScopedClient,
  parseChoice,
  parseThreshold,
  percent,
  percent1,
  plural,
  resolveScanIdArgument,
  scanPageUrl,
} from "./support";

const COMMAND = "report get";
const NAME_COLUMN = 23;

// --- The human summary (section 3.6) -----------------------------------------------------------

function metric(label: string, value: string): string {
  return `  ${label.padEnd(NAME_COLUMN + 2)}${value}`.replace(/\s+$/, "");
}

function item(name: string, ...cells: string[]): string {
  return `    ${name.padEnd(NAME_COLUMN)}${cells.join("   ")}`.replace(/\s+$/, "");
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

export function reportSummaryLines(report: ReportData): string[] {
  const lines = [
    `${report.brandName}  (workspace ${report.workspaceName})   scan of ${report.scanDate}   methodology ${report.methodologyVersion}`,
    "",
    metric("AI visibility score", `${report.score} / 100`),
    metric(
      "Presence rate",
      `${percent(report.presenceRate).padEnd(8)}95% CI ${percent(report.presenceCiLow)} to ${percent(report.presenceCiHigh)}`,
    ),
    metric("Share of voice", percent(report.sov)),
    metric("Sentiment", report.sentimentScore === null ? "not measured" : signed(report.sentimentScore)),
    metric("Brand citation share", percent(report.brandCitationShare)),
  ];

  if (report.perModel.length > 0) {
    lines.push("", "  Per model");
    // Model names are printed as the API served them. None is ever typed here.
    for (const m of report.perModel) lines.push(item(m.model, String(Math.round(m.score))));
  }
  if (report.competitors.length > 0) {
    lines.push("", "  Share of voice");
    for (const c of report.competitors) {
      lines.push(
        item(
          c.isTarget ? `${c.name}  (you)` : c.name,
          percent(c.sov).padEnd(4),
          `${c.mentions} ${plural(c.mentions, "mention", "mentions")}`,
        ),
      );
    }
  }
  if (report.citations.length > 0) {
    lines.push("", "  Most cited domains");
    for (const c of report.citations) {
      lines.push(item(c.domain, String(c.count).padStart(3), percent1(c.share).padStart(5), c.bucket));
    }
  }
  if (report.recommendations.length > 0) {
    lines.push("", "  Top recommendations");
    for (const r of report.recommendations) lines.push(`    ${String(Math.round(r.priority)).padStart(3)}  ${r.title}`);
  }
  return lines;
}

// --- The command ---------------------------------------------------------------------------------

interface GetOptions {
  scan?: string;
  format?: string;
  output?: string;
  failUnder?: string;
}

/**
 * `--scan` (a full id, or an unambiguous prefix of one as `wam scan list` prints it), or the latest
 * completed scan of the resolved workspace.
 */
async function resolveScanId(ctx: Context, client: WamClient, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.trim() !== "") return resolveScanIdArgument(ctx, client, explicit, COMMAND);
  const workspace = ctx.requireWorkspace();
  const page = await call(ctx, COMMAND, () => client.scans.list(workspace, { status: "done", limit: 1 }), {
    workspace,
  });
  const latest = page.data[0];
  if (!latest) {
    throw new CliError("not_found", EXIT.FAILURE, [
      `Workspace ${workspace} has no completed scan yet, so there is no report.`,
      "Run one with: wam scan run --wait",
    ]);
  }
  return latest.id;
}

/** Section 15 item 8. One extra GET, made only for an all-zero report, and never fatal. */
async function warnIfSuspiciousZero(ctx: Context, client: WamClient, report: ReportData): Promise<void> {
  if (report.score !== 0 || report.presenceRate !== 0) return;
  let done = 0;
  let url: string | null = null;
  try {
    const scan = await client.scans.get(report.scanId);
    done = scan.progress.done;
    url = scanPageUrl(ctx, scan.workspaceSlug, scan.id);
  } catch (err) {
    // The report itself was served. A failed side check must not turn it into an error.
    ctx.out.debug(`zero-score check failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (done > 0) zeroScoreWarning(ctx, done, url);
}

function applyThreshold(ctx: Context, report: ReportData, threshold: number | null): void {
  if (threshold === null || report.score >= threshold) return;
  // Stderr even under --json, and no throw: the report on stdout stays the single document.
  const gate = thresholdNotMetError(report.score, threshold);
  ctx.out.error(["", ...gate.lines]);
  ctx.setExitCode(gate.exitCode);
}

async function runReportGet(ctx: Context, opts: GetOptions): Promise<void> {
  const format: ReportFormat = parseChoice("--format", opts.format, REPORT_FORMATS) ?? "json";
  const flagThreshold = parseThreshold("--fail-under", opts.failUnder);
  if (format === "pdf" && opts.output === undefined) {
    throw usageError(
      "--format pdf needs -o <file>: a PDF is binary and is never written to a terminal.",
      "Try: wam report get --format pdf -o report.pdf",
    );
  }
  if (format !== "json" && flagThreshold !== undefined) {
    throw usageError("--fail-under compares the score in the JSON report, so it cannot be used with --format csv or pdf.");
  }
  if (format === "csv" && opts.output === undefined && ctx.out.json) {
    // Under --json, stdout is one JSON document (section 3.1). Raw CSV there is neither.
    throw usageError(
      "--format csv with --json needs -o <file>: under --json, stdout carries one JSON document, and a CSV is not one.",
      "Try: wam report get --format csv -o report.csv --json",
    );
  }

  const { client } = await orgScopedClient(ctx);
  const threshold = flagThreshold ?? (format === "json" ? ctx.config().failUnder.value : null);
  const scanId = await resolveScanId(ctx, client, opts.scan);
  const body = await call(ctx, COMMAND, () => client.scans.report(scanId, format), { scanId });

  if (format !== "json") {
    const bytes = body as Uint8Array;
    if (opts.output === undefined) {
      // csv only (pdf was refused above): text, byte for byte, with nothing around it.
      ctx.out.raw(new TextDecoder("utf-8").decode(bytes));
      return;
    }
    const path = resolve(ctx.primitives.cwd, opts.output);
    writeFileSync(path, bytes);
    if (ctx.out.json) ctx.out.jsonDocument({ ok: true, scanId, format, path, bytes: bytes.byteLength });
    else ctx.out.chatter(`Wrote ${path} (${bytes.byteLength} bytes)`);
    return;
  }

  const report = body as ReportData;
  if (opts.output !== undefined) {
    const path = resolve(ctx.primitives.cwd, opts.output);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (ctx.out.json) ctx.out.jsonDocument(report);
    else ctx.out.chatter(`Wrote ${path}`);
  } else if (ctx.out.json) {
    ctx.out.jsonDocument(report);
  } else {
    for (const line of reportSummaryLines(report)) ctx.out.data(line);
  }

  await warnIfSuspiciousZero(ctx, client, report);
  applyThreshold(ctx, report, threshold);
}

export function registerReportCommands(program: Command, getContext: () => Context): void {
  const report = program.command("report").description("Fetch a scan's report");

  report
    .command("get")
    .description("Print a scan's report, or save it as JSON, CSV or PDF. Spends no credits")
    .option(
      "--scan <scanId>",
      "The scan to report on: a full id, or an unambiguous prefix of one as wam scan list prints it (default: the latest completed scan of the workspace)",
    )
    .option("--format <format>", `One of: ${REPORT_FORMATS.join(", ")} (default json)`)
    .option("-o, --output <file>", "Write to a file. Required for --format pdf")
    .option("--fail-under <n>", "Exit 7 when the AI visibility score is below n (0 to 100)")
    .addHelpText("after", "\nExample:\n  $ wam report get --json --fail-under 55\n")
    .action((opts: GetOptions) => runReportGet(getContext(), opts));

  // `wam report` has no write subcommand in 10-CLI. Anything added later registers here, on `report`.
}
