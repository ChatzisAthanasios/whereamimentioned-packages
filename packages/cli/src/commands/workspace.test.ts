import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_SCAN_ID,
  CREDITS_ACME,
  ME_ORG_KEY,
  ME_USER_KEY_NORTHWIND,
  REQUEST_ID,
  TOKEN_ENV,
  WORKSPACES_PAGE,
  WORKSPACE_DETAIL,
  errorResponse,
  fakeApi,
  jsonResponse,
  sandbox,
  type FakeApi,
  type Sandbox,
} from "./fixtures";
import { WORKSPACE_CREATED, answers, recordingApi, runCli, type RecordingApi } from "./write-fixtures";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.tmp.cleanup();
});

function listApi(): FakeApi {
  return fakeApi()
    .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
    .on("GET", "/api/v1/workspaces", jsonResponse(200, WORKSPACES_PAGE))
    .on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME));
}

describe("wam workspace list", () => {
  it("renders the section 3.4 table from exactly three requests, with nothing fetched per row", async () => {
    await box.storeCredential("org", "acme");
    const api = listApi();
    const r = await box.run(["workspace", "list"], { api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual(["GET /api/v1/me", "GET /api/v1/workspaces", "GET /api/v1/credits"]);
    // No per-row scan fetch, even though one workspace has a scan in flight.
    expect(api.calls.some((c) => c.path.startsWith("/api/v1/scans"))).toBe(false);

    expect(r.stdout).toBe(
      [
        "ORG   WORKSPACE  BRAND      REGION  PROMPTS  LAST SCAN         SCORE",
        "acme  acme-eu    Acme       eu      12/150   2026-08-24  done     61",
        "acme  northwind  Northwind  eu      28/150   running 9c4f1a70      -",
        "",
        "Plan Pro, 312 credits remaining (about 7 scans at the maximum scan size for this tier).",
        "",
      ].join("\n"),
    );
    // The running row names the active scan and draws no progress count.
    expect(r.stdout).toContain(`running ${ACTIVE_SCAN_ID.slice(0, 8)}`);
    expect(r.stdout).not.toMatch(/\d+\s+of\s+\d+/);
    expect(r.stdout).not.toContain("%");
  });

  it("the ORG column is the org the request resolved, and the denominator is plan.promptsPerWorkspace as received", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi()
      .on("GET", "/api/v1/me", jsonResponse(200, ME_USER_KEY_NORTHWIND))
      .on("GET", "/api/v1/workspaces", jsonResponse(200, WORKSPACES_PAGE))
      .on("GET", "/api/v1/credits", jsonResponse(200, { ...CREDITS_ACME, balance: 1, estimatedScansRemaining: 0 }));
    const r = await box.run(["workspace", "list", "--org", "northwind"], { api });

    expect(r.code).toBe(0);
    for (const call of api.calls) expect(call.headers["X-Wam-Org"]).toBe("northwind");
    const rows = r.stdout.split("\n").slice(1, 3);
    for (const row of rows) expect(row.startsWith("northwind  ")).toBe(true);
    expect(r.stdout).toContain("12/15 ");
    expect(r.stdout).toContain("28/15 ");
    expect(r.stdout).toContain("Plan Single Brand, 1 credit remaining (about 0 scans at the maximum scan size for this tier).");
  });

  it("the footer prints the credits body verbatim, never a figure the CLI worked out", async () => {
    const api = listApi().on("GET", "/api/v1/credits", jsonResponse(200, { ...CREDITS_ACME, balance: 999, estimatedScansRemaining: 4321 }));
    const r = await box.run(["workspace", "list", "--org", "acme"], { env: TOKEN_ENV, api });
    expect(r.stdout).toContain("Plan Pro, 999 credits remaining (about 4321 scans at the maximum scan size for this tier).");
  });

  it("--json is the workspaces envelope unchanged", async () => {
    const api = listApi();
    const r = await box.run(["workspace", "list", "--org", "acme", "--json", "--limit", "10"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(WORKSPACES_PAGE)}\n`);
    expect(api.calls.find((c) => c.path === "/api/v1/workspaces")!.query).toEqual({ limit: "10" });
  });

  it("on an account-wide key with no org resolved: exit 2 locally, and no request at all", async () => {
    await box.storeCredential("user", null);
    const api = listApi();
    const r = await box.run(["workspace", "list"], { api });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "No organization selected. This key reaches several, so it cannot guess.",
        "Pass --org <slug>, set WAM_ORG, or run wam config set org acme. See what it reaches: wam org list",
        "",
      ].join("\n"),
    );
    expect(api.calls).toHaveLength(0);
  });

  it("an org key sends X-Wam-Org only when --org, WAM_ORG or config supplied one", async () => {
    const bare = listApi();
    await box.run(["workspace", "list"], { env: TOKEN_ENV, api: bare });
    for (const call of bare.calls) expect(call.headers["X-Wam-Org"]).toBeUndefined();

    const fromEnv = listApi();
    await box.run(["workspace", "list"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api: fromEnv });
    expect(fromEnv.calls).toHaveLength(3);
    for (const call of fromEnv.calls) expect(call.headers["X-Wam-Org"]).toBe("acme");
  });
});

describe("wam workspace use", () => {
  it("validates with one GET under X-Wam-Org = the argument's org, then writes the user config and prints the path", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu", jsonResponse(200, WORKSPACE_DETAIL));
    const r = await box.run(["workspace", "use", "acme/acme-eu"], { api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual(["GET /api/v1/workspaces/acme-eu"]);
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBe("acme");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`Default workspace set to acme/acme-eu.\nWritten to ${box.userConfigPath()}\n`);

    const written = JSON.parse(readFileSync(box.userConfigPath(), "utf8"));
    expect(written).toEqual({ version: 1, profiles: { default: { org: "acme", workspace: "acme-eu" } } });

    // The next command picks both up with no flag.
    const next = fakeApi()
      .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
      .on("GET", "/api/v1/workspaces", jsonResponse(200, WORKSPACES_PAGE))
      .on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME));
    const list = await box.run(["workspace", "list"], { api: next });
    expect(list.code).toBe(0);
    expect(next.calls[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it("the argument's org wins over --org for the validating request", async () => {
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu", jsonResponse(200, WORKSPACE_DETAIL));
    const r = await box.run(["workspace", "use", "acme/acme-eu", "--org", "northwind"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it.each(["acme", "acme/", "/acme-eu", "acme/acme-eu/extra", "acme eu/x"])(
    "a malformed argument (%s) is exit 2, writes nothing and makes no request",
    async (arg) => {
      const api = fakeApi();
      const r = await box.run(["workspace", "use", arg], { env: TOKEN_ENV, api });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("is not an org/workspace pair.");
      expect(r.stderr).toContain("wam workspace use acme/acme-eu");
      expect(api.calls).toHaveLength(0);
      expect(existsSync(box.userConfigPath())).toBe(false);
    },
  );

  it("a 404 on an org key is exit 3 with the section 9 mismatch copy, and nothing is written", async () => {
    await box.storeCredential("org", "northwind");
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu", errorResponse(404, "not_found", "Organization not found."));
    const r = await box.run(["workspace", "use", "acme/acme-eu"], { api });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      [
        "Workspace acme-eu was not found, or this key cannot see it.",
        `This key is bound to the organization northwind. Check wam auth status. (request ${REQUEST_ID})`,
        "",
      ].join("\n"),
    );
    expect(api.calls).toHaveLength(1);
    expect(existsSync(box.userConfigPath())).toBe(false);
  });

  it("a 404 on an account-wide key names the organization it could not reach", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu", errorResponse(404, "not_found", "Organization not found."));
    const r = await box.run(["workspace", "use", "initech/acme-eu"], { api });
    expect(r.code).toBe(3);
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBe("initech");
    expect(r.stderr).toContain("Organization initech was not found, or you are not a member of it.");
    expect(r.stderr).toContain("See what this key reaches: wam org list");
    expect(existsSync(box.userConfigPath())).toBe(false);
  });

  it("the help of each subcommand ends with a copy-pasteable example", async () => {
    const list = await box.run(["workspace", "list", "--help"]);
    expect(list.stdout.trimEnd().split("\n").pop()).toBe("  $ wam workspace list --org acme");
    const use = await box.run(["workspace", "use", "--help"]);
    expect(use.stdout.trimEnd().split("\n").pop()).toBe("  $ wam workspace use acme/acme-eu");
  });
});

// --- Checkpoint 5: wam workspace create ------------------------------------------------------------

const WORKSPACES_PATH = "/api/v1/workspaces";

function createApi(response: Response = jsonResponse(201, WORKSPACE_CREATED)): RecordingApi {
  const api = recordingApi();
  api.on("POST", WORKSPACES_PATH, response);
  return api;
}

describe("wam workspace create", () => {
  it("sends the org as X-Wam-Org and never as a body field, sends no Idempotency-Key, and prints the 201 body's counts", async () => {
    await box.storeCredential("user", null);
    const api = createApi();
    const r = await runCli(box, ["workspace", "create", "Acme Labs EU", "--org", "acme-labs", "--yes"], { api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${WORKSPACES_PATH}`]);
    const sent = api.requests[0]!;
    expect(sent.headers["X-Wam-Org"]).toBe("acme-labs");
    expect(sent.body).toEqual({ name: "Acme Labs EU" });
    expect(JSON.stringify(sent.body)).not.toContain("acme-labs");
    // No Idempotency-Key header at all, in any casing.
    expect(Object.keys(sent.headers).map((h) => h.toLowerCase())).not.toContain("idempotency-key");

    expect(r.stdout).toBe(
      ["Created Acme Labs EU (acme-labs-eu) in acme-labs.", "  Prompts      0", "  Competitors  0", "  Scans        none yet", ""].join("\n"),
    );
    // No denominator: the create response does not carry the plan's cap.
    expect(r.stdout).not.toMatch(/\d+\s*(of|\/)\s*\d+/);
    expect(r.stderr).toContain("Next:  wam workspace use acme-labs/acme-labs-eu");
  });

  it("no Idempotency-Key even in CI with a run id, where wam scan run would derive one", async () => {
    const api = createApi();
    await runCli(box, ["workspace", "create", "X", "--yes"], { env: { ...TOKEN_ENV, WAM_ORG: "acme", GITHUB_RUN_ID: "9001", CI: "1" }, api });
    expect(api.requests).toHaveLength(1);
    expect(Object.keys(api.requests[0]!.headers).map((h) => h.toLowerCase())).not.toContain("idempotency-key");
  });

  it("--json is the 201 body verbatim", async () => {
    const r = await runCli(box, ["workspace", "create", "Acme Labs EU", "--yes", "--json"], { env: { ...TOKEN_ENV, WAM_ORG: "acme-labs" }, api: createApi() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(WORKSPACE_CREATED)}\n`);
    expect(r.stderr).toBe("");
  });

  it("at the plan's cap: exit 10, the API's message verbatim, and no plan label or limit typed locally", async () => {
    // A message no CLI could have typed: if it shows up, it was printed from the response.
    const message = "Your Test Tier Zeta plan allows 3 workspaces. Upgrade to add more.";
    const api = createApi(
      errorResponse(409, "conflict", message, { limit: 3, current: 3, tier: "single", billingUrl: "https://whereamimentioned.com/acme/billing" }),
    );
    const r = await runCli(box, ["workspace", "create", "X", "--yes"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(10);
    expect(r.stderr).toBe(
      [message, `This organization already has 3. Change plan: https://whereamimentioned.com/acme/billing (request ${REQUEST_ID})`, ""].join("\n"),
    );
    expect(r.stderr).not.toMatch(/Single Brand|Pro plan|Agency/);
    // A ceiling is never retried.
    expect(api.calls).toHaveLength(1);
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = createApi();
    const r = await runCli(box, ["workspace", "create", "X", "--yes"], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });

  it("a stored org key creates in its own organization without being told the slug again", async () => {
    await box.storeCredential("org", "acme");
    const api = createApi();
    const r = await runCli(box, ["workspace", "create", "X", "--yes"], { api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${WORKSPACES_PATH}`]);
    expect(api.requests[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it("a bare org key learns its organization from GET /api/v1/me, names it in the confirmation, then creates there", async () => {
    const api = createApi();
    api.on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY));
    const r = await runCli(box, ["workspace", "create", "X"], { env: TOKEN_ENV, api, tty: true, stdin: answers(["y"]) });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual(["GET /api/v1/me", `POST ${WORKSPACES_PATH}`]);
    expect(r.stderr).toContain("This creates a workspace in acme. It cannot be deleted from the CLI or the API.");
    expect(api.sent("POST", WORKSPACES_PATH)[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it("requires --yes where it cannot ask: exit 2 and nothing is created", async () => {
    const api = createApi();
    const r = await runCli(box, ["workspace", "create", "X"], { env: { ...TOKEN_ENV, WAM_ORG: "acme", CI: "1" }, api, tty: true });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("This command creates a workspace in acme and cannot prompt for confirmation here.");
    expect(r.stderr).toContain("Pass --yes to confirm.");
    expect(api.calls).toHaveLength(0);
  });

  it("in a terminal it confirms with the cannot-be-undone reason, never a money warning, and an empty answer cancels", async () => {
    const api = createApi();
    const env = { ...TOKEN_ENV, WAM_ORG: "acme-labs" };
    const no = await runCli(box, ["workspace", "create", "X"], { env, api, tty: true, stdin: answers([""]) });
    expect(no.code).toBe(0);
    expect(no.stderr).toContain("This creates a workspace in acme-labs. It cannot be deleted from the CLI or the API.");
    expect(no.stderr).toContain("Create it? (y/N)");
    expect(no.stderr).toContain("Cancelled.");
    expect(no.stderr).not.toMatch(/credit|spend|cost|money|charge/i);
    expect(api.calls).toHaveLength(0);

    const yes = await runCli(box, ["workspace", "create", "X"], { env, api, tty: true, stdin: answers(["yes"]) });
    expect(yes.code).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  it("a missing scope and a role that is too low are exit 3", async () => {
    const env = { ...TOKEN_ENV, WAM_ORG: "acme" };
    const scope = createApi(errorResponse(403, "insufficient_scope", "Missing scope.", { requiredScope: "workspaces:write", heldScopes: ["workspaces:read"] }));
    const a = await runCli(box, ["workspace", "create", "X", "--yes"], { env, api: scope });
    expect(a.code).toBe(3);
    expect(a.stderr).toContain("This key does not carry the workspaces:write scope, which this command needs.");

    const role = createApi(errorResponse(403, "insufficient_role", "Role too low.", { effectiveRole: "viewer", requiredRole: "member" }));
    const b = await runCli(box, ["workspace", "create", "X", "--yes"], { env, api: role });
    expect(b.code).toBe(3);
    expect(b.stderr).toContain("is not high enough to create a workspace. Member or above is required.");
  });

  it("a 500 is exit 1 after exactly one create: this command is never retried", async () => {
    const api = createApi(errorResponse(500, "internal_error", "boom"));
    const r = await runCli(box, ["workspace", "create", "X", "--yes"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(1);
    expect(api.calls).toHaveLength(1);
  });

  it("the help of create ends with a copy-pasteable example", async () => {
    const help = await box.run(["workspace", "create", "--help"]);
    expect(help.stdout.trimEnd().split("\n").pop()).toBe('  $ wam workspace create "Acme Labs EU" --org acme-labs');
  });
});
