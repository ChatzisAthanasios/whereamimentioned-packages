/**
 * Configuration (10-CLI section 5): discovery, precedence and read/write.
 *
 * Precedence, highest first: command-line flag, environment variable, the nearest `wam.json`
 * found by walking up from the working directory (stopping at a directory that contains `.git`
 * or at the filesystem root), the user config, the built-in default. Both files are parsed with
 * `.strict()` schemas: an unknown key is a usage error (exit 2) naming the file and the valid
 * options, never a silent ignore, because a typo'd `workSpace` that does nothing is exactly how a
 * CI job scans the wrong brand.
 *
 * `apiUrl` is a user-config key ONLY. A `wam.json` is committed with the code it ships in, so a
 * repository someone cloned would otherwise get to decide where that person's API key is sent:
 * one file in a downloaded project, and the next `wam` command posts the token to a stranger's
 * server. The project file therefore refuses the key outright (exit 2, naming the alternatives)
 * rather than ignoring it.
 *
 * `wam config set` writes only the user config. Nothing here ever writes `wam.json`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { CliError, EXIT, unknownConfigKeyError, usageError } from "./errors";
import type { Env } from "./output";

export const DEFAULT_API_URL = "https://whereamimentioned.com";
export const DEFAULT_PROFILE = "default";
export const PROJECT_CONFIG_FILENAME = "wam.json";
export const USER_CONFIG_FILENAME = "config.json";
export const CONFIG_DIR_NAME = "whereamimentioned";

/** The settable keys of section 3.3, which are also the per-profile keys of the user config. */
export const CONFIG_KEYS = ["org", "workspace", "apiUrl", "failUnder"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** The keys `wam.json` may carry (section 5.2): the settable keys minus `apiUrl`, see the module comment. */
export const PROJECT_CONFIG_KEYS = ["org", "workspace", "failUnder"] as const;

/** Section 5.2. No `apiUrl`, on purpose: a committed file never chooses where a key is sent. */
export const projectConfigSchema = z
  .object({
    $schema: z.string().optional(),
    org: z.string().trim().min(1).optional(),
    workspace: z.string().trim().min(1).optional(),
    failUnder: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** One profile of the user config (section 5.3): the same four keys, same discipline. */
export const userProfileSchema = z
  .object({
    org: z.string().trim().min(1).optional(),
    workspace: z.string().trim().min(1).optional(),
    apiUrl: z.string().url().optional(),
    failUnder: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type UserProfile = z.infer<typeof userProfileSchema>;

export const USER_CONFIG_TOP_KEYS = ["version", "activeProfile", "profiles"] as const;

export const userConfigSchema = z
  .object({
    version: z.literal(1),
    activeProfile: z.string().trim().min(1).optional(),
    profiles: z.record(z.string(), userProfileSchema),
  })
  .strict();
export type UserConfig = z.infer<typeof userConfigSchema>;

/** What path resolution needs from the invocation. Injected, so tests use temp dirs. */
export interface ConfigEnvironment {
  env: Env;
  cwd: string;
  homedir: string;
  platform: string;
}

// --- Paths -----------------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function envValue(env: Env, name: string): string | null {
  const v = env[name];
  return v !== undefined && v !== "" ? v : null;
}

/**
 * `WAM_CONFIG_DIR` overrides everything. Otherwise `%APPDATA%\whereamimentioned` on Windows and
 * `${XDG_CONFIG_HOME:-~/.config}/whereamimentioned` elsewhere (sections 4.5 and 5.1).
 */
export function userConfigDir(e: ConfigEnvironment): string {
  const override = envValue(e.env, "WAM_CONFIG_DIR");
  if (override) return resolve(override);
  if (e.platform === "win32") {
    const appData = envValue(e.env, "APPDATA") ?? join(e.homedir, "AppData", "Roaming");
    return join(appData, CONFIG_DIR_NAME);
  }
  const xdg = envValue(e.env, "XDG_CONFIG_HOME");
  return join(xdg ?? join(e.homedir, ".config"), CONFIG_DIR_NAME);
}

export function userConfigPath(e: ConfigEnvironment): string {
  return join(userConfigDir(e), USER_CONFIG_FILENAME);
}

/**
 * `./wam.json` for a file under cwd, `~/...` for one under the home directory, `../wam.json` for
 * one above cwd that is not under home, else absolute (a different drive, or outside both).
 */
export function displayPath(path: string, e: ConfigEnvironment): string {
  const rel = relative(e.cwd, path);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return `./${toPosix(rel)}`;
  const home = relative(e.homedir, path);
  if (home !== "" && !home.startsWith("..") && !isAbsolute(home)) return `~/${toPosix(home)}`;
  if (rel !== "" && !isAbsolute(rel)) return toPosix(rel);
  return toPosix(path);
}

/** The nearest `wam.json` at or above `cwd`, stopping after a directory that contains `.git`. */
export function findProjectConfig(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (isFile(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// --- Reading ---------------------------------------------------------------------------------

interface IssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
  keys?: string[];
}

function parseJsonFile(path: string, display: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw usageError(`Could not read ${display}: ${err instanceof Error ? err.message : String(err)}.`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw usageError(`Could not parse ${display}: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenFieldError(display: string): CliError {
  return usageError(
    `${display} must not contain a token.`,
    `Remove the "token" field from ${display} and use WAM_TOKEN or wam auth login instead.`,
  );
}

function issueError(issue: IssueLike, display: string, validFor: (path: PropertyKey[]) => readonly string[]): CliError {
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys?.[0] ?? "?";
    return unknownConfigKeyError(key, display, validFor(issue.path));
  }
  const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  return new CliError("usage_error", EXIT.USAGE, [`Invalid value for "${where}" in ${display}: ${issue.message}.`]);
}

function projectApiUrlError(display: string): CliError {
  return usageError(
    `${display} must not set apiUrl: a committed project file cannot choose where your API key is sent.`,
    `Remove "apiUrl" from ${display} and set the server with WAM_API_URL, --api-url or wam config set apiUrl.`,
  );
}

export function readProjectConfig(path: string, e: ConfigEnvironment): ProjectConfig {
  const display = displayPath(path, e);
  const raw = parseJsonFile(path, display);
  if (!isRecord(raw)) throw usageError(`${display} must contain a JSON object.`);
  if ("token" in raw) throw tokenFieldError(display);
  if ("apiUrl" in raw) throw projectApiUrlError(display);
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as IssueLike | undefined;
    if (issue) throw issueError(issue, display, () => PROJECT_CONFIG_KEYS);
    throw usageError(`Could not parse ${display}.`);
  }
  return parsed.data;
}

export function readUserConfig(path: string, e: ConfigEnvironment): UserConfig | null {
  if (!isFile(path)) return null;
  const display = displayPath(path, e);
  const raw = parseJsonFile(path, display);
  if (!isRecord(raw)) throw usageError(`${display} must contain a JSON object.`);
  if (isRecord(raw.profiles)) {
    for (const profile of Object.values(raw.profiles)) {
      if (isRecord(profile) && "token" in profile) throw tokenFieldError(display);
    }
  }
  const parsed = userConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as IssueLike | undefined;
    if (issue) {
      throw issueError(issue, display, (p) => (p[0] === "profiles" ? CONFIG_KEYS : USER_CONFIG_TOP_KEYS));
    }
    throw usageError(`Could not parse ${display}.`);
  }
  return parsed.data;
}

export function writeUserConfig(path: string, config: UserConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// --- Resolution -----------------------------------------------------------------------------

export interface ConfigFlags {
  org?: string;
  workspace?: string;
  apiUrl?: string;
  profile?: string;
  failUnder?: number;
}

export interface ResolvedValue<T> {
  value: T;
  /** `--org`, `WAM_ORG`, `./wam.json`, `~/.config/whereamimentioned/config.json` or `(default)`. */
  source: string;
}

export interface ConsultedSource {
  kind: "project" | "user";
  path: string;
  display: string;
  exists: boolean;
}

export interface ResolvedConfig {
  org: ResolvedValue<string | null>;
  workspace: ResolvedValue<string | null>;
  apiUrl: ResolvedValue<string>;
  failUnder: ResolvedValue<number | null>;
  profile: ResolvedValue<string>;
  /** Every file source, in precedence order, whether or not it existed (`--debug`, `config path`). */
  consulted: ConsultedSource[];
  projectConfigPath: string | null;
  userConfigPath: string;
}

function normalizeApiUrl(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`${source} must be an absolute URL such as ${DEFAULT_API_URL}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usageError(`${source} must be an http or https URL such as ${DEFAULT_API_URL}.`);
  }
  return raw.replace(/\/+$/, "");
}

export function resolveConfig(flags: ConfigFlags, e: ConfigEnvironment): ResolvedConfig {
  const projectPath = findProjectConfig(e.cwd);
  const project = projectPath ? readProjectConfig(projectPath, e) : null;
  const userPath = userConfigPath(e);
  const user = readUserConfig(userPath, e);
  const projectDisplay = projectPath ? displayPath(projectPath, e) : null;
  const userDisplay = displayPath(userPath, e);

  const profile: ResolvedValue<string> = flags.profile
    ? { value: flags.profile, source: "--profile" }
    : envValue(e.env, "WAM_PROFILE")
      ? { value: envValue(e.env, "WAM_PROFILE")!, source: "WAM_PROFILE" }
      : user?.activeProfile
        ? { value: user.activeProfile, source: userDisplay }
        : { value: DEFAULT_PROFILE, source: "(default)" };
  const userProfile: UserProfile | null = user?.profiles[profile.value] ?? null;

  function pick<T>(
    flag: T | undefined,
    flagName: string,
    envName: string | null,
    fromEnv: (raw: string) => T,
    fromProject: T | undefined,
    fromUser: T | undefined,
    fallback: T,
  ): ResolvedValue<T> {
    if (flag !== undefined) return { value: flag, source: flagName };
    const env = envName === null ? null : envValue(e.env, envName);
    if (env !== null && envName !== null) return { value: fromEnv(env), source: envName };
    if (fromProject !== undefined && projectDisplay) return { value: fromProject, source: projectDisplay };
    if (fromUser !== undefined) return { value: fromUser, source: userDisplay };
    return { value: fallback, source: "(default)" };
  }

  const apiUrlFlag = flags.apiUrl !== undefined ? normalizeApiUrl(flags.apiUrl, "--api-url") : undefined;

  return {
    org: pick<string | null>(flags.org, "--org", "WAM_ORG", (v) => v, project?.org, userProfile?.org, null),
    workspace: pick<string | null>(
      flags.workspace,
      "--workspace",
      "WAM_WORKSPACE",
      (v) => v,
      project?.workspace,
      userProfile?.workspace,
      null,
    ),
    // The project file has no say over apiUrl (see the module comment): flag, env, user config, default.
    apiUrl: pick<string>(
      apiUrlFlag,
      "--api-url",
      "WAM_API_URL",
      (v) => normalizeApiUrl(v, "WAM_API_URL"),
      undefined,
      userProfile?.apiUrl ? normalizeApiUrl(userProfile.apiUrl, `apiUrl in ${userDisplay}`) : undefined,
      DEFAULT_API_URL,
    ),
    // No environment variable for failUnder exists in section 4.7's table, so none is read.
    failUnder: pick<number | null>(
      flags.failUnder,
      "--fail-under",
      null,
      () => null,
      project?.failUnder,
      userProfile?.failUnder,
      null,
    ),
    profile,
    consulted: [
      ...(projectPath
        ? [{ kind: "project" as const, path: projectPath, display: projectDisplay!, exists: true }]
        : [
            {
              kind: "project" as const,
              path: join(resolve(e.cwd), PROJECT_CONFIG_FILENAME),
              display: `./${PROJECT_CONFIG_FILENAME}`,
              exists: false,
            },
          ]),
      { kind: "user" as const, path: userPath, display: userDisplay, exists: user !== null },
    ],
    projectConfigPath: projectPath,
    userConfigPath: userPath,
  };
}

// --- Writing (wam config set / unset, wam workspace use) --------------------------------------

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

/** Validates a `wam config set` value for its key. Exit 2 on anything the schema would refuse. */
export function parseConfigValue(key: ConfigKey, raw: string): string | number {
  switch (key) {
    case "org":
    case "workspace": {
      const v = raw.trim();
      if (v === "") throw usageError(`${key} must not be empty.`);
      return v;
    }
    case "apiUrl":
      return normalizeApiUrl(raw.trim(), "apiUrl");
    case "failUnder": {
      const n = Number(raw.trim());
      if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 0 || n > 100) {
        throw usageError("failUnder must be an integer from 0 to 100.");
      }
      return n;
    }
  }
}

function loadOrCreateUserConfig(e: ConfigEnvironment): { path: string; config: UserConfig } {
  const path = userConfigPath(e);
  const existing = readUserConfig(path, e);
  return { path, config: existing ?? { version: 1, profiles: {} } };
}

export function setUserConfigValue(
  e: ConfigEnvironment,
  profile: string,
  key: ConfigKey,
  value: string | number,
): { path: string } {
  const { path, config } = loadOrCreateUserConfig(e);
  const current: UserProfile = config.profiles[profile] ?? {};
  const next: Record<string, unknown> = { ...current, [key]: value };
  const parsed = userProfileSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as IssueLike | undefined;
    throw usageError(`Invalid value for ${key}: ${issue?.message ?? "rejected by the schema"}.`);
  }
  config.profiles[profile] = parsed.data;
  writeUserConfig(path, config);
  return { path };
}

export function unsetUserConfigValue(
  e: ConfigEnvironment,
  profile: string,
  key: ConfigKey,
): { path: string; removed: boolean } {
  const { path, config } = loadOrCreateUserConfig(e);
  const current = config.profiles[profile];
  if (!current || current[key] === undefined) return { path, removed: false };
  const next: UserProfile = { ...current };
  delete next[key];
  config.profiles[profile] = next;
  writeUserConfig(path, config);
  return { path, removed: true };
}

/** `wam workspace use acme/acme-eu` writes both keys at once (section 3.4). */
export function setUserConfigProfile(
  e: ConfigEnvironment,
  profile: string,
  values: Partial<UserProfile>,
): { path: string } {
  const { path, config } = loadOrCreateUserConfig(e);
  const parsed = userProfileSchema.safeParse({ ...(config.profiles[profile] ?? {}), ...values });
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as IssueLike | undefined;
    throw usageError(`Invalid config value: ${issue?.message ?? "rejected by the schema"}.`);
  }
  config.profiles[profile] = parsed.data;
  writeUserConfig(path, config);
  return { path };
}
