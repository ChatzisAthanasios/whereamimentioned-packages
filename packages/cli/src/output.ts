/**
 * The output contract (10-CLI section 6): stdout is data, stderr is chatter.
 *
 * Every byte the CLI prints goes through an `Output` built here, never through `console.*` or a
 * bare `process.stdout.write`, so the stream rule holds by construction. eslint (`no-console` for
 * packages/cli/src) enforces the first half; the Context (context.ts) owning the only stream
 * handles enforces the second.
 *
 * Also home to the three pure decisions the streams depend on: colour (section 3.0),
 * interactivity (section 6.3) and whether the update notice may print (section 11.2).
 */

export interface WritableLike {
  write(chunk: string): unknown;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Presence of any of these marks an agent-driven shell (10-CLI section 6.3). */
export const AGENT_ENV_VARS = ["CLAUDE_CODE", "CURSOR_AGENT", "AGENT"] as const;

export interface ColorInput {
  /** `--color` is true, `--no-color` is false, neither is undefined. */
  flag: boolean | undefined;
  json: boolean;
  env: Env;
  stdoutIsTTY: boolean;
}

/**
 * Section 3.0: `--color` forces colour on and overrides everything except `--json`; `--no-color`,
 * `NO_COLOR` (by presence, whatever its value), `TERM=dumb` and a non-TTY stdout turn it off.
 */
export function resolveColor(input: ColorInput): boolean {
  if (input.json) return false;
  if (input.flag === true) return true;
  if (input.flag === false) return false;
  if (input.env.NO_COLOR !== undefined) return false;
  if (input.env.TERM === "dumb") return false;
  return input.stdoutIsTTY;
}

export interface InteractivityInput {
  flag: boolean;
  json: boolean;
  env: Env;
  stdoutIsTTY: boolean;
}

/** Section 6.3, the single definition of the trigger set. */
export function resolveNonInteractive(input: InteractivityInput): boolean {
  if (input.flag || input.json) return true;
  if (!input.stdoutIsTTY) return true;
  if (input.env.CI !== undefined) return true;
  return AGENT_ENV_VARS.some((name) => input.env[name] !== undefined);
}

export interface UpdateNoticeInput {
  json: boolean;
  quiet: boolean;
  stdoutIsTTY: boolean;
  env: Env;
  /** User arguments, without node and the script path. */
  argv: readonly string[];
}

/** Section 11.2: the notice is suppressed under any of these, and always for `wam completion`. */
export function shouldNotifyUpdates(input: UpdateNoticeInput): boolean {
  if (input.json || input.quiet || !input.stdoutIsTTY) return false;
  if (input.env.CI !== undefined) return false;
  if (input.env.WAM_NO_UPDATE_NOTIFIER !== undefined && input.env.WAM_NO_UPDATE_NOTIFIER !== "") return false;
  const first = input.argv.find((arg) => !arg.startsWith("-"));
  return first !== "completion";
}

// --- Colour ----------------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const;

export interface Colours {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function createColours(enabled: boolean): Colours {
  const wrap = (code: string) => (s: string) => (enabled ? `${code}${s}${ANSI.reset}` : s);
  return {
    bold: wrap(ANSI.bold),
    dim: wrap(ANSI.dim),
    red: wrap(ANSI.red),
    green: wrap(ANSI.green),
    yellow: wrap(ANSI.yellow),
    cyan: wrap(ANSI.cyan),
  };
}

// --- Tables ----------------------------------------------------------------------------------

export interface TableColumn {
  key: string;
  header: string;
  /** Defaults to right when every non-empty cell in the column is a number, left otherwise. */
  align?: "left" | "right";
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Aligned columns separated by two spaces, numbers right-aligned, no trailing whitespace on a
 * row. Returns the lines joined by newlines with no trailing newline; the caller decides the
 * stream. Headers are printed as given (callers pass upper case where the spec shows it).
 */
export function formatTable(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  columns: ReadonlyArray<TableColumn>,
  opts: { indent?: string; header?: boolean } = {},
): string {
  const indent = opts.indent ?? "";
  const showHeader = opts.header ?? true;
  const cells = rows.map((row) => columns.map((col) => cellText(row[col.key])));
  const aligns = columns.map((col) => {
    if (col.align) return col.align;
    const values = rows.map((row) => row[col.key]).filter((v) => v !== null && v !== undefined && v !== "");
    return values.length > 0 && values.every((v) => typeof v === "number") ? "right" : "left";
  });
  const widths = columns.map((col, i) =>
    Math.max(showHeader ? col.header.length : 0, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  const renderRow = (values: string[]) => {
    const parts = values.map((text, i) => {
      const last = i === values.length - 1;
      if (aligns[i] === "right") return text.padStart(widths[i] ?? 0);
      return last ? text : text.padEnd(widths[i] ?? 0);
    });
    return (indent + parts.join("  ")).replace(/\s+$/, "");
  };
  const lines: string[] = [];
  if (showHeader) lines.push(renderRow(columns.map((c) => c.header)));
  for (const row of cells) lines.push(renderRow(row));
  return lines.join("\n");
}

// --- The output object ------------------------------------------------------------------------

export interface OutputOptions {
  stdout: WritableLike;
  stderr: WritableLike;
  json: boolean;
  quiet: boolean;
  color: boolean;
  debug: boolean;
}

export interface Output extends Colours {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
  readonly debugEnabled: boolean;
  /** Data, to stdout, newline-terminated. */
  data(text: string): void;
  /** Data, to stdout, byte for byte (generated file contents). */
  raw(text: string): void;
  /** Progress and confirmations, to stderr, dropped under `--quiet`. */
  chatter(text: string): void;
  /** A warning, to stderr, printed even under `--quiet`. */
  warn(text: string): void;
  /** Error lines, to stderr, always. */
  error(lines: readonly string[]): void;
  /** Diagnostics, to stderr, only under `--debug`. Callers must never pass a token. */
  debug(text: string): void;
  /** The single JSON document of section 6.2 rule 1. Throws if called twice in one invocation. */
  jsonDocument(value: unknown): void;
  /** One line of newline-delimited JSON (`--wait --json`). */
  ndjson(value: unknown): void;
  /**
   * The section 6.2 rule 4 error object, written by the boundary only. Not guarded like
   * `jsonDocument`, because a command may already have printed its document before failing.
   */
  jsonError(value: unknown): void;
  /** `formatTable` written as data. */
  table(rows: ReadonlyArray<Readonly<Record<string, unknown>>>, columns: ReadonlyArray<TableColumn>, opts?: { indent?: string; header?: boolean }): void;
}

export function createOutput(opts: OutputOptions): Output {
  const colours = createColours(opts.color);
  let documents = 0;
  const line = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
  return {
    ...colours,
    json: opts.json,
    quiet: opts.quiet,
    color: opts.color,
    debugEnabled: opts.debug,
    data(text) {
      opts.stdout.write(line(text));
    },
    raw(text) {
      opts.stdout.write(text);
    },
    chatter(text) {
      if (opts.quiet) return;
      opts.stderr.write(line(text));
    },
    warn(text) {
      opts.stderr.write(line(text));
    },
    error(lines) {
      for (const l of lines) opts.stderr.write(line(l));
    },
    debug(text) {
      if (!opts.debug) return;
      opts.stderr.write(line(`[debug] ${text}`));
    },
    jsonDocument(value) {
      documents += 1;
      if (documents > 1) {
        throw new Error("jsonDocument was called twice in one invocation; --json emits exactly one document");
      }
      opts.stdout.write(`${JSON.stringify(value)}\n`);
    },
    ndjson(value) {
      opts.stdout.write(`${JSON.stringify(value)}\n`);
    },
    jsonError(value) {
      opts.stdout.write(`${JSON.stringify(value)}\n`);
    },
    table(rows, columns, tableOpts) {
      opts.stdout.write(`${formatTable(rows, columns, tableOpts)}\n`);
    },
  };
}
