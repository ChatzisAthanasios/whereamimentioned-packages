import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANSWER_CITATIONS_MAX, ANSWER_TEXT_MAX_CHARS, SCAN_STATUSES } from "@whereamimentioned/api-client";
import { followClock } from "./follow";
import {
  ANSWERS_PAGE,
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
  type Sandbox,
} from "./fixtures";

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

const SCAN_PATH = `/api/v1/scans/${SCAN_ID}`;
const ORG_ENV = { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" };

describe("wam scan status", () => {
  it("prints the section 3.5 block: raw counts, the may-still-grow note, and no percentage", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual([`GET ${SCAN_PATH}`]);
    expect(r.stdout).toBe(
      [
        `Scan ${SCAN_ID}   acme/acme-eu`,
        "",
        "  Status        running",
        "  Progress      25 of 42 answers  (total may still grow)",
        "  Mode          grounded, 1 repetition",
        "  Reserved      42 credits",
        "  Started       2026-09-10T11:57:48.000Z  (2m 12s ago)",
        "",
      ].join("\n"),
    );
    expect(r.stdout).not.toContain("%");
  });

  it("a finished scan drops the note and adds what it spent and scored", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE));
    const r = await box.run(["scan", "status", SCAN_ID], { env: ORG_ENV, api });
    expect(r.stdout).toContain("  Progress      48 of 48 answers\n");
    expect(r.stdout).not.toContain("may still grow");
    expect(r.stdout).toContain("  Spent         42 credits");
    expect(r.stdout).toContain("  Score         61 / 100");
    expect(r.stdout).not.toContain("%");
  });

  it("--json is the GET /api/v1/scans/{scanId} body verbatim, totalIsFinal false mid-scan", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(SCAN_RUNNING)}\n`);
    expect(JSON.parse(r.stdout).progress.totalIsFinal).toBe(false);
  });

  it("without --wait a failed scan is reported, not an exit 6", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_FAILED));
    const r = await box.run(["scan", "status", SCAN_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("  Status        failed");
    expect(r.stdout).toContain("  Error         extraction returned no usable answers.");
  });

  it("a finished scan that scored 0 with answers collected warns on stderr, and stdout stays the data", async () => {
    const zero = { ...SCAN_DONE, score: 0 };
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, zero));
    const r = await box.run(["scan", "status", SCAN_ID, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(zero)}\n`);
    expect(r.stderr).toContain("Warning: this scan scored 0 across 48 answers.");
    expect(r.stderr).toContain(`https://whereamimentioned.com/acme/acme-eu/scans/${SCAN_ID}`);
  });

  it("a scan of another org, or a mistyped id, is exit 1 naming the scan (the org and workspace resolved fine)", async () => {
    await box.storeCredential("org", "northwind");
    const api = fakeApi().on("GET", SCAN_PATH, errorResponse(404, "not_found", "Scan not found."));
    const r = await box.run(["scan", "status", SCAN_ID, "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Scan ${SCAN_ID} was not found in organization northwind, or this key cannot see it.`);
    expect(r.stderr).toContain("Check the id against: wam scan list");
    expect(r.stderr).not.toContain("Workspace acme-eu was not found");
  });

  it("on an account-wide key with no org resolved: exit 2 locally and no request", async () => {
    await box.storeCredential("user", null);
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID], { api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No organization selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam scan status --wait", () => {
  it("polls at max(--poll, 5) seconds and prints one line per tick on stderr, then the block on stdout", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [
      jsonResponse(200, SCAN_RUNNING),
      jsonResponse(200, SCAN_RUNNING_LATER),
      jsonResponse(200, SCAN_DONE),
    ]);
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--poll", "1"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(3);
    // --poll 1 is floored at 5 seconds.
    expect(slept).toEqual([5000, 5000]);
    expect(r.stderr).toBe(
      ["running  25 of 42 answers  (total may still grow)", "running  40 of 48 answers  (total may still grow)", ""].join("\n"),
    );
    expect(r.stderr).not.toContain("%");
    expect(r.stdout).toContain("  Status        done");
    expect(r.stdout).toContain("  Progress      48 of 48 answers");
  });

  it("defaults to a 10 second poll", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [jsonResponse(200, SCAN_RUNNING), jsonResponse(200, SCAN_DONE)]);
    await box.run(["scan", "status", SCAN_ID, "--wait"], { env: ORG_ENV, api });
    expect(slept).toEqual([10000]);
  });

  it("--json is NDJSON: progress objects, then exactly one terminal result", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [
      jsonResponse(200, SCAN_RUNNING),
      jsonResponse(200, SCAN_RUNNING_LATER),
      jsonResponse(200, SCAN_DONE),
    ]);
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--json"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const objects = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(objects.map((o) => o.type)).toEqual(["progress", "progress", "result"]);
    expect(objects[0]).toEqual({ type: "progress", ...SCAN_RUNNING });
    expect(objects[0].progress.totalIsFinal).toBe(false);
    expect(objects[2]).toEqual({ type: "result", ...SCAN_DONE });
    expect(objects.filter((o) => o.type === "result" || o.type === "error")).toHaveLength(1);
  });

  it("wam scan watch is the alias of status --wait", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [jsonResponse(200, SCAN_RUNNING), jsonResponse(200, SCAN_DONE)]);
    const r = await box.run(["scan", "watch", SCAN_ID, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["progress", "result"]);
  });

  it("the follow timeout is exit 1 with the section 9 copy, and the scan is left running", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--timeout", "120", "--poll", "60"], { env: ORG_ENV, api });

    expect(r.code).toBe(1);
    expect(slept).toEqual([60000, 60000]);
    // Only GETs: nothing cancels or touches the scan.
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
    expect(r.stderr).toContain(
      ["Stopped following after 2 minutes. The scan is still running on the server.", `Check on it later: wam scan status ${SCAN_ID}`].join("\n"),
    );
    expect(r.stdout).toBe("");
  });

  it("the default follow timeout is 30 minutes", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--quiet"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(slept).toHaveLength(180);
    expect(r.stderr).toBe(
      `Stopped following after 30 minutes. The scan is still running on the server.\nCheck on it later: wam scan status ${SCAN_ID}\n`,
    );
  });

  it("under --json the timeout is the one terminal error object, with exit 1", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_RUNNING));
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--json", "--timeout", "60", "--poll", "60"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    const objects = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(objects.map((o) => o.type)).toEqual(["progress", "progress", "error"]);
    expect(objects[2]).toMatchObject({ type: "error", ok: false, exitCode: 1, error: { code: "timed_out" } });
  });

  it("a scan that fails while followed is exit 6 with the scan-failed copy", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [jsonResponse(200, SCAN_RUNNING), jsonResponse(200, SCAN_FAILED)]);
    const r = await box.run(["scan", "status", SCAN_ID, "--wait"], { env: ORG_ENV, api });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain(
      [
        `Scan ${SCAN_ID} failed: extraction returned no usable answers.`,
        `Reserved credits have been refunded. See https://whereamimentioned.com/acme/acme-eu/scans/${SCAN_ID}`,
      ].join("\n"),
    );

    const again = fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_FAILED));
    const j = await box.run(["scan", "status", SCAN_ID, "--wait", "--json"], { env: ORG_ENV, api: again });
    expect(j.code).toBe(6);
    const objects = j.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "error", exitCode: 6, error: { code: "scan_failed" } });
  });

  it("a 429 while following is exit 5 and is never retried", async () => {
    const api = fakeApi().on("GET", SCAN_PATH, [
      jsonResponse(200, SCAN_RUNNING),
      errorResponse(429, "rate_limited", "Too many requests.", { retryAfterSeconds: 42 }, { "Retry-After": "42", "X-RateLimit-Limit": "120" }),
    ]);
    const r = await box.run(["scan", "status", SCAN_ID, "--wait"], { env: ORG_ENV, api });
    expect(r.code).toBe(5);
    expect(api.calls).toHaveLength(2);
    expect(r.stderr).toContain("Rate limited. Try again in 42 seconds.");
    expect(r.stderr).toContain(`Limit: 120 requests per window for this key. (request ${REQUEST_ID})`);
  });

  it("a bad --poll is a usage error", async () => {
    const r = await box.run(["scan", "status", SCAN_ID, "--wait", "--poll", "soon"], { env: ORG_ENV, api: fakeApi() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--poll must be a whole number of seconds, 1 or more.\n");
  });
});

