import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_VARS,
  createColours,
  createOutput,
  formatTable,
  resolveColor,
  resolveNonInteractive,
  shouldNotifyUpdates,
} from "./output";
import { fakeStream } from "./test-support";

const ESC = String.fromCharCode(27);

function make(opts: Partial<Parameters<typeof createOutput>[0]> = {}) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const out = createOutput({ stdout, stderr, json: false, quiet: false, color: false, debug: false, ...opts });
  return { out, stdout, stderr };
}

describe("resolveColor (section 3.0)", () => {
  const tty = { flag: undefined, json: false, env: {}, stdoutIsTTY: true };

  it("is on for a TTY with nothing set", () => {
    expect(resolveColor(tty)).toBe(true);
  });

  it("NO_COLOR disables by presence, even with the value 0", () => {
    expect(resolveColor({ ...tty, env: { NO_COLOR: "0" } })).toBe(false);
    expect(resolveColor({ ...tty, env: { NO_COLOR: "" } })).toBe(false);
  });

  it("TERM=dumb and a non-TTY stdout disable it", () => {
    expect(resolveColor({ ...tty, env: { TERM: "dumb" } })).toBe(false);
    expect(resolveColor({ ...tty, stdoutIsTTY: false })).toBe(false);
  });

  it("--color overrides NO_COLOR, non-TTY and TERM=dumb; --no-color overrides a TTY", () => {
    expect(resolveColor({ flag: true, json: false, env: { NO_COLOR: "1", TERM: "dumb" }, stdoutIsTTY: false })).toBe(true);
    expect(resolveColor({ ...tty, flag: false })).toBe(false);
  });

  it("is always off under --json, even with --color", () => {
    expect(resolveColor({ flag: true, json: true, env: {}, stdoutIsTTY: true })).toBe(false);
  });
});

describe("resolveNonInteractive (section 6.3)", () => {
  const base = { flag: false, json: false, env: {}, stdoutIsTTY: true };

  it("is interactive for a TTY with nothing set", () => {
    expect(resolveNonInteractive(base)).toBe(false);
  });

  it("non-TTY stdout implies non-interactive", () => {
    expect(resolveNonInteractive({ ...base, stdoutIsTTY: false })).toBe(true);
  });

  it("CI by presence, --json, --non-interactive and each agent variable", () => {
    expect(resolveNonInteractive({ ...base, env: { CI: "" } })).toBe(true);
    expect(resolveNonInteractive({ ...base, json: true })).toBe(true);
    expect(resolveNonInteractive({ ...base, flag: true })).toBe(true);
    for (const name of AGENT_ENV_VARS) {
      expect(resolveNonInteractive({ ...base, env: { [name]: "1" } })).toBe(true);
    }
    expect(AGENT_ENV_VARS).toEqual(["CLAUDE_CODE", "CURSOR_AGENT", "AGENT"]);
  });
});

describe("shouldNotifyUpdates (section 11.2)", () => {
  const base = { json: false, quiet: false, stdoutIsTTY: true, env: {}, argv: ["scan", "list"] };

  it("allows a plain interactive command", () => {
    expect(shouldNotifyUpdates(base)).toBe(true);
  });

  it("is suppressed by --json, --quiet, non-TTY, CI, WAM_NO_UPDATE_NOTIFIER and wam completion", () => {
    expect(shouldNotifyUpdates({ ...base, json: true })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, quiet: true })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, stdoutIsTTY: false })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, env: { CI: "true" } })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, env: { WAM_NO_UPDATE_NOTIFIER: "1" } })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, argv: ["completion", "zsh"] })).toBe(false);
    expect(shouldNotifyUpdates({ ...base, argv: ["--debug", "completion", "bash"] })).toBe(false);
  });
});

