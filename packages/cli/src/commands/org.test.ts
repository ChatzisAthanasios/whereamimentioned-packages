import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrganizationResult, organizationSummary, page } from "@whereamimentioned/api-client";
import {
  FAKE_TOKEN,
  ORGANIZATIONS_PAGE,
  REQUEST_ID,
  TOKEN_ENV,
  errorResponse,
  fakeApi,
  jsonResponse,
  sandbox,
  type Sandbox,
} from "./fixtures";
import { ORG_CREATED, ORG_MESSAGE, answers, recordingApi, runCli, type RecordingApi } from "./write-fixtures";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.tmp.cleanup();
});

describe("wam org list", () => {
  it("lists every org with its effectiveRole and workspaceCount, free orgs included, and the footer", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on("GET", "/api/v1/organizations", jsonResponse(200, ORGANIZATIONS_PAGE));
    const r = await box.run(["org", "list"], { api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        "ORG        NAME       TIER    YOUR ROLE  WORKSPACES",
        "acme       Acme Ltd   pro     member              3",
        "northwind  Northwind  single  member              1",
        "acme-labs  Acme Labs  free    member              0",
        "",
        "3 organizations. acme-labs is on the free floor and cannot run scans yet.",
        "",
      ].join("\n"),
    );
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.method).toBe("GET");
    expect(api.calls[0]!.url).toBe("https://whereamimentioned.com/api/v1/organizations");
    expect(api.calls[0]!.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("takes no org: it needs no --org on an account-wide key and sends no X-Wam-Org even when one is set", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on("GET", "/api/v1/organizations", jsonResponse(200, ORGANIZATIONS_PAGE));
    const r = await box.run(["org", "list", "--org", "acme"], { api });
    expect(r.code).toBe(0);
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBeUndefined();
  });

  it("--limit and --cursor are passed through, and a further page prints the next command on stderr", async () => {
    const paged = page(organizationSummary).parse({
      data: ORGANIZATIONS_PAGE.data.slice(0, 1),
      pagination: { nextCursor: "b3JnXzE", hasMore: true, limit: 1 },
    });
    const api = fakeApi().on("GET", "/api/v1/organizations", jsonResponse(200, paged));
    const r = await box.run(["org", "list", "--limit", "1", "--cursor", "abc"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(api.calls[0]!.query).toEqual({ limit: "1", cursor: "abc" });
    expect(r.stdout).toContain("1 organization.");
    expect(r.stdout).not.toContain("free floor");
    expect(r.stderr).toContain("Next page:  wam org list --cursor b3JnXzE");
  });

  it("--json is the paginated envelope unchanged", async () => {
    const api = fakeApi().on("GET", "/api/v1/organizations", jsonResponse(200, ORGANIZATIONS_PAGE));
    const r = await box.run(["org", "list", "--json"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(ORGANIZATIONS_PAGE)}\n`);
    expect(r.stderr).toBe("");
  });

  it("on an org key: exit 3, the section 9 copy, and exactly one request", async () => {
    await box.storeCredential("org", "acme");
    const api = fakeApi().on(
      "GET",
      "/api/v1/organizations",
      errorResponse(
        403,
        "insufficient_scope",
        "This route requires an account-wide API key; an organization key cannot act across organizations.",
        { requiredKind: "user" },
      ),
    );
    const r = await box.run(["org", "list"], { api });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "This key is bound to one organization, so it cannot list or create organizations.",
        `Sign in again with an account-wide key: wam auth login --account-wide (request ${REQUEST_ID})`,
        "",
      ].join("\n"),
    );
    // One request, and never a second one of a different shape.
    expect(api.calls).toHaveLength(1);
    expect(api.paths()).toEqual(["GET /api/v1/organizations"]);
  });

  it("the same refusal under --json is the stable error object on stdout", async () => {
    const api = fakeApi().on(
      "GET",
      "/api/v1/organizations",
      errorResponse(403, "insufficient_scope", "refused", { requiredKind: "user" }),
    );
    const r = await box.run(["org", "list", "--json"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("");
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, exitCode: 3, error: { code: "insufficient_scope", requestId: REQUEST_ID } });
    expect(api.calls).toHaveLength(1);
  });

  it("a bad --limit is a usage error and makes no request", async () => {
    const api = fakeApi();
    const r = await box.run(["org", "list", "--limit", "500"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--limit must be an integer from 1 to 100.\n");
    expect(api.calls).toHaveLength(0);
  });

  it("the help of list ends with a copy-pasteable example", async () => {
    const r = await box.run(["org", "list", "--help"]);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("  $ wam org list --limit 50");
  });
});

// --- Checkpoint 5: wam org create ------------------------------------------------------------------

const ORGS_PATH = "/api/v1/organizations";

function createApi(response: Response = jsonResponse(201, ORG_CREATED)): RecordingApi {
  const api = recordingApi();
  api.on("POST", ORGS_PATH, response);
  return api;
}

describe("wam org create", () => {
  it("creates with one POST, no X-Wam-Org, the name and type in the body, and prints the API's message and subscribeUrl verbatim", async () => {
    await box.storeCredential("user", null);
    const api = createApi();
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand", "--yes", "--org", "acme"], { api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${ORGS_PATH}`]);
    const sent = api.requests[0]!;
    expect(sent.body).toEqual({ name: "Acme Labs", type: "brand" });
    expect(sent.headers["X-Wam-Org"]).toBeUndefined();
    expect(sent.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);

    expect(r.stdout).toBe(
      [
        "Created Acme Labs (acme-labs), type brand, tier free.",
        "",
        "  Usable      no",
        `  Subscribe   ${ORG_CREATED.subscribeUrl}`,
        "",
        ORG_MESSAGE,
        "",
        "Your key already reaches it. After someone subscribes:",
        '  wam workspace create "<name>" --org acme-labs',
        "",
      ].join("\n"),
    );
    // Byte-identical, and the URL is printed BEFORE the sentence that says "the URL above".
    expect(r.stdout).toContain(ORG_CREATED.message!);
    expect(r.stdout.indexOf(ORG_CREATED.subscribeUrl)).toBeLessThan(r.stdout.indexOf(ORG_CREATED.message!));
  });

  it("never rewords not usable into anything cheerier, and promises no trial, tier or credits", async () => {
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand", "--yes"], { env: TOKEN_ENV, api: createApi() });
    expect(r.stdout).toContain("  Usable      no");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/\bready\b|start scanning|\btrial\b|free tier|free credits/i);
  });

  it("--json is the 201 body verbatim", async () => {
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand", "--yes", "--json"], { env: TOKEN_ENV, api: createApi() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(ORG_CREATED)}\n`);
    expect(JSON.parse(r.stdout).usable).toBe(false);
    expect(r.stderr).toBe("");
  });

  it("requires --type: without it, where it cannot ask, exit 2 and nothing is created", async () => {
    const api = createApi();
    const ci = await runCli(box, ["org", "create", "X"], { env: { ...TOKEN_ENV, CI: "1" }, api, tty: true });
    expect(ci.code).toBe(2);
    expect(ci.stderr).toContain("wam org create needs --type, one of: agency, brand. It cannot ask for it here.");
    const withYes = await runCli(box, ["org", "create", "X", "--yes"], { env: TOKEN_ENV, api });
    expect(withYes.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("a --type outside the contract's tuple is exit 2 and nothing is created", async () => {
    const api = createApi();
    const r = await runCli(box, ["org", "create", "X", "--type", "enterprise", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--type must be one of: agency, brand.");
    expect(api.calls).toHaveLength(0);
  });

  it("requires --yes where it cannot ask: exit 2 with the --yes copy and nothing is created", async () => {
    const api = createApi();
    const r = await runCli(box, ["org", "create", "X", "--type", "brand"], { env: { ...TOKEN_ENV, CI: "1" }, api, tty: true });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot prompt for confirmation here");
    expect(r.stderr).toContain("Pass --yes to confirm.");
    expect(api.calls).toHaveLength(0);
  });

  it("in a terminal it confirms with the cannot-be-undone reason and never a money warning, and y proceeds", async () => {
    const api = createApi();
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand"], { env: TOKEN_ENV, api, tty: true, stdin: answers(["y"]) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("This creates an organization on your account. It cannot be deleted from the CLI or the API.");
    expect(r.stderr).toContain("Create it? (y/N)");
    expect(r.stderr).not.toMatch(/credit|spend|cost|money|charge/i);
    expect(api.calls).toHaveLength(1);
  });

  it("an empty answer cancels with exit 0 and creates nothing, with no word about credits", async () => {
    const api = createApi();
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand"], { env: TOKEN_ENV, api, tty: true, stdin: answers([""]) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Cancelled.");
    expect(r.stderr).not.toMatch(/credit/i);
    expect(api.calls).toHaveLength(0);
  });

  it("in a terminal a missing --type is asked for, then the create is confirmed", async () => {
    const api = createApi();
    const r = await runCli(box, ["org", "create", "Acme Labs"], { env: TOKEN_ENV, api, tty: true, stdin: answers(["brand", "yes"]) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Organization type (agency or brand):");
    expect(api.requests[0]!.body).toEqual({ name: "Acme Labs", type: "brand" });
  });

  it("the idempotency key is stable across two runs with the same GITHUB_RUN_ID and differs without one", async () => {
    const keyOf = async (env: Record<string, string>, name = "Acme Labs") => {
      const api = createApi();
      await runCli(box, ["org", "create", name, "--type", "brand", "--yes"], { env: { ...TOKEN_ENV, ...env }, api });
      return api.requests[0]!.headers["Idempotency-Key"]!;
    };
    const first = await keyOf({ GITHUB_RUN_ID: "9001" });
    expect(await keyOf({ GITHUB_RUN_ID: "9001" })).toBe(first);
    expect(await keyOf({ GITHUB_RUN_ID: "9002" })).not.toBe(first);
    expect(await keyOf({ GITHUB_RUN_ID: "9001" }, "Other Name")).not.toBe(first);
    // No run id: a human who asks twice gets two organizations, which is what they asked for.
    expect(await keyOf({})).not.toBe(await keyOf({}));
  });

  it("--idempotency-key overrides the derivation, and a malformed one is exit 2 with no request", async () => {
    const api = createApi();
    await runCli(box, ["org", "create", "X", "--type", "brand", "--yes", "--idempotency-key", "attempt:1"], { env: TOKEN_ENV, api });
    expect(api.requests[0]!.headers["Idempotency-Key"]).toBe("attempt:1");

    const bad = createApi();
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes", "--idempotency-key", "no/slash"], { env: TOKEN_ENV, api: bad });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -.\n");
    expect(bad.calls).toHaveLength(0);
  });

  it("a replay returns the original organization and says so, exit 0, even past the ceiling", async () => {
    const api = createApi(jsonResponse(200, ORG_CREATED, { "X-Idempotent-Replay": "true" }));
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("An organization for this run already exists (acme-labs). Returning it instead of creating a second one.");
    expect(r.stdout).toContain("Created Acme Labs (acme-labs)");
  });

  it("a replay of an organization that has since subscribed prints usable yes and no message", async () => {
    const { message: _message, ...rest } = ORG_CREATED;
    const usable = createOrganizationResult.parse({ ...rest, tier: "pro", usable: true });
    const api = createApi(jsonResponse(200, usable, { "X-Idempotent-Replay": "true" }));
    const r = await runCli(box, ["org", "create", "Acme Labs", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  Usable      yes");
    expect(r.stdout).not.toContain("After someone subscribes");
  });

  it("on a stored org key: exit 3 with the section 9 copy, before any question and any request", async () => {
    await box.storeCredential("org", "acme");
    const api = createApi();
    const r = await runCli(box, ["org", "create", "X", "--type", "brand"], { api, tty: true, stdin: answers(["y"]) });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      [
        "This key is bound to one organization, so it cannot list or create organizations.",
        "Sign in again with an account-wide key: wam auth login --account-wide",
        "",
      ].join("\n"),
    );
    expect(api.calls).toHaveLength(0);
  });

  it("on an org key the CLI cannot recognise (a bare WAM_TOKEN) the server's 403 gets the same copy, after one request", async () => {
    const api = createApi(errorResponse(403, "insufficient_scope", "An organization key cannot act across organizations.", { requiredKind: "user" }));
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("This key is bound to one organization, so it cannot list or create organizations.");
    expect(api.calls).toHaveLength(1);
  });

  it("on an account-wide key without orgs:write: exit 3 with the OTHER section 9 string", async () => {
    await box.storeCredential("user", null);
    const api = createApi(errorResponse(403, "insufficient_scope", "Missing scope.", { requiredScope: "orgs:write", heldScopes: ["workspaces:read"] }));
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("This key does not carry the orgs:write scope, which creating an organization needs.");
    expect(r.stderr).toContain("wam auth login --account-wide --scopes orgs:write,workspaces:read,scans:read,reports:read");
    expect(r.stderr).not.toContain("bound to one organization");
  });

  it("403 feature_not_available exits 11 and prints details.billingUrl as received", async () => {
    const billingUrl = "https://whereamimentioned.com/northwind/billing";
    const api = createApi(
      errorResponse(403, "feature_not_available", "Creating organizations requires at least one organization on a paid plan.", { billingUrl }),
    );
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(11);
    expect(r.stderr).toContain("Creating organizations requires at least one organization on a paid plan.");
    expect(r.stderr).toContain(`Subscribe first, then try again: ${billingUrl}`);
    expect(api.calls).toHaveLength(1);
  });

  it("the same 403 code from wam prompt add still exits 3: the branch is on the command, not the code alone", async () => {
    const api = recordingApi();
    api.on(
      "POST",
      "/api/v1/workspaces/acme-eu/prompts",
      errorResponse(403, "feature_not_available", "This workspace already has 150 prompts, which is the cap on the Pro plan.", { limit: 150, current: 150 }),
    );
    const r = await runCli(box, ["prompt", "add", "a prompt that is long enough"], { env: { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" }, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("This workspace already has 150 prompts, which is the cap on the Pro plan.");
  });

  it("409 conflict at the ceiling exits 10 and prints the API's message verbatim", async () => {
    const message = "You already own 25 organizations, which is the limit on one account.";
    const api = createApi(errorResponse(409, "conflict", message, { limit: 25, current: 25 }));
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(10);
    expect(r.stderr).toContain(`${message}\n`);
    expect(r.stderr).toContain("This is a ceiling, not a rate, so waiting will not clear it.");
    expect(api.calls).toHaveLength(1);
  });

  it("409 conflict with details.originalOrgId exits 9: a reused key, not a ceiling", async () => {
    const api = createApi(errorResponse(409, "conflict", "Idempotency-Key reuse.", { originalOrgId: "org_labs", fields: ["name"] }));
    const r = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes", "--idempotency-key", "k1"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(9);
    expect(r.stderr).toContain("That idempotency key was already used for a different organization (org_labs).");
    expect(r.stderr).not.toContain("ceiling");
  });

  it("429 is exit 5, a 500 is exit 1, and the create is never retried", async () => {
    const limited = createApi(errorResponse(429, "rate_limited", "Slow down.", { retryAfterSeconds: 60 }, { "Retry-After": "60" }));
    const a = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api: limited });
    expect(a.code).toBe(5);
    expect(limited.calls).toHaveLength(1);

    const broken = createApi(errorResponse(500, "internal_error", "boom"));
    const b = await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api: broken });
    expect(b.code).toBe(1);
    expect(broken.calls).toHaveLength(1);
  });

  it("mints nothing: the only request is the create, and the help ends with a copy-pasteable example", async () => {
    const api = createApi();
    await runCli(box, ["org", "create", "X", "--type", "brand", "--yes"], { env: TOKEN_ENV, api });
    expect(api.calls.every((c) => c.path === ORGS_PATH)).toBe(true);
    const help = await box.run(["org", "create", "--help"]);
    expect(help.stdout.trimEnd().split("\n").pop()).toBe('  $ wam org create "Acme Labs" --type brand --yes');
    expect(help.stdout).not.toMatch(/credits? (will|are) (be )?spent/i);
  });
});
