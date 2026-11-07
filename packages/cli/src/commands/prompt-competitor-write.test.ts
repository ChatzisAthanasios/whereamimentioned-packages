import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptListResponse } from "@whereamimentioned/api-client";
import {
  PROMPTS_PAGE,
  REQUEST_ID,
  TOKEN_ENV,
  WORKSPACE_DETAIL,
  errorResponse,
  jsonResponse,
  sandbox,
  type Sandbox,
} from "./fixtures";
import {
  COMPETITOR_CREATED,
  PROMPT_CREATED,
  PROMPT_ID,
  answers,
  recordingApi,
  runCli,
  type RecordingApi,
} from "./write-fixtures";

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.tmp.cleanup();
});

const ORG_ENV = { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" };
const PROMPTS_PATH = "/api/v1/workspaces/acme-eu/prompts";
const PROMPT_PATH = `${PROMPTS_PATH}/${PROMPT_ID}`;
const WORKSPACE_PATH = "/api/v1/workspaces/acme-eu";
const COMPETITORS_PATH = "/api/v1/workspaces/acme-eu/competitors";
const SHORT_ID = PROMPT_ID.slice(0, 8);

/** A list page that contains the prompt the tests toggle and remove. */
const PAGE_WITH_TARGET = promptListResponse.parse({
  ...PROMPTS_PAGE,
  data: [...PROMPTS_PAGE.data, PROMPT_CREATED],
});

describe("wam prompt add", () => {
  it("posts only what was asked for, and prints the prompt as the API stored it", async () => {
    const api = recordingApi();
    api.on("POST", PROMPTS_PATH, jsonResponse(201, PROMPT_CREATED));
    const r = await runCli(box, ["prompt", "add", "  which tools track brand mentions in AI answers  "], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${PROMPTS_PATH}`]);
    // No stage, persona, enabled or source: the API defaults the stage and forces the source.
    expect(api.requests[0]!.body).toEqual({ text: "which tools track brand mentions in AI answers" });
    expect(api.requests[0]!.headers["X-Wam-Org"]).toBe("acme");
    expect(api.requests[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(r.stdout).toBe(`Prompt ${SHORT_ID} added: comparison, custom, enabled.\n`);
  });

  it("--stage, --persona and --disabled map onto intentStage, persona and enabled", async () => {
    const api = recordingApi();
    api.on("POST", PROMPTS_PATH, jsonResponse(201, { ...PROMPT_CREATED, enabled: false }));
    const r = await runCli(
      box,
      ["prompt", "add", "which tools track brand mentions", "--stage", "comparison", "--persona", "agency owner", "--disabled"],
      { env: ORG_ENV, api },
    );
    expect(r.code).toBe(0);
    expect(api.requests[0]!.body).toEqual({
      text: "which tools track brand mentions",
      intentStage: "comparison",
      persona: "agency owner",
      enabled: false,
    });
    expect(r.stdout).toContain("disabled.");
  });

  it("--json is the 201 body verbatim", async () => {
    const api = recordingApi();
    api.on("POST", PROMPTS_PATH, jsonResponse(201, PROMPT_CREATED));
    const r = await runCli(box, ["prompt", "add", "which tools track brand mentions", "--json"], { env: ORG_ENV, api });
    expect(r.stdout).toBe(`${JSON.stringify(PROMPT_CREATED)}\n`);
  });

  it("a --stage outside the contract's tuple is exit 2 and sends nothing", async () => {
    const api = recordingApi();
    const r = await runCli(box, ["prompt", "add", "which tools track brand mentions", "--stage", "checkout"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--stage must be one of: awareness, research, comparison, purchase, branded.");
    expect(api.calls).toHaveLength(0);
  });

  it("a full allowance is the 403, exit 3, with the API's message and the number it carried", async () => {
    const api = recordingApi();
    api.on(
      "POST",
      PROMPTS_PATH,
      errorResponse(403, "feature_not_available", "This workspace already has 37 prompts, which is the cap on the Test plan.", { limit: 37, current: 37 }),
    );
    const r = await runCli(box, ["prompt", "add", "which tools track brand mentions"], { env: ORG_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      [
        "This workspace already has 37 prompts, which is the cap on the Test plan.",
        `Disable or remove one first: wam prompt list (request ${REQUEST_ID})`,
        "",
      ].join("\n"),
    );
    expect(api.calls).toHaveLength(1);
  });

  it("a 422 is exit 2 with the API's issues", async () => {
    const api = recordingApi();
    api.on(
      "POST",
      PROMPTS_PATH,
      errorResponse(422, "validation_failed", "Invalid request body.", { issues: [{ path: ["text"], message: "Too short" }] }),
    );
    const r = await runCli(box, ["prompt", "add", "short"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("text: Too short");
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = recordingApi();
    const r = await runCli(box, ["prompt", "add", "which tools track brand mentions", "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam prompt enable and disable", () => {
  function toggleApi(enabled: boolean): RecordingApi {
    const api = recordingApi();
    api
      .on("GET", PROMPTS_PATH, jsonResponse(200, PAGE_WITH_TARGET))
      .on("PATCH", PROMPT_PATH, jsonResponse(200, { ...PROMPT_CREATED, enabled }))
      .on("GET", WORKSPACE_PATH, jsonResponse(200, { ...WORKSPACE_DETAIL, enabledPromptCount: 11 }));
    return api;
  }

  it("disable PATCHes { enabled: false } and prints the section 3.7 line, with the footer's two numbers from the API", async () => {
    const api = toggleApi(false);
    const r = await runCli(box, ["prompt", "disable", PROMPT_ID], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.sent("PATCH", PROMPT_PATH)).toHaveLength(1);
    expect(api.sent("PATCH", PROMPT_PATH)[0]!.body).toEqual({ enabled: false });
    expect(r.stdout).toBe(
      [
        `Prompt ${SHORT_ID} disabled. It will not consume credits in the next scan.`,
        // 11 is enabledPromptCount from the workspace, 150 is promptsPerWorkspace from the list.
        "11 of 150 prompts enabled. Tier cap is 150 per workspace on this plan.",
        "",
      ].join("\n"),
    );
  });

  it("enable PATCHes { enabled: true }", async () => {
    const api = toggleApi(true);
    const r = await runCli(box, ["prompt", "enable", PROMPT_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.sent("PATCH", PROMPT_PATH)[0]!.body).toEqual({ enabled: true });
    expect(r.stdout).toContain(`Prompt ${SHORT_ID} enabled. It is eligible for the next scan.`);
  });

  it("the cap in the footer is whatever the list served, never a local table", async () => {
    const api = toggleApi(false);
    api.on("GET", PROMPTS_PATH, jsonResponse(200, { ...PAGE_WITH_TARGET, promptsPerWorkspace: 37 }));
    const r = await runCli(box, ["prompt", "disable", PROMPT_ID], { env: ORG_ENV, api });
    expect(r.stdout).toContain("11 of 37 prompts enabled. Tier cap is 37 per workspace on this plan.");
  });

  it("takes the short id wam prompt list shows, resolving it against the list before it writes", async () => {
    const api = toggleApi(false);
    const r = await runCli(box, ["prompt", "disable", SHORT_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()[0]).toBe(`GET ${PROMPTS_PATH}`);
    // The PATCH goes to the FULL id. A short id sent as is would be a 404 by design.
    expect(api.sent("PATCH", PROMPT_PATH)).toHaveLength(1);
    expect(api.calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual([PROMPT_PATH]);
  });

  it("a short id that matches several prompts is exit 2 and writes nothing", async () => {
    const twin = { ...PROMPT_CREATED, id: `${SHORT_ID}-1111-4000-8000-000000000009` };
    const api = recordingApi();
    api.on("GET", PROMPTS_PATH, jsonResponse(200, { ...PAGE_WITH_TARGET, data: [...PAGE_WITH_TARGET.data, twin] }));
    const r = await runCli(box, ["prompt", "disable", SHORT_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`The id ${SHORT_ID} matches 2 prompts`);
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a short id that matches nothing, and a 404 on the PATCH, both name the prompt and exit 3", async () => {
    const none = recordingApi();
    none.on("GET", PROMPTS_PATH, jsonResponse(200, PROMPTS_PAGE));
    const a = await runCli(box, ["prompt", "enable", "ffffffff"], { env: ORG_ENV, api: none });
    expect(a.code).toBe(3);
    expect(a.stderr).toContain("Prompt ffffffff was not found in workspace acme-eu, or this key cannot see it.");
    expect(none.calls.some((c) => c.method === "PATCH")).toBe(false);

    const gone = recordingApi();
    gone.on("PATCH", PROMPT_PATH, errorResponse(404, "not_found", "Prompt not found."));
    const b = await runCli(box, ["prompt", "enable", PROMPT_ID], { env: ORG_ENV, api: gone });
    expect(b.code).toBe(3);
    expect(b.stderr).toContain(`Prompt ${PROMPT_ID} was not found in workspace acme-eu, or this key cannot see it.`);
    expect(b.stderr).toContain(`(request ${REQUEST_ID})`);
  });

  it("--json is the PATCH body verbatim, from one request", async () => {
    const api = toggleApi(false);
    const r = await runCli(box, ["prompt", "disable", PROMPT_ID, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ ...PROMPT_CREATED, enabled: false })}\n`);
    expect(api.paths()).toEqual([`PATCH ${PROMPT_PATH}`]);
  });

  it("a footer that cannot be read does not turn a write that happened into a failure", async () => {
    const api = recordingApi();
    api.on("PATCH", PROMPT_PATH, jsonResponse(200, { ...PROMPT_CREATED, enabled: false }));
    const r = await runCli(box, ["prompt", "disable", PROMPT_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Prompt ${SHORT_ID} disabled. It will not consume credits in the next scan.\n`);
  });

  it("a role that is too low is exit 3 and names the action", async () => {
    const api = recordingApi();
    api.on("PATCH", PROMPT_PATH, errorResponse(403, "insufficient_role", "Role too low.", { effectiveRole: "viewer", requiredRole: "member" }));
    const r = await runCli(box, ["prompt", "disable", PROMPT_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("is not high enough to change a prompt.");
  });
});

describe("wam prompt remove", () => {
  it("with --yes it deletes and says so", async () => {
    const api = recordingApi();
    api.on("DELETE", PROMPT_PATH, jsonResponse(200, { deleted: true, id: PROMPT_ID }));
    const r = await runCli(box, ["prompt", "remove", PROMPT_ID, "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`DELETE ${PROMPT_PATH}`]);
    expect(r.stdout).toBe(`Prompt ${SHORT_ID} removed.\n`);
  });

  it("a 404 on delete is success: the prompt is gone either way", async () => {
    const api = recordingApi();
    api.on("DELETE", PROMPT_PATH, errorResponse(404, "not_found", "Prompt not found."));
    const r = await runCli(box, ["prompt", "remove", PROMPT_ID, "--yes", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ deleted: true, id: PROMPT_ID });
    expect(api.calls).toHaveLength(1);
  });

  it("where it cannot ask, without --yes: exit 2 and no request at all", async () => {
    const api = recordingApi();
    const r = await runCli(box, ["prompt", "remove", SHORT_ID], { env: { ...ORG_ENV, CI: "1" }, api, tty: true });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`This command removes prompt ${SHORT_ID} from workspace acme-eu and cannot prompt for confirmation here.`);
    expect(r.stderr).toContain("Pass --yes to confirm.");
    expect(api.calls).toHaveLength(0);
  });

  it("in a terminal it asks first: an empty answer cancels with exit 0, and y removes", async () => {
    const api = recordingApi();
    api.on("DELETE", PROMPT_PATH, jsonResponse(200, { deleted: true, id: PROMPT_ID }));
    const no = await runCli(box, ["prompt", "remove", PROMPT_ID], { env: ORG_ENV, api, tty: true, stdin: answers([""]) });
    expect(no.code).toBe(0);
    expect(no.stderr).toContain(`This removes prompt ${PROMPT_ID} from workspace acme-eu.`);
    expect(no.stderr).toContain("Remove it? (y/N)");
    expect(no.stderr).toContain("Cancelled.");
    expect(api.calls).toHaveLength(0);

    const yes = await runCli(box, ["prompt", "remove", PROMPT_ID], { env: ORG_ENV, api, tty: true, stdin: answers(["y"]) });
    expect(yes.code).toBe(0);
    expect(api.paths()).toEqual([`DELETE ${PROMPT_PATH}`]);
  });

  it("a short id is resolved to the full id before the DELETE, so a removal is never reported that did not happen", async () => {
    const api = recordingApi();
    api.on("GET", PROMPTS_PATH, jsonResponse(200, PAGE_WITH_TARGET)).on("DELETE", PROMPT_PATH, jsonResponse(200, { deleted: true, id: PROMPT_ID }));
    const r = await runCli(box, ["prompt", "remove", SHORT_ID, "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${PROMPTS_PATH}`, `DELETE ${PROMPT_PATH}`]);
    expect(r.stdout).toBe(`Prompt ${SHORT_ID} removed.\n`);
  });

  it("a short id that matches nothing sends no DELETE and says there was nothing to remove", async () => {
    const api = recordingApi();
    api.on("GET", PROMPTS_PATH, jsonResponse(200, PROMPTS_PAGE));
    const r = await runCli(box, ["prompt", "remove", "ffffffff", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No prompt with an id starting with ffffffff is in workspace acme-eu, so there is nothing to remove.");
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("the help of every write subcommand ends with a copy-pasteable example", async () => {
    const last = async (argv: string[]) => (await box.run(argv)).stdout.trimEnd().split("\n").pop();
    expect(await last(["prompt", "add", "--help"])).toBe('  $ wam prompt add "best AI visibility tools for agencies" --stage comparison');
    expect(await last(["prompt", "enable", "--help"])).toBe("  $ wam prompt enable 7b12ee40");
    expect(await last(["prompt", "disable", "--help"])).toBe("  $ wam prompt disable 7b12ee40");
    expect(await last(["prompt", "remove", "--help"])).toBe("  $ wam prompt remove 7b12ee40 --yes");
    expect(await last(["competitor", "add", "--help"])).toBe(
      '  $ wam competitor add "Rival Co" --domain rival.example --alias Rival --alias "Rival Inc"',
    );
  });
});

describe("wam competitor add", () => {
  it("posts the name, the domain and every --alias, and prints the competitor as the API stored it", async () => {
    const api = recordingApi();
    api.on("POST", COMPETITORS_PATH, jsonResponse(201, COMPETITOR_CREATED));
    const r = await runCli(
      box,
      ["competitor", "add", "Rival Co", "--domain", "rival.example", "--alias", "Rival", "--alias", "Rival Inc"],
      { env: ORG_ENV, api },
    );
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${COMPETITORS_PATH}`]);
    expect(api.requests[0]!.body).toEqual({ name: "Rival Co", domain: "rival.example", aliases: ["Rival", "Rival Inc"] });
    expect(api.requests[0]!.headers["X-Wam-Org"]).toBe("acme");
    expect(api.requests[0]!.headers["Idempotency-Key"]).toBeUndefined();
    // The API lowercases the name; the CLI prints what came back, not what was typed.
    expect(r.stdout).toBe(
      ["Competitor rival co (rival.example) added. It takes effect on the next scan.", "  Aliases  Rival, Rival Inc", ""].join("\n"),
    );
  });

  it("with a name only, the body is the name only", async () => {
    const api = recordingApi();
    api.on("POST", COMPETITORS_PATH, jsonResponse(201, { ...COMPETITOR_CREATED, domain: null, aliases: [] }));
    const r = await runCli(box, ["competitor", "add", "Rival Co"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.requests[0]!.body).toEqual({ name: "Rival Co" });
    expect(r.stdout).toBe("Competitor rival co added. It takes effect on the next scan.\n");
  });

  it("--json is the 201 body verbatim", async () => {
    const api = recordingApi();
    api.on("POST", COMPETITORS_PATH, jsonResponse(201, COMPETITOR_CREATED));
    const r = await runCli(box, ["competitor", "add", "Rival Co", "--json"], { env: ORG_ENV, api });
    expect(r.stdout).toBe(`${JSON.stringify(COMPETITOR_CREATED)}\n`);
  });

  it("a duplicate is the 409 conflict, exit 9, with the API's message, and is not retried", async () => {
    const api = recordingApi();
    api.on(
      "POST",
      COMPETITORS_PATH,
      errorResponse(409, "conflict", "A competitor with the same name already exists in this workspace.", { fields: ["name"] }),
    );
    const r = await runCli(box, ["competitor", "add", "Rival Co"], { env: ORG_ENV, api });
    expect(r.code).toBe(9);
    expect(r.stderr).toContain("A competitor with the same name already exists in this workspace.");
    expect(api.calls).toHaveLength(1);
  });

  it("a missing competitors:write scope is exit 3 with the scope copy", async () => {
    const api = recordingApi();
    api.on(
      "POST",
      COMPETITORS_PATH,
      errorResponse(403, "insufficient_scope", "Missing scope.", { requiredScope: "competitors:write", heldScopes: ["competitors:read"] }),
    );
    const r = await runCli(box, ["competitor", "add", "Rival Co"], { env: ORG_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("This key does not carry the competitors:write scope, which this command needs.");
  });

  it("with no workspace resolved: exit 2 and no request", async () => {
    const api = recordingApi();
    const r = await runCli(box, ["competitor", "add", "Rival Co"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No workspace selected.");
    expect(api.calls).toHaveLength(0);
  });
});
