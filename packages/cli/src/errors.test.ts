import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ApiError, ApiTimeoutError, SUPPORTED_API_VERSION } from "@whereamimentioned/api-client";
import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT,
  EXIT_CODES,
  LOCAL_ERROR_CODES,
  apiVersionMismatchError,
  assertApiVersion,
  describeNetworkError,
  expiredOn,
  followTimedOutError,
  formatExitCodeTable,
  formatFileMode,
  isNetworkError,
  malformedIdempotencyKeyError,
  mapApiError,
  noCredentialError,
  noOrgError,
  noWorkspaceError,
  requestTimedOutError,
  scanFailedError,
  thresholdNotMetError,
  unknownConfigKeyError,
  unsafeCredentialFileError,
  usageError,
  type ErrorContext,
} from "./errors";

const RID = "req_01JQ8Z3F7K4W2N0000000000000";
const NOW = new Date("2026-09-10T12:00:00.000Z");
const EM_DASH = String.fromCharCode(0x2014);

function api(
  status: number,
  code: string,
  opts: { message?: string; details?: Record<string, unknown>; retryAfterSeconds?: number | null; requestId?: string | null } = {},
): ApiError {
  return new ApiError({
    status,
    code,
    message: opts.message ?? `HTTP ${status}`,
    requestId: opts.requestId === undefined ? RID : opts.requestId,
    details: opts.details,
    retryAfterSeconds: opts.retryAfterSeconds ?? null,
  });
}

const orgKey: ErrorContext = {
  apiUrl: "https://whereamimentioned.com",
  org: "acme",
  workspace: "acme-eu",
  credential: { kind: "org", org: "northwind", expiresAt: null },
  now: NOW,
};

const userKey: ErrorContext = {
  ...orgKey,
  org: "northwind",
  credential: { kind: "user", org: null, expiresAt: null },
};

/** Every line but the last is verbatim; the last carries the request id suffix. */
function expectLines(err: CliError, lines: string[]): void {
  const withRid = [...lines];
  const last = withRid.length - 1;
  if (!withRid[last]!.includes(RID)) withRid[last] = `${withRid[last]} (request ${RID})`;
  expect(err.lines).toEqual(withRid);
}

