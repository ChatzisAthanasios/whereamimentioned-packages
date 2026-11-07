import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPORT_FORMATS, reportData } from "@whereamimentioned/api-client";
import {
  REPORT,
  REPORT_ALL_ZERO,
  REQUEST_ID,
  SCANS_PAGE,
  SCAN_DONE,
  SCAN_ID,
  TOKEN_ENV,
  bytesResponse,
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

const ORG_ENV = { ...TOKEN_ENV, WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" };
const REPORT_PATH = `/api/v1/scans/${SCAN_ID}/report`;
const SCAN_PATH = `/api/v1/scans/${SCAN_ID}`;
const SCANS_PATH = "/api/v1/workspaces/acme-eu/scans";

function reportApi(body: unknown = REPORT): FakeApi {
  return fakeApi()
    .on("GET", SCANS_PATH, jsonResponse(200, { ...SCANS_PAGE, data: SCANS_PAGE.data.slice(0, 1) }))
    .on("GET", REPORT_PATH, jsonResponse(200, body));
}

describe("wam report get --json", () => {
  it("is byte-identical to the ReportData the API served: no wrapper, no added field", async () => {
    const api = reportApi();
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--json"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${JSON.stringify(REPORT)}\n`);
    expect(api.paths()).toEqual([`GET ${REPORT_PATH}`]);
    expect(api.calls[0]!.query).toEqual({ format: "json" });

    const doc = JSON.parse(r.stdout);
    // The output validates against the contract schema, and a strict copy of it finds no extra key.
    expect(reportData.strict().parse(doc)).toEqual(REPORT);
    expect(doc.methodologyVersion).toBe("1.0.0");
    // On ReportData itself (08 section 4.8), and it names the scan the report was built from.
    expect(doc.scanId).toBe(SCAN_ID);
  });

  it("--scan defaults to the latest completed scan of the resolved workspace", async () => {
    const api = reportApi();
    const r = await box.run(["report", "get", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${REPORT_PATH}`]);
    expect(api.calls[0]!.query).toEqual({ limit: "1", status: "done" });
    expect(JSON.parse(r.stdout).scanId).toBe(SCAN_ID);
  });

  it("a workspace with no completed scan is exit 1 and says what to run", async () => {
    const api = fakeApi().on("GET", SCANS_PATH, jsonResponse(200, { ...SCANS_PAGE, data: [] }));
    const r = await box.run(["report", "get"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("Workspace acme-eu has no completed scan yet, so there is no report.\nRun one with: wam scan run --wait\n");
  });

  it("with no --scan and no workspace: exit 2 with the no-workspace copy, and no request", async () => {
    const api = fakeApi();
    const r = await box.run(["report", "get"], { env: TOKEN_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No workspace selected.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("wam report get, the human summary", () => {
  it("renders section 3.6 from the ReportData alone", async () => {
    const r = await box.run(["report", "get", "--scan", SCAN_ID], { env: ORG_ENV, api: reportApi() });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        "Acme  (workspace Acme EU)   scan of 2026-08-28   methodology 1.0.0",
        "",
        "  AI visibility score      61 / 100",
        "  Presence rate            58%     95% CI 41% to 74%",
        "  Share of voice           22%",
        "  Sentiment                +0.34",
        "  Brand citation share     14%",
        "",
        "  Per model",
        "    Model One              68",
        "    Model Two              49",
        "",
        "  Share of voice",
        "    Rival A                31%    18 mentions",
        "    Acme  (you)            22%    13 mentions",
        "",
        "  Most cited domains",
        "    reviews.example         12    9.4%   third_party",
        "    acme.example             8    6.3%   owned",
        "",
        "  Top recommendations",
        "     88  Win back the research prompts",
        "",
      ].join("\n"),
    );
  });
});

describe("wam report get --format", () => {
  it("pdf without -o is a usage error, exit 2, and makes no request", async () => {
    const api = reportApi();
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "pdf"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--format pdf needs -o <file>");
    expect(api.calls).toHaveLength(0);
  });

  it("an unknown format is a usage error naming the contract's formats", async () => {
    const r = await box.run(["report", "get", "--format", "xlsx"], { env: ORG_ENV, api: fakeApi() });
    expect(r.code).toBe(2);
    // The list is the contract's tuple, in the contract's order, never one typed here.
    expect(r.stderr).toBe(`--format must be one of: ${REPORT_FORMATS.join(", ")}.\n`);
  });

  it("csv with -o writes the bytes as served", async () => {
    const csv = new TextEncoder().encode("metric,value\r\nscore,61\r\n");
    const api = fakeApi().on("GET", REPORT_PATH, bytesResponse(csv, "text/csv; charset=utf-8"));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "csv", "-o", "out/../report.csv"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.calls[0]!.query).toEqual({ format: "csv" });
    const path = join(box.cwd, "report.csv");
    expect(new Uint8Array(readFileSync(path))).toEqual(csv);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`Wrote ${path} (${csv.byteLength} bytes)\n`);
  });

  it("pdf with -o writes binary untouched", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a]);
    const api = fakeApi().on("GET", REPORT_PATH, bytesResponse(pdf, "application/pdf"));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "pdf", "-o", "report.pdf"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(box.cwd, "report.pdf")))).toEqual(pdf);
  });

  it("csv without -o goes to stdout with nothing around it", async () => {
    const text = "metric,value\nscore,61\n";
    const api = fakeApi().on("GET", REPORT_PATH, bytesResponse(new TextEncoder().encode(text), "text/csv; charset=utf-8"));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "csv"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(text);
    expect(r.stderr).toBe("");
  });

  it("csv without -o under --json is a usage error, exit 2, and makes no request: raw CSV never lands in the JSON stream", async () => {
    const api = fakeApi().on("GET", REPORT_PATH, bytesResponse(new TextEncoder().encode("metric,value\n"), "text/csv; charset=utf-8"));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "csv", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    // Under --json the error itself is the one JSON document on stdout (section 3.1), never CSV.
    const doc = JSON.parse(r.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe("usage_error");
    expect(doc.error.message).toContain("--format csv with --json needs -o <file>");
    expect(r.stdout).not.toContain("metric,value");
    expect(api.calls).toHaveLength(0);
  });

  it("csv with -o under --json prints the one JSON receipt and writes the bytes", async () => {
    const csv = new TextEncoder().encode("metric,value\nscore,61\n");
    const api = fakeApi().on("GET", REPORT_PATH, bytesResponse(csv, "text/csv; charset=utf-8"));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "csv", "-o", "report.csv", "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ ok: true, scanId: SCAN_ID, format: "csv", bytes: csv.byteLength });
    expect(new Uint8Array(readFileSync(join(box.cwd, "report.csv")))).toEqual(csv);
  });

  it("json with -o writes the ReportData and nothing else", async () => {
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "-o", "report.json"], { env: ORG_ENV, api: reportApi() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(JSON.parse(readFileSync(join(box.cwd, "report.json"), "utf8"))).toEqual(REPORT);
  });

  it("a 403 on the format is exit 3 with the section 9 copy, and no file is written", async () => {
    const api = fakeApi().on(
      "GET",
      REPORT_PATH,
      errorResponse(403, "feature_not_available", "The Single Brand plan does not include PDF export. Upgrade at https://whereamimentioned.com/acme/billing", {
        allowedFormats: ["csv"],
        billingUrl: "https://whereamimentioned.com/acme/billing",
      }),
    );
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--format", "pdf", "-o", "report.pdf"], { env: ORG_ENV, api });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(
      [
        "The Single Brand plan does not include PDF export. Upgrade at https://whereamimentioned.com/acme/billing",
        `This plan allows: csv. See https://whereamimentioned.com/pricing (request ${REQUEST_ID})`,
        "",
      ].join("\n"),
    );
    expect(existsSync(join(box.cwd, "report.pdf"))).toBe(false);
  });

  it("a 404 with a status is the report-not-ready copy, exit 1", async () => {
    const api = fakeApi().on(
      "GET",
      REPORT_PATH,
      errorResponse(404, "not_found", "No report exists for this scan yet: its status is running, and a report is built once a scan is done.", {
        status: "running",
      }),
    );
    const r = await box.run(["report", "get", "--scan", SCAN_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      [
        "That scan is still running, so there is no report yet.",
        `Follow it with: wam scan status ${SCAN_ID} --wait (request ${REQUEST_ID})`,
        "",
      ].join("\n"),
    );
  });

  it("a plain 404 on --scan (another org's scan, or a mistyped id) is exit 1 naming the scan, not the workspace", async () => {
    await box.storeCredential("org", "northwind");
    const api = fakeApi().on("GET", REPORT_PATH, errorResponse(404, "not_found", "Scan not found."));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--workspace", "acme-eu"], { api });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Scan ${SCAN_ID} was not found in organization northwind, or this key cannot see it.`);
    expect(r.stderr).toContain("Check the id against: wam scan list");
    expect(r.stderr).not.toContain("Workspace acme-eu was not found");
  });
});

describe("wam report get --fail-under", () => {
  it("exits 7 with the report still on stdout and the comparison on stderr", async () => {
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--fail-under", "65"], { env: ORG_ENV, api: reportApi() });
    expect(r.code).toBe(7);
    expect(r.stdout).toContain("  AI visibility score      61 / 100");
    expect(r.stderr).toBe("\nAI visibility score 61 is below the threshold of 65.\n");
  });

  it("under --json the report stays the ONE stdout document and the gate goes to stderr", async () => {
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--json", "--fail-under", "65"], { env: ORG_ENV, api: reportApi() });
    expect(r.code).toBe(7);
    expect(r.stdout).toBe(`${JSON.stringify(REPORT)}\n`);
    expect(r.stderr).toContain("AI visibility score 61 is below the threshold of 65.");
    expect(r.stdout).not.toContain("threshold_not_met");
  });

  it("a score at or above the threshold is exit 0 and says nothing", async () => {
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--json", "--fail-under", "61"], { env: ORG_ENV, api: reportApi() });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("failUnder from config is the default, and the flag wins over it", async () => {
    writeFileSync(join(box.cwd, "wam.json"), JSON.stringify({ org: "acme", workspace: "acme-eu", failUnder: 70 }), "utf8");
    const fromConfig = await box.run(["report", "get", "--scan", SCAN_ID, "--json"], { env: TOKEN_ENV, api: reportApi() });
    expect(fromConfig.code).toBe(7);
    expect(fromConfig.stderr).toContain("is below the threshold of 70.");
    const flagged = await box.run(["report", "get", "--scan", SCAN_ID, "--json", "--fail-under", "50"], { env: TOKEN_ENV, api: reportApi() });
    expect(flagged.code).toBe(0);
  });

  it("a value outside 0 to 100 is a usage error", async () => {
    const r = await box.run(["report", "get", "--fail-under", "101"], { env: ORG_ENV, api: fakeApi() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("--fail-under must be an integer from 0 to 100.\n");
  });
});

describe("the zero-score warning (section 15 item 8)", () => {
  it("an all-zero report triggers exactly one extra GET of the scan, and warns when answers were collected", async () => {
    const api = reportApi(REPORT_ALL_ZERO).on("GET", SCAN_PATH, jsonResponse(200, { ...SCAN_DONE, score: 0 }));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--json"], { env: ORG_ENV, api });

    expect(r.code).toBe(0);
    expect(api.paths()).toEqual([`GET ${REPORT_PATH}`, `GET ${SCAN_PATH}`]);
    expect(api.calls.filter((c) => c.path === SCAN_PATH)).toHaveLength(1);
    // The document is still exactly the report.
    expect(r.stdout).toBe(`${JSON.stringify(REPORT_ALL_ZERO)}\n`);
    expect(r.stderr).toContain("Warning: this scan scored 0 across 48 answers.");
    expect(r.stderr).toContain(`https://whereamimentioned.com/acme/acme-eu/scans/${SCAN_ID}`);
  });

  it("reads progress.done: a scan that collected nothing draws no warning", async () => {
    const empty = { ...SCAN_DONE, score: 0, progress: { done: 0, total: 0, totalIsFinal: true } };
    const api = reportApi(REPORT_ALL_ZERO).on("GET", SCAN_PATH, jsonResponse(200, empty));
    const r = await box.run(["report", "get", "--scan", SCAN_ID], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(api.calls.filter((c) => c.path === SCAN_PATH)).toHaveLength(1);
    expect(r.stderr).toBe("");
  });

  it("a normal report never fetches the scan", async () => {
    const api = reportApi();
    await box.run(["report", "get", "--scan", SCAN_ID], { env: ORG_ENV, api });
    expect(api.calls.some((c) => c.path === SCAN_PATH)).toBe(false);
  });

  it("a score of 0 with a non-zero presence rate is a real result and is left alone", async () => {
    const api = reportApi({ ...REPORT_ALL_ZERO, presenceRate: 0.1 });
    const r = await box.run(["report", "get", "--scan", SCAN_ID], { env: ORG_ENV, api });
    expect(api.calls.some((c) => c.path === SCAN_PATH)).toBe(false);
    expect(r.stderr).toBe("");
  });

  it("a failed side check never turns a served report into an error", async () => {
    const api = reportApi(REPORT_ALL_ZERO).on("GET", SCAN_PATH, errorResponse(404, "not_found", "Scan not found."));
    const r = await box.run(["report", "get", "--scan", SCAN_ID, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify(REPORT_ALL_ZERO)}\n`);
  });
});

describe("help", () => {
  it("report get ends with a copy-pasteable example", async () => {
    const r = await box.run(["report", "get", "--help"]);
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("  $ wam report get --json --fail-under 55");
  });
});

describe("wam report get --scan with a prefix, as the ID column of wam scan list prints it", () => {
  const short = SCAN_ID.slice(0, 8);

  it("resolves the prefix through the workspace's scan list, then fetches the report of the full id", async () => {
    const api = fakeApi().on("GET", SCANS_PATH, jsonResponse(200, SCANS_PAGE)).on("GET", REPORT_PATH, jsonResponse(200, REPORT));
    const r = await box.run(["report", "get", "--scan", short, "--json"], { env: ORG_ENV, api });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`, `GET ${REPORT_PATH}`]);
    // The lookup, not the "latest completed" default: every status, at the contract's page ceiling.
    expect(api.calls[0]!.query).toEqual({ limit: "100" });
    expect(r.stdout).toBe(`${JSON.stringify(REPORT)}\n`);
  });

  it("a prefix two scans share is exit 2 listing both, and fetches no report", async () => {
    const twin = { ...SCANS_PAGE.data[0]!, id: `${short}-ffff-4fff-8fff-ffffffffffff` };
    const api = fakeApi()
      .on("GET", SCANS_PATH, jsonResponse(200, { ...SCANS_PAGE, data: [SCANS_PAGE.data[0]!, twin] }))
      .on("GET", REPORT_PATH, jsonResponse(200, REPORT));
    const r = await box.run(["report", "get", "--scan", short], { env: ORG_ENV, api });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`${short} matches 2 scans in workspace acme-eu:`);
    expect(r.stderr).toContain(`  ${SCAN_ID}  done`);
    expect(r.stderr).toContain(`  ${twin.id}  done`);
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`]);
  });

  it("a prefix nothing starts with is exit 1, and the copy says a prefix is accepted", async () => {
    const api = fakeApi().on("GET", SCANS_PATH, jsonResponse(200, SCANS_PAGE)).on("GET", REPORT_PATH, jsonResponse(200, REPORT));
    const r = await box.run(["report", "get", "--scan", "ffff"], { env: ORG_ENV, api });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has an id starting with ffff, or this key cannot see one.");
    expect(r.stderr).toContain("A full id or an unambiguous prefix of one is accepted.");
    expect(api.paths()).toEqual([`GET ${SCANS_PATH}`]);
  });

  it("a --scan prefix without a workspace is exit 2 and makes no request; a full --scan never needed one", async () => {
    const api = fakeApi();
    const r = await box.run(["report", "get", "--scan", short], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("or pass the full id.");
    expect(api.calls).toHaveLength(0);

    const full = fakeApi().on("GET", REPORT_PATH, jsonResponse(200, REPORT));
    const ok = await box.run(["report", "get", "--scan", SCAN_ID, "--json"], { env: { ...TOKEN_ENV, WAM_ORG: "acme" }, api: full });
    expect(ok.code).toBe(0);
    expect(full.paths()).toEqual([`GET ${REPORT_PATH}`]);
  });
});
