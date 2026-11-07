/**
 * `wam scan` (10-CLI section 3.5): estimate, run, status, list, evidence.
 *
 * The reads (checkpoint 4) are `status` (with `--wait`, and `watch` as its documented alias),
 * `list` and `evidence`. The writes (checkpoint 5) are `estimate`, which spends nothing, and `run`,
 * the only command in the CLI that spends money. All of them register on one `scan` group and
 * share the follow loop in ./follow.ts.
 *
 * The rules that decide what these commands may do and print:
 *  - `run` is always estimate, then confirm, then create (sections 3.5 and 8.1). The cost is
 *    printed before the create call even with `--yes` and even under `--quiet` or `--json`, a
 *    quote that expired while the user was thinking is re-estimated once and never sent, and the
 *    create is never retried;
 *  - `mode` and `repetitions` are not flags and never will be (section 8.1 rule 4);
 *  - a 409 is branched on `error.code`, never on the status: `details.scanId` is read only under
 *    `scan_already_running` (section 3.1);
 *  - progress is raw counts, with "(total may still grow)" until `totalIsFinal`, and never a
 *    percentage, because `progress.total` grows while a scan runs;
 *  - the evidence filters are the API's (`modelId`, `mentioned`, `lowConfidence`), passed straight
 *    through. They are never applied to a fetched page, which would break `nextCursor`;
 *  - `<scanId>` is a full id or an unambiguous prefix of one: the ID column of `list` prints the
 *    first eight characters, so what the table shows must paste back. A prefix is resolved client
 *    side against the workspace's scan list (./support.ts) and the server only ever sees a full id;
 *  - no model name, credit figure or cap is typed here: every one is printed as a response served it.
 */
import type { Command } from "commander";
import {
  ApiError,
  QUOTE_TTL_SECONDS,
  SCAN_STATUSES,
  parseErrorDetails,
  type CreateScanResult,
  type ReportData,
  type ScanAnswer,
  type ScanEstimate,
  type ScanStatus,
  type ScanSummary,
  type WamClient,
} from "@whereamimentioned/api-client";
import { confirmSpend } from "../confirm";
import type { Context } from "../context";
import { CliError, EXIT, thresholdNotMetError } from "../errors";
import { deriveScanIdempotencyKey, parseIdempotencyKeyFlag } from "../idempotency";
import type { TableColumn } from "../output";
import { emitFollowResult, failFollow, failedScanError, followToEnd, progressText } from "./follow";
import {
  call,
  formatDateTime,
  formatDuration,
  knownOrg,
  labelled,
  nextPageHint,
  orgScopedClient,
  parseBooleanFlag,
  parseChoice,
  parseLimit,
  parsePositiveSeconds,
  parseThreshold,
  percent,
  plural,
  resolveScanIdArgument,
  scanPageUrl,
  shortId,
} from "./support";

const STATUS_LABEL_WIDTH = 14;

/** The `<scanId>` note under the help of every command that takes one. */
const SCAN_ID_HELP =
  "\n<scanId> is the full id, or an unambiguous prefix of it: the ID column of wam scan list is one.\n";

// --- status ------------------------------------------------------------------------------------

function ago(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return `  (${formatDuration(now.getTime() - at)} ago)`;
}

/** The block of section 3.5. Every value is the GET /api/v1/scans/{scanId} body as received. */
export function scanStatusLines(ctx: Context, scan: ScanStatus): string[] {
  const now = ctx.primitives.now();
  const org = knownOrg(ctx);
  const where = org ? `${org}/${scan.workspaceSlug}` : scan.workspaceSlug;
  const row = (label: string, value: string) => labelled(label, value, STATUS_LABEL_WIDTH);
  const lines = [`Scan ${scan.id}   ${where}`, ""];
  lines.push(row("Status", scan.status));
  lines.push(row("Progress", progressText(scan)));
  lines.push(row("Mode", `${scan.mode}, ${scan.repetitions} ${plural(scan.repetitions, "repetition", "repetitions")}`));
  lines.push(row("Reserved", `${scan.creditsReserved} ${plural(scan.creditsReserved, "credit", "credits")}`));
  if (scan.creditsSpent !== null) {
    lines.push(row("Spent", `${scan.creditsSpent} ${plural(scan.creditsSpent, "credit", "credits")}`));
  }
  if (scan.score !== null) lines.push(row("Score", `${Math.round(scan.score)} / 100`));
  lines.push(row("Started", scan.startedAt === null ? "not started yet" : `${scan.startedAt}${ago(scan.startedAt, now)}`));
  if (scan.finishedAt !== null) lines.push(row("Finished", `${scan.finishedAt}${ago(scan.finishedAt, now)}`));
  if (scan.error !== null) lines.push(row("Error", scan.error));
  return lines;
}

