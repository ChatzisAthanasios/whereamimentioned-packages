/**
 * Helpers shared by the read and write command modules (10-CLI sections 3.4 to 3.7).
 *
 * Nothing here prints on its own and nothing here holds a number, a model name or a plan limit:
 * flag parsing, the one error-mapping wrapper, the org-scoped preamble every command runs before
 * its first request, the scan id resolver the id-taking commands share, and the display formatting
 * the tables share.
 */
import type { ScanSummary, WamClient } from "@whereamimentioned/api-client";
import { createContext, type Context } from "../context";
import {
  ambiguousScanPrefixError,
  noWorkspaceForScanPrefixError,
  notAScanIdError,
  scanPrefixNotFoundError,
  usageError,
  type ErrorContext,
} from "../errors";

// --- The preamble ------------------------------------------------------------------------------

/**
 * Every org-scoped command starts here. On an account-wide key with no org resolved this throws
 * the local `no_org` usage error (exit 2) BEFORE any request is made (section 3.0); with no
 * credential it throws the "Not signed in." error (exit 3).
 */
export async function orgScopedClient(ctx: Context): Promise<{ client: WamClient; org: string | null }> {
  const org = await ctx.requireOrg();
  const client = await ctx.client();
  return { client, org };
}

/** Runs one client call and maps whatever it threw to the section 9 CliError for `command`. */
export async function call<T>(
  ctx: Context,
  command: string,
  fn: () => Promise<T>,
  extra?: Partial<ErrorContext>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw ctx.mapError(err, command, extra);
  }
}

/**
 * A Context for the same invocation with the org overridden, for the one command whose org comes
 * from an argument and not from `--org`, `WAM_ORG` or config (`wam workspace use org/workspace`).
 * Its `client()` is the same guarded api-client, so `X-Wam-Org` is the argument's org. Print
 * through the ORIGINAL context: only `client()`, `mapError()` and `errorContext()` of this one
 * are meant to be used.
 */
export function withOrg(ctx: Context, org: string): Context {
  return createContext({ ...ctx.primitives, flags: { ...ctx.flags, org } });
}

/** The org slug the invocation resolved, when the CLI knows one locally. Null on a bare WAM_TOKEN. */
export function knownOrg(ctx: Context): string | null {
  return ctx.errorContext().org ?? null;
}

/** The dashboard page of a scan, or null when the org slug is not known locally. */
export function scanPageUrl(ctx: Context, workspaceSlug: string, scanId: string): string | null {
  const org = knownOrg(ctx);
  if (!org) return null;
  const base = ctx.config().apiUrl.value.replace(/\/+$/, "");
  return `${base}/${org}/${workspaceSlug}/scans/${scanId}`;
}

// --- Scan id arguments -------------------------------------------------------------------------
//
// The ID column of `wam scan list` prints the first eight characters of a scan id (section 3.5),
// and section 9's own copy pastes that short form back into `wam scan status`. So every command
// that reads a scan id accepts an unambiguous prefix of one. The server only ever sees a full id:
// a prefix is resolved HERE, by paging the workspace's scan list and matching case-insensitively.

const UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/** The contract's `pageQuery` ceiling, the same bound `parseLimit` enforces on `--limit`. */
const LOOKUP_PAGE_LIMIT = 100;

/** A complete scan id, in either case. It is sent as typed and costs no lookup. */
export function isFullScanId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Could `value` begin a scan id: hex where a UUID has hex, a dash where it has a dash. */
export function isScanIdPrefix(value: string): boolean {
  if (value.length === 0 || value.length > UUID_TEMPLATE.length) return false;
  for (let i = 0; i < value.length; i++) {
    const want = UUID_TEMPLATE[i];
    const got = value[i]!;
    if (want === "-" ? got !== "-" : !/^[0-9a-f]$/i.test(got)) return false;
  }
  return true;
}

