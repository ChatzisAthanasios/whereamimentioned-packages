import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTENT_STAGES } from "@whereamimentioned/api-client";
import {
  COMPETITORS_PAGE,
  PROMPTS_PAGE,
  TOKEN_ENV,
  WORKSPACE_DETAIL,
  fakeApi,
  jsonResponse,
  sandbox,
  type Sandbox,
} from "./fixtures";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.tmp.cleanup();
});

const ORG_ENV = { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" };
const PROMPTS_PATH = "/api/v1/workspaces/acme-eu/prompts";
const WORKSPACE_PATH = "/api/v1/workspaces/acme-eu";
const COMPETITORS_PATH = "/api/v1/workspaces/acme-eu/competitors";

describe("wam prompt list", () => {
  it("renders the section 3.7 table, with the footer's count from the workspace detail and its cap from the envelope", async () => {
    const api = fakeApi()
      .on("GET", PROMPTS_PATH, jsonResponse(200, PROMPTS_PAGE))
      .on("GET", WORKSPACE_PATH, jsonResponse(200, WORKSPACE_DETAIL));
    const r = await box.run(["prompt", "list"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual([`GET ${PROMPTS_PATH}`, `GET ${WORKSPACE_PATH}`]);
    expect(r.stdout).toBe(
      [
        "ID        STAGE     SOURCE     ON   TEXT",
        "a3f0c1d2  research  generated  yes  best AI visibility tracking tools for SaaS",
        "d411bb02  purchase  custom     yes  Acme pricing compared to Rival A",
        "",
        // 12 is enabledPromptCount from GET /api/v1/workspaces/{slug}; the page holds 2 rows.
        "12 of 150 prompts enabled. Tier cap is 150 per workspace on this plan.",
        "",
      ].join("\n"),
    );
  });

  it("the cap is whatever the envelope served, and the count is never the number of rows on the page", async () => {
    const api = fakeApi()
      .on("GET", PROMPTS_PATH, jsonResponse(200, { ...PROMPTS_PAGE, promptsPerWorkspace: 15 }))
      .on("GET", WORKSPACE_PATH, jsonResponse(200, { ...WORKSPACE_DETAIL, enabledPromptCount: 9 }));
    const r = await box.run(["prompt", "list"], { env: ORG_ENV, api });
    expect(r.stdout).toContain("9 of 15 prompts enabled. Tier cap is 15 per workspace on this plan.");
    expect(r.stdout).not.toContain("2 of ");
  });

  it("passes --enabled, --source, --stage, --limit and --cursor straight through", async () => {
    const api = fakeApi()
      .on("GET", PROMPTS_PATH, jsonResponse(200, PROMPTS_PAGE))
      .on("GET", WORKSPACE_PATH, jsonResponse(200, WORKSPACE_DETAIL));
    const r = await box.run(
      ["prompt", "list", "--enabled", "true", "--source", "custom", "--stage", "purchase", "--limit", "5", "--cursor", "c1"],
      { env: ORG_ENV, api },
    );
    expect(r.code).toBe(0);
    expect(api.calls[0]!.query).toEqual({ enabled: "true", source: "custom", stage: "purchase", limit: "5", cursor: "c1" });
    // Both rows of the served page are printed: the generated one is not dropped locally.
    expect(r.stdout).toContain("generated");
  });

  it("--json is the envelope unchanged, cap fields included, from one request", async () => {
    const api = fakeApi().on("GET", PROMPTS_PATH, jsonResponse(200, PROMPTS_PAGE));
    const r = await box.run(["prompt", "list", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(PROMPTS_PAGE)}\n`);
    expect(api.calls).toHaveLength(1);
  });

  it("bad flag values are usage errors naming the contract's values", async () => {
    const stage = await box.run(["prompt", "list", "--stage", "checkout"], { env: ORG_ENV, api: fakeApi() });
    expect(stage.code).toBe(2);
    expect(stage.stderr).toBe(`--stage must be one of: ${INTENT_STAGES.join(", ")}.\n`);
    const enabled = await box.run(["prompt", "list", "--enabled", "1"], { env: ORG_ENV, api: fakeApi() });
    expect(enabled.code).toBe(2);
    expect(enabled.stderr).toBe("--enabled must be true or false.\n");
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi();
    const r = await box.run(["prompt", "list", "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam competitor list", () => {
  it("renders the section 3.7 table", async () => {
    const api = fakeApi().on("GET", COMPETITORS_PATH, jsonResponse(200, COMPETITORS_PAGE));
    const r = await box.run(["competitor", "list"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${COMPETITORS_PATH}`]);
    expect(r.stdout).toBe(
      ["NAME     DOMAIN           ALIASES", "rival a  rival-a.example  Rival A Inc", "rival b  -", ""].join("\n"),
    );
  });

  it("--json is the envelope unchanged", async () => {
    const api = fakeApi().on("GET", COMPETITORS_PATH, jsonResponse(200, COMPETITORS_PAGE));
    const r = await box.run(["competitor", "list", "--json", "--limit", "50"], { env: ORG_ENV, api });
    expect(r.stdout).toBe(`${JSON.stringify(COMPETITORS_PAGE)}\n`);
    expect(api.calls[0]!.query).toEqual({ limit: "50" });
  });

  it("no workspace resolved is exit 2 and no request", async () => {
    const api = fakeApi();
    const r = await box.run(["competitor", "list"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No workspace selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("help", () => {
  it("each list ends with a copy-pasteable example", async () => {
    const prompt = await box.run(["prompt", "list", "--help"]);
    expect(prompt.stdout.trimEnd().split("\n").pop()).toBe("  $ wam prompt list --enabled true --stage research");
    const competitor = await box.run(["competitor", "list", "--help"]);
    expect(competitor.stdout.trimEnd().split("\n").pop()).toBe("  $ wam competitor list --workspace acme-eu");
  });
});
