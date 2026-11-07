/**
 * The Context: everything a command needs, built once per invocation from injectable primitives.
 *
 * Every primitive (streams, env, cwd, fetch, keyring, clock, browser, home, platform, exec)
 * defaults to the real one and can be replaced, so every command's action is unit-testable by
 * calling it with a fake Context and never by spawning a process. Config, credential and client
 * are resolved lazily and exactly once.
 *
 * It owns the three decisions of 10-CLI sections 3.0 and 6.3 (colour, interactivity, output
 * mode) and the one client the CLI is allowed to have (section 12.2 rule 1): the api-client,
 * built with `wam-cli/<version>` as its user agent, the resolved API origin, the resolved org and
 * the resolved credential. The `fetch` default below is the only bare `fetch` in packages/cli/src.
 */
import { execFile } from "node:child_process";
import { homedir as osHomedir } from "node:os";
import {
  DEFAULT_TIMEOUT_MS,
  createWamClient,
  type WamClient,
} from "@whereamimentioned/api-client";
import { resolveConfig, type ConfigEnvironment, type ResolvedConfig } from "./config";
import type { ConfirmDeps } from "./confirm";
import {
  CredentialStore,
  loadSystemKeyring,
  resolveCredential,
  type KeyringLoader,
  type ResolvedCredential,
} from "./credentials";
import {
  CliError,
  assertApiVersion,
  mapApiError,
  noCredentialError,
  noOrgError,
  noWorkspaceError,
  type ErrorContext,
} from "./errors";
import {
  createOutput,
  resolveColor,
  resolveNonInteractive,
  type Env,
  type Output,
  type WritableLike,
} from "./output";
import { VERSION } from "./version";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * The errno name (`ENOENT`, `EINVAL`, `EACCES`) when the command could not be started at all, so
   * `code` is not an exit code the command produced. Absent when the command ran.
   */
  spawnError?: string;
}

/** The injectable primitives. Every field has a real default in `defaultPrimitives`. */
export interface ContextPrimitives {
  /** User arguments only: no node, no script path. */
  argv: readonly string[];
  env: Env;
  cwd: string;
  stdout: WritableLike;
  stderr: WritableLike;
  stdin: NodeJS.ReadableStream;
  isTTY: { stdout: boolean; stdin: boolean };
  fetch: typeof globalThis.fetch;
  keyring: KeyringLoader;
  now: () => Date;
  openBrowser: (url: string) => Promise<void>;
  homedir: string;
  platform: string;
  exec: (command: string, args: readonly string[]) => Promise<ExecResult>;
  /** Permission bits of a path, for the credential-file check. Defaults to `fs.statSync`. */
  fileMode?: (path: string) => number | null;
}

/** The global flags of section 3.0, as commander parsed them. */
export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  /** `--color` true, `--no-color` false, neither undefined. */
  color: boolean | undefined;
  nonInteractive: boolean;
  yes: boolean;
  debug: boolean;
  org?: string;
  workspace?: string;
  token?: string;
  apiUrl?: string;
  profile?: string;
}

export const DEFAULT_GLOBAL_FLAGS: GlobalFlags = {
  json: false,
  quiet: false,
  color: undefined,
  nonInteractive: false,
  yes: false,
  debug: false,
};

export interface Context {
  readonly primitives: ContextPrimitives;
  readonly flags: GlobalFlags;
  readonly out: Output;
  /** Section 6.3. */
  readonly nonInteractive: boolean;
  readonly interactive: boolean;
  readonly color: boolean;
  readonly timeoutMs: number;
  /** Set by a command that finishes without an error but not with 0 (exit 7 under `--json`, exit 8). */
  exitCode: number;
  setExitCode(code: number): void;

  configEnvironment(): ConfigEnvironment;
  /** Resolved once. Throws a usage error on a bad config file. */
  config(): ResolvedConfig;
  credentialStore(): CredentialStore;
  /** Resolved once: `--token`, `WAM_TOKEN`, then the store. Null when there is none. */
  credential(): Promise<ResolvedCredential | null>;
  /** Exit 3 with the "Not signed in." copy when there is no credential. */
  requireCredential(): Promise<ResolvedCredential>;
  /**
   * The org to send as `X-Wam-Org`. On an account-wide key with none resolved this is the local
   * `no_org` usage error (section 3.0); on an org key, or an unknown kind, null is legal.
   */
  requireOrg(): Promise<string | null>;
  /** Exit 2 with the "No workspace selected." copy when none resolved. */
  requireWorkspace(): string;
  /** The authenticated api-client, built once. Requires a credential. */
  client(): Promise<WamClient>;
  /** A client with no credential and no store access, for the `wam site` commands. */
  anonymousClient(): WamClient;
  /** What `mapApiError` needs, from whatever has been resolved so far. */
  errorContext(extra?: Partial<ErrorContext>): ErrorContext;
  /** `mapApiError` bound to this invocation. */
  mapError(error: unknown, command: string, extra?: Partial<ErrorContext>): CliError;
  confirmDeps(): ConfirmDeps;
}