describe("exit codes (section 3.1)", () => {
  it("lists twelve codes, 0 to 11, nothing above 125", () => {
    expect(EXIT_CODES.map(([c]) => c)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(EXIT).toMatchObject({ OK: 0, USAGE: 2, AUTH: 3, CREDITS: 4, RATE_LIMITED: 5, CEILING: 10, NO_PAID_ORG: 11 });
    const table = formatExitCodeTable();
    for (const [code, meaning] of EXIT_CODES) {
      expect(table).toContain(`${String(code).padStart(2)}  ${meaning}`);
    }
  });

  it("names exactly the six local codes of section 6.2", () => {
    expect([...LOCAL_ERROR_CODES]).toEqual([
      "no_credential",
      "no_org",
      "no_workspace",
      "network_unreachable",
      "usage_error",
      "timed_out",
    ]);
  });
});

describe("CliError", () => {
  it("renders the section 6.2 rule 4 object", () => {
    const err = new CliError("insufficient_credits", 4, ["a", "b"], {
      details: { required: 42, available: 11 },
      requestId: RID,
    });
    expect(err.toJsonObject()).toEqual({
      ok: false,
      error: { code: "insufficient_credits", message: "a\nb", requestId: RID, details: { required: 42, available: 11 } },
      exitCode: 4,
    });
    expect(new CliError("usage_error", 2, ["x"]).toJsonObject().error).toEqual({
      code: "usage_error",
      message: "x",
      requestId: null,
      details: null,
    });
  });
});

describe("local rows of the section 9 table", () => {
  it("no credential is exit 3", () => {
    const err = noCredentialError();
    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("no_credential");
    expect(err.lines).toEqual(["Not signed in.", "Run wam auth login, or set WAM_TOKEN in your environment."]);
  });

  it("no organization on an account-wide key is exit 2", () => {
    const err = noOrgError();
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("no_org");
    expect(err.lines).toEqual([
      "No organization selected. This key reaches several, so it cannot guess.",
      "Pass --org <slug>, set WAM_ORG, or run wam config set org acme. See what it reaches: wam org list",
    ]);
  });

  it("no workspace is exit 2", () => {
    const err = noWorkspaceError();
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("no_workspace");
    expect(err.lines).toEqual([
      "No workspace selected.",
      "Pass --workspace <slug>, set WAM_WORKSPACE, or run wam workspace use acme/acme-eu",
    ]);
  });

  it("unsafe credential file mode is exit 3 with the chmod copy", () => {
    const err = unsafeCredentialFileError(0o644, "/home/you/.config/whereamimentioned/credentials.json");
    expect(err.exitCode).toBe(3);
    expect(err.lines).toEqual([
      "Credential file has unsafe permissions (0644). Fix it and try again:",
      "  chmod 600 /home/you/.config/whereamimentioned/credentials.json",
    ]);
    expect(formatFileMode(0o100644)).toBe("0644");
    expect(formatFileMode(0o600)).toBe("0600");
  });

  it("unknown key in wam.json is exit 2", () => {
    const err = unknownConfigKeyError("workSpace", "./wam.json", ["org", "workspace", "apiUrl", "failUnder"]);
    expect(err.exitCode).toBe(2);
    expect(err.lines).toEqual(['Unknown option "workSpace" in ./wam.json.', "Valid options are: org, workspace, apiUrl, failUnder."]);
  });

  it("scan failed is exit 6", () => {
    const err = scanFailedError("3f9c1e42", "extraction returned no usable answers.", "https://whereamimentioned.com/acme/acme-eu/scans/3f9c1e42");
    expect(err.exitCode).toBe(6);
    expect(err.lines).toEqual([
      "Scan 3f9c1e42 failed: extraction returned no usable answers.",
      "Reserved credits have been refunded. See https://whereamimentioned.com/acme/acme-eu/scans/3f9c1e42",
    ]);
    expect(scanFailedError("x", null, "u").lines[0]).toBe("Scan x failed.");
  });

  it("threshold not met is exit 7", () => {
    const err = thresholdNotMetError(61, 65);
    expect(err.exitCode).toBe(7);
    expect(err.code).toBe("threshold_not_met");
    expect(err.lines).toEqual(["AI visibility score 61 is below the threshold of 65."]);
  });

  it("follow timed out is exit 1 with code timed_out", () => {
    const err = followTimedOutError(30, "3f9c1e42");
    expect(err.exitCode).toBe(1);
    expect(err.code).toBe("timed_out");
    expect(err.lines).toEqual([
      "Stopped following after 30 minutes. The scan is still running on the server.",
      "Check on it later: wam scan status 3f9c1e42",
    ]);
  });

  it("request timed out is exit 1 with code timed_out", () => {
    const err = requestTimedOutError(30_000);
    expect(err.exitCode).toBe(1);
    expect(err.code).toBe("timed_out");
    expect(err.lines).toEqual(["The request timed out after 30 seconds.", "Retry, or run with --debug to see what happened."]);
    expect(mapApiError(new ApiTimeoutError("GET", "/api/v1/me", 30_000), "auth status")).toEqual(err);
  });

  it("API version mismatch is exit 1 and compares against SUPPORTED_API_VERSION", () => {
    const err = apiVersionMismatchError(2);
    expect(err.exitCode).toBe(1);
    expect(err.lines).toEqual([
      `This server speaks API version 2 and this CLI understands version ${SUPPORTED_API_VERSION}.`,
      "Upgrade: npm install -g @whereamimentioned/cli@latest",
    ]);
    expect(() => assertApiVersion({ lastApiVersion: SUPPORTED_API_VERSION + 1 })).toThrow(CliError);
    expect(() => assertApiVersion({ lastApiVersion: SUPPORTED_API_VERSION })).not.toThrow();
    expect(() => assertApiVersion({ lastApiVersion: null })).not.toThrow();
  });

  it("malformed idempotency key is exit 2", () => {
    expect(malformedIdempotencyKeyError().lines).toEqual([
      "--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -.",
    ]);
    expect(usageError("x").exitCode).toBe(2);
  });
});

describe("network errors", () => {
  it("maps undici's fetch failed with an ENOTFOUND cause to exit 1", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND whereamimentioned.com"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    });
    const err = mapApiError(new TypeError("fetch failed", { cause }), "scan list", { apiUrl: "https://whereamimentioned.com" });
    expect(err.exitCode).toBe(1);
    expect(err.code).toBe("network_unreachable");
    expect(err.lines).toEqual([
      "Could not reach https://whereamimentioned.com (getaddrinfo ENOTFOUND).",
      "Check your connection, or set WAM_API_URL if you are pointing at a different environment.",
    ]);
    expect(isNetworkError(new Error("plain"))).toBe(false);
    expect(describeNetworkError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
  });

  it("maps anything else to a generic exit 1", () => {
    const err = mapApiError(new RangeError("boom"), "scan list");
    expect(err.exitCode).toBe(1);
    expect(err.code).toBe("unknown");
    expect(err.lines[0]).toBe("Something went wrong: boom");
  });

  it("passes a CliError through untouched", () => {
    const original = noWorkspaceError();
    expect(mapApiError(original, "scan run")).toBe(original);
  });
});

describe("server rows of the section 9 table", () => {
  it("401: credential no longer valid is exit 3, with the dashboard URL for the org", () => {
    const err = mapApiError(api(401, "unauthorized"), "scan list", orgKey);
    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("unauthorized");
    expectLines(err, [
      "This API key is no longer valid.",
      "Create a new one with wam auth login, or in the dashboard at https://whereamimentioned.com/acme/settings/api-keys",
    ]);
  });

  it("401 with a stored expiry in the past prepends the local hint", () => {
    const ctx = { ...orgKey, credential: { kind: "org" as const, org: "acme", expiresAt: "2026-05-26T00:00:00.000Z" } };
    const err = mapApiError(api(401, "unauthorized"), "scan list", ctx);
    expect(err.lines[0]).toBe("Your stored key expired on 2026-05-26.");
    expect(err.lines[1]).toBe("This API key is no longer valid.");
    expect(expiredOn("2099-01-01T00:00:00.000Z", NOW)).toBeNull();
    expect(expiredOn(null, NOW)).toBeNull();
    expect(expiredOn("garbage", NOW)).toBeNull();
  });

  it("403 insufficient_scope: scope missing lists the held scopes when the server sends them", () => {
    const err = mapApiError(
      api(403, "insufficient_scope", {
        details: { requiredScope: "scans:write", heldScopes: ["workspaces:read", "scans:read", "reports:read"] },
      }),
      "scan run",
      orgKey,
    );
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "This key does not carry the scans:write scope, which this command needs.",
      "It has: workspaces:read, scans:read, reports:read.",
      "Create a key with the right scopes: wam auth login --scopes workspaces:read,scans:read,reports:read,scans:write",
    ]);
  });

  it("403 insufficient_scope without a held list omits the It has line", () => {
    const err = mapApiError(api(403, "insufficient_scope", { details: { requiredScope: "reports:read" } }), "report get", orgKey);
    expectLines(err, [
      "This key does not carry the reports:read scope, which this command needs.",
      "Create a key with the right scopes: wam auth login --scopes reports:read",
    ]);
  });

  it("403 insufficient_scope: an org command on an org key", () => {
    const err = mapApiError(api(403, "insufficient_scope", { details: { requiredKind: "user" } }), "org list", orgKey);
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "This key is bound to one organization, so it cannot list or create organizations.",
      "Sign in again with an account-wide key: wam auth login --account-wide",
    ]);
  });

  it("403 insufficient_scope: orgs:write missing on an account-wide key", () => {
    const err = mapApiError(api(403, "insufficient_scope", { details: { requiredScope: "orgs:write" } }), "org create", userKey);
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "This key does not carry the orgs:write scope, which creating an organization needs.",
      "Sign in again and ask for it: wam auth login --account-wide --scopes orgs:write,workspaces:read,scans:read,reports:read",
    ]);
  });

  it("403 insufficient_role: role too low", () => {
    const err = mapApiError(
      api(403, "insufficient_role", { details: { requiredRole: "member", effectiveRole: "viewer" } }),
      "scan run",
      orgKey,
    );
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "Your role in this organization (viewer) is not high enough to run a scan. Member or above is required.",
      "Ask an owner or admin to change your role.",
    ]);
  });

  it("403 feature_not_available: the tier gate", () => {
    const err = mapApiError(
      api(403, "feature_not_available", {
        details: { tier: "free", billingUrl: "https://whereamimentioned.com/acme/billing" },
      }),
      "scan list",
      orgKey,
    );
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "The API and the CLI are available on paid plans. This organization is on the free floor, which means there is no active subscription.",
      "Choose a plan: https://whereamimentioned.com/acme/billing",
    ]);
  });

  it("403 feature_not_available from wam org create is exit 11, from anything else exit 3", () => {
    const details = { billingUrl: "https://whereamimentioned.com/acme/billing" };
    const create = mapApiError(api(403, "feature_not_available", { details }), "org create", userKey);
    expect(create.exitCode).toBe(11);
    expectLines(create, [
      "Creating organizations requires at least one organization on a paid plan.",
      "Subscribe first, then try again: https://whereamimentioned.com/acme/billing",
    ]);
    const cap = api(403, "feature_not_available", {
      message: "Your Pro plan allows 150 prompts per workspace. Delete a prompt or upgrade to add more.",
      details: { limit: 150, current: 150, billingUrl: "https://whereamimentioned.com/acme/billing" },
    });
    const prompt = mapApiError(cap, "prompt add", orgKey);
    expect(prompt.exitCode).toBe(3);
    expectLines(prompt, [cap.message, "Disable or remove one first: wam prompt list"]);
  });

  it("403 feature_not_available: export format not allowed", () => {
    const e = api(403, "feature_not_available", {
      message: "The Single Brand plan does not include PDF export. Upgrade at https://whereamimentioned.com/acme/billing",
      details: { allowedFormats: ["json", "csv"], billingUrl: "https://whereamimentioned.com/acme/billing" },
    });
    const err = mapApiError(e, "report get", orgKey);
    expect(err.exitCode).toBe(3);
    expectLines(err, [e.message, "This plan allows: csv. See https://whereamimentioned.com/pricing"]);
  });

  it("402 insufficient_credits is exit 4 with the figures from details", () => {
    const err = mapApiError(
      api(402, "insufficient_credits", {
        details: { required: 42, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" },
      }),
      "scan run",
      orgKey,
    );
    expect(err.exitCode).toBe(4);
    expect(err.code).toBe("insufficient_credits");
    expectLines(err, [
      "Not enough credits. This scan needs 42 credits and the organization has 11.",
      "Add credits or change plan: https://whereamimentioned.com/acme/billing",
    ]);
    expect(err.details).toEqual({ required: 42, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" });
  });

  it("404 on an org key is the workspace mismatch row", () => {
    const err = mapApiError(api(404, "not_found"), "scan list", orgKey);
    expect(err.exitCode).toBe(3);
    expectLines(err, [
      "Workspace acme-eu was not found, or this key cannot see it.",
      "This key is bound to the organization northwind. Check wam auth status.",
    ]);
  });

  it("404 on an account-wide key is the org not reachable row", () => {
    const err = mapApiError(api(404, "not_found"), "workspace list", userKey);
    expect(err.exitCode).toBe(3);
    expectLines(err, ["Organization northwind was not found, or you are not a member of it.", "See what this key reaches: wam org list"]);
  });

  it("404 on an id-addressed request names the scan, not the organization or the workspace, exit 1", () => {
    for (const command of ["scan status", "scan evidence", "report get"]) {
      const err = mapApiError(api(404, "not_found"), command, { ...orgKey, scanId: "3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb" });
      expect(err.exitCode, command).toBe(1);
      // `org` is the organization the request RESOLVED (acme), not the key's default (northwind).
      expectLines(err, [
        "Scan 3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb was not found in organization acme, or this key cannot see it.",
        "Check the id against: wam scan list. A full id or an unambiguous prefix of one is accepted.",
      ]);
    }
    // An account-wide key without a resolved org still blames the scan, not the organization.
    const bare = mapApiError(api(404, "not_found"), "scan status", { ...userKey, org: null, scanId: "3f9c1e42" });
    expect(bare.lines[0]).toBe("Scan 3f9c1e42 was not found, or this key cannot see it.");
  });

  it("404 with a status from wam report get is the report not ready row, exit 1", () => {
    const err = mapApiError(api(404, "not_found", { details: { status: "running" } }), "report get", {
      ...orgKey,
      scanId: "3f9c1e42",
    });
    expect(err.exitCode).toBe(1);
    expectLines(err, ["That scan is still running, so there is no report yet.", "Follow it with: wam scan status 3f9c1e42 --wait"]);
  });

  it("409 conflict from wam scan run is exit 9: moved terms, or a reused idempotency key", () => {
    const moved = mapApiError(api(409, "conflict", { details: { fields: ["models", "prompts"] } }), "scan run", orgKey);
    expect(moved.exitCode).toBe(9);
    expectLines(moved, [
      "The scan the server priced is no longer the scan it would run.",
      "The fields that changed: models, prompts.",
      "Run wam scan estimate again, then wam scan run.",
    ]);
    const reused = mapApiError(
      api(409, "conflict", { details: { originalScanId: "3f9c1e42", fields: ["prompts"] } }),
      "scan run",
      orgKey,
    );
    expect(reused.exitCode).toBe(9);
    expectLines(reused, [
      "That idempotency key was already used for a different scan (3f9c1e42).",
      "Use a different --idempotency-key, or follow the original: wam scan status 3f9c1e42",
    ]);
  });

  it("409 conflict from wam org create is exit 10 at the ceiling and 9 on an idempotency replay", () => {
    const ceiling = api(409, "conflict", {
      message: "You already own 25 organizations, which is the limit on one account.",
      details: { limit: 25, current: 25 },
    });
    const err = mapApiError(ceiling, "org create", userKey);
    expect(err.exitCode).toBe(10);
    expectLines(err, [
      ceiling.message,
      "This is a ceiling, not a rate, so waiting will not clear it. Write to support@whereamimentioned.com if you genuinely need another.",
    ]);
    const replay = mapApiError(api(409, "conflict", { details: { originalOrgId: "org_1" } }), "org create", userKey);
    expect(replay.exitCode).toBe(9);
    expect(replay.lines[0]).toBe("That idempotency key was already used for a different organization (org_1).");
  });

  it("409 conflict from wam workspace create is exit 10 with the message verbatim", () => {
    const cap = api(409, "conflict", {
      message: "Your Single Brand plan allows 1 workspace. Upgrade to add more.",
      details: { limit: 1, current: 1, billingUrl: "https://whereamimentioned.com/acme/billing" },
    });
    const err = mapApiError(cap, "workspace create", orgKey);
    expect(err.exitCode).toBe(10);
    expectLines(err, [cap.message, "This organization already has 1. Change plan: https://whereamimentioned.com/acme/billing"]);
  });

  it("409 conflict from any other command is exit 9 with the message", () => {
    const err = mapApiError(api(409, "conflict", { message: "Competitor already exists." }), "competitor add", orgKey);
    expect(err.exitCode).toBe(9);
    expectLines(err, ["Competitor already exists."]);
  });

  it("409 scan_already_running reaching the mapper is the --no-follow row, exit 8", () => {
    const err = mapApiError(api(409, "scan_already_running", { details: { scanId: "3f9c1e42" } }), "scan run", orgKey);
    expect(err.exitCode).toBe(8);
    expect(err.code).toBe("scan_already_running");
    expectLines(err, [
      "A scan is already running for this workspace (3f9c1e42).",
      "Pass no flag, or use wam scan status 3f9c1e42, to follow it.",
    ]);
  });

  it("422 validation_failed on the Idempotency-Key header is the malformed key row, exit 2", () => {
    const err = mapApiError(
      api(422, "validation_failed", {
        details: { issues: [{ path: ["Idempotency-Key"], message: "Must be 1 to 128 characters" }] },
      }),
      "scan run",
      orgKey,
    );
    expect(err.exitCode).toBe(2);
    expectLines(err, ["--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -."]);
  });

  it("422 validation_failed otherwise is exit 2 with the message and the hint or issues", () => {
    const hinted = mapApiError(
      api(422, "validation_failed", { message: "An organization is required.", details: { hint: "See GET /api/v1/organizations" } }),
      "workspace list",
      orgKey,
    );
    expect(hinted.exitCode).toBe(2);
    expectLines(hinted, ["An organization is required.", "See GET /api/v1/organizations"]);
    const issues = mapApiError(
      api(422, "validation_failed", { message: "Invalid body.", details: { issues: [{ path: ["name"], message: "Required" }] } }),
      "competitor add",
      orgKey,
    );
    expectLines(issues, ["Invalid body.", "  name: Required"]);
  });

  it("429 is exit 5, with the retry figure from Retry-After and the limit only when known", () => {
    const withLimit = mapApiError(api(429, "rate_limited", { retryAfterSeconds: 42 }), "scan run", { ...orgKey, rateLimitLimit: "120" });
    expect(withLimit.exitCode).toBe(5);
    expectLines(withLimit, ["Rate limited. Try again in 42 seconds.", "Limit: 120 requests per window for this key."]);
    const bare = mapApiError(api(429, "rate_limited", { retryAfterSeconds: 7 }), "scan run", orgKey);
    expectLines(bare, ["Rate limited. Try again in 7 seconds."]);
    const noRetry = mapApiError(api(429, "rate_limited"), "scan run", orgKey);
    expectLines(noRetry, ["Rate limited."]);
  });

  it("500 is exit 1 with the request id in the first line and not repeated", () => {
    const err = mapApiError(api(500, "internal_error"), "scan list", orgKey);
    expect(err.exitCode).toBe(1);
    expect(err.lines).toEqual([
      `The server returned an unexpected error (request ${RID}).`,
      "If this keeps happening, contact support@whereamimentioned.com and quote that request id.",
    ]);
    const unknown5xx = mapApiError(api(503, "unknown", { message: "Unexpected non-JSON response (HTTP 503)" }), "scan list", orgKey);
    expect(unknown5xx.exitCode).toBe(1);
    expect(unknown5xx.lines[0]).toContain(RID);
  });

  it("appends the request id to every server error", () => {
    const samples: Array<[ApiError, string, ErrorContext]> = [
      [api(401, "unauthorized"), "scan list", orgKey],
      [api(403, "insufficient_scope", { details: { requiredScope: "scans:read" } }), "scan list", orgKey],
      [api(403, "insufficient_role", { details: { requiredRole: "member", effectiveRole: "viewer" } }), "scan run", orgKey],
      [api(403, "feature_not_available", { details: { tier: "free" } }), "scan list", orgKey],
      [api(403, "feature_not_available", { details: {} }), "org create", userKey],
      [api(402, "insufficient_credits", { details: { required: 1, available: 0 } }), "scan run", orgKey],
      [api(404, "not_found"), "scan list", orgKey],
      [api(404, "not_found"), "scan list", userKey],
      [api(404, "not_found"), "scan list", { ...orgKey, credential: null }],
      [api(409, "conflict"), "scan run", orgKey],
      [api(409, "conflict"), "org create", userKey],
      [api(409, "conflict"), "workspace create", orgKey],
      [api(409, "scan_already_running", { details: { scanId: "x" } }), "scan run", orgKey],
      [api(422, "validation_failed", { message: "bad" }), "scan run", orgKey],
      [api(429, "rate_limited", { retryAfterSeconds: 1 }), "scan run", orgKey],
      [api(500, "internal_error"), "scan run", orgKey],
      [api(400, "bad_request", { message: "bad json" }), "scan run", orgKey],
      [api(418, "unknown", { message: "teapot" }), "scan run", orgKey],
    ];
    for (const [error, command, ctx] of samples) {
      const mapped = mapApiError(error, command, ctx);
      expect(mapped.requestId).toBe(RID);
      expect(mapped.lines.some((l) => l.includes(RID)), `${error.code} via ${command}`).toBe(true);
      expect(mapped.lines.filter((l) => l.includes(RID))).toHaveLength(1);
      expect(mapped.exitCode).not.toBe(0);
    }
  });

  it("a server error without a request id appends nothing", () => {
    const err = mapApiError(api(401, "unauthorized", { requestId: null }), "scan list", orgKey);
    expect(err.lines[1]).not.toContain("(request");
  });
});

describe("copy discipline (section 15 item 9)", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...tsFiles(full));
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("no .ts file under packages/cli/src contains U+2014", () => {
    const files = tsFiles(__dirname);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes(EM_DASH));
    expect(offenders).toEqual([]);
  });

  it("no rendered section 9 line contains U+2014", () => {
    const errors = [
      noCredentialError(),
      noOrgError(),
      noWorkspaceError(),
      unsafeCredentialFileError(0o644, "/x"),
      unknownConfigKeyError("a", "./wam.json", ["org"]),
      requestTimedOutError(30_000),
      followTimedOutError(30, "x"),
      apiVersionMismatchError(2),
      scanFailedError("x", "y", "z"),
      thresholdNotMetError(1, 2),
      mapApiError(api(500, "internal_error"), "scan run", orgKey),
    ];
    for (const err of errors) {
      for (const line of err.lines) expect(line).not.toContain(EM_DASH);
    }
  });
});
