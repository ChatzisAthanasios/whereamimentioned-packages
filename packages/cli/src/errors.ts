/**
 * CliError, the exit-code table (10-CLI section 3.1) and the user-visible copy of section 9.
 *
 * Every failure the CLI reports is a `CliError`: a script-visible `code`, an exit code, the exact
 * stderr lines, and the server `details` and `requestId` when there was a server. The boundary in
 * index.ts renders it once, either as stderr lines or as the `--json` error object of section
 * 6.2 rule 4. Command modules never format an error themselves.
 *
 * Server errors are mapped by ONE function, `mapApiError(error, command, ctx)`, because two
 * `ApiErrorCode`s map to two exit codes each depending on the command that produced them (section
 * 3.1), so the mapping is deliberately not a lookup table.
 *
 * Copy discipline (section 9 and CLAUDE.md): no em dash anywhere in this file, no number that did
 * not arrive in a response, and never a token beyond prefix...last4.
 */
import {
  ApiError,
  ApiTimeoutError,
  DEFAULT_BASE_URL,
  SUPPORTED_API_VERSION,
  type ApiErrorCode,
  type ApiKeyKind,
} from "@whereamimentioned/api-client";

// --- Exit codes (section 3.1) -----------------------------------------------------------------

export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  AUTH: 3,
  CREDITS: 4,
  RATE_LIMITED: 5,
  SCAN_FAILED: 6,
  THRESHOLD: 7,
  SCAN_RUNNING: 8,
  CONFLICT: 9,
  CEILING: 10,
  NO_PAID_ORG: 11,
} as const;

/** Printed by `wam --help`. Nothing above 125, because the shell reserves 126, 127 and 128+n. */
export const EXIT_CODES: ReadonlyArray<readonly [number, string]> = [
  [EXIT.OK, "Success"],
  [EXIT.FAILURE, "Generic failure (unexpected server 500, unhandled condition)"],
  [EXIT.USAGE, "Usage error (unknown flag, missing argument, bad value, no workspace or org resolved)"],
  [EXIT.AUTH, "Auth required or expired (no credential, revoked or expired key, scope, role or tier gate)"],
  [EXIT.CREDITS, "Insufficient credits (HTTP 402 from the scan-create route)"],
  [EXIT.RATE_LIMITED, "Rate limited (HTTP 429)"],
  [EXIT.SCAN_FAILED, "Scan failed while being followed"],
  [EXIT.THRESHOLD, "Threshold not met (--fail-under)"],
  [EXIT.SCAN_RUNNING, "Scan already running and --no-follow was passed"],
  [EXIT.CONFLICT, "Conflict: the priced terms moved, or an Idempotency-Key was reused with different terms"],
  [EXIT.CEILING, "Ceiling reached: the plan's workspace cap, or the organizations one account may own"],
  [EXIT.NO_PAID_ORG, "No paid organization: wam org create needs an organization on a paid plan"],
];

export function formatExitCodeTable(): string {
  const width = Math.max(...EXIT_CODES.map(([code]) => String(code).length));
  return EXIT_CODES.map(([code, meaning]) => `  ${String(code).padStart(width)}  ${meaning}`).join("\n");
}

// --- Codes -----------------------------------------------------------------------------------

/** The CLI-local members of the script-visible `error.code` union (section 6.2 rule 4). */
export const LOCAL_ERROR_CODES = [
  "no_credential",
  "no_org",
  "no_workspace",
  "network_unreachable",
  "usage_error",
  "timed_out",
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

/**
 * `ApiErrorCode` plus the local codes, plus three the CLI needs for conditions section 6.2's list
 * does not name: an `X-Wam-Api-Version` above the compiled one, a followed scan ending `failed`,
 * and `threshold_not_met`, which never reaches the stdout error object (section 7.4). `unknown`
 * is what the api-client itself emits for a non-JSON body, and what the boundary uses for an
 * unexpected exception.
 */
export type CliErrorCode =
  | ApiErrorCode
  | LocalErrorCode
  | "api_version_mismatch"
  | "scan_failed"
  | "threshold_not_met"
  | "unknown";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | null;

  constructor(
    code: CliErrorCode,
    exitCode: number,
    lines: readonly string[],
    opts: { details?: Record<string, unknown>; requestId?: string | null } = {},
  ) {
    super(lines.join("\n"));
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.lines = lines;
    this.details = opts.details;
    this.requestId = opts.requestId ?? null;
  }

  /** The stable stdout object of section 6.2 rule 4. */
  toJsonObject(): {
    ok: false;
    error: { code: string; message: string; requestId: string | null; details: Record<string, unknown> | null };
    exitCode: number;
  } {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.lines.join("\n"),
        requestId: this.requestId,
        details: this.details ?? null,
      },
      exitCode: this.exitCode,
    };
  }
}

