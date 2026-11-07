/**
 * `wam`: program assembly, global flags, the error boundary and exit codes (10-CLI section 2.4).
 *
 * `main(argv, overrides)` returns the exit code instead of calling `process.exit`, so tests run
 * commands in-process with fake primitives and never spawn. The binary entry at the bottom is the
 * only place `process.exitCode` is set.
 *
 * The boundary renders every failure exactly once: a `CliError` as its stderr lines, or under
 * `--json` as the section 6.2 rule 4 object on stdout; a commander parse failure as a usage error
 * (exit 2) with short help; anything else as a generic line (exit 1) with the stack on stderr under
 * `--debug`. It never exits 0 on an error (section 9.2).
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { registerCommands } from "./commands";
import { createContext, type Context, type ContextOverrides, type GlobalFlags } from "./context";
import { CliError, EXIT, formatExitCodeTable } from "./errors";
import { shouldNotifyUpdates } from "./output";
import { VERSION } from "./version";

export const PACKAGE_NAME = "@whereamimentioned/cli";
const DESCRIPTION =
  "Track and score your brand's visibility in AI answers, from the terminal and from CI.";
const DOCS_URL = "https://whereamimentioned.com/docs/cli";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Section 11.1: the exit-code table, the free-read note of section 8.1 rule 6, three examples, and the telemetry line. */
export const HELP_AFTER = `
Exit codes:
${formatExitCodeTable()}

Read commands spend no credits: wam scan estimate, wam scan list, wam scan evidence,
wam report get, wam prompt list, wam competitor list, wam org list, wam workspace list
and every wam site command.

Examples:
  $ npx ${PACKAGE_NAME} site check-crawlers acme.com
  $ wam auth login
  $ wam scan run --wait --fail-under 55 --yes

This CLI sends no telemetry.
Docs: ${DOCS_URL}
`;

/** The global flags of section 3.0, added to the real program and to the pre-parse. */
function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--json", "Emit a single JSON document on stdout (NDJSON for --wait). Suppresses human formatting")
    .option("-q, --quiet", "Suppress progress, spinners and non-essential stderr. Errors still print")
    .option("--color", "Force ANSI colour on. Overrides NO_COLOR, a non-TTY stdout and TERM=dumb. Ignored under --json")
    .option("--no-color", "Disable ANSI colour. Also off when NO_COLOR is set, stdout is not a TTY, or TERM=dumb")
    .option(
      "--non-interactive",
      "Never prompt. Automatic when stdout is not a TTY, CI is set, --json is passed, or an agent is detected",
    )
    .option("-y, --yes", "Answer yes to confirmations. Required for any money-spending command when not interactive")
    .option("--debug", "Verbose diagnostics on stderr: request ids, config sources, HTTP status lines. Never the token")
    .option("--org <slug>", "Select the organization for this invocation (required on an account-wide key)")
    .option("--workspace <slug>", "Override the workspace for this invocation")
    .option("--token <token>", "Override the credential. Prefer WAM_TOKEN: arguments leak into shell history")
    .option("--api-url <url>", "Override the API origin, for staging (default: https://whereamimentioned.com)")
    .option("--profile <name>", "Select a named credential and config profile (default: default)");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Commander's `opts()` for the global options, as a `GlobalFlags`. */
export function flagsFromOpts(opts: Record<string, unknown>): GlobalFlags {
  return {
    json: opts.json === true,
    quiet: opts.quiet === true,
    color: typeof opts.color === "boolean" ? opts.color : undefined,
    nonInteractive: opts.nonInteractive === true,
    yes: opts.yes === true,
    debug: opts.debug === true,
    org: str(opts.org),
    workspace: str(opts.workspace),
    token: str(opts.token),
    apiUrl: str(opts.apiUrl),
    profile: str(opts.profile),
  };
}

/**
 * Reads the global flags before the real parse, so the Context (and with it the output mode the
 * boundary renders in) exists before any command runs. Unknown options and operands are ignored
 * here; the real program rejects them.
 */
export function preparseGlobalFlags(argv: readonly string[]): {
  flags: GlobalFlags;
  operands: string[];
  unknown: string[];
} {
  const scanner = addGlobalOptions(new Command("wam"))
    .option("-V, --version")
    .option("-h, --help")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
  const parsed = scanner.parseOptions([...argv]);
  return { flags: flagsFromOpts(scanner.opts()), operands: parsed.operands, unknown: parsed.unknown };
}