describe("the stream rule (section 6.1)", () => {
  it("data goes to stdout only, chatter and warnings to stderr only", () => {
    const { out, stdout, stderr } = make();
    out.data("hello");
    out.chatter("Estimating...");
    out.warn("careful");
    out.error(["bad", "worse"]);
    expect(stdout.text).toBe("hello\n");
    expect(stderr.text).toBe("Estimating...\ncareful\nbad\nworse\n");
  });

  it("raw writes bytes verbatim and data adds a newline only when missing", () => {
    const { out, stdout } = make();
    out.raw("<xml/>");
    out.data("line\n");
    expect(stdout.text).toBe("<xml/>line\n");
  });

  it("--quiet drops chatter but not warnings or errors", () => {
    const { out, stdout, stderr } = make({ quiet: true });
    out.chatter("progress");
    out.warn("still printed");
    out.error(["also printed"]);
    out.data("data");
    expect(stderr.text).toBe("still printed\nalso printed\n");
    expect(stdout.text).toBe("data\n");
  });

  it("debug prints only under --debug, on stderr", () => {
    const off = make();
    off.out.debug("secret-free diagnostics");
    expect(off.stderr.text).toBe("");
    const on = make({ debug: true });
    on.out.debug("GET /api/v1/me -> 200");
    expect(on.stderr.text).toBe("[debug] GET /api/v1/me -> 200\n");
    expect(on.stdout.text).toBe("");
  });
});

describe("--json (section 6.2)", () => {
  it("emits exactly one document, compact, newline-terminated", () => {
    const { out, stdout, stderr } = make({ json: true });
    out.jsonDocument({ score: 61, presenceRate: 0.58 });
    expect(stdout.text).toBe('{"score":61,"presenceRate":0.58}\n');
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toEqual({ score: 61, presenceRate: 0.58 });
  });

  it("refuses a second document in one invocation", () => {
    const { out } = make({ json: true });
    out.jsonDocument({ a: 1 });
    expect(() => out.jsonDocument({ b: 2 })).toThrow(/exactly one document/);
  });

  it("ndjson emits one object per line with one terminal object", () => {
    const { out, stdout } = make({ json: true });
    out.ndjson({ type: "progress", done: 11, total: 42, totalIsFinal: false });
    out.ndjson({ type: "progress", done: 25, total: 42, totalIsFinal: false });
    out.ndjson({ type: "result", status: "done", score: 61 });
    const lines = stdout.text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.type === "result" || l.type === "error")).toHaveLength(1);
    expect(lines[2].type).toBe("result");
  });

  it("the error object is data: it goes to stdout, and chatter still goes to stderr", () => {
    const { out, stdout, stderr } = make({ json: true });
    out.chatter("Estimating...");
    out.jsonError({ ok: false, error: { code: "insufficient_credits" }, exitCode: 4 });
    expect(JSON.parse(stdout.text)).toMatchObject({ ok: false, exitCode: 4 });
    expect(stderr.text).toBe("Estimating...\n");
  });
});

describe("colours", () => {
  it("wraps with ANSI codes when enabled and passes through when not", () => {
    expect(createColours(true).red("x")).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(createColours(true).bold("x")).toBe(`${ESC}[1mx${ESC}[0m`);
    expect(createColours(false).red("x")).toBe("x");
    const { out, stdout } = make({ color: false });
    out.data(out.green("plain"));
    expect(stdout.text).toBe("plain\n");
  });
});

describe("formatTable", () => {
  it("aligns columns, right-aligns numbers, never leaves trailing whitespace", () => {
    const text = formatTable(
      [
        { org: "acme", name: "Acme Ltd", tier: "pro", workspaces: 3 },
        { org: "northwind", name: "Northwind", tier: "single", workspaces: 12 },
      ],
      [
        { key: "org", header: "ORG" },
        { key: "name", header: "NAME" },
        { key: "tier", header: "TIER" },
        { key: "workspaces", header: "WORKSPACES" },
      ],
    );
    expect(text).toBe(
      [
        "ORG        NAME       TIER    WORKSPACES",
        "acme       Acme Ltd   pro              3",
        "northwind  Northwind  single          12",
      ].join("\n"),
    );
    for (const line of text.split("\n")) expect(line).not.toMatch(/\s$/);
  });

  it("supports no header, an indent, an explicit alignment and empty cells", () => {
    const text = formatTable(
      [
        { k: "org", v: "acme", s: "./wam.json" },
        { k: "apiUrl", v: null, s: "(default)" },
      ],
      [
        { key: "k", header: "" },
        { key: "v", header: "", align: "left" },
        { key: "s", header: "" },
      ],
      { header: false, indent: "  " },
    );
    expect(text).toBe(["  org     acme  ./wam.json", "  apiUrl        (default)"].join("\n"));
  });

  it("writes a table as data", () => {
    const { out, stdout, stderr } = make();
    out.table([{ a: 1 }], [{ key: "a", header: "A" }]);
    expect(stdout.text).toBe("A\n1\n");
    expect(stderr.text).toBe("");
  });
});
