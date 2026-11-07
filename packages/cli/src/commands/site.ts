/**
 * `wam site` (10-CLI section 3.9): the seven no-account commands.
 *
 * No credential, no config and no org. Every command goes through `ctx.anonymousClient()`, whose
 * `site.*` methods POST to `<apiUrl>/api/site/*` with no bearer. The CLI never fetches the user's
 * URL itself (section 15 rule 3): the SSRF guard has to run on the server's side of the trust
 * boundary and not inside the user's own network, so the only host this module ever reaches is
 * the API origin. A refusal of the URL therefore arrives as a server error, with a request id.
 *
 * Output (section 6): stdout is data, stderr is chatter. Under `--json` the API body is the one
 * stdout document, passed through as received (section 6.2 rule 3). The two generators put only
 * the generated file on stdout, so `> llms.txt` works, and every count, notice and timing on
 * stderr; with `-o` they write the file and print the summary to stderr instead.
 *
 * Copy discipline: every number printed here is read from the response or measured locally (the
 * elapsed seconds, the size of the generated file). Third-party page text arrives under
 * `untrusted` and is printed quoted or stripped of control characters, never interpreted.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  ApiError,
  type ChunkAnalysisResult,
  type CrawlerAccessResult,
  type LlmsTxtGeneration,
  type LlmsTxtValidation,
  type MetaAnalysisResult,
  type SitemapGeneration,
  type StructuredDataValidation,
  type WamClient,
} from "@whereamimentioned/api-client";
import type { Context } from "../context";
import { CliError, EXIT, usageError } from "../errors";

// --- The URL argument -------------------------------------------------------------------------

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `acme.com` becomes `https://acme.com`. Anything that already names a scheme is handed to the
 * client unchanged: whether that URL may be fetched is the server's decision, never a local one.
 */