/**
 * Section 15 item 8: a finished scan that scored 0 with answers collected is far more likely an
 * extraction failure than a real result, so it is never presented as a normal score. The status
 * body carries no presence rate, so the trigger here is the score and `progress.done`.
 */
export function warnOnZeroScore(ctx: Context, scan: ScanStatus): void {
  if (scan.status !== "done" || scan.score !== 0 || scan.progress.done <= 0) return;
  zeroScoreWarning(ctx, scan.progress.done, scanPageUrl(ctx, scan.workspaceSlug, scan.id));
}

export function zeroScoreWarning(ctx: Context, answers: number, url: string | null): void {
  ctx.out.warn(
    `Warning: this scan scored 0 across ${answers} ${plural(answers, "answer", "answers")}. That usually means the analysis failed, not that the brand is absent.`,
  );
  ctx.out.warn(url ? `Check the scan before trusting the number: ${url}` : "Check the scan in the dashboard before trusting the number.");
}

interface StatusOptions {
  wait?: boolean;
  timeout?: string;
  poll?: string;
}

async function runScanStatus(ctx: Context, rawScanId: string, opts: StatusOptions, command: string): Promise<void> {
  const timeoutSeconds = parsePositiveSeconds("--timeout", opts.timeout);
  const pollSeconds = parsePositiveSeconds("--poll", opts.poll);
  const { client } = await orgScopedClient(ctx);
  const scanId = await resolveScanIdArgument(ctx, client, rawScanId, command);

  if (!opts.wait) {
    const scan = await call(ctx, command, () => client.scans.get(scanId), { scanId });
    if (ctx.out.json) ctx.out.jsonDocument(scan);
    else for (const line of scanStatusLines(ctx, scan)) ctx.out.data(line);
    // On stderr in both modes, so the stdout document stays the body and nothing else.
    warnOnZeroScore(ctx, scan);
    return;
  }

  const scan = await followToEnd(ctx, client, scanId, { command, pollSeconds, timeoutSeconds });
  if (scan === null) return; // The terminal NDJSON error object is already written.

  if (scan.status === "failed") {
    failFollow(ctx, failedScanError(ctx, scan));
    return;
  }
  if (ctx.out.json) emitFollowResult(ctx, scan);
  else for (const line of scanStatusLines(ctx, scan)) ctx.out.data(line);
  warnOnZeroScore(ctx, scan);
}

// --- list --------------------------------------------------------------------------------------

const SCAN_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "date", header: "DATE", align: "left" },
  { key: "id", header: "ID", align: "left" },
  { key: "status", header: "STATUS", align: "left" },
  { key: "mode", header: "MODE", align: "left" },
  { key: "prompts", header: "PROMPTS", align: "right" },
  { key: "models", header: "MODELS", align: "right" },
  { key: "credits", header: "CREDITS", align: "right" },
  { key: "score", header: "SCORE", align: "right" },
];

function scanRows(scans: readonly ScanSummary[]): Array<Record<string, unknown>> {
  return scans.map((s) => ({
    date: formatDateTime(s.createdAt),
    id: shortId(s.id),
    status: s.status,
    mode: s.mode,
    prompts: s.promptCount,
    models: s.modelCount,
    credits: s.creditsSpent ?? "-",
    score: s.score === null ? "-" : Math.round(s.score),
  }));
}

interface ListOptions {
  limit?: string;
  cursor?: string;
  status?: string;
  from?: string;
  to?: string;
}

async function runScanList(ctx: Context, opts: ListOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const status = parseChoice("--status", opts.status, SCAN_STATUSES);
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  const page = await call(
    ctx,
    "scan list",
    () => client.scans.list(workspace, { limit, cursor: opts.cursor, status, from: opts.from, to: opts.to }),
    { workspace },
  );

  if (ctx.out.json) {
    ctx.out.jsonDocument(page);
    return;
  }
  ctx.out.table(scanRows(page.data), SCAN_COLUMNS);
  nextPageHint(ctx, "wam scan list", page.pagination.nextCursor);
}