/** `wam config get`, from the failing command up to the root. */
function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

type TaggedCommanderError = CommanderError & { command?: Command };

/** Section 11.1: missing arguments print short help, not full help, then exit 2. */
function usageErrorFromCommander(err: TaggedCommanderError): CliError | null {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return null;
  const cmd = err.command;
  const path = cmd ? commandPath(cmd) : "wam";
  const message = err.message.trim();
  const lines: string[] = [];
  switch (err.code) {
    case "commander.help":
      // A group invoked without a subcommand: commander already printed its help on stderr.
      break;
    case "commander.missingArgument":
      lines.push(message);
      if (cmd) lines.push(`Usage: ${path} ${cmd.usage()}`);
      lines.push(`Run ${path} --help for the full help.`);
      break;
    case "commander.unknownCommand":
      lines.push(message, `Run ${path} --help to see the commands.`);
      break;
    case "commander.unknownOption":
      lines.push(message, `Run ${path} --help to see the options.`);
      break;
    default:
      lines.push(message, `Run ${path} --help for the full help.`);
      break;
  }
  return new CliError("usage_error", EXIT.USAGE, lines);
}

export function buildProgram(getContext: () => Context, io: { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }): Command {
  const program = new Command("wam");
  // Set before any subcommand exists: commander copies both settings into subcommands at creation.
  // `this` is the command that failed, which is how missing arguments get their short help.
  program.exitOverride(function (this: Command, err: CommanderError) {
    (err as TaggedCommanderError).command = this;
    throw err;
  });
  program.configureOutput({
    writeOut: (s) => io.stdout.write(s),
    writeErr: (s) => io.stderr.write(s),
    // The boundary renders parse errors, so they obey --json and carry short help.
    outputError: () => {},
  });
  addGlobalOptions(
    program
      .description(DESCRIPTION)
      .version(VERSION, "-V, --version", "Print the version and exit 0")
      .helpOption("-h, --help", "Print help and exit 0"),
  )
    .addHelpText("after", HELP_AFTER)
    .showHelpAfterError(false)
    .showSuggestionAfterError(true);
  registerCommands(program, getContext);
  return program;
}

/** `wam --version --json` (section 11.1). The API version comes from the contract package. */
async function versionJson(): Promise<string> {
  const { SUPPORTED_API_VERSION } = await import("@whereamimentioned/api-client");
  return JSON.stringify({ version: VERSION, node: process.version, apiVersion: SUPPORTED_API_VERSION });
}

interface UpdateAvailable {
  current: string;
  latest: string;
}

/**
 * Section 11.2. `update-notifier` reads the result of the previous background check and spawns
 * the next one detached; this never waits on the network. Loaded lazily so the module costs
 * nothing on the paths that suppress it.
 */
async function checkForUpdate(): Promise<UpdateAvailable | null> {
  const mod = await import("update-notifier");
  const notifier = mod.default({
    pkg: { name: PACKAGE_NAME, version: VERSION },
    updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
  });
  const update = notifier.update;
  return update && update.latest !== update.current ? { current: update.current, latest: update.latest } : null;
}

/**
 * `wam auth login --token` with no value means "read the key from stdin" (section 3.2), but the
 * global `--token <token>` of section 3.0 is declared on the program, so commander hands it any
 * `--token` wherever it appears and rejects a bare one as a missing argument (or, worse, takes
 * the next flag as the value). Only on `auth login`, a `--token` that is last or is followed by
 * another flag is rewritten to `--token=`: the empty value reads as "no override" globally and as
 * "read stdin" in the login action. Every other command keeps the strict missing-argument error.
 */
export function normalizeBareLoginToken(argv: readonly string[]): string[] {
  const args = [...argv];
  const operands = args.filter((a) => !a.startsWith("-"));
  const authAt = operands.indexOf("auth");
  if (authAt === -1 || operands[authAt + 1] !== "login") return args;
  return args.map((arg, i) => {
    if (arg !== "--token") return arg;
    const next = args[i + 1];
    return next === undefined || next.startsWith("-") ? "--token=" : arg;
  });
}

