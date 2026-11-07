import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDITS_ACME,
  CREDITS_NORTHWIND,
  FAKE_TOKEN,
  ME_ORG_KEY,
  ME_USER_KEY_ACME,
  ME_USER_KEY_NORTHWIND,
  ORGANIZATIONS_PAGE,
  TOKEN_ENV,
  errorResponse,
  fakeApi,
  jsonResponse,
  sandbox,
  type FakeApi,
  type Sandbox,
} from "./fixtures";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.tmp.cleanup();
});

const ORG_KEY_REFUSAL = () =>
  errorResponse(
    403,
    "insufficient_scope",
    "This route requires an account-wide API key; an organization key cannot act across organizations.",
    { requiredKind: "user" },
  );

/** /me and /credits answer for whichever org `X-Wam-Org` names, as 08 section 4.8 does. */
function userKeyApi(): FakeApi {
  return fakeApi()
    .on("GET", "/api/v1/me", (call) =>
      jsonResponse(200, call.headers["X-Wam-Org"] === "northwind" ? ME_USER_KEY_NORTHWIND : ME_USER_KEY_ACME),
    )
    .on("GET", "/api/v1/credits", (call) =>
      jsonResponse(200, call.headers["X-Wam-Org"] === "northwind" ? CREDITS_NORTHWIND : CREDITS_ACME),
    )
    .on("GET", "/api/v1/organizations", jsonResponse(200, ORGANIZATIONS_PAGE));
}

function expectNoToken(run: { stdout: string; stderr: string }): void {
  expect(run.stdout).not.toContain(FAKE_TOKEN);
  expect(run.stderr).not.toContain(FAKE_TOKEN);
}

describe("wam auth status on an org key", () => {
  it("prints the block of section 3.2 from /me and /credits, and never the token", async () => {
    await box.storeCredential("org", "acme");
    const api = fakeApi()
      .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
      .on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME));
    const r = await box.run(["auth", "status"], { api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual(["GET /api/v1/me", "GET /api/v1/credits"]);
    expect(r.stdout.split("\n")).toEqual([
      "Signed in to whereamimentioned.com",
      "",
      "  Key kind       Organization key, bound to acme",
      "  Organization   Acme Ltd (acme)",
      "  Role           admin, capped to member by this key",
      "  Plan           Pro",
      "  Credits        312   (about 7 scans at the maximum scan size for this tier)",
      `  Key            ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)}  "MBP-16 CLI"`,
      "  Scopes         workspaces:read, scans:read, scans:write, reports:read, prompts:read,",
      "                 competitors:read",
      "  Expires        2026-12-08  (89 days)",
      "  Credential     credentials.json",
      "  Default        (none set)",
      "",
    ]);
    expectNoToken(r);
  });

  it("the about-N-scans figure is estimatedScansRemaining verbatim, not a number the CLI computed", async () => {
    const api = fakeApi()
      .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
      .on("GET", "/api/v1/credits", jsonResponse(200, { ...CREDITS_ACME, estimatedScansRemaining: 4321 }));
    const r = await box.run(["auth", "status", "--org", "acme"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Credits        312   (about 4321 scans at the maximum scan size for this tier)");
    expect(r.stdout).toContain("Credential     WAM_TOKEN environment variable");
    expect(r.stdout).toContain("Default        acme   (org from --org, no workspace set)");
    expectNoToken(r);
  });

  it("with a bare WAM_TOKEN and no org, learns the kind from the 403 and still never retries it", async () => {
    const api = fakeApi()
      .on("GET", "/api/v1/organizations", ORG_KEY_REFUSAL)
      .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
      .on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME));
    const r = await box.run(["whoami"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual(["GET /api/v1/organizations", "GET /api/v1/me", "GET /api/v1/credits"]);
    expect(r.stdout).toContain("Key kind       Organization key, bound to acme");
    expect(r.stdout).not.toContain("Reaches");
  });

  it("--json carries key, org, actor, plan, the whole credits body and local, and NO organizations", async () => {
    await box.storeCredential("org", "acme");
    const api = fakeApi()
      .on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY))
      .on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME));
    const r = await box.run(["auth", "status", "--json"], { api });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const doc = JSON.parse(r.stdout);
    expect(Object.keys(doc)).toEqual(["key", "org", "actor", "plan", "credits", "local"]);
    expect(doc.key).toEqual(ME_ORG_KEY.key);
    expect(doc.org).toEqual(ME_ORG_KEY.org);
    expect(doc.actor).toEqual(ME_ORG_KEY.actor);
    expect(doc.plan).toEqual(ME_ORG_KEY.plan);
    expect(doc.credits).toEqual(CREDITS_ACME);
    expect(doc.credits.estimatedScansRemaining).toBe(7);
    expect("organizations" in doc).toBe(false);
    expect(doc.local).toEqual({ storage: "file", profile: "default", org: null, workspace: null, configSources: [] });
    // Neither is served by GET /api/v1/me, and neither is invented locally.
    expect(doc.actor.email).toBeUndefined();
    expect(doc.key.lastUsedAt).toBeUndefined();
    expectNoToken(r);
  });
});