export function normalizeSiteUrl(arg: string): string {
  const trimmed = arg.trim();
  if (trimmed === "") throw usageError("The <url> argument is empty.", "Pass a site, for example: acme.com");
  return SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// --- Errors -----------------------------------------------------------------------------------

/** `details.reason` of the three 422s the /api/site/* routes raise for a URL they will not use. */
const SITE_REFUSAL_REASONS: ReadonlySet<string> = new Set(["unsafe_url", "upstream_unavailable", "crawl_refused"]);

/**
 * Every failure goes through `ctx.mapError`, so the copy and the request id are the boundary's.
 * One adjustment: a 422 carrying one of the site refusal reasons is the server declining to fetch
 * the URL (a private address, an unreachable origin, a robots.txt that shuts our crawler out).
 * The command line was well formed and the refusal happened on the server, so it is reported as
 * a server error (exit 1) and never as a local usage error (exit 2).
 */
export function mapSiteError(ctx: Context, err: unknown, command: string): CliError {
  const mapped = ctx.mapError(err, command);
  if (!(err instanceof ApiError) || mapped.exitCode !== EXIT.USAGE) return mapped;
  const reason = err.details?.reason;
  if (typeof reason !== "string" || !SITE_REFUSAL_REASONS.has(reason)) return mapped;
  return new CliError(mapped.code, EXIT.FAILURE, mapped.lines, {
    details: mapped.details,
    requestId: mapped.requestId,
  });
}

async function callSite<T>(ctx: Context, command: string, fn: (client: WamClient) => Promise<T>): Promise<T> {
  try {
    return await fn(ctx.anonymousClient());
  } catch (err) {
    throw mapSiteError(ctx, err, command);
  }
}

// --- Small formatters -------------------------------------------------------------------------

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** One line of third-party text for a table cell: control characters out, whitespace collapsed, capped. */
function cell(text: string, max: number): string {
  let clean = "";
  for (const ch of text) clean += isControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** Third-party text, quoted. JSON string quoting escapes quotes, newlines and the C0 controls. */
function quoted(text: string | null | undefined): string {
  if (text === null || text === undefined) return "(none)";
  let out = "";
  for (const ch of JSON.stringify(text)) {
    const code = ch.codePointAt(0) ?? 0;
    out += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elapsedSeconds(started: Date, finished: Date): number {
  return Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000));
}

function severityCounts(findings: ReadonlyArray<{ severity: string }>, order: readonly string[]): string {
  const parts: string[] = [];
  for (const severity of order) {
    const n = findings.filter((f) => f.severity === severity).length;
    if (n > 0) parts.push(severity === "info" ? `${n} info` : plural(n, severity, severity === "pass" ? "passes" : undefined));
  }
  return parts.join(", ");
}

function bySeverity<T extends { severity: string }>(findings: readonly T[], order: readonly string[]): T[] {
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  return [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
}

// --- check-crawlers ---------------------------------------------------------------------------

type CrawlerBot = CrawlerAccessResult["bots"][number];
export type CrawlerVerdict = "allowed" | "disallowed" | "requested";

/**
 * `respectsRobots` is a reputation field with three values, and it is compared here, never
 * coerced: only an operator recorded as honouring robots.txt earns a plain "no". For "no" and
 * "unverified" a disallow rule is a request the operator may ignore, and the table says so.
 */
export function crawlerVerdict(bot: Pick<CrawlerBot, "allowed" | "respectsRobots">): CrawlerVerdict {
  if (bot.allowed) return "allowed";
  return bot.respectsRobots === "yes" ? "disallowed" : "requested";
}

const VERDICT_CELL: Record<CrawlerVerdict, string> = {
  allowed: "yes",
  disallowed: "no",
  requested: "requested not to crawl",
};

function robotsHeader(r: CrawlerAccessResult): string {
  let note = `${plural(r.sitemaps.length, "sitemap")} declared`;
  if (r.robotsMissing) note = "no robots.txt, so every crawler is allowed";
  else if (r.robotsServerError) note = "server error, which compliant crawlers treat as a full disallow";
  return `robots.txt for ${r.origin}   HTTP ${r.robotsStatus}   (${note})`;
}

function ruleCell(bot: CrawlerBot): string {
  const rule = bot.untrusted.matchedRule;
  if (rule === null) return "(no matching rule)";
  const text = cell(rule, 60);
  return bot.matchedLine === null ? text : `${text}   line ${bot.matchedLine}`;
}

function renderCrawlerAccess(ctx: Context, r: CrawlerAccessResult, arg: string): void {
  const { out } = ctx;
  out.data(robotsHeader(r));
  if (r.truncated) out.data("The robots.txt file is larger than the parser limit, so only the first part was read.");
  out.data("");
  out.table(
    r.bots.map((bot) => ({
      allowed: VERDICT_CELL[crawlerVerdict(bot)],
      bot: bot.token,
      operator: bot.operator,
      category: bot.category,
      respects: bot.respectsRobots,
      rule: ruleCell(bot),
    })),
    [
      { key: "allowed", header: "ALLOWED", align: "left" },
      { key: "bot", header: "BOT", align: "left" },
      { key: "operator", header: "OPERATOR", align: "left" },
      { key: "category", header: "CATEGORY", align: "left" },
      { key: "respects", header: "RESPECTS", align: "left" },
      { key: "rule", header: "RULE", align: "left" },
    ],
  );

  const verdicts = r.bots.map(crawlerVerdict);
  const allowed = verdicts.filter((v) => v === "allowed").length;
  const disallowed = verdicts.filter((v) => v === "disallowed").length;
  const requested = verdicts.filter((v) => v === "requested").length;
  const parts = [`${allowed} allowed`, `${disallowed} disallowed`];
  if (requested > 0) parts.push(`${requested} requested not to crawl`);
  out.data("");
  out.data(`${parts.join(", ")}, of ${r.bots.length} known AI crawlers.`);
  if (requested > 0) {
    out.data("Requested not to crawl: robots.txt is voluntary, and those operators are not verified to honour it.");
  }
  const search = r.bots.filter((bot) => crawlerVerdict(bot) === "disallowed" && bot.category === "search").length;
  if (search === 1) {
    out.data("1 disallowed bot is a search crawler, which means that assistant cannot cite you.");
  } else if (search > 1) {
    out.data(`${search} disallowed bots are search crawlers, which means those assistants cannot cite you.`);
  }
  out.chatter("");
  out.chatter(`Full JSON:  wam site check-crawlers ${arg} --json`);
}

// --- validate-llms-txt ------------------------------------------------------------------------

const LLMS_SEVERITIES = ["error", "warning", "info"] as const;

function renderLlmsTxtValidation(ctx: Context, r: LlmsTxtValidation, arg: string): void {
  const { out } = ctx;
  out.data(`llms.txt for ${r.origin}   HTTP ${r.status}${r.missing ? "   (not found)" : ""}`);
  if (r.missing) out.data("No llms.txt was found, so there is nothing to score.");
  if (r.score !== null) out.data(`Score: ${r.score}/100`);

  if (r.findings.length > 0) {
    out.data("");
    out.data(`Findings: ${severityCounts(r.findings, LLMS_SEVERITIES)}`);
    out.table(
      bySeverity(r.findings, LLMS_SEVERITIES).map((f) => ({
        severity: f.severity,
        line: f.line === undefined ? "" : `line ${f.line}`,
        message: f.message,
      })),
      [
        { key: "severity", header: "SEVERITY", align: "left" },
        { key: "line", header: "LINE", align: "left" },
        { key: "message", header: "MESSAGE", align: "left" },
      ],
      { indent: "  ", header: false },
    );
  } else if (!r.missing) {
    out.data("");
    out.data("Findings: none");
  }

  if (r.stats !== null) {
    const s = r.stats;
    out.data("");
    out.data(
      `Stats: ${plural(s.lines, "line")}, ${formatBytes(s.bytes)}, ${plural(s.sections, "section")}, ` +
        `${plural(s.entries, "entry", "entries")} (${s.entriesWithDescription} with a description)`,
    );
  }
  if (!r.missing) {
    out.data(`Links: ${r.linksChecked} checked, ${r.brokenLinks.length} broken`);
    for (const link of r.brokenLinks) out.data(`  HTTP ${link.status}  ${cell(link.url, 200)}`);
    out.data(`llms-full.txt: ${r.hasLlmsFullTxt ? "found" : "not found"}`);
  }
  if (r.missing) {
    out.chatter("");
    out.chatter(`Generate one:  wam site generate-llms-txt ${arg} -o llms.txt`);
  }
}

// --- The two generators -----------------------------------------------------------------------

function writeGeneratedFile(ctx: Context, file: string, content: string): void {
  try {
    writeFileSync(resolve(ctx.primitives.cwd, file), content, "utf8");
  } catch (err) {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    throw usageError(
      `Could not write ${file}${typeof code === "string" ? ` (${code})` : ""}.`,
      "Check that the directory exists and that you can write to it.",
    );
  }
}

/** `## ` headings and `- [` link lines of the llmstxt.org index format, counted from the file itself. */
function llmsIndexShape(content: string): { entries: number; sections: number } {
  const lines = content.split("\n");
  return {
    entries: lines.filter((l) => l.startsWith("- [")).length,
    sections: lines.filter((l) => l.startsWith("## ")).length,
  };
}

function llmsTxtChatter(ctx: Context, r: LlmsTxtGeneration, seconds: number): void {
  const { out } = ctx;
  out.chatter(
    `Crawled ${plural(r.pageCount, "page")} via ${r.discoveredVia} in ${seconds}s. ${r.skippedCount} skipped.`,
  );
  if (r.totalWords !== undefined) {
    out.chatter(
      r.estTokens === undefined
        ? `${plural(r.totalWords, "word")} of page content.`
        : `${plural(r.totalWords, "word")} of page content, about ${r.estTokens} tokens.`,
    );
  }
  for (const notice of r.notices) out.chatter(notice);
  if (r.timedOut && r.notices.length === 0) {
    out.chatter("The crawl hit its time budget. The file was built from the pages fetched so far.");
  }
}

function renderLlmsTxtGeneration(ctx: Context, r: LlmsTxtGeneration, seconds: number, file: string | undefined): void {
  const content = r.untrusted.content;
  if (file === undefined) {
    ctx.out.raw(content);
    llmsTxtChatter(ctx, r, seconds);
    return;
  }
  writeGeneratedFile(ctx, file, content);
  llmsTxtChatter(ctx, r, seconds);
  const size = formatBytes(Buffer.byteLength(content, "utf8"));
  if (r.depth === "full") {
    ctx.out.chatter(`Wrote ${file} (${size}, ${plural(r.pageCount, "page")}).`);
    return;
  }
  const shape = llmsIndexShape(content);
  ctx.out.chatter(
    `Wrote ${file} (${size}, ${plural(shape.entries, "entry", "entries")} in ${plural(shape.sections, "section")}).`,
  );
}

function sitemapChatter(ctx: Context, r: SitemapGeneration, seconds: number): void {
  ctx.out.chatter(`Found ${plural(r.urlCount, "URL")} via ${r.discoveredVia} in ${seconds}s. ${r.skipped} skipped.`);
  if (r.timedOut) ctx.out.chatter("The crawl hit its time budget. The sitemap covers the pages reached so far.");
}

function renderSitemapGeneration(ctx: Context, r: SitemapGeneration, seconds: number, file: string | undefined): void {
  const xml = r.untrusted.xml;
  if (file === undefined) {
    ctx.out.raw(xml);
    sitemapChatter(ctx, r, seconds);
    return;
  }
  writeGeneratedFile(ctx, file, xml);
  sitemapChatter(ctx, r, seconds);
  ctx.out.chatter(`Wrote ${file} (${formatBytes(Buffer.byteLength(xml, "utf8"))}, ${plural(r.urlCount, "URL")}).`);
}

// --- validate-schema --------------------------------------------------------------------------

const SCHEMA_SEVERITIES = ["error", "warning", "info", "pass"] as const;

function renderStructuredData(ctx: Context, r: StructuredDataValidation): void {
  const { out } = ctx;
  out.data(`Structured data for ${r.url}`);
  out.data(
    `Score: ${r.score}/100   ${plural(r.entityCount, "entity", "entities")}   ` +
      `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}, ${plural(r.passes, "pass", "passes")}`,
  );
  out.data(
    `Microdata annotations: ${r.microdataCount}   RDFa annotations: ${r.rdfaCount}   (counted, not validated)`,
  );
  if (r.blocks.length === 0) {
    out.data("");
    out.data("No JSON-LD blocks were found on this page.");
    return;
  }
  for (const block of r.blocks) {
    out.data("");
    out.data(`JSON-LD block ${block.index}`);
    if (block.syntaxError !== undefined) out.data(`  Syntax error: ${cell(block.syntaxError, 200)}`);
    if (block.entities.length === 0 && block.syntaxError === undefined) out.data("  No entities.");
    for (const entity of block.entities) {
      const name = entity.untrusted.name;
      out.data(`  ${cell(entity.type, 80)}${name === undefined ? "" : ` ${quoted(name)}`}`);
      if (entity.findings.length > 0) {
        out.table(
          bySeverity(entity.findings, SCHEMA_SEVERITIES).map((f) => ({ severity: f.severity, message: f.message })),
          [
            { key: "severity", header: "SEVERITY", align: "left" },
            { key: "message", header: "MESSAGE", align: "left" },
          ],
          { indent: "    ", header: false },
        );
      }
      if (entity.aiNote !== undefined) out.data(`    AI note: ${entity.aiNote}`);
    }
  }
}

// --- check-meta -------------------------------------------------------------------------------

const META_LEVELS = ["error", "warning", "suggestion", "pass"] as const;

function cutoffText(index: number | null): string {
  return index === null ? "fits" : `truncates around character ${index}`;
}

function renderChecks(ctx: Context, title: string, checks: MetaAnalysisResult["checks"]): void {
  if (checks.length === 0) return;
  const rank = (level: string) => META_LEVELS.indexOf(level as (typeof META_LEVELS)[number]);
  ctx.out.data("");
  ctx.out.data(title);
  ctx.out.table(
    [...checks].sort((a, b) => rank(a.level) - rank(b.level)).map((c) => ({ level: c.level, message: c.message })),
    [
      { key: "level", header: "LEVEL", align: "left" },
      { key: "message", header: "MESSAGE", align: "left" },
    ],
    { indent: "  ", header: false },
  );
}

function renderMeta(ctx: Context, r: MetaAnalysisResult): void {
  const { out } = ctx;
  out.data(`Meta description for ${r.url}`);
  out.data(`Score: ${r.score}/100   ${plural(r.chars, "char")}, ${r.pixels} px`);
  out.data(`Desktop: ${cutoffText(r.desktopCutoff)}   Mobile: ${cutoffText(r.mobileCutoff)}`);
  out.data("");
  out.table(
    [
      { field: "Title", value: quoted(r.untrusted.title) },
      { field: "Description", value: quoted(r.untrusted.description) },
      { field: "og:description", value: quoted(r.untrusted.ogDescription) },
      { field: "First paragraph", value: quoted(r.untrusted.firstParagraph) },
    ],
    [
      { key: "field", header: "FIELD", align: "left" },
      { key: "value", header: "VALUE", align: "left" },
    ],
    { header: false },
  );
  renderChecks(ctx, "Checks", r.checks);
  renderChecks(ctx, "Opening paragraph", r.openingParagraphChecks);
}

// --- analyze-chunks ---------------------------------------------------------------------------

const CHUNK_SEVERITIES = ["error", "warning"] as const;

function renderChunks(ctx: Context, r: ChunkAnalysisResult): void {
  const { out } = ctx;
  out.data(`Content chunking for ${r.url}   (${r.mode})`);
  out.data(
    `Score: ${r.score}/100   ${plural(r.totalWords, "word")}, ${plural(r.totalTokens, "token")}   ` +
      `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}, ${plural(r.strengthCount, "strength")}   ` +
      `${plural(r.chunks.length, "chunk")}`,
  );
  if (r.topFixes.length > 0) {
    out.data("");
    out.data("Top fixes");
    r.topFixes.forEach((fix, i) => out.data(`  ${i + 1}. ${fix}`));
  }
  if (r.docFindings.length > 0) {
    out.data("");
    out.data("Document findings");
    out.table(
      bySeverity(r.docFindings, CHUNK_SEVERITIES).map((f) => ({ severity: f.severity, message: f.message })),
      [
        { key: "severity", header: "SEVERITY", align: "left" },
        { key: "message", header: "MESSAGE", align: "left" },
      ],
      { indent: "  ", header: false },
    );
  }
  if (r.chunks.length === 0) return;

  const heading = (chunk: ChunkAnalysisResult["chunks"][number]) =>
    chunk.untrusted.heading === null ? "(no heading)" : cell(chunk.untrusted.heading, 48);
  out.data("");
  out.table(
    r.chunks.map((chunk, i) => ({
      n: i + 1,
      level: chunk.level === 0 ? "intro" : `H${chunk.level}`,
      heading: heading(chunk),
      words: chunk.words,
      tokens: chunk.tokens,
      paragraphs: chunk.paragraphs,
      longest: chunk.longestParagraphWords,
      errors: chunk.findings.filter((f) => f.severity === "error").length,
      warnings: chunk.findings.filter((f) => f.severity === "warning").length,
      strengths: chunk.strengths.length,
    })),
    [
      { key: "n", header: "#" },
      { key: "level", header: "LEVEL", align: "left" },
      { key: "heading", header: "HEADING", align: "left" },
      { key: "words", header: "WORDS" },
      { key: "tokens", header: "TOKENS" },
      { key: "paragraphs", header: "PARAS" },
      { key: "longest", header: "LONGEST" },
      { key: "errors", header: "ERRORS" },
      { key: "warnings", header: "WARNINGS" },
      { key: "strengths", header: "STRENGTHS" },
    ],
  );

  const flagged = r.chunks.map((chunk, i) => ({ chunk, n: i + 1 })).filter(({ chunk }) => chunk.findings.length > 0);
  if (flagged.length === 0) return;
  out.data("");
  out.data("Findings by chunk");
  for (const { chunk, n } of flagged) {
    out.data(`  #${n} ${chunk.untrusted.heading === null ? "(no heading)" : quoted(cell(chunk.untrusted.heading, 80))}`);
    out.table(
      bySeverity(chunk.findings, CHUNK_SEVERITIES).map((f) => ({ severity: f.severity, message: f.message })),
      [
        { key: "severity", header: "SEVERITY", align: "left" },
        { key: "message", header: "MESSAGE", align: "left" },
      ],
      { indent: "    ", header: false },
    );
  }
}

// --- Registration -----------------------------------------------------------------------------

function example(...lines: string[]): string {
  return `\n${lines.length === 1 ? "Example" : "Examples"}:\n${lines.map((l) => `  $ ${l}`).join("\n")}\n`;
}

const GROUP_HELP = `
These commands need no account, no API key and no config. The site is fetched by the
whereamimentioned server, never by this CLI, so the checks see it from the public internet.

Examples:
  $ npx @whereamimentioned/cli site check-crawlers acme.com
  $ wam site validate-llms-txt acme.com --json
  $ wam site generate-sitemap acme.com > sitemap.xml
`;

export function registerSiteCommands(program: Command, getContext: () => Context): void {
  const site = program
    .command("site")
    .description("Free checks on any site, no account needed")
    .addHelpText("after", GROUP_HELP);

  site
    .command("check-crawlers <url>")
    .description("Show which known AI crawlers the site's robots.txt allows, with the rule and line that decided it")
    .addHelpText("after", example("wam site check-crawlers acme.com"))
    .action(async (arg: string) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const result = await callSite(ctx, "site check-crawlers", (client) => client.site.checkCrawlers(url));
      if (ctx.out.json) ctx.out.jsonDocument(result);
      else renderCrawlerAccess(ctx, result, arg);
    });

  site
    .command("validate-llms-txt <url>")
    .description("Score the site's llms.txt: findings with line numbers, stats, broken links and llms-full.txt presence")
    .addHelpText("after", example("wam site validate-llms-txt acme.com"))
    .action(async (arg: string) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const result = await callSite(ctx, "site validate-llms-txt", (client) => client.site.validateLlmsTxt(url));
      if (ctx.out.json) ctx.out.jsonDocument(result);
      else renderLlmsTxtValidation(ctx, result, arg);
    });

  site
    .command("generate-llms-txt <url>")
    .description("Crawl the site and generate an llms.txt on stdout (counts and notices go to stderr)")
    .option("--full", "Generate llms-full.txt, with the extracted page content, instead of the link index")
    .option("-o, --output <file>", "Write the file there instead of stdout, and print a summary to stderr")
    .addHelpText(
      "after",
      example("wam site generate-llms-txt acme.com > llms.txt", "wam site generate-llms-txt acme.com --full -o llms-full.txt"),
    )
    .action(async (arg: string, opts: { full?: boolean; output?: string }) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const started = ctx.primitives.now();
      const result = await callSite(ctx, "site generate-llms-txt", (client) =>
        client.site.generateLlmsTxt(url, { full: opts.full === true }),
      );
      const seconds = elapsedSeconds(started, ctx.primitives.now());
      if (ctx.out.json) {
        if (opts.output !== undefined) writeGeneratedFile(ctx, opts.output, result.untrusted.content);
        ctx.out.jsonDocument(result);
        return;
      }
      renderLlmsTxtGeneration(ctx, result, seconds, opts.output);
    });

  site
    .command("generate-sitemap <url>")
    .description("Crawl the site and generate a sitemap.xml on stdout (counts and timing go to stderr)")
    .option("-o, --output <file>", "Write the file there instead of stdout, and print a summary to stderr")
    .addHelpText(
      "after",
      example("wam site generate-sitemap acme.com > sitemap.xml", "wam site generate-sitemap acme.com -o sitemap.xml"),
    )
    .action(async (arg: string, opts: { output?: string }) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const started = ctx.primitives.now();
      const result = await callSite(ctx, "site generate-sitemap", (client) => client.site.generateSitemap(url));
      const seconds = elapsedSeconds(started, ctx.primitives.now());
      if (ctx.out.json) {
        if (opts.output !== undefined) writeGeneratedFile(ctx, opts.output, result.untrusted.xml);
        ctx.out.jsonDocument(result);
        return;
      }
      renderSitemapGeneration(ctx, result, seconds, opts.output);
    });

  site
    .command("validate-schema <url>")
    .description("Validate the page's JSON-LD entities: score, per-entity findings, microdata and RDFa counts")
    .addHelpText("after", example("wam site validate-schema acme.com/pricing"))
    .action(async (arg: string) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const result = await callSite(ctx, "site validate-schema", (client) => client.site.validateStructuredData(url));
      if (ctx.out.json) ctx.out.jsonDocument(result);
      else renderStructuredData(ctx, result);
    });

  site
    .command("check-meta <url>")
    .description("Check the page's title, meta description and opening paragraph: widths, truncation and findings")
    .option("--keyword <keyword>", "A target keyword to check for presence and position")
    .addHelpText("after", example('wam site check-meta acme.com/pricing --keyword "team pricing"'))
    .action(async (arg: string, opts: { keyword?: string }) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const result = await callSite(ctx, "site check-meta", (client) => client.site.checkMeta(url, opts.keyword));
      if (ctx.out.json) ctx.out.jsonDocument(result);
      else renderMeta(ctx, result);
    });

  site
    .command("analyze-chunks <url>")
    .description("Analyze how the page chunks for retrieval: per-heading sections, findings, a score and the top fixes")
    .addHelpText("after", example("wam site analyze-chunks acme.com/blog/launch"))
    .action(async (arg: string) => {
      const ctx = getContext();
      const url = normalizeSiteUrl(arg);
      const result = await callSite(ctx, "site analyze-chunks", (client) => client.site.analyzeChunks(url));
      if (ctx.out.json) ctx.out.jsonDocument(result);
      else renderChunks(ctx, result);
    });
}