export async function main(argv: readonly string[], overrides: ContextOverrides = {}): Promise<number> {
  const args = normalizeBareLoginToken(argv);

  // Flags first, so the boundary already renders in the right mode if the parse itself fails.
  let pre: { flags: GlobalFlags; operands: string[]; unknown: string[] };
  try {
    pre = preparseGlobalFlags(args);
  } catch (err) {
    pre = {
      flags: {
        ...flagsFromOpts({}),
        json: args.includes("--json"),
        quiet: args.includes("--quiet") || args.includes("-q"),
        debug: args.includes("--debug"),
      },
      operands: [],
      unknown: [...args],
    };
    if (!(err instanceof CommanderError)) throw err;
  }
  const ctx = createContext({ ...overrides, argv: args, flags: { ...pre.flags, ...overrides.flags } });
  const { out } = ctx;

  if (args.includes("--version") || args.includes("-V")) {
    out.data(ctx.flags.json ? await versionJson() : VERSION);
    return EXIT.OK;
  }

  let updateCheck: Promise<UpdateAvailable | null> | null = null;
  if (
    shouldNotifyUpdates({
      json: ctx.flags.json,
      quiet: ctx.flags.quiet,
      stdoutIsTTY: ctx.primitives.isTTY.stdout,
      env: ctx.primitives.env,
      // The operands, not the raw arguments: in `wam --org acme completion zsh` the command is
      // `completion`, and the notice must stay out of that stdout too (section 11.2).
      argv: pre.operands.length > 0 ? pre.operands : args,
    })
  ) {
    updateCheck = checkForUpdate().catch(() => null);
  }

  const program = buildProgram(() => ctx, { stdout: ctx.primitives.stdout, stderr: ctx.primitives.stderr });

  let code: number;
  try {
    // Bare `wam` (global flags only, nothing unknown) prints help and exits 0. Anything unknown
    // goes through the real parse so it is rejected as a usage error, never swallowed as help.
    if (pre.operands.length === 0 && pre.unknown.length === 0 && !args.includes("--help") && !args.includes("-h")) {
      program.outputHelp();
      code = EXIT.OK;
    } else {
      await program.parseAsync(args, { from: "user" });
      code = ctx.exitCode;
    }
  } catch (err) {
    code = renderFailure(err, ctx);
  }

  if (updateCheck) {
    // Never blocking: only a check that has already finished gets to print.
    const info = await Promise.race([updateCheck, Promise.resolve(null)]);
    if (info) {
      out.chatter(`Update available: ${info.current} to ${info.latest}`);
      out.chatter(`Run npm install -g ${PACKAGE_NAME} to update.`);
    }
  }
  return code;
}

/** The error boundary. Returns the exit code, never 0. */
function renderFailure(err: unknown, ctx: Context): number {
  const { out } = ctx;
  if (err instanceof CommanderError) {
    const usage = usageErrorFromCommander(err as TaggedCommanderError);
    if (usage === null) return EXIT.OK;
    return renderCliError(usage, ctx);
  }
  if (err instanceof CliError) return renderCliError(err, ctx);
  const message = err instanceof Error ? err.message : String(err);
  const generic = new CliError("unknown", EXIT.FAILURE, [
    `Something went wrong: ${message}`,
    "Run again with --debug to see the stack trace.",
  ]);
  const code = renderCliError(generic, ctx);
  if (ctx.flags.debug && err instanceof Error && err.stack) out.debug(err.stack);
  return code;
}

function renderCliError(err: CliError, ctx: Context): number {
  // Section 7.4: the threshold gate goes to stderr even under --json, because the report object
  // on stdout is the data the caller asked for.
  if (ctx.out.json && err.code !== "threshold_not_met") {
    ctx.out.jsonError(err.toJsonObject());
  } else if (err.lines.length > 0) {
    ctx.out.error(err.lines);
  }
  return err.exitCode === 0 ? EXIT.FAILURE : err.exitCode;
}

const invokedAsBinary = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // realpath, because a `bin` symlink names the link and import.meta.url names the target.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsBinary) {
  // `wam --help | head` closes stdout early. That is not a failure and earns no stack trace.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT.FAILURE;
    },
  );
}
