import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { idempotencyKey } from "@whereamimentioned/api-client";
import { CliError } from "./errors";
import {
  RUN_ID_ENV_VARS,
  deriveOrgCreateIdempotencyKey,
  deriveScanIdempotencyKey,
  parseIdempotencyKeyFlag,
  runIdFrom,
  utcDate,
} from "./idempotency";

const NOW = new Date("2026-09-10T23:59:59.000Z");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("the derived Idempotency-Key of section 7.3", () => {
  it("wam scan run: sha256 of org:workspace:utc-date:run-id, 64 hex characters the API accepts", () => {
    const key = deriveScanIdempotencyKey(
      { org: "acme", workspace: "acme-eu" },
      { env: { GITHUB_RUN_ID: "9001" }, now: NOW },
    );
    expect(key).toBe(sha("acme:acme-eu:2026-09-10:9001"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey.safeParse(key).success).toBe(true);
  });

  it("wam org create: sha256 of orgcreate:name:type:utc-date:run-id", () => {
    const key = deriveOrgCreateIdempotencyKey(
      { name: "Acme Labs", type: "brand" },
      { env: { GITHUB_RUN_ID: "9001" }, now: NOW },
    );
    expect(key).toBe(sha("orgcreate:Acme Labs:brand:2026-09-10:9001"));
    expect(idempotencyKey.safeParse(key).success).toBe(true);
  });

  it("is stable across two runs of the same CI run id, and differs across run ids", () => {
    const terms = { org: "acme", workspace: "acme-eu" };
    const a = deriveScanIdempotencyKey(terms, { env: { GITHUB_RUN_ID: "1" }, now: NOW });
    const b = deriveScanIdempotencyKey(terms, { env: { GITHUB_RUN_ID: "1" }, now: NOW });
    const c = deriveScanIdempotencyKey(terms, { env: { GITHUB_RUN_ID: "2" }, now: NOW });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("differs by org, by workspace and by day", () => {
    const inputs = { env: { GITHUB_RUN_ID: "1" }, now: NOW };
    const base = deriveScanIdempotencyKey({ org: "acme", workspace: "acme-eu" }, inputs);
    expect(deriveScanIdempotencyKey({ org: "northwind", workspace: "acme-eu" }, inputs)).not.toBe(base);
    expect(deriveScanIdempotencyKey({ org: "acme", workspace: "acme-us" }, inputs)).not.toBe(base);
    expect(
      deriveScanIdempotencyKey(
        { org: "acme", workspace: "acme-eu" },
        { env: { GITHUB_RUN_ID: "1" }, now: new Date("2026-09-11T00:00:00.000Z") },
      ),
    ).not.toBe(base);
  });

  it("the date is the UTC date, whatever the local zone", () => {
    expect(utcDate(new Date("2026-09-10T23:59:59.000Z"))).toBe("2026-09-10");
    expect(utcDate(new Date("2026-09-11T00:00:00.000Z"))).toBe("2026-09-11");
  });

  it("reads the run id in the order GITHUB_RUN_ID, CI_PIPELINE_ID, CI_JOB_ID", () => {
    expect(RUN_ID_ENV_VARS).toEqual(["GITHUB_RUN_ID", "CI_PIPELINE_ID", "CI_JOB_ID"]);
    const never = () => {
      throw new Error("randomUUID must not be called when a run id is present");
    };
    expect(runIdFrom({ GITHUB_RUN_ID: "gh", CI_PIPELINE_ID: "gl", CI_JOB_ID: "job" }, never)).toBe("gh");
    expect(runIdFrom({ CI_PIPELINE_ID: "gl", CI_JOB_ID: "job" }, never)).toBe("gl");
    expect(runIdFrom({ CI_JOB_ID: "job" }, never)).toBe("job");
  });

  it("a retried GitLab job (new CI_JOB_ID, same CI_PIPELINE_ID) derives the same key, so it replays instead of paying twice", () => {
    const terms = { org: "acme", workspace: "acme-eu" };
    const first = deriveScanIdempotencyKey(terms, { env: { CI_PIPELINE_ID: "4242", CI_JOB_ID: "1001" }, now: NOW });
    const retry = deriveScanIdempotencyKey(terms, { env: { CI_PIPELINE_ID: "4242", CI_JOB_ID: "1002" }, now: NOW });
    expect(retry).toBe(first);
    const nextPipeline = deriveScanIdempotencyKey(terms, { env: { CI_PIPELINE_ID: "4243", CI_JOB_ID: "1003" }, now: NOW });
    expect(nextPipeline).not.toBe(first);
  });

  it("falls back to a fresh UUID, so a human who asks twice gets two keys", () => {
    const terms = { org: "acme", workspace: "acme-eu" };
    const a = deriveScanIdempotencyKey(terms, { env: {}, now: NOW });
    const b = deriveScanIdempotencyKey(terms, { env: {}, now: NOW });
    expect(a).not.toBe(b);

    let n = 0;
    const fixed = deriveScanIdempotencyKey(terms, { env: {}, now: NOW, randomUUID: () => `uuid-${(n += 1)}` });
    expect(fixed).toBe(sha("acme:acme-eu:2026-09-10:uuid-1"));
  });

  it("an empty run id counts as absent, so a blank variable never makes a day of runs share one key", () => {
    expect(runIdFrom({ GITHUB_RUN_ID: "", CI_JOB_ID: "job" }, () => "uuid")).toBe("job");
    expect(runIdFrom({ GITHUB_RUN_ID: "" }, () => "uuid")).toBe("uuid");
  });

  it("an org the CLI was never told is the empty string, which is as stable across a retry", () => {
    const inputs = { env: { GITHUB_RUN_ID: "1" }, now: NOW };
    const key = deriveScanIdempotencyKey({ org: null, workspace: "acme-eu" }, inputs);
    expect(key).toBe(sha(":acme-eu:2026-09-10:1"));
    expect(deriveScanIdempotencyKey({ org: null, workspace: "acme-eu" }, inputs)).toBe(key);
  });
});

describe("--idempotency-key", () => {
  it("passes a well-formed key through and leaves an absent one absent", () => {
    expect(parseIdempotencyKeyFlag(undefined)).toBeUndefined();
    expect(parseIdempotencyKeyFlag("release-2026.09:attempt_1")).toBe("release-2026.09:attempt_1");
    expect(parseIdempotencyKeyFlag("a".repeat(128))).toBe("a".repeat(128));
  });

  it.each(["", "has space", "slash/no", "a".repeat(129), "emoji\u{1F600}"])(
    "a malformed key (%j) is the section 9 usage error, exit 2",
    (raw) => {
      let thrown: unknown;
      try {
        parseIdempotencyKeyFlag(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      const err = thrown as CliError;
      expect(err.exitCode).toBe(2);
      expect(err.lines).toEqual(["--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -."]);
    },
  );
});
