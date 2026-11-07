import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPrimitives } from "../context";
import { main, preparseGlobalFlags } from "../index";
import { shouldNotifyUpdates } from "../output";
import { fakePrimitives, fakeStream, mkdirp, tempDir, type TempDir } from "../test-support";
import { COMPLETION_SHELLS, INSTALL_INSTRUCTIONS } from "./completion";

const notifierCalls = vi.hoisted(() => ({ count: 0 }));

// The real module spawns a detached background check. The fake records that it was asked and
// reports an update, so a test can tell "suppressed" from "checked and found nothing".
vi.mock("update-notifier", () => ({
  default: () => {
    notifierCalls.count += 1;
    return { update: { current: "0.1.0", latest: "9.9.9", type: "major", name: "@whereamimentioned/cli" } };
  },
}));

const EM_DASH = String.fromCharCode(0x2014);

let tmp: TempDir;
let home: string;
let cwd: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], overrides: Partial<ContextPrimitives> = {}): Promise<Run> {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await main(argv, fakePrimitives({ homedir: home, cwd, stdout, stderr, ...overrides }));
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const TTY = { isTTY: { stdout: true, stdin: false } };

/**
 * main() never waits on the update check (section 11.2: never blocking), so the fake is only
 * called once the lazy import behind it has loaded. Let that settle before counting.
 */
async function runAndSettle(argv: string[]): Promise<Run> {
  const r = await run(argv, TTY);
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return r;
}

beforeEach(() => {
  tmp = tempDir("wam-completion-");
  home = mkdirp(join(tmp.dir, "home"));
  cwd = mkdirp(join(tmp.dir, "repo"));
  mkdirSync(join(cwd, ".git"));
  notifierCalls.count = 0;
});

afterEach(() => {
  tmp.cleanup();
});

/** One line that only the real script for that shell contains. */
const SIGNATURE: Record<(typeof COMPLETION_SHELLS)[number], RegExp> = {
  bash: /^complete -F __wam_complete wam$/m,
  zsh: /^#compdef wam$/m,
  fish: /^# fish completion for wam/m,
  powershell: /Register-ArgumentCompleter/,
};

describe("wam completion <shell> (section 3.10)", () => {
  for (const shell of COMPLETION_SHELLS) {
    it(`${shell}: the script is the only thing on stdout, and the instructions are on stderr`, async () => {
      const r = await run(["completion", shell]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(SIGNATURE[shell]);
      // The script calls the binary back for suggestions, by name and not by a node path.
      // (PowerShell quotes the separator: & wam complete '--' ...)
      expect(r.stdout).toMatch(/wam complete (?:--|'--')/);
      expect(r.stdout).not.toContain(process.execPath);
      expect(r.stdout.endsWith("\n")).toBe(true);
      for (const line of INSTALL_INSTRUCTIONS[shell]) {
        expect(r.stderr).toContain(`${line}\n`);
        expect(r.stdout).not.toContain(line);
      }
      expect(r.stderr).toContain(`wam completion ${shell}`);
      expect(r.stdout + r.stderr).not.toContain(EM_DASH);
      expect(r.stdout + r.stderr).not.toMatch(/npx wam\b/);
    });
  }

  it("zsh starts with the compdef header, so eval \"$(wam completion zsh)\" works unmodified", async () => {
    const r = await run(["completion", "zsh"]);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["#compdef wam", "compdef _wam wam"]);
    expect(r.stderr).toContain('eval "$(wam completion zsh)"');
  });

  it("--quiet drops the instructions and keeps the script", async () => {
    const loud = await run(["completion", "bash"]);
    const quiet = await run(["completion", "bash", "--quiet"]);
    expect(quiet.stderr).toBe("");
    expect(quiet.stdout).toBe(loud.stdout);
  });

  it("--json is one document carrying the script", async () => {
    const plain = await run(["completion", "fish"]);
    const r = await run(["completion", "fish", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const doc = JSON.parse(r.stdout) as { shell: string; script: string };
    expect(Object.keys(doc)).toEqual(["shell", "script"]);
    expect(doc.shell).toBe("fish");
    expect(doc.script.endsWith("\n") ? doc.script : `${doc.script}\n`).toBe(plain.stdout);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("an unknown shell and a missing shell are usage errors with nothing on stdout", async () => {
    const unknown = await run(["completion", "tcsh"]);
    expect(unknown).toMatchObject({ code: 2, stdout: "" });
    expect(unknown.stderr).toContain("Allowed choices are bash, zsh, fish, powershell");
    const missing = await run(["completion"]);
    expect(missing).toMatchObject({ code: 2, stdout: "" });
    expect(missing.stderr).toContain("missing required argument 'shell'");
    expect(missing.stderr).toContain("Usage: wam completion [options] <shell>");
  });

  it("help lists the four shells and ends with a copy-pasteable example", async () => {
    const r = await run(["completion", "--help"]);
    expect(r.code).toBe(0);
    // Commander wraps the argument description, so compare with the whitespace collapsed.
    expect(r.stdout.replace(/\s+/g, " ")).toContain('choices: "bash", "zsh", "fish", "powershell"');
    expect(r.stdout.trimEnd().split("\n").pop()).toMatch(/^ {2}\$ wam completion /);
    expect(r.stdout).toContain('$ eval "$(wam completion zsh)"');
    expect(r.stdout).not.toContain(EM_DASH);
  });
});

describe("wam complete -- <words>: what the scripts call back", () => {
  const values = (stdout: string) => stdout.split("\n").filter((l) => l !== "" && !l.startsWith(":")).map((l) => l.split("\t")[0]);

  it("suggests the command groups from the one definition tree, and never the hidden callback", async () => {
    const r = await run(["complete", "--", ""]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const groups = values(r.stdout);
    for (const group of ["auth", "config", "org", "workspace", "scan", "report", "competitor", "prompt", "site", "mcp", "completion"]) {
      expect(groups).toContain(group);
    }
    expect(groups).not.toContain("complete");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe(":4");
  });

  it("suggests subcommands, flags, and the choices of an option and of an argument", async () => {
    expect(values((await run(["complete", "--", "mcp", ""])).stdout)).toEqual(expect.arrayContaining(["url", "install"]));
    expect(values((await run(["complete", "--", "mcp", "in"])).stdout)).toEqual(["install"]);
    const flags = values((await run(["complete", "--", "mcp", "install", "--"])).stdout);
    // Its own options, then the global flags, which are accepted after any subcommand.
    expect(flags).toEqual(expect.arrayContaining(["--client", "--readonly", "--scope", "--global", "--print", "--yes", "--json", "--org"]));
    expect(values((await run(["complete", "--", "mcp", "install", "--client", ""])).stdout)).toEqual([
      "claude-code",
      "cursor",
      "vscode",
      "windsurf",
      "zed",
      "warp",
      "opencode",
      "amp",
      "jetbrains",
    ]);
    expect(values((await run(["complete", "--", "mcp", "url", "--scope", ""])).stdout)).toEqual(["org", "workspace", "none"]);
    expect(values((await run(["complete", "--", "completion", ""])).stdout)).toEqual(["bash", "zsh", "fish", "powershell"]);
  });

  it("is hidden from wam --help", async () => {
    const help = await run(["--help"]);
    expect(help.stdout).toMatch(/^ {2}completion <shell>/m);
    expect(help.stdout).not.toMatch(/^ {2}complete\b(?!ion)/m);
  });
});

describe("the update notice (section 11.2)", () => {
  it("is checked for an ordinary command on a terminal, which proves the fake is wired", async () => {
    const r = await runAndSettle(["config", "path"]);
    expect(r.code).toBe(0);
    expect(notifierCalls.count).toBe(1);
  });

  it("is never checked, and never printed, for wam completion", async () => {
    for (const argv of [["completion", "zsh"], ["--debug", "completion", "bash"], ["--org", "acme", "completion", "fish"], ["completion", "powershell", "--profile", "work"]]) {
      const r = await runAndSettle(argv);
      expect(r.code).toBe(0);
      expect(notifierCalls.count).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("Update available");
      expect(r.stdout + r.stderr).not.toContain("npm install -g");
    }
  });

  it("the suppression keys off the parsed command, not the first bare word", () => {
    const base = { json: false, quiet: false, stdoutIsTTY: true, env: {} };
    const argv = ["--org", "acme", "completion", "zsh"];
    expect(preparseGlobalFlags(argv).operands).toEqual(["completion", "zsh"]);
    expect(shouldNotifyUpdates({ ...base, argv: preparseGlobalFlags(argv).operands })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, argv: preparseGlobalFlags(["--org", "completion", "scan", "list"]).operands })).toBe(true);
  });
});