// --- evidence ----------------------------------------------------------------------------------

/** The CLI's own terminal truncation, lifted by `--full`. The API never returns more than it does. */
const PROMPT_DISPLAY_CHARS = 60;
const ANSWER_DISPLAY_CHARS = 240;
const PROMPT_COLUMN = 56;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number, full: boolean): { text: string; clipped: boolean } {
  if (full || text.length <= max) return { text, clipped: false };
  return { text: text.slice(0, max).trimEnd(), clipped: true };
}

function uniqueDomains(answer: ScanAnswer): string[] {
  return [...new Set(answer.citations.map((c) => c.domain))];
}

export function evidenceLines(answer: ScanAnswer, index: number, full: boolean): string[] {
  const prompt = clip(oneLine(answer.promptText), PROMPT_DISPLAY_CHARS, full);
  const quoted = `"${prompt.text}${prompt.clipped ? "..." : ""}"`;
  const head = `[${index}] ${quoted.padEnd(PROMPT_COLUMN)}  ${answer.intentStage}  ${answer.modelName}  ${answer.grounded ? "grounded" : "ungrounded"}`;

  let mention = "Brand mentioned: no";
  if (answer.brandMentioned) {
    const parts = ["Brand mentioned: yes"];
    if (answer.brandPosition !== null) parts.push(`position ${answer.brandPosition} of ${answer.brandsPresent.length}`);
    parts.push(`sentiment ${answer.sentiment}`, `confidence ${answer.confidence.toFixed(2)}`);
    mention = parts.join(", ");
  }
  if (answer.lowConfidence) mention += "  (low confidence)";

  const lines = [head, `    ${mention}`];
  if (answer.brandsPresent.length > 0) {
    const brands = answer.brandsPresent.map((b) => (b.rank === null ? b.name : `${b.name} (${b.rank})`));
    lines.push(`    Also present: ${brands.join(", ")}`);
  }
  const domains = uniqueDomains(answer);
  if (domains.length > 0) lines.push(`    Citations: ${domains.join(", ")}`);

  const excerpt = clip(oneLine(answer.answerText), ANSWER_DISPLAY_CHARS, full);
  const more = excerpt.clipped || answer.answerTextTruncated ? "..." : "";
  lines.push(`    "${excerpt.text}${more}"`);
  return lines;
}

interface EvidenceOptions {
  limit?: string;
  cursor?: string;
  model?: string;
  mentioned?: string;
  lowConfidence?: string;
  full?: boolean;
}

async function runScanEvidence(ctx: Context, rawScanId: string, opts: EvidenceOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const mentioned = parseBooleanFlag("--mentioned", opts.mentioned);
  const lowConfidence = parseBooleanFlag("--low-confidence", opts.lowConfidence);
  const { client } = await orgScopedClient(ctx);
  const scanId = await resolveScanIdArgument(ctx, client, rawScanId, "scan evidence");

  // One to one onto the endpoint's own filters, and nothing is filtered after the fetch.
  const query = { limit, cursor: opts.cursor, modelId: opts.model, mentioned, lowConfidence };

  if (ctx.out.json) {
    const page = await call(ctx, "scan evidence", () => client.scans.answers(scanId, query), { scanId });
    ctx.out.jsonDocument(page);
    return;
  }

  // The header needs the workspace and the answer count, which the answers page does not carry.
  const scan = await call(ctx, "scan evidence", () => client.scans.get(scanId), { scanId });
  const page = await call(ctx, "scan evidence", () => client.scans.answers(scanId, query), { scanId });

  const org = knownOrg(ctx);
  const where = org ? `${org}/${scan.workspaceSlug}` : scan.workspaceSlug;
  const total = scan.progress.done;
  ctx.out.data(
    `Scan ${shortId(scan.id)}  ${where}  (${total} ${plural(total, "answer", "answers")}, showing ${page.data.length})`,
  );
  page.data.forEach((answer, i) => {
    ctx.out.data("");
    for (const line of evidenceLines(answer, i + 1, opts.full === true)) ctx.out.data(line);
  });

  const filters = [
    opts.model === undefined ? "" : ` --model ${opts.model}`,
    mentioned === undefined ? "" : ` --mentioned ${mentioned}`,
    lowConfidence === undefined ? "" : ` --low-confidence ${lowConfidence}`,
    limit === undefined ? "" : ` --limit ${limit}`,
  ].join("");
  nextPageHint(ctx, `wam scan evidence ${scan.id}${filters}`, page.pagination.nextCursor);
}

