/**
 * The follow loop behind `wam scan status --wait`, `wam scan watch` and (checkpoint 5)
 * `wam scan run --wait` (10-CLI sections 3.5, 6.2 rule 1 and 6.3).
 *
 * It polls `GET /api/v1/scans/{scanId}` at max(--poll, 5) seconds, default 10, and reports one
 * line per tick: on stderr for a human, or as NDJSON `{ "type": "progress", ... }` on stdout under
 * `--json`. It never renders a percentage, because `progress.total` grows while a scan runs and a
 * naive done/total moves backwards; it prints the raw counts, with "(total may still grow)" until
 * `totalIsFinal` is true.
 *
 * `followScan` returns the terminal scan body and decides nothing about exit codes. The caller
 * ends the stream with `emitFollowResult` or `failFollow`, so `scan run` can put its own threshold
 * gate in between. A GET is never retried here beyond what the api-client already does, and a 429
 * stops the loop like any other error.
 */
import type { ScanStatus, WamClient } from "@whereamimentioned/api-client";
import type { Context } from "../context";
import { CliError, followTimedOutError, scanFailedError } from "../errors";
import { call, scanPageUrl } from "./support";

export const MIN_POLL_SECONDS = 5;
export const DEFAULT_POLL_SECONDS = 10;
export const DEFAULT_FOLLOW_TIMEOUT_SECONDS = 1800;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The loop's only wait. A test replaces `sleep` so nothing depends on a wall clock. */
export const followClock: { sleep: (ms: number) => Promise<void> } = { sleep: realSleep };

export interface FollowOptions {
  /** `--poll`, in seconds. Floored at MIN_POLL_SECONDS. */
  pollSeconds?: number;
  /** `--timeout`, in seconds. */
  timeoutSeconds?: number;
  /** The space-joined command path, for `mapError`. */
  command: string;
}

/** `25 of 42 answers  (total may still grow)`. Raw counts only, never a percentage. */
export function progressText(scan: Pick<ScanStatus, "progress">): string {
  const { done, total, totalIsFinal } = scan.progress;
  const counts = `${done} of ${total} answers`;
  return totalIsFinal ? counts : `${counts}  (total may still grow)`;
}

export function isTerminal(scan: Pick<ScanStatus, "status">): boolean {
  return scan.status === "done" || scan.status === "failed";
}

/** The "Scan failed" row of section 9, exit 6. */
export function failedScanError(ctx: Context, scan: ScanStatus): CliError {
  const url = scanPageUrl(ctx, scan.workspaceSlug, scan.id) ?? ctx.config().apiUrl.value;
  return scanFailedError(scan.id, scan.error, url);
}

/**
 * Polls until the scan is `done` or `failed` and returns that body. Throws the "Follow timed out"
 * error of section 9 (exit 1, the scan is left running) once `timeoutSeconds` have passed, and the
 * mapped section 9 error for anything the API refused.
 */
export async function followScan(
  ctx: Context,
  client: WamClient,
  scanId: string,
  opts: FollowOptions,
): Promise<ScanStatus> {
  const interval = Math.max(opts.pollSeconds ?? DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS);
  const timeout = opts.timeoutSeconds ?? DEFAULT_FOLLOW_TIMEOUT_SECONDS;
  const startedAt = ctx.primitives.now().getTime();
  let slept = 0;

  for (;;) {
    const scan = await call(ctx, opts.command, () => client.scans.get(scanId), { scanId });
    if (isTerminal(scan)) return scan;

    if (ctx.out.json) ctx.out.ndjson({ type: "progress", ...scan });
    else ctx.out.chatter(`${scan.status}  ${progressText(scan)}`);

    // The larger of the time slept and the wall clock: a slow server still counts, and a fixed
    // test clock still terminates.
    const elapsed = Math.max(slept, (ctx.primitives.now().getTime() - startedAt) / 1000);
    if (elapsed >= timeout) throw followTimedOutError(Math.max(1, Math.round(timeout / 60)), scanId);

    await followClock.sleep(interval * 1000);
    slept += interval;
  }
}

/**
 * Section 6.2 rule 1: under `--json` a streaming command ends with exactly ONE terminal object
 * whose `type` is "result" or "error". The boundary in index.ts would print the rule 4 object with
 * no `type`, so a failure while streaming is written here and the exit code is set without
 * throwing. Without `--json` the error is thrown and the boundary renders it on stderr.
 */
export function failFollow(ctx: Context, err: CliError): void {
  if (!ctx.out.json) throw err;
  ctx.out.ndjson({ type: "error", ...err.toJsonObject() });
  ctx.setExitCode(err.exitCode === 0 ? 1 : err.exitCode);
}

/** The terminal `{ "type": "result", ... }` object: the scan body as received, plus the type. */
export function emitFollowResult(ctx: Context, scan: ScanStatus): void {
  ctx.out.ndjson({ type: "result", ...scan });
}

/**
 * `followScan` with its failures routed through `failFollow`. Resolves to null when the error has
 * already been written as the terminal NDJSON object and the exit code set.
 */
export async function followToEnd(
  ctx: Context,
  client: WamClient,
  scanId: string,
  opts: FollowOptions,
): Promise<ScanStatus | null> {
  try {
    return await followScan(ctx, client, scanId, opts);
  } catch (err) {
    if (err instanceof CliError) {
      failFollow(ctx, err);
      return null;
    }
    throw err;
  }
}
