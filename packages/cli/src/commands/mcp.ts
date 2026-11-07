/**
 * `wam mcp` (10-CLI section 3.8): url, install.
 *
 * `url` prints the hosted MCP endpoint for the resolved organization and workspace and nothing
 * else, so it composes. `install` exists because no single config snippet works everywhere: the
 * file, the top-level key and the remote transport discriminator all differ per client, and the
 * table below is the section 3.8 table, row for row.
 *
 * The five rules of section 3.8, all enforced here:
 *  1. a project-scoped file never receives the raw token: it gets "Bearer ${WAM_TOKEN}" and a
 *     reminder to export it. Only a user-level file (`--global`) gets the literal token, and only
 *     after an explicit confirmation. The same confirmation guards `claude mcp add`;
 *  2. merge, never overwrite: only the `whereamimentioned` entry under the client's top-level key
 *     is set. A file that is JSONC (a comment or a trailing comma), or that does not parse, is
 *     refused and the command falls back to printing the snippet;
 *  3. `--print` writes the snippet to stdout and touches nothing;
 *  4. a backup `<file>.wam-backup-<timestamp>` is written before any in-place edit;
 *  5. Windsurf's two config paths are probed, never assumed.
 *
 * The token is never printed: every echo of an entry carries the placeholder or prefix...last4.
 * All file access goes through node:fs with paths built from the injected cwd and homedir.
 * `claude mcp add` is never run through a shell, because the token is in its argv: on Windows only
 * a native `claude.exe` is launched, and an npm `claude.cmd` shim is named and refused.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Option, type Command } from "commander";
import { isYes, type ConfirmDeps } from "../confirm";
import type { Context, ExecResult } from "../context";
import { CliError, EXIT, usageError } from "../errors";

export const SERVER_NAME = "whereamimentioned";
export const MCP_PATH = "/api/mcp";
export const READONLY_SEGMENT = "readonly";
/** Written literally into project-scoped files. The client, or the user's shell, expands it. */
export const TOKEN_PLACEHOLDER_HEADER = "Bearer ${WAM_TOKEN}";
export const EXPORT_REMINDER = "Export it in your shell:  export WAM_TOKEN=wam_live_...";

export const MCP_CLIENTS = [
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "warp",
  "opencode",
  "amp",
  "jetbrains",
] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];
export type FileClient = Exclude<McpClient, "claude-code">;