// --- Local errors (section 9 rows with no server behind them) ---------------------------------

export function usageError(...lines: string[]): CliError {
  return new CliError("usage_error", EXIT.USAGE, lines);
}

export function noCredentialError(): CliError {
  return new CliError("no_credential", EXIT.AUTH, [
    "Not signed in.",
    "Run wam auth login, or set WAM_TOKEN in your environment.",
  ]);
}

export function noOrgError(): CliError {
  return new CliError("no_org", EXIT.USAGE, [
    "No organization selected. This key reaches several, so it cannot guess.",
    "Pass --org <slug>, set WAM_ORG, or run wam config set org acme. See what it reaches: wam org list",
  ]);
}

export function noWorkspaceError(): CliError {
  return new CliError("no_workspace", EXIT.USAGE, [
    "No workspace selected.",
    "Pass --workspace <slug>, set WAM_WORKSPACE, or run wam workspace use acme/acme-eu",
  ]);
}

// --- Scan id arguments (scan status, scan watch, scan evidence, report get --scan) ---------------
//
// The ID column of `wam scan list` prints the first eight characters of a scan id, so every command
// that takes an id accepts an unambiguous prefix of one and resolves it client side against the
// workspace's scan list (commands/support.ts). These are the rows for the ways that can go wrong.

/** The second line of every "scan not found" row, a server 404 and a local prefix miss alike. */
export const CHECK_SCAN_ID_HINT =
  "Check the id against: wam scan list. A full id or an unambiguous prefix of one is accepted.";

/** The argument is neither a scan id nor the start of one, so no request is worth making. */
export function notAScanIdError(raw: string): CliError {
  return new CliError("usage_error", EXIT.USAGE, [
    `"${raw}" is not a scan id or the start of one.`,
    "Copy it from the ID column of wam scan list. A full id or an unambiguous prefix of one is accepted.",
  ]);
}

/** A prefix is looked up in one workspace's scan list, and none is selected. */
export function noWorkspaceForScanPrefixError(prefix: string): CliError {
  return new CliError("no_workspace", EXIT.USAGE, [
    `${prefix} is a prefix of a scan id, and a prefix is looked up in one workspace's scan list, but no workspace is selected.`,
    "Pass --workspace <slug>, set WAM_WORKSPACE, run wam workspace use acme/acme-eu, or pass the full id.",
  ]);
}

/** No scan of the workspace starts with the prefix. Exit 1, the same as a server 404 on a full id. */
export function scanPrefixNotFoundError(prefix: string, workspace: string, org: string | null): CliError {
  return new CliError("not_found", EXIT.FAILURE, [
    `No scan in workspace ${workspace}${org ? ` of organization ${org}` : ""} has an id starting with ${prefix}, or this key cannot see one.`,
    CHECK_SCAN_ID_HINT,
  ]);
}

/**
 * Several scans start with the prefix. A usage error (exit 2) that lists them, so the next attempt
 * can be typed from this one. The timestamps are printed as the API served them.
 */
export function ambiguousScanPrefixError(
  prefix: string,
  workspace: string,
  candidates: ReadonlyArray<{ id: string; status: string; createdAt: string }>,
): CliError {
  const width = Math.max(...candidates.map((c) => c.status.length));
  return new CliError(
    "usage_error",
    EXIT.USAGE,
    [
      `${prefix} matches ${candidates.length} scans in workspace ${workspace}:`,
      ...candidates.map((c) => `  ${c.id}  ${c.status.padEnd(width)}  ${c.createdAt}`),
      "Pass more of the id, or the full one.",
    ],
    { details: { prefix, workspace, candidates: candidates.map((c) => c.id) } },
  );
}

export function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

export function unsafeCredentialFileError(mode: number, path: string): CliError {
  return new CliError("no_credential", EXIT.AUTH, [
    `Credential file has unsafe permissions (${formatFileMode(mode)}). Fix it and try again:`,
    `  chmod 600 ${path}`,
  ]);
}

