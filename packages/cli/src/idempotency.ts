/**
 * The derived `Idempotency-Key` of 10-CLI section 7.3.
 *
 * Two commands send the header, because 08 section 7.1 accepts it on exactly two endpoints:
 * `wam scan run` and `wam org create`. `wam workspace create` sends none, and nothing in this file
 * is for it.
 *
 * The default value is derived, not random, so a retried CI step replays the original instead of
 * starting a second scan (or creating a second organization):
 *
 *   sha256(`${org}:${workspace}:${yyyy-mm-dd UTC}:${runId}`)             wam scan run
 *   sha256(`orgcreate:${name}:${type}:${yyyy-mm-dd UTC}:${runId}`)       wam org create
 *
 * where `runId` is GITHUB_RUN_ID, else CI_PIPELINE_ID, else CI_JOB_ID, else a fresh random UUID.
 * On GitLab the pipeline id is the one that survives a retry: a retried job gets a NEW CI_JOB_ID
 * inside the same CI_PIPELINE_ID, so reading the job id first would start a second scan on every
 * retry, which is the exact case the derivation exists to prevent. (There is no GITLAB_PIPELINE_ID
 * variable; CI_PIPELINE_ID is GitLab's name for it.) The UUID fallback is deliberate: a human
 * running the same command twice asked twice, and a same-day dedupe would silently swallow the
 * second request. The digest is 64 hex characters, which is inside the 1 to 128 characters of
 * [A-Za-z0-9_.:-] the API accepts.
 */
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { idempotencyKey as idempotencyKeySchema } from "@whereamimentioned/api-client";
import { malformedIdempotencyKeyError } from "./errors";
import type { Env } from "./output";

/** The CI variables that name "the same attempt", in the order section 7.3 reads them. */
export const RUN_ID_ENV_VARS = ["GITHUB_RUN_ID", "CI_PIPELINE_ID", "CI_JOB_ID"] as const;

export interface IdempotencyInputs {
  env: Env;
  now: Date;
  /** Replaced in tests. Defaults to node:crypto's. */
  randomUUID?: () => string;
}

/**
 * The first CI run id present, else a fresh UUID. An EMPTY variable counts as absent: a blank
 * run id would make every run of the day share one key, and a scan that silently replays an
 * unrelated one is worse than a second scan.
 */
export function runIdFrom(env: Env, randomUUID: () => string = nodeRandomUUID): string {
  for (const name of RUN_ID_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return randomUUID();
}

/** `yyyy-mm-dd`, in UTC. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 64);
}

/**
 * `wam scan run`. `org` is the slug the invocation resolved locally, or null when the CLI holds a
 * bare org key and was never told the slug; the empty string then stands in for it, which is just
 * as stable across a retry of the same step.
 */
export function deriveScanIdempotencyKey(
  terms: { org: string | null; workspace: string },
  inputs: IdempotencyInputs,
): string {
  const runId = runIdFrom(inputs.env, inputs.randomUUID);
  return sha256Hex(`${terms.org ?? ""}:${terms.workspace}:${utcDate(inputs.now)}:${runId}`);
}

/** `wam org create`: there is no org or workspace slug yet, so the terms are the name and the type. */
export function deriveOrgCreateIdempotencyKey(
  terms: { name: string; type: string },
  inputs: IdempotencyInputs,
): string {
  const runId = runIdFrom(inputs.env, inputs.randomUUID);
  return sha256Hex(`orgcreate:${terms.name}:${terms.type}:${utcDate(inputs.now)}:${runId}`);
}

/**
 * `--idempotency-key <key>`, checked against the contract's own pattern BEFORE any request, so a
 * malformed key is the section 9 usage error (exit 2) and not a round trip to a 422.
 */
export function parseIdempotencyKeyFlag(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!idempotencyKeySchema.safeParse(raw).success) throw malformedIdempotencyKeyError();
  return raw;
}
