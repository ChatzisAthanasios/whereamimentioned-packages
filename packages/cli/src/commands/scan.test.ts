import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../index";
import { fakeStream } from "../test-support";
import { followClock } from "./follow";
import {
  ANSWERS_PAGE,
  CREDITS_ACME,
  REPORT,
  REPORT_ALL_ZERO,
  REQUEST_ID,
  SCANS_PAGE,
  SCAN_DONE,
  SCAN_FAILED,
  SCAN_ID,
  SCAN_RUNNING,
  SCAN_RUNNING_LATER,
  TOKEN_ENV,
  errorResponse,
  fakeApi,
  jsonResponse,
  sandbox,
  type FakeApi,
  type Sandbox,
} from "./fixtures";
import { isFullScanId, isScanIdPrefix } from "./support";
import {
  ESTIMATE,
  ESTIMATE_FRESH,
  ESTIMATE_SHORT,
  FRESH_QUOTE_TOKEN,
  QUOTE_TOKEN,
  SCAN_CREATED,
  answers,
  fakeClock,
  recordingApi,
  runCli,
  type RecordingApi,
} from "./write-fixtures";

let box: Sandbox;
let slept: number[];
const realSleep = followClock.sleep;

beforeEach(() => {
  box = sandbox();
  slept = [];
  // The follow loop's only wait. Recorded, never waited on.
  followClock.sleep = async (ms) => {
    slept.push(ms);
  };
});

afterEach(() => {
  followClock.sleep = realSleep;
  box.tmp.cleanup();
});

const ESTIMATE_PATH = "/api/v1/workspaces/acme-eu/scans/estimate";
const CREATE_PATH = "/api/v1/workspaces/acme-eu/scans";
const SCAN_PATH = `/api/v1/scans/${SCAN_ID}`;
const REPORT_PATH = `/api/v1/scans/${SCAN_ID}/report`;
const CREDITS_PATH = "/api/v1/credits";
const ORG_ENV = { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" };

/** An API where the estimate and the create both succeed. */
function happyApi(): RecordingApi {
  const api = recordingApi();
  api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE)).on("POST", CREATE_PATH, jsonResponse(201, SCAN_CREATED));
  return api;
}

/** `happyApi` plus everything `--wait` reads once the scan is done. */
function followApi(scans: unknown[] = [SCAN_RUNNING, SCAN_RUNNING_LATER, SCAN_DONE]): RecordingApi {
  const api = happyApi();
  api
    .on(
      "GET",
      SCAN_PATH,
      scans.map((s) => jsonResponse(200, s)),
    )
    .on("GET", REPORT_PATH, jsonResponse(200, REPORT))
    .on("GET", CREDITS_PATH, jsonResponse(200, { ...CREDITS_ACME, balance: 270 }));
  return api;
}