describe("wam scan list", () => {
  it("renders the section 3.5 table", async () => {
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu/scans", jsonResponse(200, SCANS_PAGE));
    const r = await box.run(["scan", "list"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "DATE              ID        STATUS  MODE      PROMPTS  MODELS  CREDITS  SCORE",
        "2026-08-28 09:14  3f9c1e42  done    grounded        6       7       42     61",
        "2026-08-07 08:03  b21a77c0  failed  grounded        6       7        0      -",
        "",
      ].join("\n"),
    );
    expect(api.calls[0]!.headers["X-Wam-Org"]).toBe("acme");
  });

  it("passes every filter straight through as a query parameter", async () => {
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu/scans", jsonResponse(200, SCANS_PAGE));
    const r = await box.run(
      ["scan", "list", "--limit", "5", "--cursor", "abc", "--status", "done", "--from", "2026-08-01", "--to", "2026-08-31"],
      { env: ORG_ENV, api },
    );
    expect(r.code).toBe(0);
    expect(api.calls[0]!.query).toEqual({ limit: "5", cursor: "abc", status: "done", from: "2026-08-01", to: "2026-08-31" });
    // The page is printed as served: the failed row is still there under --status done, because
    // filtering is the server's job and this fake did none.
    expect(r.stdout).toContain("failed");
  });

  it("--json is the envelope unchanged", async () => {
    const api = fakeApi().on("GET", "/api/v1/workspaces/acme-eu/scans", jsonResponse(200, SCANS_PAGE));
    const r = await box.run(["scan", "list", "--json"], { env: ORG_ENV, api });
    expect(r.stdout).toBe(`${JSON.stringify(SCANS_PAGE)}\n`);
  });

  it("no workspace resolved is exit 2 with the section 9 copy, and no request", async () => {
    const api = fakeApi();
    const r = await box.run(["scan", "list"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      "No workspace selected.\nPass --workspace <slug>, set WAM_WORKSPACE, or run wam workspace use acme/acme-eu\n",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("an unknown --status is a usage error naming the contract's values", async () => {
    const r = await box.run(["scan", "list", "--status", "finished"], { env: ORG_ENV, api: fakeApi() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(`--status must be one of: ${SCAN_STATUSES.join(", ")}.\n`);
  });
});

describe("wam scan evidence", () => {
  const ANSWERS_PATH = `${SCAN_PATH}/answers`;

  it("maps --model, --mentioned and --low-confidence one to one onto modelId, mentioned and lowConfidence", async () => {
    const api = fakeApi().on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE));
    const r = await box.run(
      ["scan", "evidence", SCAN_ID, "--json", "--limit", "2", "--cursor", "c1", "--model", "vendor/model-one", "--mentioned", "true", "--low-confidence", "false"],
      { env: ORG_ENV, api },
    );
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${ANSWERS_PATH}`]);
    expect(api.calls[0]!.query).toEqual({
      limit: "2",
      cursor: "c1",
      modelId: "vendor/model-one",
      mentioned: "true",
      lowConfidence: "false",
    });
  });

  it("never filters a fetched page locally: every row the server returned is printed", async () => {
    const api = fakeApi()
      .on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE))
      .on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE));
    // The fake ignores the filter and serves a row that does NOT mention the brand.
    const r = await box.run(["scan", "evidence", SCAN_ID, "--mentioned", "true"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[1] ");
    expect(r.stdout).toContain("[2] ");
    expect(r.stdout).toContain("Brand mentioned: no");

    const j = await box.run(["scan", "evidence", SCAN_ID, "--mentioned", "true", "--json"], {
      env: ORG_ENV,
      api: fakeApi().on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE)),
    });
    expect(j.stdout).toBe(`${JSON.stringify(ANSWERS_PAGE)}\n`);
  });

  it("renders the section 3.5 layout and the Next page hint from nextCursor", async () => {
    const api = fakeApi()
      .on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE))
      .on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE));
    const r = await box.run(["scan", "evidence", SCAN_ID, "--limit", "2"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("Scan 3f9c1e42  acme/acme-eu  (48 answers, showing 2)");
    expect(lines[2]).toMatch(/^\[1\] "best AI visibility tracking tools for SaaS"\s+research {2}\S.* {2}grounded$/);
    expect(lines[3]).toBe("    Brand mentioned: yes, position 3 of 3, sentiment positive, confidence 0.91");
    expect(lines[4]).toBe("    Also present: Rival A (1), Rival B (2), Acme (3)");
    // One entry per domain, however many URLs cited it.
    expect(lines[5]).toBe("    Citations: reviews.example, acme.example");
    expect(lines[6]).toMatch(/^ {4}"For teams that want a breakdown per model.*\.\.\."$/);
    expect(r.stdout).toContain("    Brand mentioned: no  (low confidence)");
    expect(r.stderr).toContain(`Next page:  wam scan evidence ${SCAN_ID} --limit 2 --cursor ${ANSWERS_PAGE.pagination.nextCursor}`);
  });

  it("--full only stops the CLI's own truncation", async () => {
    const routes = () =>
      fakeApi().on("GET", SCAN_PATH, jsonResponse(200, SCAN_DONE)).on("GET", ANSWERS_PATH, jsonResponse(200, ANSWERS_PAGE));
    const short = await box.run(["scan", "evidence", SCAN_ID], { env: ORG_ENV, api: routes() });
    const fullApi = routes();
    const full = await box.run(["scan", "evidence", SCAN_ID, "--full"], { env: ORG_ENV, api: fullApi });

    const answer = ANSWERS_PAGE.data[0]!.answerText;
    expect(short.stdout).not.toContain(answer);
    expect(full.stdout).toContain(`"${answer}"`);
    // --full is not an API parameter: the request is the same one.
    expect(fullApi.calls.find((c) => c.path === ANSWERS_PATH)!.query).toEqual({});
  });

  it("the fixture honours the contract's caps, which the CLI never raises", () => {
    expect(ANSWERS_PAGE.data[0]!.answerText.length).toBeLessThanOrEqual(ANSWER_TEXT_MAX_CHARS);
    expect(ANSWERS_PAGE.data[0]!.citations.length).toBeLessThanOrEqual(ANSWER_CITATIONS_MAX);
  });

  it("--mentioned takes true or false and nothing else", async () => {
    const r = await box.run(["scan", "evidence", SCAN_ID, "--mentioned", "yes"], { env: ORG_ENV, api: fakeApi() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--mentioned must be true or false.\n");
  });
});

describe("help", () => {
  it.each([
    [["scan", "status", "--help"], `  $ wam scan status ${SCAN_ID} --wait`],
    [["scan", "watch", "--help"], `  $ wam scan watch ${SCAN_ID}`],
    [["scan", "list", "--help"], "  $ wam scan list --status done --limit 5"],
    [["scan", "evidence", "--help"], `  $ wam scan evidence ${SCAN_ID} --mentioned false --limit 5`],
  ])("%j ends with a copy-pasteable example", async (argv, example) => {
    const r = await box.run(argv);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe(example);
  });
});