export function unknownConfigKeyError(key: string, file: string, valid: readonly string[]): CliError {
  return new CliError("usage_error", EXIT.USAGE, [
    `Unknown option "${key}" in ${file}.`,
    `Valid options are: ${valid.join(", ")}.`,
  ]);
}

export function malformedIdempotencyKeyError(): CliError {
  return new CliError("validation_failed", EXIT.USAGE, [
    "--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -.",
  ]);
}

export function requestTimedOutError(timeoutMs: number): CliError {
  return new CliError("timed_out", EXIT.FAILURE, [
    `The request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
    "Retry, or run with --debug to see what happened.",
  ]);
}

export function followTimedOutError(minutes: number, scanId: string): CliError {
  return new CliError("timed_out", EXIT.FAILURE, [
    `Stopped following after ${minutes} minutes. The scan is still running on the server.`,
    `Check on it later: wam scan status ${scanId}`,
  ]);
}

export function networkUnreachableError(apiUrl: string, reason: string): CliError {
  return new CliError("network_unreachable", EXIT.FAILURE, [
    `Could not reach ${apiUrl} (${reason}).`,
    "Check your connection, or set WAM_API_URL if you are pointing at a different environment.",
  ]);
}

export function apiVersionMismatchError(serverVersion: number): CliError {
  return new CliError("api_version_mismatch", EXIT.FAILURE, [
    `This server speaks API version ${serverVersion} and this CLI understands version ${SUPPORTED_API_VERSION}.`,
    "Upgrade: npm install -g @whereamimentioned/cli@latest",
  ]);
}

/**
 * Section 9.1: the header is read from the client's last response. A value above the compiled
 * `SUPPORTED_API_VERSION` stops the CLI; an absent header means an older server and is fine.
 */
export function assertApiVersion(client: { readonly lastApiVersion: number | null }): void {
  const seen = client.lastApiVersion;
  if (seen !== null && seen > SUPPORTED_API_VERSION) throw apiVersionMismatchError(seen);
}

export function scanFailedError(scanId: string, reason: string | null, scanUrl: string): CliError {
  const why = reason ? reason.trim().replace(/\.$/, "") : "";
  return new CliError("scan_failed", EXIT.SCAN_FAILED, [
    why ? `Scan ${scanId} failed: ${why}.` : `Scan ${scanId} failed.`,
    `Reserved credits have been refunded. See ${scanUrl}`,
  ]);
}

/** Section 7.4. Under `--json` the boundary routes this one to stderr, never to the stdout object. */
export function thresholdNotMetError(score: number, threshold: number): CliError {
  return new CliError("threshold_not_met", EXIT.THRESHOLD, [
    `AI visibility score ${score} is below the threshold of ${threshold}.`,
  ]);
}

// --- Server errors ----------------------------------------------------------------------------

/** What `mapApiError` needs from the invocation to choose and fill the section 9 rows. */
export interface ErrorContext {
  /** The resolved API origin. Defaults to the production origin. */
  apiUrl?: string;
  /** The org the request resolved, if any. */
  org?: string | null;
  /** The workspace the request addressed, if any. */
  workspace?: string | null;
  /** The scan the request addressed, if any (the "report not ready" row). */
  scanId?: string | null;
  /** The credential in use: its cached kind, default org and expiry (section 4.5). */
  credential?: { kind: ApiKeyKind | null; org: string | null; expiresAt: string | null } | null;
  /** `X-RateLimit-Limit` of the failing response, when the header was present (08 section 5.4). */
  rateLimitLimit?: string | null;
  /** For the local expiry hint. Defaults to the wall clock. */
  now?: Date;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

function baseUrl(ctx: ErrorContext): string {
  return (ctx.apiUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKeysUrl(ctx: ErrorContext): string {
  const org = ctx.org ?? ctx.credential?.org ?? null;
  return org ? `${baseUrl(ctx)}/${org}/settings/api-keys` : baseUrl(ctx);
}

function billingUrl(ctx: ErrorContext, details: Record<string, unknown>): string {
  const fromServer = str(details.billingUrl);
  if (fromServer) return fromServer;
  const org = ctx.org ?? ctx.credential?.org ?? null;
  return org ? `${baseUrl(ctx)}/${org}/billing` : `${baseUrl(ctx)}/pricing`;
}

/** `YYYY-MM-DD` when the stored expiry is already behind `now`, else null. */
export function expiredOn(expiresAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at) || at > now.getTime()) return null;
  return new Date(at).toISOString().slice(0, 10);
}

/** The verb phrase of the "role too low" row, chosen by the command that hit the 403. */
function roleAction(command: string): string {
  const actions: Record<string, string> = {
    "scan run": "run a scan",
    "workspace create": "create a workspace",
    "org create": "create an organization",
    "prompt add": "add a prompt",
    "prompt enable": "change a prompt",
    "prompt disable": "change a prompt",
    "prompt remove": "remove a prompt",
    "competitor add": "add a competitor",
    "auth logout": "revoke this key",
  };
  return actions[command] ?? "run this command";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function heldScopes(details: Record<string, unknown>): string[] | null {
  return strings(details.heldScopes) ?? strings(details.scopes) ?? strings(details.held);
}

function mentionsIdempotencyKey(details: Record<string, unknown>): boolean {
  const issues = details.issues;
  if (!Array.isArray(issues)) return false;
  return issues.some((issue) => {
    const path = (issue as { path?: unknown }).path;
    return Array.isArray(path) && path.some((p) => String(p).toLowerCase() === "idempotency-key");
  });
}

/** Appends `(request req_...)` to the last line unless a line already carries the id. */
function withRequestId(lines: string[], requestId: string | null): string[] {
  if (!requestId || lines.length === 0) return lines;
  if (lines.some((l) => l.includes(requestId))) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), `${last} (request ${requestId})`];
}

function serverError500(requestId: string | null): string[] {
  return [
    `The server returned an unexpected error (request ${requestId ?? "id unavailable"}).`,
    "If this keeps happening, contact support@whereamimentioned.com and quote that request id.",
  ];
}

function mapServerError(err: ApiError, command: string, ctx: ErrorContext): CliError {
  const d: Record<string, unknown> = err.details ?? {};
  const rid = err.requestId;
  const make = (code: CliErrorCode, exitCode: number, lines: string[]) =>
    new CliError(code, exitCode, withRequestId(lines, rid), { details: err.details, requestId: rid });

  switch (err.code) {
    case "unauthorized": {
      const lines: string[] = [];
      const expired = expiredOn(ctx.credential?.expiresAt, ctx.now);
      if (expired) lines.push(`Your stored key expired on ${expired}.`);
      lines.push(
        "This API key is no longer valid.",
        `Create a new one with wam auth login, or in the dashboard at ${apiKeysUrl(ctx)}`,
      );
      return make("unauthorized", EXIT.AUTH, lines);
    }

    case "insufficient_scope": {
      if (d.requiredKind === "user") {
        return make("insufficient_scope", EXIT.AUTH, [
          "This key is bound to one organization, so it cannot list or create organizations.",
          "Sign in again with an account-wide key: wam auth login --account-wide",
        ]);
      }
      const required = str(d.requiredScope);
      if (required === "orgs:write") {
        return make("insufficient_scope", EXIT.AUTH, [
          "This key does not carry the orgs:write scope, which creating an organization needs.",
          "Sign in again and ask for it: wam auth login --account-wide --scopes orgs:write,workspaces:read,scans:read,reports:read",
        ]);
      }
      if (required === null) return make("insufficient_scope", EXIT.AUTH, [err.message]);
      const held = heldScopes(d);
      const lines = [`This key does not carry the ${required} scope, which this command needs.`];
      if (held) lines.push(`It has: ${held.join(", ")}.`);
      const suggested = held ? [...new Set([...held, required])] : [required];
      lines.push(`Create a key with the right scopes: wam auth login --scopes ${suggested.join(",")}`);
      return make("insufficient_scope", EXIT.AUTH, lines);
    }

    case "insufficient_role": {
      const effective = str(d.effectiveRole);
      const required = str(d.requiredRole);
      const ask = "Ask an owner or admin to change your role.";
      if (!effective || !required) return make("insufficient_role", EXIT.AUTH, [err.message, ask]);
      return make("insufficient_role", EXIT.AUTH, [
        `Your role in this organization (${effective}) is not high enough to ${roleAction(command)}. ${capitalize(required)} or above is required.`,
        ask,
      ]);
    }

    case "feature_not_available": {
      if (command === "org create") {
        return make("feature_not_available", EXIT.NO_PAID_ORG, [
          "Creating organizations requires at least one organization on a paid plan.",
          `Subscribe first, then try again: ${billingUrl(ctx, d)}`,
        ]);
      }
      const allowedFormats = strings(d.allowedFormats);
      if (allowedFormats) {
        const files = allowedFormats.filter((f) => f !== "json");
        return make("feature_not_available", EXIT.AUTH, [
          err.message,
          `This plan allows: ${files.length > 0 ? files.join(", ") : "no file exports"}. See ${baseUrl(ctx)}/pricing`,
        ]);
      }
      if (num(d.limit) !== null && command.startsWith("prompt")) {
        return make("feature_not_available", EXIT.AUTH, [err.message, "Disable or remove one first: wam prompt list"]);
      }
      const tier = str(d.tier);
      if (tier === null || tier === "free") {
        return make("feature_not_available", EXIT.AUTH, [
          "The API and the CLI are available on paid plans. This organization is on the free floor, which means there is no active subscription.",
          `Choose a plan: ${billingUrl(ctx, d)}`,
        ]);
      }
      return make("feature_not_available", EXIT.AUTH, [err.message, `Choose a plan: ${billingUrl(ctx, d)}`]);
    }

    case "insufficient_credits": {
      const required = num(d.required);
      const available = num(d.available);
      const first =
        required !== null && available !== null
          ? `Not enough credits. This scan needs ${required} credits and the organization has ${available}.`
          : err.message;
      return make("insufficient_credits", EXIT.CREDITS, [first, `Add credits or change plan: ${billingUrl(ctx, d)}`]);
    }

    case "not_found": {
      if (command === "report get" && str(d.status) !== null) {
        return make("not_found", EXIT.FAILURE, [
          "That scan is still running, so there is no report yet.",
          `Follow it with: wam scan status ${ctx.scanId ?? "<scanId>"} --wait`,
        ]);
      }
      // An id-addressed request (scan status, scan evidence, report get --scan) that 404s is about
      // THAT scan: a mistyped id, a scan of another organization, or one this key cannot see.
      // The org and the workspace resolved fine, so the rows below would blame the wrong thing.
      if (ctx.scanId) {
        return make("not_found", EXIT.FAILURE, [
          `Scan ${ctx.scanId} was not found${ctx.org ? ` in organization ${ctx.org}` : ""}, or this key cannot see it.`,
          CHECK_SCAN_ID_HINT,
        ]);
      }
      const kind = ctx.credential?.kind ?? null;
      if (kind === "user") {
        return make("not_found", EXIT.AUTH, [
          `Organization ${ctx.org ?? "(none)"} was not found, or you are not a member of it.`,
          "See what this key reaches: wam org list",
        ]);
      }
      if (kind === "org") {
        const boundOrg = ctx.credential?.org ?? null;
        return make("not_found", EXIT.AUTH, [
          ctx.workspace ? `Workspace ${ctx.workspace} was not found, or this key cannot see it.` : err.message,
          boundOrg
            ? `This key is bound to the organization ${boundOrg}. Check wam auth status.`
            : "Check wam auth status.",
        ]);
      }
      return make("not_found", EXIT.AUTH, [err.message, "Check wam auth status."]);
    }

    case "conflict": {
      if (command === "scan run") {
        const original = str(d.originalScanId);
        if (original) {
          return make("conflict", EXIT.CONFLICT, [
            `That idempotency key was already used for a different scan (${original}).`,
            `Use a different --idempotency-key, or follow the original: wam scan status ${original}`,
          ]);
        }
        const fields = strings(d.fields) ?? [];
        // A quote the server refused outright (expired, bad signature, not this server's, or
        // minted for another key) carries `details.reason` and no fields: nothing "changed", so
        // the API's own sentence is the honest first line and the remedy is the same.
        if (fields.length === 0 && str(d.reason)) {
          return make("conflict", EXIT.CONFLICT, [err.message, "Run wam scan estimate again, then wam scan run."]);
        }
        return make("conflict", EXIT.CONFLICT, [
          "The scan the server priced is no longer the scan it would run.",
          `The fields that changed: ${fields.length > 0 ? fields.join(", ") : "not reported"}.`,
          "Run wam scan estimate again, then wam scan run.",
        ]);
      }
      if (command === "org create") {
        const original = str(d.originalOrgId);
        if (original) {
          return make("conflict", EXIT.CONFLICT, [
            `That idempotency key was already used for a different organization (${original}).`,
            "Use a different --idempotency-key, or see the original: wam org list",
          ]);
        }
        return make("conflict", EXIT.CEILING, [
          err.message,
          "This is a ceiling, not a rate, so waiting will not clear it. Write to support@whereamimentioned.com if you genuinely need another.",
        ]);
      }
      if (command === "workspace create") {
        const current = num(d.current);
        const url = str(d.billingUrl);
        const second =
          current !== null
            ? `This organization already has ${current}.${url ? ` Change plan: ${url}` : ""}`
            : url
              ? `Change plan: ${url}`
              : null;
        return make("conflict", EXIT.CEILING, second ? [err.message, second] : [err.message]);
      }
      return make("conflict", EXIT.CONFLICT, [err.message]);
    }

    case "scan_already_running": {
      // The scan command intercepts this before mapping when it is going to follow the scan
      // (section 3.5). Reaching here means --no-follow, or a command that cannot follow.
      const scanId = str(d.scanId) ?? "unknown";
      return make("scan_already_running", EXIT.SCAN_RUNNING, [
        `A scan is already running for this workspace (${scanId}).`,
        `Pass no flag, or use wam scan status ${scanId}, to follow it.`,
      ]);
    }

    case "validation_failed": {
      if (mentionsIdempotencyKey(d)) {
        const e = malformedIdempotencyKeyError();
        return new CliError(e.code, e.exitCode, withRequestId([...e.lines], rid), { details: err.details, requestId: rid });
      }
      const lines = [err.message];
      const hint = str(d.hint);
      if (hint) lines.push(hint);
      else if (Array.isArray(d.issues)) {
        for (const issue of d.issues) {
          const path = (issue as { path?: unknown[] }).path;
          const message = (issue as { message?: unknown }).message;
          // An issue that only repeats the headline (the site routes' unsafe-URL 422 does) adds nothing.
          if (Array.isArray(path) && typeof message === "string" && message !== err.message) {
            lines.push(`  ${path.join(".")}: ${message}`);
          }
        }
      }
      return make("validation_failed", EXIT.USAGE, lines);
    }

    case "rate_limited": {
      const retry = err.retryAfterSeconds;
      const lines = [`Rate limited.${retry !== null ? ` Try again in ${retry} seconds.` : ""}`];
      if (ctx.rateLimitLimit) lines.push(`Limit: ${ctx.rateLimitLimit} requests per window for this key.`);
      return make("rate_limited", EXIT.RATE_LIMITED, lines);
    }

    case "bad_request":
      return make("bad_request", EXIT.FAILURE, [err.message]);

    case "internal_error":
      return make("internal_error", EXIT.FAILURE, serverError500(rid));

    default: {
      if (err.status >= 500) return make("internal_error", EXIT.FAILURE, serverError500(rid));
      return make("unknown", EXIT.FAILURE, [err.message]);
    }
  }
}

function codeOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** DNS, refused, reset, or undici's `fetch failed` wrapper around one of those. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ApiError || err instanceof ApiTimeoutError || err instanceof CliError) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (codeOf(err) !== null || codeOf(cause) !== null) return true;
  return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(err.message);
}

/** `getaddrinfo ENOTFOUND`, `connect ECONNREFUSED`, or the message when there is no code. */
export function describeNetworkError(err: unknown): string {
  const cause = err instanceof Error ? ((err as { cause?: unknown }).cause ?? err) : err;
  const code = codeOf(cause) ?? codeOf(err);
  const syscall = typeof cause === "object" && cause !== null ? (cause as { syscall?: unknown }).syscall : undefined;
  if (code && typeof syscall === "string") return `${syscall} ${code}`;
  if (code) return code;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one mapping from whatever a client call threw to the CliError the boundary renders.
 * `command` is the space-joined command path (`"scan run"`, `"org create"`), because section 3.1
 * resolves two codes by it.
 */
export function mapApiError(error: unknown, command: string, ctx: ErrorContext = {}): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ApiTimeoutError) return requestTimedOutError(error.timeoutMs);
  if (error instanceof ApiError) return mapServerError(error, command, ctx);
  if (isNetworkError(error)) return networkUnreachableError(baseUrl(ctx), describeNetworkError(error));
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("unknown", EXIT.FAILURE, [
    `Something went wrong: ${message}`,
    "Run again with --debug to see what happened.",
  ]);
}