describe("wam scan estimate", () => {
  it("prints the cost, the prompts, the models by display name and the balance, and spends nothing", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE));
    const r = await runCli(box, ["scan", "estimate"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    // One request, the free one. Nothing that could touch a ledger.
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`]);
    expect(api.requests[0]!.body).toEqual({});
    expect(api.requests[0]!.headers["Idempotency-Key"]).toBeUndefined();

    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Scan estimate for acme/acme-eu");
    expect(r.stdout).toContain("  Prompts        6\n");
    expect(r.stdout).toContain("  Repetitions    1\n");
    expect(r.stdout).toContain("  Mode           grounded\n");
    expect(r.stdout).toContain("  Cost           42 credits\n");
    expect(r.stdout).toContain("  Balance        312 credits, 270 after this scan\n");
    // The count is the length of the served array and every name is a served displayName.
    expect(r.stdout).toContain(`  Models         ${ESTIMATE.models.length}   ${ESTIMATE.models[0]!.displayName},`);
    for (const m of ESTIMATE.models) expect(r.stdout).toContain(m.displayName);
    expect(r.stderr).toContain("Run it with:  wam scan run");
  });

  it("the model count and names follow the response, never a constant", async () => {
    const two = { ...ESTIMATE, credits: 12, models: ESTIMATE.models.slice(0, 2) };
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, two));
    const r = await runCli(box, ["scan", "estimate"], { env: ORG_ENV, api });
    expect(r.stdout).toContain(`  Models         2   ${two.models[0]!.displayName}, ${two.models[1]!.displayName}\n`);
    expect(r.stdout).toContain("  Cost           12 credits\n");
    expect(r.stdout).not.toContain(ESTIMATE.models[2]!.displayName);
  });

  it("--json is the estimate body verbatim, quote included", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE));
    const r = await runCli(box, ["scan", "estimate", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(ESTIMATE)}\n`);
    expect(JSON.parse(r.stdout).quote.token).toBe(QUOTE_TOKEN);
    expect(r.stderr).toBe("");
  });

  it("exits 4 when sufficient is false, with the shortfall on stderr and the estimate still on stdout", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE_SHORT));
    const r = await runCli(box, ["scan", "estimate"], { env: ORG_ENV, api });
    expect(r.code).toBe(4);
    expect(r.stdout).toContain("  Balance        11 credits, which does not cover this scan\n");
    expect(r.stderr).toContain("Not enough credits. This scan needs 42 credits and the organization has 11.");
    expect(r.stderr).toContain("Add credits or change plan: https://whereamimentioned.com/acme/billing");
    expect(r.stderr).not.toContain("Run it with");

    const json = await runCli(box, ["scan", "estimate", "--json"], { env: ORG_ENV, api });
    expect(json.code).toBe(4);
    // Still exactly one document: the body, which says `sufficient: false` itself.
    expect(json.stdout).toBe(`${JSON.stringify(ESTIMATE_SHORT)}\n`);
    expect(json.stderr).toContain("Not enough credits.");
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = recordingApi();
    const r = await runCli(box, ["scan", "estimate", "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });

  it("with no workspace resolved: exit 2 and no request", async () => {
    const api = recordingApi();
    const r = await runCli(box, ["scan", "estimate"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No workspace selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam scan run: estimate, then confirm, then create", () => {
  it("always calls estimate before create, even with --yes, and prints the cost before the create", async () => {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`, `POST ${CREATE_PATH}`]);
    expect(r.stderr).toContain("Estimating...");
    expect(r.stderr).toContain("  Workspace   acme/acme-eu");
    expect(r.stderr).toContain("  Cost        42 credits");
    expect(r.stderr).toContain("  Balance     312 now, 270 after");
    for (const m of ESTIMATE.models) expect(r.stderr).toContain(m.displayName);

    expect(r.stdout).toContain(`Scan ${SCAN_ID} queued.`);
    expect(r.stdout).toContain("  Cost      42 credits");
    expect(r.stdout).toContain("  Balance   270 credits after this scan");
    expect(r.stderr).toContain(`Follow it with:  wam scan status ${SCAN_ID} --wait`);
  });

  it("sends the confirmed quote and nothing else in the body: never a mode or a repetitions field", async () => {
    const api = happyApi();
    await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    const create = api.sent("POST", CREATE_PATH)[0]!;
    expect(create.body).toEqual({ quote: QUOTE_TOKEN });
    expect(create.headers["X-Wam-Org"]).toBe("acme");
    for (const request of api.requests) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      expect(body).not.toHaveProperty("mode");
      expect(body).not.toHaveProperty("repetitions");
    }
  });

  it("the cost still reaches stderr under --quiet and under --json, because rule 1 has no exception", async () => {
    const quiet = await runCli(box, ["scan", "run", "--yes", "--quiet"], { env: ORG_ENV, api: happyApi() });
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toContain("  Cost        42 credits");
    expect(quiet.stderr).not.toContain("Estimating...");

    const json = await runCli(box, ["scan", "run", "--yes", "--json"], { env: ORG_ENV, api: happyApi() });
    expect(json.code).toBe(0);
    expect(json.stderr).toContain("  Cost        42 credits");
    // One document on stdout: the 201 body, verbatim.
    expect(json.stdout).toBe(`${JSON.stringify(SCAN_CREATED)}\n`);
  });

  it("--mode and --repetitions are not registered options, and passing one is exit 2 with no request", async () => {
    const program = buildProgram(
      () => {
        throw new Error("no context is needed to inspect the program");
      },
      { stdout: fakeStream(), stderr: fakeStream() },
    );
    const run = program.commands.find((c) => c.name() === "scan")!.commands.find((c) => c.name() === "run")!;
    const longs = run.options.map((o) => o.long);
    expect(longs).not.toContain("--mode");
    expect(longs).not.toContain("--repetitions");
    expect(longs).toEqual(
      expect.arrayContaining(["--wait", "--fail-under", "--timeout", "--poll", "--no-follow", "--idempotency-key"]),
    );

    for (const argv of [
      ["scan", "run", "--mode", "both", "--yes"],
      ["scan", "run", "--repetitions", "3", "--yes"],
    ]) {
      const api = happyApi();
      const r = await runCli(box, argv, { env: ORG_ENV, api });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown option");
      expect(api.calls).toHaveLength(0);
    }
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = happyApi();
    const r = await runCli(box, ["scan", "run", "--yes", "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam scan run: the confirmation", () => {
  it("in a terminal it asks, and y proceeds", async () => {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin: answers(["y"]) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("This spends real credits. Run the scan? (y/N)");
    // The cost was on screen before the question.
    expect(r.stderr.indexOf("  Cost        42 credits")).toBeLessThan(r.stderr.indexOf("This spends real credits."));
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`, `POST ${CREATE_PATH}`]);
  });

  it.each([
    ["an empty answer", [""]],
    ["n", ["n"]],
    ["anything that is not y or yes", ["sure"]],
    ["EOF", []],
  ])("%s cancels with exit 0, the section 8.1 line, and no create call", async (_label, lines) => {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin: answers(lines) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Cancelled. No credits were spent.");
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`]);
    expect(r.stdout).toBe("");
  });

  it("CI=1 without --yes exits 2 with the --yes copy, the credit figure from the estimate, and creates no scan", async () => {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run"], { env: { ...ORG_ENV, CI: "1" }, api, tty: true });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      [
        "This command spends about 42 credits and cannot prompt for confirmation here.",
        "Pass --yes to confirm, or run wam scan estimate to see the cost first.",
      ].join("\n"),
    );
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`]);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(0);
  });

  it("a pipe, --json and --non-interactive all refuse the same way, and the figure is whatever the estimate said", async () => {
    const pricey = { ...ESTIMATE, credits: 96 };
    for (const argv of [["scan", "run"], ["scan", "run", "--json"], ["scan", "run", "--non-interactive"]]) {
      const api = recordingApi();
      api.on("POST", ESTIMATE_PATH, jsonResponse(200, pricey)).on("POST", CREATE_PATH, jsonResponse(201, SCAN_CREATED));
      const r = await runCli(box, argv, { env: ORG_ENV, api, tty: argv.length > 2 });
      expect(r.code).toBe(2);
      expect(`${r.stdout}${r.stderr}`).toContain("This command spends about 96 credits");
      expect(api.sent("POST", CREATE_PATH)).toHaveLength(0);
    }
  });

  it("an answer that arrives after the 300 second quote re-estimates once and re-prompts, and no request carries the expired quote", async () => {
    const clock = fakeClock();
    const api = recordingApi();
    api
      .on("POST", ESTIMATE_PATH, [jsonResponse(200, ESTIMATE), jsonResponse(200, ESTIMATE_FRESH)])
      .on("POST", CREATE_PATH, jsonResponse(201, SCAN_CREATED));
    // The first answer takes 301 seconds. The second is prompt.
    const stdin = answers(["y", "y"], (i) => {
      if (i === 0) clock.advance(301_000);
    });
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin, now: clock.now });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`, `POST ${ESTIMATE_PATH}`, `POST ${CREATE_PATH}`]);
    // Asked twice, and the fresh cost was printed before the second question.
    expect(r.stderr.split("This spends real credits. Run the scan? (y/N)")).toHaveLength(3);
    expect(r.stderr).toContain("That quote expired while it waited for an answer, so nothing was sent.");
    expect(r.stderr).toContain("  Cost        49 credits");
    // The create carries the fresh quote. The expired one was never sent, and neither was "no quote".
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
    expect(api.sent("POST", CREATE_PATH)[0]!.body).toEqual({ quote: FRESH_QUOTE_TOKEN });
    for (const request of api.requests) expect(JSON.stringify(request.body ?? {})).not.toContain(QUOTE_TOKEN);
  });

  it("a prompt answer inside the quote's life sends that quote with no second estimate", async () => {
    const clock = fakeClock();
    const api = happyApi();
    const stdin = answers(["yes"], () => clock.advance(120_000));
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin, now: clock.now });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`POST ${ESTIMATE_PATH}`, `POST ${CREATE_PATH}`]);
    expect(api.sent("POST", CREATE_PATH)[0]!.body).toEqual({ quote: QUOTE_TOKEN });
  });

  it("a second late answer stops the command: it re-estimates once, never in a loop, and starts nothing", async () => {
    const clock = fakeClock();
    const api = recordingApi();
    api
      .on("POST", ESTIMATE_PATH, [jsonResponse(200, ESTIMATE), jsonResponse(200, ESTIMATE_FRESH)])
      .on("POST", CREATE_PATH, jsonResponse(201, SCAN_CREATED));
    const stdin = answers(["y", "y"], () => clock.advance(900_000));
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin, now: clock.now });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The quote expired again before it was confirmed, so no scan was started and no credits were spent.");
    expect(api.sent("POST", ESTIMATE_PATH)).toHaveLength(2);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(0);
  });

  it("saying no to the second question also cancels with exit 0 and no create", async () => {
    const clock = fakeClock();
    const api = recordingApi();
    api
      .on("POST", ESTIMATE_PATH, [jsonResponse(200, ESTIMATE), jsonResponse(200, ESTIMATE_FRESH)])
      .on("POST", CREATE_PATH, jsonResponse(201, SCAN_CREATED));
    const stdin = answers(["y", "n"], (i) => {
      if (i === 0) clock.advance(301_000);
    });
    const r = await runCli(box, ["scan", "run"], { env: ORG_ENV, api, tty: true, stdin, now: clock.now });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Cancelled. No credits were spent.");
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(0);
  });
});

describe("wam scan run: the Idempotency-Key", () => {
  async function keyOf(env: Record<string, string>, extraArgs: string[] = []): Promise<string> {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run", "--yes", ...extraArgs], { env: { ...ORG_ENV, ...env }, api });
    expect(r.code).toBe(0);
    return api.sent("POST", CREATE_PATH)[0]!.headers["Idempotency-Key"]!;
  }

  it("is stable across two runs with the same GITHUB_RUN_ID and differs across runs", async () => {
    const first = await keyOf({ GITHUB_RUN_ID: "9001" });
    const retry = await keyOf({ GITHUB_RUN_ID: "9001" });
    const next = await keyOf({ GITHUB_RUN_ID: "9002" });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it("reads CI_PIPELINE_ID and CI_JOB_ID when GITHUB_RUN_ID is absent, and is random with none of them", async () => {
    expect(await keyOf({ CI_PIPELINE_ID: "77" })).toBe(await keyOf({ CI_PIPELINE_ID: "77" }));
    // GitLab: a retried job keeps the pipeline id and gets a new job id, and must follow the same scan.
    expect(await keyOf({ CI_PIPELINE_ID: "77", CI_JOB_ID: "1" })).toBe(await keyOf({ CI_PIPELINE_ID: "77", CI_JOB_ID: "2" }));
    expect(await keyOf({ CI_JOB_ID: "5" })).toBe(await keyOf({ CI_JOB_ID: "5" }));
    expect(await keyOf({})).not.toBe(await keyOf({}));
  });

  it("depends on the workspace", async () => {
    const api = recordingApi();
    api
      .on("POST", "/api/v1/workspaces/acme-us/scans/estimate", jsonResponse(200, ESTIMATE))
      .on("POST", "/api/v1/workspaces/acme-us/scans", jsonResponse(201, SCAN_CREATED));
    await runCli(box, ["scan", "run", "--yes", "--workspace", "acme-us"], { env: { ...ORG_ENV, GITHUB_RUN_ID: "9001" }, api });
    const other = api.sent("POST", "/api/v1/workspaces/acme-us/scans")[0]!.headers["Idempotency-Key"];
    expect(other).not.toBe(await keyOf({ GITHUB_RUN_ID: "9001" }));
  });

  it("the estimate never carries the header, and --idempotency-key overrides the derivation", async () => {
    const api = happyApi();
    await runCli(box, ["scan", "run", "--yes", "--idempotency-key", "release-2026.09:1"], { env: ORG_ENV, api });
    expect(api.sent("POST", ESTIMATE_PATH)[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(api.sent("POST", CREATE_PATH)[0]!.headers["Idempotency-Key"]).toBe("release-2026.09:1");
  });

  it("a malformed --idempotency-key is exit 2 with the section 9 copy and no request at all", async () => {
    const api = happyApi();
    const r = await runCli(box, ["scan", "run", "--yes", "--idempotency-key", "has space"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -.\n");
    expect(api.calls).toHaveLength(0);
  });

  it("a 422 naming the header maps to the same copy and exit 2", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE)).on(
      "POST",
      CREATE_PATH,
      errorResponse(422, "validation_failed", "Invalid Idempotency-Key header.", {
        issues: [{ path: ["Idempotency-Key"], message: "Invalid" }],
      }),
    );
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--idempotency-key must be 1 to 128 characters from A-Z a-z 0-9 _ . : and -.");
  });

  it("a replay (200 with X-Idempotent-Replay) returns the same scan and says so, instead of reporting a new one", async () => {
    const api = recordingApi();
    api
      .on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE))
      .on("POST", CREATE_PATH, [jsonResponse(201, SCAN_CREATED), jsonResponse(200, SCAN_CREATED, { "X-Idempotent-Replay": "true" })]);
    const env = { ...ORG_ENV, GITHUB_RUN_ID: "9001" };

    const first = await runCli(box, ["scan", "run", "--yes", "--json"], { env, api });
    const second = await runCli(box, ["scan", "run", "--yes", "--json"], { env, api });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stderr).not.toContain("already exists");
    expect(second.stderr).toContain(`A scan for this run already exists (${SCAN_ID}). Returning it instead of starting a second one.`);
    expect(JSON.parse(second.stdout).id).toBe(JSON.parse(first.stdout).id);
    const [a, b] = api.sent("POST", CREATE_PATH);
    expect(a!.headers["Idempotency-Key"]).toBe(b!.headers["Idempotency-Key"]);
    // Not followed: a command that did not ask to wait does not start waiting on a replay.
    expect(api.calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("a replay under --wait prints the exact section 7.3 line and follows the original", async () => {
    const api = followApi([SCAN_RUNNING, SCAN_DONE]);
    api.on("POST", CREATE_PATH, jsonResponse(200, SCAN_CREATED, { "X-Idempotent-Replay": "true" }));
    const r = await runCli(box, ["scan", "run", "--yes", "--wait"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`A scan for this run already exists (${SCAN_ID}). Following it instead of starting a second one.`);
    expect(api.sent("GET", SCAN_PATH)).toHaveLength(2);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
  });
});

describe("wam scan run: what the create can answer", () => {
  function refusing(response: Response): RecordingApi {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE)).on("POST", CREATE_PATH, response);
    return api;
  }

  it("402 is exit 4 with the section 8.2 copy taken from details, and nothing is retried", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE_SHORT)).on(
      "POST",
      CREATE_PATH,
      errorResponse(402, "insufficient_credits", "This scan needs 42 credits and the organization has 11.", {
        // Deliberately not the estimate's numbers: the copy must come from details, not be recomputed.
        required: 43,
        available: 9,
        billingUrl: "https://whereamimentioned.com/acme/billing",
      }),
    );
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("  Balance     11 now, which does not cover this scan");
    expect(r.stderr).toContain("Not enough credits. This scan needs 43 credits and the organization has 9.");
    expect(r.stderr).toContain(`Add credits or change plan: https://whereamimentioned.com/acme/billing (request ${REQUEST_ID})`);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
    expect(r.stdout).toBe("");
  });

  it("409 scan_already_running follows the running scan by default and exits 0", async () => {
    const api = followApi([SCAN_RUNNING, SCAN_DONE]);
    api.on(
      "POST",
      CREATE_PATH,
      errorResponse(409, "scan_already_running", "A scan is already running for this workspace.", {
        scanId: SCAN_ID,
        pollUrl: SCAN_PATH,
      }),
    );
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`A scan is already running for this workspace (${SCAN_ID}). Following it instead.`);
    expect(api.sent("GET", SCAN_PATH)).toHaveLength(2);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
    expect(r.stdout).toContain("AI visibility score");
  });

  it("409 scan_already_running with --no-follow is exit 8 with the section 9 copy, and nothing is polled", async () => {
    const api = followApi();
    api.on(
      "POST",
      CREATE_PATH,
      errorResponse(409, "scan_already_running", "A scan is already running for this workspace.", {
        scanId: SCAN_ID,
        pollUrl: SCAN_PATH,
      }),
    );
    const r = await runCli(box, ["scan", "run", "--yes", "--no-follow"], { env: ORG_ENV, api });
    expect(r.code).toBe(8);
    expect(r.stderr).toContain(`A scan is already running for this workspace (${SCAN_ID}).`);
    expect(r.stderr).toContain(`Pass no flag, or use wam scan status ${SCAN_ID}, to follow it.`);
    expect(api.calls.some((c) => c.method === "GET")).toBe(false);
  });

  it.each([[["scan", "run", "--yes"]], [["scan", "run", "--yes", "--no-follow"]], [["scan", "run", "--yes", "--wait"]]])(
    "409 conflict (the priced terms moved) is exit 9 on every path and never reads details.scanId: %j",
    async (argv) => {
      // A scanId is planted in the details. A client branching on the 409 would follow it.
      const api = followApi();
      api.on(
        "POST",
        CREATE_PATH,
        errorResponse(409, "conflict", "The quote no longer matches.", { fields: ["models", "prompts"], scanId: SCAN_ID }),
      );
      const r = await runCli(box, argv, { env: ORG_ENV, api });
      expect(r.code).toBe(9);
      expect(r.stderr).toContain("The scan the server priced is no longer the scan it would run.");
      expect(r.stderr).toContain("The fields that changed: models, prompts.");
      expect(r.stderr).toContain("Run wam scan estimate again, then wam scan run.");
      expect(r.stderr).not.toContain("Following it");
      expect(api.calls.some((c) => c.method === "GET")).toBe(false);
      expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
      // It does not quietly re-price and try again either.
      expect(api.sent("POST", ESTIMATE_PATH)).toHaveLength(1);
    },
  );

  it("409 conflict for a reused idempotency key is exit 9 with the other section 9 row", async () => {
    const original = "b21a77c0-1111-4222-8333-444455556666";
    const api = refusing(
      errorResponse(409, "conflict", "Idempotency-Key reuse.", { originalScanId: original, fields: ["models"] }),
    );
    const r = await runCli(box, ["scan", "run", "--yes", "--idempotency-key", "k1"], { env: ORG_ENV, api });
    expect(r.code).toBe(9);
    expect(r.stderr).toContain(`That idempotency key was already used for a different scan (${original}).`);
    expect(r.stderr).toContain(`Use a different --idempotency-key, or follow the original: wam scan status ${original}`);
    expect(api.calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("429 is exit 5 and the create is never retried", async () => {
    const api = refusing(
      errorResponse(429, "rate_limited", "Too many requests.", { retryAfterSeconds: 42 }, { "Retry-After": "42", "X-RateLimit-Limit": "3" }),
    );
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("Rate limited. Try again in 42 seconds.");
    expect(r.stderr).toContain("Limit: 3 requests per window for this key.");
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
  });

  it("a 500 on the create is exit 1 after exactly one create request", async () => {
    const api = refusing(errorResponse(500, "internal_error", "boom"));
    const r = await runCli(box, ["scan", "run", "--yes", "--wait"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`The server returned an unexpected error (request ${REQUEST_ID}).`);
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
    expect(api.calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("403 insufficient_role names the action, exit 3", async () => {
    const api = refusing(
      errorResponse(403, "insufficient_role", "Role too low.", { effectiveRole: "viewer", requiredRole: "member" }),
    );
    const r = await runCli(box, ["scan", "run", "--yes"], { env: ORG_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Your role in this organization (viewer) is not high enough to run a scan. Member or above is required.");
  });
});

describe("wam scan run --wait", () => {
  it("follows to the end and prints the result, with model names from the report and no percentage", async () => {
    const api = followApi();
    const r = await runCli(box, ["scan", "run", "--yes", "--wait", "--poll", "1"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([
      `POST ${ESTIMATE_PATH}`,
      `POST ${CREATE_PATH}`,
      `GET ${SCAN_PATH}`,
      `GET ${SCAN_PATH}`,
      `GET ${SCAN_PATH}`,
      `GET ${REPORT_PATH}`,
      `GET ${CREDITS_PATH}`,
    ]);
    expect(api.sent("GET", REPORT_PATH)[0]!.query).toEqual({ format: "json" });
    expect(slept).toEqual([5000, 5000]);

    // While totalIsFinal is false: raw counts and the note, never a proportion.
    expect(r.stderr).toContain("running  25 of 42 answers  (total may still grow)");
    expect(r.stderr).toContain("running  40 of 48 answers  (total may still grow)");
    // Every progress tick is on stderr, and none of them draws a proportion.
    expect(r.stderr).not.toContain("%");

    expect(r.stdout).toContain("42 credits spent, 270 remaining.");
    expect(r.stdout).toContain(`  AI visibility score   ${REPORT.score}`);
    expect(r.stdout).toContain("  Presence rate         58%   (95% CI 41% to 74%)");
    expect(r.stdout).toContain("  Share of voice        22%");
    expect(r.stdout).toContain("  Brand citation share  14%");
    for (const m of REPORT.perModel) expect(r.stdout).toContain(m.model);
    expect(r.stderr).toContain(`Full report:  wam report get --scan ${SCAN_ID}`);
  });

  it("--json is NDJSON with exactly one terminal result object, composed from the three reads", async () => {
    const api = followApi();
    const r = await runCli(box, ["scan", "run", "--yes", "--wait", "--json"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    const objects = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(objects.map((o) => o.type)).toEqual(["progress", "progress", "result"]);
    expect(objects.filter((o) => o.type === "result" || o.type === "error")).toHaveLength(1);
    expect(objects[0].progress.totalIsFinal).toBe(false);
    for (const o of objects.slice(0, 2)) expect(JSON.stringify(o)).not.toContain("percent");

    const result = objects[2];
    expect(result).toEqual({
      type: "result",
      id: SCAN_ID,
      status: "done",
      creditsSpent: SCAN_DONE.creditsSpent,
      balance: 270,
      score: REPORT.score,
      presenceRate: REPORT.presenceRate,
      sov: REPORT.sov,
      brandCitationShare: REPORT.brandCitationShare,
      perModel: REPORT.perModel,
      durationMs: 0,
    });
  });

  it("--fail-under 99 exits 7 after printing the result, implies --wait, and never starts another scan", async () => {
    const api = followApi([SCAN_DONE]);
    const r = await runCli(box, ["scan", "run", "--yes", "--fail-under", "99", "--json"], { env: ORG_ENV, api });

    expect(r.code).toBe(7);
    const objects = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    // The result is still the one terminal stdout object. The gate is on stderr (section 7.4).
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("result");
    expect(objects[0].score).toBe(REPORT.score);
    expect(r.stderr).toContain(`AI visibility score ${REPORT.score} is below the threshold of 99.`);
    expect(r.stdout).not.toContain("threshold");
    expect(api.sent("POST", CREATE_PATH)).toHaveLength(1);
    expect(api.sent("POST", ESTIMATE_PATH)).toHaveLength(1);
  });

  it("--fail-under at or below the score exits 0, and the human run prints the gate after the result", async () => {
    const met = await runCli(box, ["scan", "run", "--yes", "--fail-under", String(REPORT.score)], { env: ORG_ENV, api: followApi([SCAN_DONE]) });
    expect(met.code).toBe(0);
    expect(met.stderr).not.toContain("below the threshold");

    const missed = await runCli(box, ["scan", "run", "--yes", "--fail-under", "99"], { env: ORG_ENV, api: followApi([SCAN_DONE]) });
    expect(missed.code).toBe(7);
    expect(missed.stdout).toContain("AI visibility score");
    expect(missed.stderr).toContain("is below the threshold of 99.");
  });

  it("a bad --fail-under is exit 2 before any request", async () => {
    const api = followApi();
    const r = await runCli(box, ["scan", "run", "--yes", "--fail-under", "101"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("a scan that ends failed is exit 6 with the section 9 copy, and the report is not fetched", async () => {
    const api = followApi([SCAN_RUNNING, SCAN_FAILED]);
    const r = await runCli(box, ["scan", "run", "--yes", "--wait"], { env: ORG_ENV, api });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain(`Scan ${SCAN_ID} failed: extraction returned no usable answers.`);
    expect(r.stderr).toContain("Reserved credits have been refunded.");
    expect(api.sent("GET", REPORT_PATH)).toHaveLength(0);

    const json = await runCli(box, ["scan", "run", "--yes", "--wait", "--json"], { env: ORG_ENV, api: followApi([SCAN_FAILED]) });
    expect(json.code).toBe(6);
    const objects = json.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "error", ok: false, exitCode: 6, error: { code: "scan_failed" } });
  });

  it("--timeout leaves the scan running and exits 1 with the scan id", async () => {
    const api = followApi([SCAN_RUNNING]);
    const r = await runCli(box, ["scan", "run", "--yes", "--wait", "--timeout", "120", "--poll", "60"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(slept).toEqual([60000, 60000]);
    expect(r.stderr).toContain("Stopped following after 2 minutes. The scan is still running on the server.");
    expect(r.stderr).toContain(`Check on it later: wam scan status ${SCAN_ID}`);
    // Nothing cancels the scan, and nothing starts another.
    expect(api.calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([ESTIMATE_PATH, CREATE_PATH]);
  });

  it("under --wait --json every failure is the one typed terminal object, a 402 included", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE)).on(
      "POST",
      CREATE_PATH,
      errorResponse(402, "insufficient_credits", "Short.", { required: 42, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" }),
    );
    const r = await runCli(box, ["scan", "run", "--yes", "--wait", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(4);
    const objects = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      type: "error",
      ok: false,
      exitCode: 4,
      error: { code: "insufficient_credits", requestId: REQUEST_ID, details: { required: 42, available: 11 } },
    });
  });

  it("without --wait the --json error is the plain section 6.2 object", async () => {
    const api = recordingApi();
    api.on("POST", ESTIMATE_PATH, jsonResponse(200, ESTIMATE)).on(
      "POST",
      CREATE_PATH,
      errorResponse(402, "insufficient_credits", "Short.", { required: 42, available: 11, billingUrl: "https://whereamimentioned.com/acme/billing" }),
    );
    const r = await runCli(box, ["scan", "run", "--yes", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(4);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, exitCode: 4, error: { code: "insufficient_credits" } });
    expect(doc.type).toBeUndefined();
  });

  it("an all-zero result with answers collected warns on stderr instead of passing as a low score", async () => {
    const api = followApi([{ ...SCAN_DONE, score: 0 }]);
    api.on("GET", REPORT_PATH, jsonResponse(200, REPORT_ALL_ZERO));
    const r = await runCli(box, ["scan", "run", "--yes", "--wait", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Warning: this scan scored 0 across 48 answers.");
    expect(r.stderr).toContain(`https://whereamimentioned.com/acme/acme-eu/scans/${SCAN_ID}`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!).type).toBe("result");
  });

  it("a failUnder from config gates a followed run and never makes a run wait on its own", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(box.cwd, "wam.json"), JSON.stringify({ org: "acme", workspace: "acme-eu", failUnder: 99 }));

    const fire = happyApi();
    const noWait = await runCli(box, ["scan", "run", "--yes"], { env: TOKEN_ENV, api: fire });
    expect(noWait.code).toBe(0);
    expect(fire.calls.some((c) => c.method === "GET")).toBe(false);

    const waited = await runCli(box, ["scan", "run", "--yes", "--wait"], { env: TOKEN_ENV, api: followApi([SCAN_DONE]) });
    expect(waited.code).toBe(7);
    expect(waited.stderr).toContain("is below the threshold of 99.");
  });

  it("the help of estimate and run ends with a copy-pasteable example", async () => {
    const estimate = await runCli(box, ["scan", "estimate", "--help"]);
    expect(estimate.stdout.trimEnd().split("\n").pop()).toBe("  $ wam scan estimate --workspace acme-eu");
    const run = await runCli(box, ["scan", "run", "--help"]);
    expect(run.stdout.trimEnd().split("\n").pop()).toBe("  $ wam scan run --wait --fail-under 55 --yes");
  });
});

// --- Scan id prefixes ----------------------------------------------------------------------------
//
// The ID column of `wam scan list` prints the first eight characters of an id, so every command that
// takes a scan id accepts an unambiguous prefix and resolves it client side against the workspace's
// scan list. The server only ever sees a full id.

describe("isFullScanId and isScanIdPrefix", () => {
  it("a full id is 8-4-4-4-12 hex in either case; a prefix is any start of that shape", () => {
    expect(isFullScanId(SCAN_ID)).toBe(true);
    expect(isFullScanId(SCAN_ID.toUpperCase())).toBe(true);
    expect(isFullScanId(SCAN_ID.slice(0, 35))).toBe(false);
    expect(isFullScanId(`${SCAN_ID}0`)).toBe(false);

    expect(isScanIdPrefix("3")).toBe(true);
    expect(isScanIdPrefix("3f9c1e42")).toBe(true);
    expect(isScanIdPrefix("3F9C1E42-08A1-4")).toBe(true);
    expect(isScanIdPrefix(SCAN_ID)).toBe(true);
    expect(isScanIdPrefix("")).toBe(false);
    expect(isScanIdPrefix(`${SCAN_ID}0`)).toBe(false);
    expect(isScanIdPrefix("3f9c1e42x")).toBe(false);
    expect(isScanIdPrefix("3f9c1e4208a1")).toBe(false); // hex where the dash belongs
    expect(isScanIdPrefix("3f9c1e42-0-")).toBe(false); // a dash where hex belongs
  });
});

describe("a scan id prefix, as the ID column of wam scan list prints it", () => {
  const SCANS_PATH = "/api/v1/workspaces/acme-eu/scans";
  const ANSWERS_PATH = `${SCAN_PATH}/answers`;
  const short = SCAN_ID.slice(0, 8);
  /** A second scan sharing the first eight characters of SCAN_ID, so `short` alone is ambiguous. */
  const TWIN_ID = `${short}-ffff-4fff-8fff-ffffffffffff`;
  const TWIN = { ...SCANS_PAGE.data[0]!, id: TWIN_ID, status: "failed" as const, createdAt: "2026-08-29T10:00:00.000Z" };

  function listApi(scans = SCANS_PAGE.data): FakeApi {
    return fakeApi().on("GET", SCANS_PATH, jsonResponse(200, { ...SCANS_PAGE, data: scans }));
  }

  it("scan status resolves an 8-character prefix through the workspace's scan list and reads the full id", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", short], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`]);
    // The lookup pages at the contract's ceiling and filters nothing: a prefix may name any scan.
    expect(api.calls[0]!.query).toEqual({ limit: "100" });
    expect(r.stdout.split("\n")[0]).toBe(`Scan ${SCAN_ID}   acme/acme-eu`);
  });

  it("a full id is sent as typed and costs no lookup", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", SCAN_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCAN_PATH}`]);
  });

  it("matches case-insensitively, and a longer prefix with dashes is fine", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", SCAN_ID.slice(0, 13).toUpperCase()], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`]);
  });

  it("under --json stdout stays the one GET /api/v1/scans/{scanId} body, lookup or not", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", short, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(SCAN_RUNNING)}\n`);
  });

  it("scan watch follows the resolved id", async () => {
    const api = listApi().on("GET", SCAN_PATH, [jsonResponse(200, SCAN_RUNNING), jsonResponse(200, SCAN_DONE)]);
    const r = await box.run(["scan", "watch", short, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`, `GET ${SCAN_PATH}`]);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["progress", "result"]);
  });

  it("scan evidence resolves the prefix before reading the scan and its answers", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE)).on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE));
    const r = await box.run(["scan", "evidence", short], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`, `GET ${ANSWERS_PATH}`]);
    expect(r.stdout.split("\n")[0]).toBe(`Scan ${short}  acme/acme-eu  (48 answers, showing 2)`);
  });

  it("the lookup follows nextCursor to later pages", async () => {
    const api = fakeApi()
      .on("GET", SCANS_PATH, (c) =>
        c.query.cursor === undefined
          ? jsonResponse(200, { data: [SCANS_PAGE.data[1]!], pagination: { nextCursor: "page-two", hasMore: true, limit: 100 } })
          : jsonResponse(200, { data: [SCANS_PAGE.data[0]!], pagination: { nextCursor: null, hasMore: false, limit: 100 } }),
      )
      .on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", short], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`]);
    expect(api.calls[1]!.query).toEqual({ limit: "100", cursor: "page-two" });
  });

  it("a prefix several scans share is a usage error (exit 2) that lists them, and reads no scan", async () => {
    const api = listApi([SCANS_PAGE.data[0]!, TWIN]).on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", short], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        `${short} matches 2 scans in workspace acme-eu:`,
        `  ${SCAN_ID}  done    2026-08-28T09:14:02.000Z`,
        `  ${TWIN_ID}  failed  2026-08-29T10:00:00.000Z`,
        "Pass more of the id, or the full one.",
        "",
      ].join("\n"),
    );
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`]);

    // Enough of the id to tell them apart resolves.
    const again = listApi([SCANS_PAGE.data[0]!, TWIN]).on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const ok = await box.run(["scan", "status", `${short}-0`], { env: ORG_ENV, api: again });
    expect(ok.code).toBe(0);
    expect(again.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${SCAN_PATH}`]);
  });

  it("under --json the ambiguity is the section 6.2 error object, carrying the candidates", async () => {
    const api = listApi([SCANS_PAGE.data[0]!, TWIN]);
    const r = await box.run(["scan", "status", short, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "usage_error", details: { prefix: short, workspace: "acme-eu", candidates: [SCAN_ID, TWIN_ID] } },
    });
  });

  it("a prefix no scan starts with is exit 1, with copy that says a prefix is accepted, and reads no scan", async () => {
    const api = listApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", "0000"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      [
        "No scan in workspace acme-eu of organization acme has an id starting with 0000, or this key cannot see one.",
        "Check the id against: wam scan list. A full id or an unambiguous prefix of one is accepted.",
        "",
      ].join("\n"),
    );
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`]);
  });

  it("something that cannot begin a scan id is a usage error before any request", async () => {
    for (const bad of ["foo", "3f9c1e42x", "3f9c1e42_08a1", "3f9c1e4208a1"]) {
      const api = listApi();
      const r = await box.run(["scan", "evidence", bad], { env: ORG_ENV, api });
      expect(r.code, bad).toBe(2);
      expect(r.stderr, bad).toContain(`"${bad}" is not a scan id or the start of one.`);
      expect(api.calls, bad).toHaveLength(0);
    }
  });

  it("a prefix with no workspace resolved is exit 2 naming the way around it, and makes no request", async () => {
    const api = listApi();
    const r = await box.run(["scan", "status", short], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("but no workspace is selected.");
    expect(r.stderr).toContain("or pass the full id.");
    expect(api.calls).toHaveLength(0);

    // A full id never needed a workspace, and still does not.
    const full = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const ok = await box.run(["scan", "status", SCAN_ID], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api: full });
    expect(ok.code).toBe(0);
  });

  it("the help of every id-taking command says a prefix is accepted", async () => {
    for (const argv of [["scan", "status"], ["scan", "watch"], ["scan", "evidence"]]) {
      const r = await box.run([...argv, "--help"]);
      expect(r.stdout, argv.join(" ")).toContain("<scanId> is the full id, or an unambiguous prefix of it");
    }
  });
});