// --- estimate ----------------------------------------------------------------------------------

const MODEL_LINE_WIDTH = 60;

function creditsText(n: number): string {
  return `${n} ${plural(n, "credit", "credits")}`;
}

function whereText(ctx: Context, workspace: string): string {
  const org = knownOrg(ctx);
  return org ? `${org}/${workspace}` : workspace;
}

/**
 * `7   Name, Name,` then continuation lines under a hanging indent. The names are the estimate's
 * `models[].displayName`, printed as received; the count is the length of that array.
 */
function modelRows(label: string, names: readonly string[], labelWidth: number): string[] {
  const count = String(names.length);
  const chunks: string[] = [];
  let current = "";
  names.forEach((name, i) => {
    const piece = i < names.length - 1 ? `${name},` : name;
    if (current !== "" && current.length + 1 + piece.length > MODEL_LINE_WIDTH) {
      chunks.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current} ${piece}`;
    }
  });
  if (current !== "") chunks.push(current);

  const first = labelled(label, chunks.length > 0 ? `${count.padEnd(4)}${chunks[0]}` : count, labelWidth);
  const hang = " ".repeat(2 + labelWidth + 4);
  return [first, ...chunks.slice(1).map((chunk) => `${hang}${chunk}`)];
}

function costText(e: ScanEstimate): string {
  return e.usesOwnKey ? `${creditsText(e.credits)}  (this workspace uses its own provider key)` : creditsText(e.credits);
}

/** The block of `wam scan estimate` (section 3.5). Every value is the estimate body as received. */
export function estimateLines(ctx: Context, workspace: string, e: ScanEstimate): string[] {
  const width = 15;
  const row = (label: string, value: string) => labelled(label, value, width);
  const balance = e.sufficient
    ? `${creditsText(e.balance)}, ${e.balance - e.credits} after this scan`
    : `${creditsText(e.balance)}, which does not cover this scan`;
  return [
    `Scan estimate for ${whereText(ctx, workspace)}`,
    "",
    row("Prompts", String(e.prompts)),
    ...modelRows("Models", e.models.map((m) => m.displayName), width),
    row("Repetitions", String(e.repetitions)),
    row("Mode", e.mode),
    row("Cost", costText(e)),
    row("Balance", balance),
  ];
}

/** The shorter block `wam scan run` prints before it asks (sections 3.5 and 8.2). */
export function runEstimateLines(ctx: Context, workspace: string, e: ScanEstimate): string[] {
  const width = 12;
  const row = (label: string, value: string) => labelled(label, value, width);
  const balance = e.sufficient
    ? `${e.balance} now, ${e.balance - e.credits} after`
    : `${e.balance} now, which does not cover this scan`;
  return [
    "",
    row("Workspace", whereText(ctx, workspace)),
    row("Prompts", String(e.prompts)),
    ...modelRows("Models", e.models.map((m) => m.displayName), width),
    row("Cost", costText(e)),
    row("Balance", balance),
    "",
  ];
}

/**
 * `wam scan estimate` exits 4 when `sufficient` is false (section 3.5). Both numbers are the
 * estimate body's. The URL line is printed only when the org slug is known locally, because the
 * estimate body carries no `billingUrl` and the CLI does not guess one.
 */
function shortfallLines(ctx: Context, e: ScanEstimate): string[] {
  const lines = [`Not enough credits. This scan needs ${e.credits} credits and the organization has ${e.balance}.`];
  const org = knownOrg(ctx);
  if (org) lines.push(`Add credits or change plan: ${ctx.config().apiUrl.value.replace(/\/+$/, "")}/${org}/billing`);
  return lines;
}

async function runScanEstimate(ctx: Context): Promise<void> {
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();
  const estimate = await call(ctx, "scan estimate", () => client.scans.estimate(workspace), { workspace });

  if (ctx.out.json) {
    // Verbatim, quote included. A short balance is a gate on this data, so the body stays the one
    // stdout document and the shortfall goes to stderr, like --fail-under (section 7.4).
    ctx.out.jsonDocument(estimate);
  } else {
    for (const line of estimateLines(ctx, workspace, estimate)) ctx.out.data(line);
  }

  if (!estimate.sufficient) {
    ctx.out.error(["", ...shortfallLines(ctx, estimate)]);
    ctx.setExitCode(EXIT.CREDITS);
    return;
  }
  if (ctx.out.json) return;
  ctx.out.chatter("");
  ctx.out.chatter("Run it with:  wam scan run");
}

// --- run ---------------------------------------------------------------------------------------

const COMMAND_RUN = "scan run";

/** A quote is treated as spent this long before the server would refuse it, to cover the request itself. */
const QUOTE_SAFETY_MARGIN_MS = 5_000;
/** Used only when the response carried no `Date` header to measure the quote's lifetime against. */
const QUOTE_FALLBACK_LIFETIME_MS = QUOTE_TTL_SECONDS * 1000;

interface PricedScan {
  estimate: ScanEstimate;
  /** The CLI's clock when the estimate arrived. */
  receivedAt: number;
  /** How long the quote lives from `receivedAt`, measured on the SERVER's clock. */
  lifetimeMs: number;
}

/**
 * `quote.expiresAt` minus the response's own `Date` header: the lifetime as the server sees it, so
 * a laptop whose clock is minutes off neither sends a dead quote nor refuses a live one.
 */
function quoteLifetimeMs(client: WamClient, estimate: ScanEstimate): number {
  const expiresAt = Date.parse(estimate.quote.expiresAt);
  const serverNow = Date.parse(client.lastResponse?.headers.get("date") ?? "");
  if (Number.isNaN(expiresAt) || Number.isNaN(serverNow)) return QUOTE_FALLBACK_LIFETIME_MS;
  return Math.max(0, expiresAt - serverNow);
}

function quoteExpired(ctx: Context, priced: PricedScan): boolean {
  const elapsed = ctx.primitives.now().getTime() - priced.receivedAt;
  return elapsed >= priced.lifetimeMs - QUOTE_SAFETY_MARGIN_MS;
}

/**
 * Section 8.1 rule 1: the estimate always runs and the cost is always printed, before any create
 * call, with `--yes`, under `--quiet` and under `--json` alike. It goes to stderr through `warn`,
 * the one stderr channel `--quiet` does not drop, so it reaches the CI log.
 */
async function priceScan(ctx: Context, client: WamClient, workspace: string): Promise<PricedScan> {
  const estimate = await call(ctx, COMMAND_RUN, () => client.scans.estimate(workspace), { workspace });
  const priced: PricedScan = {
    estimate,
    receivedAt: ctx.primitives.now().getTime(),
    lifetimeMs: quoteLifetimeMs(client, estimate),
  };
  for (const line of runEstimateLines(ctx, workspace, estimate)) ctx.out.warn(line);
  return priced;
}

/**
 * Estimate, then confirm. Resolves null when the user said no (exit 0, nothing spent). An answer
 * that arrives after the quote died is never followed by a create with that quote, and never by
 * a create with no quote: the scan is priced again, the fresh cost printed, and the question asked
 * again, once. A second late answer stops the command instead of looping.
 */
async function obtainConsent(ctx: Context, client: WamClient, workspace: string): Promise<ScanEstimate | null> {
  ctx.out.chatter("Estimating...");
  let priced = await priceScan(ctx, client, workspace);
  if (!(await confirmSpend(ctx.confirmDeps(), { credits: priced.estimate.credits }))) return null;
  if (!quoteExpired(ctx, priced)) return priced.estimate;

  ctx.out.warn("That quote expired while it waited for an answer, so nothing was sent. Estimating again...");
  priced = await priceScan(ctx, client, workspace);
  if (!(await confirmSpend(ctx.confirmDeps(), { credits: priced.estimate.credits }))) return null;
  if (quoteExpired(ctx, priced)) {
    throw new CliError("timed_out", EXIT.FAILURE, [
      "The quote expired again before it was confirmed, so no scan was started and no credits were spent.",
      "Run wam scan run again when you are ready to answer.",
    ]);
  }
  return priced.estimate;
}

interface RunOptions {
  wait?: boolean;
  failUnder?: string;
  timeout?: string;
  poll?: string;
  /** Commander's negated option: `--no-follow` makes this false. */
  follow?: boolean;
  idempotencyKey?: string;
}

/** The terminal `{ "type": "result" }` object of section 3.5, composed only from fields the API defines. */
function runResultObject(scan: ScanStatus, report: ReportData, balance: number, durationMs: number): Record<string, unknown> {
  return {
    type: "result",
    id: scan.id,
    status: scan.status,
    creditsSpent: scan.creditsSpent,
    balance,
    score: report.score,
    presenceRate: report.presenceRate,
    sov: report.sov,
    brandCitationShare: report.brandCitationShare,
    perModel: report.perModel,
    // The one field the CLI times itself, and it is named as a duration, not as API data.
    durationMs,
  };
}

function runSummaryLines(scan: ScanStatus, report: ReportData, balance: number, durationMs: number | null): string[] {
  const head = durationMs === null ? "Scan complete." : `Scan complete in ${formatDuration(durationMs)}.`;
  const money =
    scan.creditsSpent === null
      ? `${creditsText(balance)} remaining.`
      : `${creditsText(scan.creditsSpent)} spent, ${balance} remaining.`;
  const width = Math.max(22, ...report.perModel.map((m) => m.model.length + 2));
  const row = (label: string, value: string) => `  ${label.padEnd(width)}${value}`;
  const lines = [
    `${head} ${money}`,
    "",
    row("AI visibility score", String(report.score)),
    row(
      "Presence rate",
      `${percent(report.presenceRate).padEnd(6)}(95% CI ${percent(report.presenceCiLow)} to ${percent(report.presenceCiHigh)})`,
    ),
    row("Share of voice", percent(report.sov)),
    row("Brand citation share", percent(report.brandCitationShare)),
  ];
  if (report.perModel.length > 0) {
    lines.push("");
    // Model names as the report served them. None is ever typed here.
    for (const m of report.perModel) lines.push(row(m.model, String(Math.round(m.score))));
  }
  return lines;
}

/** Follows `scanId` to its end, then prints the result and applies the `--fail-under` gate. */
async function followAndReport(
  ctx: Context,
  client: WamClient,
  scanId: string,
  opts: { pollSeconds?: number; timeoutSeconds?: number; threshold: number | null; timed: boolean; workspace: string },
): Promise<void> {
  const startedAt = ctx.primitives.now().getTime();
  const scan = await followToEnd(ctx, client, scanId, {
    command: COMMAND_RUN,
    pollSeconds: opts.pollSeconds,
    timeoutSeconds: opts.timeoutSeconds,
  });
  if (scan === null) return; // The terminal NDJSON error object is already written (timeout included).

  if (scan.status === "failed") {
    // Exit 6. The report call is skipped: a failed scan has no report.
    failFollow(ctx, failedScanError(ctx, scan));
    return;
  }

  const extra = { scanId: scan.id, workspace: opts.workspace };
  const report = (await call(ctx, COMMAND_RUN, () => client.scans.report(scan.id, "json"), extra)) as ReportData;
  const credits = await call(ctx, COMMAND_RUN, () => client.credits(), extra);
  const durationMs = ctx.primitives.now().getTime() - startedAt;

  if (ctx.out.json) {
    ctx.out.ndjson(runResultObject(scan, report, credits.balance, durationMs));
  } else {
    for (const line of runSummaryLines(scan, report, credits.balance, opts.timed ? durationMs : null)) ctx.out.data(line);
    ctx.out.chatter("");
    ctx.out.chatter(`Full report:  wam report get --scan ${scan.id}`);
  }

  // Section 15 item 8: an all-zero result with answers collected is a product failure that looks
  // like a low score. The trigger reads progress.done, which this command already holds.
  if (report.score === 0 && report.presenceRate === 0 && scan.progress.done > 0) {
    zeroScoreWarning(ctx, scan.progress.done, scanPageUrl(ctx, scan.workspaceSlug, scan.id));
  }

  // Section 7.4: a gate on data the caller asked for. The result stays the terminal stdout object,
  // the comparison goes to stderr, and nothing here ever starts another scan.
  if (opts.threshold !== null && report.score < opts.threshold) {
    const gate = thresholdNotMetError(report.score, opts.threshold);
    ctx.out.error(["", ...gate.lines]);
    ctx.setExitCode(gate.exitCode);
  }
}

async function scanRun(ctx: Context, opts: RunOptions, streaming: { on: boolean }): Promise<void> {
  const flagThreshold = parseThreshold("--fail-under", opts.failUnder);
  const timeoutSeconds = parsePositiveSeconds("--timeout", opts.timeout);
  const pollSeconds = parsePositiveSeconds("--poll", opts.poll);
  // Checked before any request: a malformed key is exit 2, not a round trip to a 422.
  const explicitKey = parseIdempotencyKeyFlag(opts.idempotencyKey);
  // --fail-under implies --wait. A failUnder from config is a threshold, not a request to wait:
  // it gates a run that is followed and never turns a fire-and-forget run into a blocking one.
  const wait = opts.wait === true || flagThreshold !== undefined;

  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();
  const threshold = flagThreshold ?? ctx.config().failUnder.value ?? null;

  // 1 and 2: estimate, print the cost, obtain consent. Exit 2 here when it cannot ask.
  const estimate = await obtainConsent(ctx, client, workspace);
  if (estimate === null) return; // "Cancelled. No credits were spent." is already on stderr.

  // 3: create, exactly once, with the quote that was just confirmed. Never retried.
  const key =
    explicitKey ??
    deriveScanIdempotencyKey(
      { org: knownOrg(ctx), workspace },
      { env: ctx.primitives.env, now: ctx.primitives.now() },
    );

  let created: CreateScanResult | null = null;
  let adoptedScanId: string | null = null;
  try {
    created = await client.scans.create(workspace, { quote: estimate.quote.token }, key);
  } catch (err) {
    // The branch is on error.code, never on the 409 itself: `conflict` is also a 409 and carries
    // no scanId. Only scan_already_running does, and only then is it read.
    const running =
      err instanceof ApiError && err.code === "scan_already_running"
        ? parseErrorDetails("scan_already_running", err.details)
        : undefined;
    if (running === undefined || opts.follow === false) throw ctx.mapError(err, COMMAND_RUN, { workspace });
    adoptedScanId = running.scanId;
  }

  const follow = { pollSeconds, timeoutSeconds, threshold, workspace };

  if (created === null) {
    // 409 scan_already_running without --no-follow: adopt the running scan (section 9), exit 0 path.
    const scanId = adoptedScanId as string;
    streaming.on = true;
    ctx.out.warn(`A scan is already running for this workspace (${scanId}). Following it instead.`);
    await followAndReport(ctx, client, scanId, { ...follow, timed: false });
    return;
  }

  // 200 with X-Idempotent-Replay: the scan of this same run, returned instead of a second one.
  const replayed = client.lastResponse?.replayed === true;
  if (replayed) {
    ctx.out.warn(
      wait
        ? `A scan for this run already exists (${created.id}). Following it instead of starting a second one.`
        : `A scan for this run already exists (${created.id}). Returning it instead of starting a second one.`,
    );
  }

  if (wait) {
    if (!replayed) ctx.out.chatter(`Scan ${created.id} ${created.status}.`);
    await followAndReport(ctx, client, created.id, { ...follow, timed: !replayed });
    return;
  }

  if (ctx.out.json) {
    ctx.out.jsonDocument(created);
    return;
  }
  ctx.out.data(`Scan ${created.id} ${created.status}.`);
  ctx.out.data(labelled("Cost", creditsText(created.credits), 10));
  ctx.out.data(labelled("Balance", `${creditsText(created.balanceAfter)} ${replayed ? "now" : "after this scan"}`, 10));
  ctx.out.chatter("");
  ctx.out.chatter(`Follow it with:  wam scan status ${created.id} --wait`);
}

async function runScanRun(ctx: Context, opts: RunOptions): Promise<void> {
  // Under --json a followed run is NDJSON, and its one terminal object needs a `type` the
  // boundary's error object does not have (section 6.2 rule 1). So once the run is a stream, by
  // --wait, by --fail-under or by adopting a running scan, a failure ends it through failFollow.
  const streaming = { on: opts.wait === true || opts.failUnder !== undefined };
  try {
    await scanRun(ctx, opts, streaming);
  } catch (err) {
    if (streaming.on && ctx.out.json && err instanceof CliError) {
      failFollow(ctx, err);
      return;
    }
    throw err;
  }
}

// --- registration ------------------------------------------------------------------------------

export function registerScanCommands(program: Command, getContext: () => Context): void {
  const scan = program.command("scan").description("Estimate, run and follow scans, and read their evidence");

  scan
    .command("estimate")
    .description("Price the next scan of the workspace. Spends no credits and starts nothing")
    .addHelpText(
      "after",
      "\nExits 4 when the balance does not cover the scan, so a workflow can check before it spends.\n\nExample:\n  $ wam scan estimate --workspace acme-eu\n",
    )
    .action(() => runScanEstimate(getContext()));

  // `mode` and `repetitions` are deliberately NOT options (section 8.1 rule 4): every
  // machine-triggered scan runs the tier default, and an unknown option is exit 2.
  scan
    .command("run")
    .description("Run a scan. Spends credits: it always prints the cost first and asks, unless --yes is passed")
    .option("--wait", "Follow the scan until it is done or failed, then print the result")
    .option("--fail-under <n>", "Exit 7 when the resulting AI visibility score is below n (0 to 100). Implies --wait")
    .option("--timeout <seconds>", "Stop following after this many seconds (default 1800) and exit 1. The scan keeps running")
    .option("--poll <seconds>", "Seconds between polls while following, 5 at least (default 10)")
    .option("--no-follow", "When a scan is already running for the workspace, exit 8 instead of following it")
    .option("--idempotency-key <key>", "Override the derived Idempotency-Key: 1 to 128 characters from A-Z a-z 0-9 _ . : and -")
    .addHelpText(
      "after",
      "\nThe cost is estimated and printed before anything is spent, even with -y, --yes. Where the CLI\ncannot ask (CI, a pipe, --json), -y, --yes is required, and without it nothing is started.\nA retried CI step replays the same scan instead of starting a second one.\n\nExample:\n  $ wam scan run --wait --fail-under 55 --yes\n",
    )
    .action((opts: RunOptions) => runScanRun(getContext(), opts));

  scan
    .command("status <scanId>")
    .description("Show a scan's status and progress. Spends no credits")
    .option("--wait", "Follow the scan until it is done or failed")
    .option("--timeout <seconds>", "Stop following after this many seconds (default 1800). The scan keeps running")
    .option("--poll <seconds>", "Seconds between polls while following, 5 at least (default 10)")
    .addHelpText("after", `${SCAN_ID_HELP}\nExample:\n  $ wam scan status 3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb --wait\n`)
    .action((scanId: string, opts: StatusOptions) => runScanStatus(getContext(), scanId, opts, "scan status"));

  scan
    .command("watch <scanId>")
    .description("Alias of wam scan status <scanId> --wait")
    .option("--timeout <seconds>", "Stop following after this many seconds (default 1800). The scan keeps running")
    .option("--poll <seconds>", "Seconds between polls, 5 at least (default 10)")
    .addHelpText("after", `${SCAN_ID_HELP}\nExample:\n  $ wam scan watch 3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb\n`)
    .action((scanId: string, opts: StatusOptions) =>
      runScanStatus(getContext(), scanId, { ...opts, wait: true }, "scan status"),
    );

  scan
    .command("list")
    .description("List the workspace's scans, newest first. Doubles as the score trend. Spends no credits")
    .option("--limit <n>", "Rows per page, 1 to 100 (default 25)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .option("--status <status>", `Only scans in this status: ${SCAN_STATUSES.join(", ")}`)
    .option("--from <date>", "Only scans created on or after this ISO 8601 date")
    .option("--to <date>", "Only scans created on or before this ISO 8601 date")
    .addHelpText("after", "\nExample:\n  $ wam scan list --status done --limit 5\n")
    .action((opts: ListOptions) => runScanList(getContext(), opts));

  scan
    .command("evidence <scanId>")
    .description("Read the answers behind a scan: who was mentioned, where, and what was cited. Spends no credits")
    .option("--limit <n>", "Answers per page, 1 to 100 (default 20)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .option("--model <id>", "Only answers from this model id")
    .option("--mentioned <true|false>", "Only answers that do, or do not, mention the brand")
    .option("--low-confidence <true|false>", "Only answers that are, or are not, flagged low confidence")
    .option("--full", "Do not shorten prompts and answers for the terminal. The API never returns more than it does")
    .addHelpText(
      "after",
      `${SCAN_ID_HELP}\nExample:\n  $ wam scan evidence 3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb --mentioned false --limit 5\n`,
    )
    .action((scanId: string, opts: EvidenceOptions) => runScanEvidence(getContext(), scanId, opts));
}
