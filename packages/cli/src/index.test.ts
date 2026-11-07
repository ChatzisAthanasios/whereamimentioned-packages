import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORTED_API_VERSION } from "@whereamimentioned/api-client";
import { EXIT_CODES } from "./errors";
import { HELP_AFTER, flagsFromOpts, main, preparseGlobalFlags } from "./index";
import { fakePrimitives, fakeStream, mkdirp, tempDir, type FakeStream, type TempDir } from "./test-support";
import { VERSION } from "./version";

let tmp: TempDir;
let home: string;
let cwd: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], env: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<Run> {
  const stdout: FakeStream = fakeStream();
  const stderr: FakeStream = fakeStream();
  const code = await main(argv, { ...fakePrimitives({ homedir: home, cwd, env, stdout, stderr }), ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

beforeEach(() => {
  tmp = tempDir("wam-index-");
  home = mkdirp(join(tmp.dir, "home"));
  cwd = mkdirp(join(tmp.dir, "repo"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  tmp.cleanup();
});

describe("--version (section 11.1)", () => {
  it("prints the bare semver on stdout and nothing else", async () => {
    const r = await run(["--version"]);
    expect(r).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(await run(["-V"])).toEqual(r);
  });

  it("--version --json prints the version object", async () => {
    const r = await run(["--version", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ version: VERSION, node: process.version, apiVersion: SUPPORTED_API_VERSION });
  });
});

describe("--help (section 11.1)", () => {
  it("lists the groups, the global flags, the exit-code table, three examples and the telemetry line", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    for (const group of ["auth", "config", "org", "workspace", "scan", "report", "competitor", "prompt", "site", "mcp", "completion"]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${group}\\s`, "m"));
    }
    for (const flag of ["--json", "-q, --quiet", "--no-color", "--color", "--non-interactive", "-y, --yes", "--debug", "--org <slug>", "--workspace <slug>", "--token <token>", "--api-url <url>", "--profile <name>", "-V, --version", "-h, --help"]) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).toContain("Exit codes:");
    for (const [code, meaning] of EXIT_CODES) expect(r.stdout).toContain(`${String(code).padStart(2)}  ${meaning}`);
    expect(r.stdout).toContain("This CLI sends no telemetry.");
    expect(r.stdout).toContain("spend no credits");
    expect((r.stdout.match(/^\s+\$ /gm) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(r.stdout).toContain("npx @whereamimentioned/cli");
    expect(r.stdout).not.toMatch(/npx wam\b/);
    expect(HELP_AFTER).not.toContain(String.fromCharCode(0x2014));
  });

  it("bare wam prints help and exits 0; a group's --help lists its subcommands", async () => {
    const bare = await run([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("Usage: wam");
    const group = await run(["config", "--help"]);
    expect(group.code).toBe(0);
    for (const sub of ["list", "get <key>", "set <key> <value>", "unset <key>", "path"]) expect(group.stdout).toContain(sub);
  });
});

describe("usage errors (sections 3.1 and 11.1)", () => {
  it("an unknown flag is exit 2 on stderr, with nothing on stdout", async () => {
    const r = await run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown option '--bogus'");
    const sub = await run(["config", "list", "--bogus"]);
    expect(sub.code).toBe(2);
    expect(sub.stderr).toContain("unknown option '--bogus'");
  });

  it("an unknown command is exit 2", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command 'frobnicate'");
  });

  it("a missing argument prints short help, not full help, then exits 2", async () => {
    const r = await run(["config", "get"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      ["error: missing required argument 'key'", "Usage: wam config get [options] <key>", "Run wam config get --help for the full help."].join("\n") + "\n",
    );
    expect(r.stderr).not.toContain("Exit codes:");
  });

  it("under --json every error is the stable object on stdout with a non-zero exit", async () => {
    const missing = await run(["config", "get", "--json"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toBe("");
    const doc = JSON.parse(missing.stdout);
    expect(doc).toMatchObject({ ok: false, error: { code: "usage_error", requestId: null, details: null }, exitCode: 2 });
    expect(doc.error.message).toContain("missing required argument 'key'");
    expect(missing.stdout.trim().split("\n")).toHaveLength(1);

    const unknownKey = await run(["config", "get", "bogus", "--json"]);
    expect(unknownKey.code).toBe(2);
    expect(JSON.parse(unknownKey.stdout)).toEqual({
      ok: false,
      error: {
        code: "usage_error",
        message: 'Unknown config key "bogus".\nValid keys are: org, workspace, apiUrl, failUnder, profile.',
        requestId: null,
        details: null,
      },
      exitCode: 2,
    });

    const unknownFlag = await run(["--json", "--bogus"]);
    expect(unknownFlag.code).toBe(2);
    expect(JSON.parse(unknownFlag.stdout).error.code).toBe("usage_error");
  });

  it("a CliError from a command renders its lines on stderr", async () => {
    const r = await run(["config", "set", "colour", "red"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('"colour" is not a settable config key.\nSettable keys are: org, workspace, apiUrl, failUnder.\n');
  });
});

describe("wam config through the program (checkpoint 2)", () => {
  it("list prints defaults with sources", async () => {
    const r = await run(["config", "list"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("apiUrl     https://whereamimentioned.com  (default)");
    expect(r.stdout).toContain("profile    default");
    expect(r.stdout).toMatch(/^org\s+\(not set\)\s+\(default\)$/m);
  });

  it("set writes the user config and list, get reflect it with the source", async () => {
    const set = await run(["config", "set", "org", "acme"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("");
    expect(set.stderr).toContain("Set org to acme in ~/.config/whereamimentioned/config.json");
    const list = await run(["config", "list"]);
    expect(list.stdout).toMatch(/^org\s+acme\s+~\/\.config\/whereamimentioned\/config\.json$/m);
    const get = await run(["config", "get", "org"]);
    expect(get).toEqual({ code: 0, stdout: "acme\n", stderr: "" });
    const json = await run(["config", "get", "org", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ key: "org", value: "acme", source: "~/.config/whereamimentioned/config.json" });
    const unset = await run(["config", "unset", "org"]);
    expect(unset.code).toBe(0);
    expect((await run(["config", "get", "org"])).stdout).toBe("");
  });

  it("a wam.json with workSpace exits 2 with the unknown-key copy", async () => {
    writeFileSync(join(cwd, "wam.json"), JSON.stringify({ workSpace: "x" }), "utf8");
    const r = await run(["config", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('Unknown option "workSpace" in ./wam.json.\nValid options are: org, workspace, failUnder.\n');
    expect(r.stdout).toBe("");
  });

  it("precedence through the program: flag beats env beats project file beats user file", async () => {
    await run(["config", "set", "org", "user-org"]);
    writeFileSync(join(cwd, "wam.json"), JSON.stringify({ org: "project-org" }), "utf8");
    expect((await run(["config", "get", "org", "--org", "flag-org"], { WAM_ORG: "env-org" })).stdout).toBe("flag-org\n");
    expect((await run(["config", "get", "org"], { WAM_ORG: "env-org" })).stdout).toBe("env-org\n");
    expect((await run(["config", "get", "org"])).stdout).toBe("project-org\n");
    writeFileSync(join(cwd, "wam.json"), "{}", "utf8");
    expect((await run(["config", "get", "org"])).stdout).toBe("user-org\n");
    // Global flags are accepted after the subcommand too.
    expect((await run(["config", "get", "org", "--org", "late"])).stdout).toBe("late\n");
  });

  it("path prints the consulted files, project first, and skips a missing project file", async () => {
    const none = await run(["config", "path"]);
    expect(none.stdout.trim().split("\n")).toEqual([join(home, ".config", "whereamimentioned", "config.json")]);
    writeFileSync(join(cwd, "wam.json"), "{}", "utf8");
    const both = await run(["config", "path"]);
    expect(both.stdout.trim().split("\n")).toEqual([join(cwd, "wam.json"), join(home, ".config", "whereamimentioned", "config.json")]);
  });

  it("--debug prints the consulted sources on stderr and never a token", async () => {
    const r = await run(["config", "get", "org", "--debug"], { WAM_TOKEN: `wam_test_${"S".repeat(43)}` });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[debug] config: ./wam.json (not found)");
    expect(r.stderr).not.toContain("S".repeat(20));
  });
});

describe("flag pre-parse", () => {
  it("reads global flags wherever they appear and reports operands and unknowns", () => {
    const pre = preparseGlobalFlags(["scan", "run", "--wait", "--json", "--org", "acme", "-y", "--no-color"]);
    expect(pre.flags).toMatchObject({ json: true, yes: true, color: false, org: "acme" });
    expect(pre.operands).toEqual(["scan", "run"]);
    expect(pre.unknown).toEqual(["--wait"]);
    expect(flagsFromOpts({})).toMatchObject({ json: false, color: undefined, org: undefined });
    expect(preparseGlobalFlags(["--color"]).flags.color).toBe(true);
  });
});