/**
 * Never through a shell: an argument can carry a bearer token, and a shell would re-parse it. A
 * non-zero exit arrives as a numeric `error.code`; a spawn failure arrives as an errno string
 * (`ENOENT` for a command that is not on the PATH, `EINVAL` when Node refuses a Windows `.cmd` or
 * `.bat` shim without a shell) and is reported as `spawnError` so the caller can say what happened.
 */
export function defaultExec(command: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      const errorCode = error ? (error as { code?: unknown }).code : undefined;
      const code = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
      const result: ExecResult = { stdout: String(stdout), stderr: String(stderr), code };
      if (typeof errorCode === "string") result.spawnError = errorCode;
      resolve(result);
    });
  });
}

/**
 * Open a URL in the default browser. On Windows this goes through rundll32's URL handler rather
 * than `cmd /c start`: cmd re-parses its command line, so the first `&` of a query string ends
 * the URL and the authorize page receives only its first parameter.
 */
export function defaultOpenBrowser(platform: string, exec: ContextPrimitives["exec"]): (url: string) => Promise<void> {
  return async (url) => {
    if (platform === "win32") await exec("rundll32", ["url.dll,FileProtocolHandler", url]);
    else if (platform === "darwin") await exec("open", [url]);
    else await exec("xdg-open", [url]);
  };
}

export function defaultPrimitives(): ContextPrimitives {
  const platform = process.platform;
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    isTTY: { stdout: Boolean(process.stdout.isTTY), stdin: Boolean(process.stdin.isTTY) },
    // The one bare fetch in packages/cli/src: it is handed to createWamClient and used nowhere else.
    // eslint-disable-next-line no-restricted-globals -- the api-client's transport, not a call against /api/v1
    fetch: (input, init) => fetch(input, init),
    keyring: loadSystemKeyring,
    now: () => new Date(),
    openBrowser: defaultOpenBrowser(platform, defaultExec),
    homedir: osHomedir(),
    platform,
    exec: defaultExec,
  };
}