/** Every scan of `workspace` whose id starts with `prefix`, case-insensitively, across all pages. */
async function scansMatchingPrefix(
  ctx: Context,
  client: WamClient,
  workspace: string,
  prefix: string,
  command: string,
): Promise<ScanSummary[]> {
  const want = prefix.toLowerCase();
  const matches: ScanSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await call(
      ctx,
      command,
      () => client.scans.list(workspace, { limit: LOOKUP_PAGE_LIMIT, cursor }),
      { workspace },
    );
    for (const scan of page.data) if (scan.id.toLowerCase().startsWith(want)) matches.push(scan);
    const next = page.pagination.nextCursor;
    // A null cursor is the last page. A repeated one would be a server bug, and never a loop here.
    if (next === null || seen.has(next)) return matches;
    seen.add(next);
    cursor = next;
  }
}

/**
 * The scan a positional `<scanId>` or `--scan` names, as a full id.
 *
 * A full id is returned as typed (trimmed) with no request made. Anything else must look like the
 * start of one (exit 2 otherwise, before any request) and is looked up in the resolved workspace's
 * scan list: exactly one match is the answer, none is the not-found row (exit 1, like a server 404
 * on a full id), several is a usage error that lists them (exit 2). A prefix needs a workspace to
 * look in; without one the error says so and offers the full id as the way around it.
 */
export async function resolveScanIdArgument(
  ctx: Context,
  client: WamClient,
  raw: string,
  command: string,
): Promise<string> {
  const value = raw.trim();
  if (isFullScanId(value)) return value;
  if (!isScanIdPrefix(value)) throw notAScanIdError(raw);

  const workspace = ctx.config().workspace.value;
  if (!workspace) throw noWorkspaceForScanPrefixError(value);

  const matches = await scansMatchingPrefix(ctx, client, workspace, value, command);
  if (matches.length === 1) {
    const id = matches[0]!.id;
    ctx.out.debug(`scan id: ${value} resolved to ${id} in workspace ${workspace}`);
    return id;
  }
  if (matches.length === 0) throw scanPrefixNotFoundError(value, workspace, knownOrg(ctx));
  throw ambiguousScanPrefixError(value, workspace, matches);
}

// --- Flag parsing ------------------------------------------------------------------------------

/** `--limit <1..100>`: the bound is the contract's `pageQuery`, fixed on every list endpoint. */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1 || n > 100) {
    throw usageError("--limit must be an integer from 1 to 100.");
  }
  return n;
}

export function parseBooleanFlag(flag: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw usageError(`${flag} must be true or false.`);
}

export function parsePositiveSeconds(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1) {
    throw usageError(`${flag} must be a whole number of seconds, 1 or more.`);
  }
  return n;
}

export function parseThreshold(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 0 || n > 100) {
    throw usageError(`${flag} must be an integer from 0 to 100.`);
  }
  return n;
}

/** A flag whose values are one of the contract's const tuples. The valid list is printed from the tuple. */
export function parseChoice<T extends string>(flag: string, raw: string | undefined, choices: readonly T[]): T | undefined {
  if (raw === undefined) return undefined;
  if ((choices as readonly string[]).includes(raw)) return raw as T;
  throw usageError(`${flag} must be one of: ${choices.join(", ")}.`);
}

// --- Display -----------------------------------------------------------------------------------

/** The first eight characters, as the tables of sections 3.4, 3.5 and 3.7 show an id. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** `2026-08-28 09:14`, in UTC, from an ISO timestamp. The raw value when it does not parse. */
export function formatDateTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/** `2026-08-28`, in UTC. */
export function formatDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toISOString().slice(0, 10);
}

/** `45s`, `2m 12s`, `1h 3m`, `3d 2h`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** A fraction as a whole percent: 0.58 is `58%`. */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A fraction as a percent with one decimal: 0.094 is `9.4%`. */
export function percent1(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** `  Label          value`, the two-space indent and 15-wide label column of section 3.2. */
export function labelled(label: string, value: string, width = 15): string {
  return `  ${label.padEnd(width)}${value}`.replace(/\s+$/, "");
}

/** `Next page:  wam ... --cursor <cursor>`, on stderr: a hint, never part of the data. */
export function nextPageHint(ctx: Context, commandLine: string, nextCursor: string | null): void {
  if (nextCursor === null) return;
  ctx.out.chatter("");
  ctx.out.chatter(`Next page:  ${commandLine} --cursor ${nextCursor}`);
}