describe("wam auth status on an account-wide key", () => {
  it("prints the resolved org's rows, then the reach table with the free-floor sentence", async () => {
    await box.storeCredential("user", null);
    const api = userKeyApi();
    const r = await box.run(["auth", "status", "--org", "acme"], { api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual(["GET /api/v1/me", "GET /api/v1/credits", "GET /api/v1/organizations"]);
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBe("acme");
    expect(api.calls[1]!.headers["X-Wam-Org"]).toBe("acme");
    // The organization list resolves no org, so the header is suppressed on it.
    expect(api.calls[2]!.headers["X-Wam-Org"]).toBeUndefined();

    expect(r.stdout).toContain("  Key kind       Account-wide key, reaches 3 organizations");
    expect(r.stdout).toContain("  Organization   Acme Ltd (acme)   (resolved for this command, from --org)");
    expect(r.stdout).toContain("  Plan           Pro");
    expect(r.stdout).toContain(
      [
        "  Reaches        ORG        NAME       TIER    YOUR ROLE  WORKSPACES",
        "                 acme       Acme Ltd   pro     member              3",
        "                 northwind  Northwind  single  member              1",
        "                 acme-labs  Acme Labs  free    member              0",
        "",
        "  acme-labs is on the free floor, so it cannot run scans until someone subscribes.",
      ].join("\n"),
    );
    expectNoToken(r);
  });

  it("the same credential prints a different plan and credits block per --org, and the same reach table", async () => {
    await box.storeCredential("user", null);
    const acme = await box.run(["auth", "status", "--org", "acme"], { api: userKeyApi() });
    const northwind = await box.run(["auth", "status", "--org", "northwind"], { api: userKeyApi() });

    expect(acme.stdout).toContain("  Plan           Pro");
    expect(acme.stdout).toContain("  Credits        312   (about 7 scans");
    expect(northwind.stdout).toContain("  Organization   Northwind (northwind)   (resolved for this command, from --org)");
    expect(northwind.stdout).toContain("  Plan           Single Brand");
    expect(northwind.stdout).toContain("  Credits        40   (about 1 scan at the maximum scan size for this tier)");

    const reach = (s: string) => s.slice(s.indexOf("  Reaches"));
    expect(reach(acme.stdout)).toBe(reach(northwind.stdout));
  });

  it("kind comes from key.kind on /me, never from the token prefix", async () => {
    // Same token, same wam_test_ prefix on both bodies: only key.kind differs.
    expect(ME_ORG_KEY.key.prefix).toBe(ME_USER_KEY_ACME.key.prefix);
    const orgKey = await box.run(["auth", "status", "--org", "acme"], {
      env: TOKEN_ENV,
      api: fakeApi().on("GET", "/api/v1/me", jsonResponse(200, ME_ORG_KEY)).on("GET", "/api/v1/credits", jsonResponse(200, CREDITS_ACME)),
    });
    const userKey = await box.run(["auth", "status", "--org", "acme"], { env: TOKEN_ENV, api: userKeyApi() });
    expect(orgKey.stdout).toContain("Key kind       Organization key, bound to acme");
    expect(userKey.stdout).toContain("Key kind       Account-wide key, reaches 3 organizations");
  });

  it("with no org resolved: the reach table only, exit 0, and no GET /api/v1/me at all", async () => {
    await box.storeCredential("user", null);
    const api = userKeyApi();
    const r = await box.run(["auth", "status"], { api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual(["GET /api/v1/organizations"]);
    expect(api.calls.some((c) => c.path === "/api/v1/me")).toBe(false);

    expect(r.stdout).toContain("  Key kind       Account-wide key, reaches 3 organizations");
    for (const row of ["  Organization ", "  Role ", "  Plan ", "  Credits "]) expect(r.stdout).not.toContain(row);
    expect(r.stdout).toContain(`  Key            ${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)}`);
    expect(r.stdout).toContain("  Reaches        ORG ");
    expect(r.stdout).toContain("acme-labs is on the free floor");
    expect(r.stdout).toContain("Pass --org <slug> to see them for one of the organizations above.");
    expectNoToken(r);
  });

  it("a bare WAM_TOKEN with no org is probed through /organizations, so /me is never sent without X-Wam-Org", async () => {
    const api = userKeyApi();
    const r = await box.run(["auth", "status"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual(["GET /api/v1/organizations"]);
    expect(r.stdout).toContain("Account-wide key, reaches 3 organizations");
  });

  it("--json has organizations on an account-wide key only, and no invented fields", async () => {
    await box.storeCredential("user", null);
    const r = await box.run(["auth", "status", "--org", "acme", "--json"], { api: userKeyApi() });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(Object.keys(doc)).toEqual(["key", "org", "actor", "plan", "credits", "organizations", "local"]);
    expect(doc.organizations).toEqual(ORGANIZATIONS_PAGE.data);
    expect(doc.credits).toEqual(CREDITS_ACME);
    expect(doc.local).toMatchObject({ storage: "file", profile: "default", org: "acme", workspace: null });
    expect(doc.actor.email).toBeUndefined();
    expect(doc.key.lastUsedAt).toBeUndefined();

    const bare = await box.run(["auth", "status", "--json"], { api: userKeyApi() });
    expect(bare.code).toBe(0);
    expect(Object.keys(JSON.parse(bare.stdout))).toEqual(["organizations", "local"]);
    expectNoToken(r);
    expectNoToken(bare);
  });

  it("an account-wide key that reaches nothing still reports an empty organizations array, not an absent one", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on(
      "GET",
      "/api/v1/organizations",
      jsonResponse(200, { data: [], pagination: { nextCursor: null, hasMore: false, limit: 25 } }),
    );
    const r = await box.run(["auth", "status", "--json"], { api });
    expect(JSON.parse(r.stdout).organizations).toEqual([]);
  });
});

describe("wam auth status failures", () => {
  it("no credential is exit 3 with the Not signed in copy and no request", async () => {
    const api = fakeApi();
    const r = await box.run(["auth", "status"], { api });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Not signed in.\nRun wam auth login, or set WAM_TOKEN in your environment.\n");
    expect(api.calls).toHaveLength(0);
  });

  it("a credential the server no longer accepts is exit 3", async () => {
    await box.storeCredential("org", "acme");
    const api = fakeApi().on("GET", "/api/v1/me", errorResponse(401, "unauthorized", "Missing or invalid API key."));
    const r = await box.run(["auth", "status"], { api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("This API key is no longer valid.");
    expectNoToken(r);
  });

  it("the help of status ends with a copy-pasteable example", async () => {
    const r = await box.run(["auth", "status", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("  $ wam auth status --org acme");
  });
});