export const MCP_SCOPES = ["org", "workspace", "none"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

// --- The URL -----------------------------------------------------------------------------------

export interface ResolvedMcpUrl {
  url: string;
  scope: McpScope;
  org: string | null;
  workspace: string | null;
  readonly: boolean;
}

function noOrgForMcpError(): CliError {
  return new CliError("no_org", EXIT.USAGE, [
    "No organization selected, so the MCP URL cannot be pinned to one.",
    "Pass --org <slug>, set WAM_ORG, or run wam config set org acme. Or pass --scope none.",
  ]);
}

/** `WAM_MCP_URL` when set (section 4.7, for staging), else `<apiUrl>/api/mcp`. No trailing slash. */
export function mcpBaseUrl(ctx: Context): string {
  const override = ctx.primitives.env.WAM_MCP_URL?.trim();
  if (!override) return `${ctx.config().apiUrl.value}${MCP_PATH}`;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw usageError("WAM_MCP_URL must be an absolute URL such as https://whereamimentioned.com/api/mcp.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError("WAM_MCP_URL must be an http or https URL such as https://whereamimentioned.com/api/mcp.");
  }
  return override.replace(/\/+$/, "");
}

/**
 * The endpoint for this invocation. The default scope is the narrowest one that resolves: the
 * workspace when one is resolved, else the organization when one is resolved, else neither. The
 * organization falls back to the stored credential's default org, which is how an org-bound key
 * with no local config still yields a pinned URL.
 */
export async function resolveMcpUrl(
  ctx: Context,
  opts: { scope?: McpScope; readonly: boolean },
): Promise<ResolvedMcpUrl> {
  const base = mcpBaseUrl(ctx);
  const config = ctx.config();
  const workspace = config.workspace.value;
  let org = config.org.value;
  if (org === null && opts.scope !== "none") {
    org = (await ctx.credential())?.record?.org ?? null;
  }

  let scope: McpScope;
  if (opts.scope === undefined) {
    if (workspace !== null && org !== null) scope = "workspace";
    else if (org !== null) scope = "org";
    else {
      scope = "none";
      if (workspace !== null) {
        ctx.out.warn(
          `A workspace is selected (${workspace}) but no organization is, so the URL is not pinned. Pass --org <slug> or set WAM_ORG to pin it.`,
        );
      }
    }
  } else {
    scope = opts.scope;
    if (scope === "workspace") ctx.requireWorkspace();
    if (scope !== "none" && org === null) throw noOrgForMcpError();
  }

  const segments: string[] = [];
  if (scope !== "none" && org !== null) segments.push(encodeURIComponent(org));
  if (scope === "workspace" && workspace !== null) segments.push(encodeURIComponent(workspace));
  if (opts.readonly) segments.push(READONLY_SEGMENT);
  return {
    url: segments.length > 0 ? `${base}/${segments.join("/")}` : base,
    scope,
    org: scope === "none" ? null : org,
    workspace: scope === "workspace" ? workspace : null,
    readonly: opts.readonly,
  };
}

// --- The clients (the section 3.8 table) ---------------------------------------------------------

interface PathEnvironment {
  homedir: string;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface FileClientDefinition {
  /** The client's name in prose. */
  label: string;
  /** What "Restart <x> to pick it up." names. */
  restart: string;
  topLevelKey: string;
  /** Path segments under the working directory, or null when the client has no project-scoped file. */
  projectFile: readonly string[] | null;
  globalFile(e: PathEnvironment): string;
  /** The remote shape. `authorization` is the whole header value. */
  entry(url: string, authorization: string): Record<string, unknown>;
  /** False for the shapes of the table that carry no Authorization header. */
  carriesToken: boolean;
}

function withHeaders(url: string, authorization: string): Record<string, unknown> {
  return { url, headers: { Authorization: authorization } };
}

/** The VS Code user profile `mcp.json`, per platform. */
export function vscodeUserMcpPath(e: PathEnvironment): string {
  if (e.platform === "win32") {
    const appData = e.env.APPDATA ? e.env.APPDATA : join(e.homedir, "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  if (e.platform === "darwin") return join(e.homedir, "Library", "Application Support", "Code", "User", "mcp.json");
  return join(e.homedir, ".config", "Code", "User", "mcp.json");
}

/** Section 3.8 rule 5: the path Windsurf's own documentation gives, and the one seen in the wild. */
export function windsurfDocumentedPath(homedir: string): string {
  return join(homedir, ".codeium", "mcp_config.json");
}

export function windsurfScopedPath(homedir: string): string {
  return join(homedir, ".codeium", "windsurf", "mcp_config.json");
}

/**
 * Writes to whichever of the two exists, falls back to the documented one when neither does, and
 * when both exist picks the documented one and reports the other so the caller can warn.
 */
export function probeWindsurfPath(homedir: string): { path: string; alsoExists: string | null } {
  const documented = windsurfDocumentedPath(homedir);
  const scoped = windsurfScopedPath(homedir);
  const hasDocumented = existsSync(documented);
  const hasScoped = existsSync(scoped);
  if (hasScoped && !hasDocumented) return { path: scoped, alsoExists: null };
  return { path: documented, alsoExists: hasScoped && hasDocumented ? scoped : null };
}

export const FILE_CLIENTS: Readonly<Record<FileClient, FileClientDefinition>> = {
  cursor: {
    label: "Cursor",
    restart: "Cursor",
    topLevelKey: "mcpServers",
    projectFile: [".cursor", "mcp.json"],
    globalFile: (e) => join(e.homedir, ".cursor", "mcp.json"),
    entry: withHeaders,
    carriesToken: true,
  },
  vscode: {
    label: "VS Code",
    restart: "VS Code",
    topLevelKey: "servers",
    projectFile: [".vscode", "mcp.json"],
    globalFile: vscodeUserMcpPath,
    entry: (url) => ({ type: "http", url }),
    carriesToken: false,
  },
  windsurf: {
    label: "Windsurf",
    restart: "Windsurf",
    topLevelKey: "mcpServers",
    projectFile: null,
    globalFile: (e) => windsurfDocumentedPath(e.homedir),
    entry: (url, authorization) => ({ serverUrl: url, headers: { Authorization: authorization } }),
    carriesToken: true,
  },
  zed: {
    label: "Zed",
    restart: "Zed",
    topLevelKey: "context_servers",
    projectFile: null,
    globalFile: (e) => join(e.homedir, ".config", "zed", "settings.json"),
    entry: withHeaders,
    carriesToken: true,
  },
  warp: {
    label: "Warp",
    restart: "Warp",
    topLevelKey: "mcpServers",
    projectFile: [".warp", ".mcp.json"],
    globalFile: (e) => join(e.homedir, ".warp", ".mcp.json"),
    entry: withHeaders,
    carriesToken: true,
  },
  opencode: {
    label: "OpenCode",
    restart: "OpenCode",
    topLevelKey: "mcp",
    projectFile: ["opencode.json"],
    globalFile: (e) => join(e.homedir, ".config", "opencode", "opencode.json"),
    entry: (url) => ({ type: "remote", url, enabled: true }),
    carriesToken: false,
  },
  amp: {
    label: "Amp",
    restart: "Amp",
    // A dotted string key (the VS Code settings convention), not a nested object.
    topLevelKey: "amp.mcpServers",
    projectFile: [".amp", "settings.json"],
    globalFile: (e) => join(e.homedir, ".config", "amp", "settings.json"),
    entry: withHeaders,
    carriesToken: true,
  },
  jetbrains: {
    label: "JetBrains (Junie)",
    restart: "your JetBrains IDE",
    topLevelKey: "mcpServers",
    projectFile: [".junie", "mcp", "mcp.json"],
    globalFile: (e) => join(e.homedir, ".junie", "mcp", "mcp.json"),
    entry: (url, authorization) => ({ type: "streamable-http", url, headers: { Authorization: authorization } }),
    carriesToken: true,
  },
};

/** The argv of the section 3.8 `claude-code` row, after the command name. */
export function claudeCodeArgs(url: string, authorization: string): string[] {
  return ["mcp", "add", "--transport", "http", SERVER_NAME, url, "--header", `Authorization: ${authorization}`];
}

function claudeCodeCommandLine(url: string, authorization: string): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: ${authorization}"`;
}

export type WindowsClaude = { kind: "exe"; path: string } | { kind: "shim"; path: string } | { kind: "none" };

/** The PATH entries of a Windows environment. The variable is spelled `Path` as often as `PATH`. */
function windowsPathEntries(env: PathEnvironment["env"]): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const raw = key === undefined ? "" : (env[key] ?? "");
  return raw
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

const SHIM_EXTENSIONS = [".cmd", ".bat"] as const;

/**
 * How `claude` resolves on Windows without a shell. CreateProcess searches the PATH for
 * `claude.exe` and never for a `.cmd` or `.bat`, so a native install is found and an npm install,
 * which is a `claude.cmd` shim, is not. The shim is probed too, so the failure can name it.
 */
export function findClaudeOnWindows(env: PathEnvironment["env"]): WindowsClaude {
  const dirs = windowsPathEntries(env);
  for (const dir of dirs) {
    const exe = join(dir, "claude.exe");
    if (existsSync(exe)) return { kind: "exe", path: exe };
  }
  for (const dir of dirs) {
    for (const ext of SHIM_EXTENSIONS) {
      const shim = join(dir, `claude${ext}`);
      if (existsSync(shim)) return { kind: "shim", path: shim };
    }
  }
  return { kind: "none" };
}

const PRINT_INSTEAD = "wam mcp install --client claude-code --print prints the exact command to paste into your shell.";

/** `claude` could not be launched: a shim (named when the PATH walk found it) or nothing at all. */
function claudeNotLaunchableError(
  found: { kind: "shim"; path: string | null } | { kind: "none" },
  platform: string,
): CliError {
  const lines =
    found.kind === "shim"
      ? [
          found.path === null
            ? "claude resolved to a .cmd or .bat shim, which this CLI does not launch."
            : `claude was found only as an npm shim (${found.path}), which this CLI does not launch.`,
          "A shim needs a shell, and the API key is in the arguments. Install Claude Code's native build, which puts a claude.exe on your PATH, or paste the command yourself.",
          PRINT_INSTEAD,
        ]
      : [
          platform === "win32"
            ? "claude was not found: neither a claude.exe nor an npm claude.cmd shim is on your PATH."
            : "claude was not found on your PATH.",
          `Install Claude Code, or paste the command yourself. ${PRINT_INSTEAD}`,
        ];
  return new CliError("unknown", EXIT.FAILURE, lines, {
    details: { client: "claude-code", reason: found.kind === "shim" ? "shim" : "not_found", path: found.kind === "shim" ? found.path : null },
  });
}

/**
 * Runs `claude` with the argv and never through a shell: the bearer token is in the arguments and
 * would need escaping. On Windows an npm install is a `claude.cmd` shim, which a shell-less spawn
 * either never resolves (ENOENT) or, from Node 18.20 and 20.12, refuses outright (EINVAL), so only
 * a native `claude.exe` is launched and a shim is named in the failure instead of being tried.
 */
async function runClaude(ctx: Context, args: string[]): Promise<ExecResult> {
  const { platform, env, exec } = ctx.primitives;
  if (platform !== "win32") {
    const result = await exec("claude", args);
    if (result.spawnError === "ENOENT") throw claudeNotLaunchableError({ kind: "none" }, platform);
    return result;
  }
  const found = findClaudeOnWindows(env);
  if (found.kind === "shim") throw claudeNotLaunchableError(found, platform);
  const result = await exec(found.kind === "exe" ? found.path : "claude.exe", args);
  if (result.spawnError === "EINVAL") throw claudeNotLaunchableError({ kind: "shim", path: null }, platform);
  if (result.spawnError === "ENOENT") throw claudeNotLaunchableError({ kind: "none" }, platform);
  return result;
}

// --- Snippets, files and backups -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `.cursor/mcp.json` for a project file, `~/.cursor/mcp.json` for one under home, else absolute. */
export function displayMcpPath(path: string, e: { cwd: string; homedir: string }, project: boolean): string {
  if (project) return toPosix(relative(e.cwd, path));
  const fromHome = relative(e.homedir, path);
  if (fromHome !== "" && !fromHome.startsWith("..") && !isAbsolute(fromHome)) return `~/${toPosix(fromHome)}`;
  return toPosix(path);
}

/** The entry under its top-level key, two-space indented, with `headers` on one line as section 3.8 shows it. */
export function formatSnippet(topLevelKey: string, entry: Record<string, unknown>): string {
  const text = JSON.stringify({ [topLevelKey]: { [SERVER_NAME]: entry } }, null, 2);
  return text.replace(/"headers": \{\s*\n\s*("Authorization": "[^"\n]*")\s*\n\s*\}/, '"headers": { $1 }');
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${prefix}${line}`))
    .join("\n");
}

/** `20260828T091802Z`: the ISO timestamp with the separators and the milliseconds removed. */
export function compactTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/**
 * True when the text is JSONC rather than JSON: a line or block comment, or a trailing comma,
 * outside any string. Rewriting such a file through JSON.parse would destroy exactly those.
 */
export function looksLikeJsonc(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return true;
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "}" || text[j] === "]") return true;
    }
  }
  return false;
}

export type ExistingConfig =
  | { state: "absent" }
  | { state: "ok"; bytes: Buffer; json: Record<string, unknown> }
  | { state: "refused"; lines: string[] };

const NOTHING_WRITTEN = "Nothing was written. Add the entry below yourself, under";

/** Reads the client's config for a merge. Anything that cannot be merged safely is refused, not healed. */
export function readExistingConfig(path: string, display: string, topLevelKey: string): ExistingConfig {
  if (!existsSync(path)) return { state: "absent" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new CliError("unknown", EXIT.FAILURE, [
      `Could not read ${display}: ${err instanceof Error ? err.message : String(err)}.`,
      "Run again with --print to see the snippet and write nothing.",
    ]);
  }
  const decoded = bytes.toString("utf8");
  // A leading byte order mark is legal in a JSON file on disk and fatal to JSON.parse.
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  const tail = `${NOTHING_WRITTEN} "${topLevelKey}":`;
  if (text.trim() === "") return { state: "ok", bytes, json: {} };
  if (looksLikeJsonc(text)) {
    return {
      state: "refused",
      lines: [`${display} contains comments or trailing commas (JSONC), and rewriting it would destroy them.`, tail],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: "refused",
      lines: [
        `${display} is not valid JSON (${err instanceof Error ? err.message : String(err)}), so it cannot be merged safely.`,
        tail,
      ],
    };
  }
  if (!isRecord(parsed)) {
    return { state: "refused", lines: [`${display} does not contain a JSON object, so it cannot be merged safely.`, tail] };
  }
  if (parsed[topLevelKey] !== undefined && !isRecord(parsed[topLevelKey])) {
    return {
      state: "refused",
      lines: [`"${topLevelKey}" in ${display} is not a JSON object, so the entry cannot be merged into it.`, tail],
    };
  }
  return { state: "ok", bytes, json: parsed };
}

/** Sets only `<topLevelKey>.whereamimentioned`. Every other key and server keeps its value and its position. */
export function mergeEntry(
  json: Record<string, unknown>,
  topLevelKey: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const servers = isRecord(json[topLevelKey]) ? json[topLevelKey] : {};
  return { ...json, [topLevelKey]: { ...servers, [SERVER_NAME]: entry } };
}

/** Rule 4: the original bytes, next to the file, before the edit. Never overwrites an earlier backup. */
function writeBackup(path: string, bytes: Buffer, now: Date): string {
  const base = `${path}.wam-backup-${compactTimestamp(now)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      writeFileSync(candidate, bytes, { flag: "wx", mode: 0o600 });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new CliError("unknown", EXIT.FAILURE, [`Could not write a backup next to ${path}, so nothing was changed.`]);
}

// --- The confirmation of rule 1 ---------------------------------------------------------------------

function readLine(stdin: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    rl.once("line", (line) => {
      if (settled) return;
      settled = true;
      resolve(line);
      rl.close();
    });
    rl.once("close", () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}

async function ask(deps: ConfirmDeps, question: string): Promise<boolean | null> {
  if (deps.prompt) return deps.prompt(question);
  if (deps.stdinIsTTY) {
    try {
      const clack = await import("@clack/prompts");
      const answer = await clack.confirm({ message: question.replace(/\s*\(y\/N\)\s*$/, ""), initialValue: false });
      return clack.isCancel(answer) ? null : answer === true;
    } catch {
      // The prompt library could not render (no terminal after all): fall back to a plain line.
    }
  }
  deps.stderr.write(`${question} `);
  const line = await readLine(deps.stdin);
  return line === null ? null : isYes(line);
}

/**
 * Same answer rules as confirm.ts: the default is No, `--yes` skips the prompt, and a context
 * that cannot prompt is a usage error naming the flag. The reason is this command's own: a token
 * is about to leave the credential store in plain text.
 */
export async function confirmTokenLeaves(
  deps: ConfirmDeps,
  opts: { reason: string; question: string; cannotPrompt: string; cancelled: string },
): Promise<boolean> {
  if (deps.yes) return true;
  if (!deps.interactive) {
    throw usageError(opts.cannotPrompt, "Pass --yes to confirm, or --print to see the snippet and write nothing.");
  }
  deps.stderr.write(`${opts.reason}\n`);
  const answer = await ask(deps, opts.question);
  if (answer === true) return true;
  deps.stderr.write(`${opts.cancelled}\n`);
  return false;
}

// --- install -----------------------------------------------------------------------------------------

interface InstallOptions {
  client: McpClient;
  readonly?: boolean;
  scope?: McpScope;
  global?: boolean;
  print?: boolean;
}

function redact(text: string, token: string, display: string): string {
  return text.split(token).join(display);
}

async function installClaudeCode(ctx: Context, url: string, opts: InstallOptions): Promise<void> {
  const { out } = ctx;
  if (opts.print) {
    const line = claudeCodeCommandLine(url, TOKEN_PLACEHOLDER_HEADER);
    if (out.json) {
      out.jsonDocument({ ok: true, client: "claude-code", written: false, executed: false, url, command: line });
      return;
    }
    out.data(line);
    out.chatter("Nothing was run. The token is never printed.");
    out.chatter(EXPORT_REMINDER);
    return;
  }

  const credential = await ctx.requireCredential();
  const shown = claudeCodeCommandLine(url, `Bearer ${credential.display}`);
  const confirmed = await confirmTokenLeaves(ctx.confirmDeps(), {
    reason: `This passes your API key (${credential.display}) to claude mcp add, which stores it in Claude Code's own config.`,
    question: "Continue? (y/N)",
    cannotPrompt: "This command passes your API key to claude mcp add and cannot prompt for confirmation here.",
    cancelled: "Cancelled. Nothing was changed.",
  });
  if (!confirmed) return;

  const result = await runClaude(ctx, claudeCodeArgs(url, `Bearer ${credential.token}`));
  if (result.code !== 0) {
    const detail = redact(result.stderr.trim() || result.stdout.trim(), credential.token, credential.display);
    const lines = [
      result.spawnError === undefined
        ? `claude mcp add failed with exit code ${result.code}.`
        : `claude could not be started (${result.spawnError}).`,
    ];
    const firstLine = detail.split("\n")[0];
    if (firstLine) lines.push(firstLine);
    lines.push("Check that the claude command is installed and on your PATH, or run again with --print to see the command.");
    throw new CliError("unknown", EXIT.FAILURE, lines);
  }
  if (out.json) {
    out.jsonDocument({ ok: true, client: "claude-code", written: false, executed: true, url, command: shown });
    return;
  }
  out.chatter(`Ran ${shown}`);
  out.chatter("Restart Claude Code to pick it up.");
}

async function installFileClient(ctx: Context, client: FileClient, url: string, opts: InstallOptions): Promise<void> {
  const { out, primitives } = ctx;
  const def = FILE_CLIENTS[client];
  const pathEnv: PathEnvironment = { homedir: primitives.homedir, platform: primitives.platform, env: primitives.env };
  const project = opts.global !== true && def.projectFile !== null;

  let path: string;
  let windsurfOther: string | null = null;
  if (project && def.projectFile !== null) {
    path = join(primitives.cwd, ...def.projectFile);
  } else if (client === "windsurf") {
    const probe = probeWindsurfPath(primitives.homedir);
    path = probe.path;
    windsurfOther = probe.alsoExists;
  } else {
    path = def.globalFile(pathEnv);
  }
  const display = displayMcpPath(path, primitives, project);
  const target = project ? "project" : "global";
  const placeholderEntry = def.entry(url, TOKEN_PLACEHOLDER_HEADER);
  const placeholderSnippet = formatSnippet(def.topLevelKey, placeholderEntry);
  const snippetObject = (entry: Record<string, unknown>) => ({ [def.topLevelKey]: { [SERVER_NAME]: entry } });

  // Rule 3: the snippet on stdout, nothing touched, no credential read, no token anywhere.
  if (opts.print) {
    if (out.json) {
      out.jsonDocument({
        ok: true,
        client,
        target,
        path,
        written: false,
        backup: null,
        url,
        topLevelKey: def.topLevelKey,
        snippet: snippetObject(placeholderEntry),
      });
      return;
    }
    out.data(placeholderSnippet);
    out.chatter(`Snippet for ${def.label} (${display}). Nothing was written.`);
    if (def.carriesToken) {
      out.chatter("The token is never printed.");
      out.chatter(EXPORT_REMINDER);
    }
    return;
  }

  if (!project && opts.global !== true) {
    out.chatter(`${def.label} has no project-scoped config file, so this uses the user-level one.`);
  }

  // Rule 1: only a user-level file gets the literal token. A project-scoped one never reads it.
  const literal = !project && def.carriesToken;
  const credential = literal ? await ctx.requireCredential() : null;

  // Rule 2: read before asking anything, so a file that cannot be merged is refused up front.
  const existing = readExistingConfig(path, display, def.topLevelKey);
  if (existing.state === "refused") {
    const refusal = new CliError("unknown", EXIT.FAILURE, existing.lines, {
      details: { path, topLevelKey: def.topLevelKey, snippet: snippetObject(placeholderEntry) },
    });
    if (out.json) out.jsonError(refusal.toJsonObject());
    else {
      out.error(refusal.lines);
      out.data(placeholderSnippet);
    }
    ctx.setExitCode(refusal.exitCode);
    return;
  }

  if (credential) {
    const confirmed = await confirmTokenLeaves(ctx.confirmDeps(), {
      reason: `This writes your API key (${credential.display}) into ${display} in plain text.`,
      question: "Write it? (y/N)",
      cannotPrompt: `This command writes your API key into ${display} and cannot prompt for confirmation here.`,
      cancelled: "Cancelled. Nothing was written.",
    });
    if (!confirmed) return;
  }

  const fileEntry = def.entry(url, credential ? `Bearer ${credential.token}` : TOKEN_PLACEHOLDER_HEADER);
  const shownEntry = def.entry(url, credential ? `Bearer ${credential.display}` : TOKEN_PLACEHOLDER_HEADER);
  const merged = mergeEntry(existing.state === "ok" ? existing.json : {}, def.topLevelKey, fileEntry);

  mkdirSync(dirname(path), { recursive: true });
  const backupPath = existing.state === "ok" ? writeBackup(path, existing.bytes, primitives.now()) : null;
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: literal ? 0o600 : 0o666 });
  // `mode` above applies only when the write creates the file: an existing config keeps its old
  // bits. A file that now carries the token is tightened explicitly. Windows has no bits to set.
  if (literal && primitives.platform !== "win32") chmodSync(path, 0o600);

  const otherDisplay = windsurfOther === null ? null : displayMcpPath(windsurfOther, primitives, false);
  const bothExist =
    otherDisplay === null
      ? null
      : `Both ${display} and ${otherDisplay} exist. Wrote the documented one. If ${def.label} does not show the server, add the same entry to ${otherDisplay}.`;

  if (out.json) {
    if (bothExist) out.warn(bothExist);
    out.jsonDocument({
      ok: true,
      client,
      target,
      path,
      written: true,
      backup: backupPath,
      url,
      topLevelKey: def.topLevelKey,
      snippet: snippetObject(shownEntry),
    });
    return;
  }

  out.chatter(`Wrote ${display}`);
  out.chatter("");
  out.chatter(indent(formatSnippet(def.topLevelKey, shownEntry), "  "));
  out.chatter("");
  if (!def.carriesToken) {
    out.chatter(`No Authorization header is written for ${def.label}, so it starts with the no-account site tools.`);
  } else if (project) {
    out.chatter("This file is project scoped, so the token is not written into it.");
    out.chatter(EXPORT_REMINDER);
  } else {
    out.chatter("The token was written into this file in plain text. Anyone who can read the file can use the key.");
  }
  if (backupPath) out.chatter(`Backup written to ${displayMcpPath(backupPath, primitives, project)}`);
  if (bothExist) out.warn(bothExist);
  out.chatter(`Restart ${def.restart} to pick it up.`);
}

// --- Registration --------------------------------------------------------------------------------------

function scopeOption(): Option {
  return new Option(
    "--scope <scope>",
    "Pin the URL to the organization, the workspace, or neither (default: the narrowest one that resolves)",
  ).choices([...MCP_SCOPES]);
}

export function registerMcpCommands(program: Command, getContext: () => Context): void {
  const mcp = program
    .command("mcp")
    .description("Print the MCP server URL or install it into an AI client")
    .addHelpText(
      "after",
      `
Examples:
  $ wam mcp url --readonly
  $ wam mcp install --client cursor
`,
    );

  mcp
    .command("url")
    .description("Print the MCP endpoint URL for the resolved organization and workspace, and nothing else")
    .option("--readonly", "Append /readonly, which drops every tool that writes")
    .addOption(scopeOption())
    .addHelpText(
      "after",
      `
WAM_MCP_URL overrides the endpoint, for staging.

Examples:
  $ wam mcp url
  $ wam mcp url --readonly --scope org
`,
    )
    .action(async (opts: { readonly?: boolean; scope?: McpScope }) => {
      const ctx = getContext();
      const resolved = await resolveMcpUrl(ctx, { scope: opts.scope, readonly: opts.readonly === true });
      if (ctx.out.json) {
        ctx.out.jsonDocument(resolved);
        return;
      }
      ctx.out.data(resolved.url);
    });

  mcp
    .command("install")
    .description("Add the whereamimentioned MCP server to an AI client's config, merging and backing up")
    .addOption(
      new Option("--client <client>", "The client to install into").choices([...MCP_CLIENTS]).makeOptionMandatory(),
    )
    .option("--readonly", "Install the /readonly endpoint, which drops every tool that writes")
    .addOption(scopeOption())
    .option("--global", "Write the user-level config instead of the project one. Writes the literal token, after a confirmation")
    .option("--print", "Write the snippet to stdout and touch nothing")
    .addHelpText(
      "after",
      `
A project-scoped file gets "Bearer \${WAM_TOKEN}" and never the token itself. Only --global writes
the literal token, and only after a confirmation, which -y, --yes answers. windsurf and zed have no
project-scoped file, so they always use the user-level one. claude-code runs claude mcp add, never
through a shell: on Windows that needs the native claude.exe, not the npm claude.cmd shim.
An existing config is merged, never overwritten, and a backup is written next to it first.
A file with comments or trailing commas is left alone and the snippet is printed instead.

Examples:
  $ wam mcp install --client cursor
  $ wam mcp install --client vscode --print
  $ wam mcp install --client windsurf --readonly --yes
`,
    )
    .action(async (opts: InstallOptions) => {
      const ctx = getContext();
      const resolved = await resolveMcpUrl(ctx, { scope: opts.scope, readonly: opts.readonly === true });
      if (opts.client === "claude-code") {
        await installClaudeCode(ctx, resolved.url, opts);
        return;
      }
      await installFileClient(ctx, opts.client, resolved.url, opts);
    });
}