/** A fetch that logs method, path, status and request id under `--debug`. Never a header or a body. */
function debugFetch(inner: typeof globalThis.fetch, out: Output): typeof globalThis.fetch {
  if (!out.debugEnabled) return inner;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    let path = url;
    try {
      const u = new URL(url);
      path = `${u.pathname}${u.search}`;
    } catch {
      // Not an absolute URL; log it as given.
    }
    const started = Date.now();
    try {
      const res = await inner(input, init);
      const rid = res.headers.get("X-Request-Id");
      out.debug(`${method} ${path} -> ${res.status}${rid ? ` (${rid})` : ""} ${Date.now() - started}ms`);
      return res;
    } catch (err) {
      out.debug(`${method} ${path} -> ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
}

/**
 * Wraps every client method so that after each call, success or failure, the API version seen on
 * the response is checked against the compiled one (section 9.1). A mismatch wins over whatever
 * the call returned.
 */
const CLIENT_META_PROPS: ReadonlySet<PropertyKey> = new Set(["lastApiVersion", "lastRequestId", "lastResponse"]);

function guardApiVersion<T extends object>(target: T, root: WamClient): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      // The response metadata is plain data (`lastResponse.headers.get` must stay synchronous).
      if (CLIENT_META_PROPS.has(prop)) return value;
      if (typeof value === "function") {
        return async (...args: unknown[]) => {
          let result: unknown;
          try {
            result = await (value as (...a: unknown[]) => unknown).apply(t, args);
          } catch (err) {
            assertApiVersion(root);
            throw err;
          }
          assertApiVersion(root);
          return result;
        };
      }
      if (typeof value === "object" && value !== null) return guardApiVersion(value, root);
      return value;
    },
  });
}

export interface ContextOverrides extends Partial<ContextPrimitives> {
  flags?: Partial<GlobalFlags>;
}

export function createContext(overrides: ContextOverrides = {}): Context {
  const { flags: flagOverrides, ...primitiveOverrides } = overrides;
  const primitives: ContextPrimitives = { ...defaultPrimitives(), ...primitiveOverrides };
  const flags: GlobalFlags = { ...DEFAULT_GLOBAL_FLAGS, ...flagOverrides };

  const color = resolveColor({
    flag: flags.color,
    json: flags.json,
    env: primitives.env,
    stdoutIsTTY: primitives.isTTY.stdout,
  });
  const nonInteractive = resolveNonInteractive({
    flag: flags.nonInteractive,
    json: flags.json,
    env: primitives.env,
    stdoutIsTTY: primitives.isTTY.stdout,
  });
  const out = createOutput({
    stdout: primitives.stdout,
    stderr: primitives.stderr,
    json: flags.json,
    quiet: flags.quiet,
    color,
    debug: flags.debug,
  });

  let config: ResolvedConfig | undefined;
  let store: CredentialStore | undefined;
  let credentialPromise: Promise<ResolvedCredential | null> | undefined;
  let credentialCache: ResolvedCredential | null | undefined;
  let clientPromise: Promise<WamClient> | undefined;
  let rawClient: WamClient | undefined;
  let anonymous: WamClient | undefined;

  const configEnvironment = (): ConfigEnvironment => ({
    env: primitives.env,
    cwd: primitives.cwd,
    homedir: primitives.homedir,
    platform: primitives.platform,
  });

  const ctx: Context = {
    primitives,
    flags,
    out,
    nonInteractive,
    interactive: !nonInteractive,
    color,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    exitCode: 0,
    setExitCode(code) {
      ctx.exitCode = code;
    },

    configEnvironment,

    config() {
      if (!config) {
        config = resolveConfig(
          {
            org: flags.org,
            workspace: flags.workspace,
            apiUrl: flags.apiUrl,
            profile: flags.profile,
          },
          configEnvironment(),
        );
        if (flags.debug) {
          for (const source of config.consulted) {
            out.debug(`config: ${source.display}${source.exists ? "" : " (not found)"}`);
          }
          out.debug(`config: profile ${config.profile.value} (${config.profile.source})`);
          out.debug(`config: org ${config.org.value ?? "(none)"} (${config.org.source})`);
          out.debug(`config: workspace ${config.workspace.value ?? "(none)"} (${config.workspace.source})`);
          out.debug(`config: apiUrl ${config.apiUrl.value} (${config.apiUrl.source})`);
        }
      }
      return config;
    },

    credentialStore() {
      if (!store) {
        store = new CredentialStore({
          ...configEnvironment(),
          keyring: primitives.keyring,
          fileMode: primitives.fileMode,
        });
      }
      return store;
    },

    credential() {
      if (!credentialPromise) {
        credentialPromise = resolveCredential({
          tokenFlag: flags.token,
          env: primitives.env,
          store: ctx.credentialStore(),
          profile: ctx.config().profile.value,
          warn: (line) => out.warn(line),
        }).then((resolved) => {
          credentialCache = resolved;
          if (resolved) out.debug(`credential: ${resolved.display} from ${resolved.source}`);
          else out.debug("credential: none");
          return resolved;
        });
      }
      return credentialPromise;
    },

    async requireCredential() {
      const resolved = await ctx.credential();
      if (!resolved) throw noCredentialError();
      return resolved;
    },

    async requireOrg() {
      const org = ctx.config().org.value;
      if (org) return org;
      const cred = await ctx.credential();
      const kind = cred?.record?.kind ?? null;
      if (kind === "user") throw noOrgError();
      return null;
    },

    requireWorkspace() {
      const ws = ctx.config().workspace.value;
      if (!ws) throw noWorkspaceError();
      return ws;
    },

    client() {
      if (!clientPromise) {
        clientPromise = (async () => {
          const cred = await ctx.requireCredential();
          const cfg = ctx.config();
          rawClient = createWamClient({
            baseUrl: cfg.apiUrl.value,
            token: cred.token,
            org: cfg.org.value ?? cred.record?.org ?? undefined,
            fetch: debugFetch(primitives.fetch, out),
            userAgent: `wam-cli/${VERSION}`,
            timeoutMs: ctx.timeoutMs,
          });
          return guardApiVersion(rawClient, rawClient);
        })();
      }
      return clientPromise;
    },

    anonymousClient() {
      if (!anonymous) {
        const cfg = ctx.config();
        const raw = createWamClient({
          baseUrl: cfg.apiUrl.value,
          fetch: debugFetch(primitives.fetch, out),
          userAgent: `wam-cli/${VERSION}`,
          timeoutMs: ctx.timeoutMs,
        });
        anonymous = guardApiVersion(raw, raw);
      }
      return anonymous;
    },

    errorContext(extra = {}) {
      const cfg = config;
      const cred = credentialCache ?? null;
      const limit = rawClient?.lastResponse?.headers.get("X-RateLimit-Limit") ?? null;
      return {
        apiUrl: cfg?.apiUrl.value,
        org: cfg?.org.value ?? cred?.record?.org ?? null,
        workspace: cfg?.workspace.value ?? null,
        credential: cred
          ? {
              kind: cred.record?.kind ?? null,
              org: cred.record?.org ?? null,
              expiresAt: cred.record?.expiresAt ?? null,
            }
          : null,
        rateLimitLimit: limit,
        now: primitives.now(),
        ...extra,
      };
    },

    mapError(error, command, extra) {
      return mapApiError(error, command, ctx.errorContext(extra));
    },

    confirmDeps() {
      return {
        interactive: !nonInteractive,
        yes: flags.yes,
        stdinIsTTY: primitives.isTTY.stdin,
        stdin: primitives.stdin,
        stderr: primitives.stderr,
      };
    },
  };

  return ctx;
}
