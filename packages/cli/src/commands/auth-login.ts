/**
 * `wam auth login` and `wam auth logout` (10-CLI sections 3.2 and 4, checkpoint 6).
 *
 * `login` has three modes:
 *  - loopback PKCE, the default (section 4.2): an http server bound to 127.0.0.1 on an ephemeral
 *    port, the browser opened at `<apiUrl>/cli/authorize`, the `state` verified on the callback,
 *    then ONE request, POST /api/cli/token with the code and the verifier;
 *  - `--device` (section 4.3): the RFC 8628 poll loop, honouring `interval` and `slow_down`;
 *  - `--token`: an existing key read from stdin (or given as the flag's value), verified against
 *    the API before it is stored.
 *
 * What this module must never do, and how it does not:
 *  - print a token: only `prefix...last4` is ever formatted, the verifier and the one-time code
 *    are never written anywhere, and the `--debug` lines carry a method, a path and a status;
 *  - make a request while it holds no credential in order to "look something up": the
 *    account-wide warning is printed from fixed copy BEFORE the browser opens, and the
 *    organization list is read from GET /api/v1/organizations only AFTER the mint;
 *  - send `kind=user` unless `--account-wide` was passed, or let `orgs:write` through without it:
 *    that combination is refused here (exit 2) before any browser opens or request is made;
 *  - bind anything but 127.0.0.1.
 *
 * `logout` revokes the key server side (DELETE /api/v1/keys/self, `?all=cli` under `--all`) and
 * only then clears local state. When the revoke fails the local credential is still cleared and
 * the command exits 1, so nobody believes a live key is gone.
 *
 * The three /api/cli/* routes are not part of /api/v1 and the api-client has no methods for them,
 * so they are called through the Context's injected fetch. Everything under /api/v1 goes through
 * `createWamClient` (section 12.2 rule 1).
 */
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname as osHostname } from "node:os";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { z } from "zod";
import {
  API_KEY_KINDS,
  API_SCOPES,
  API_VERSION_HEADER,
  ApiError,
  READ_ONLY_SCOPES,
  createWamClient,
  type ApiKeyKind,
  type ApiScope,
  type Me,
  type OrganizationSummary,
  type Page,
  type RevokeSelfResult,
  type WamClient,
} from "@whereamimentioned/api-client";
import { isYes } from "../confirm";
import type { Context } from "../context";
import {
  KEYRING_SERVICE,
  displayRecord,
  makeCredentialRecord,
  storageLabel,
  type CredentialRecord,
  type CredentialStorage,
} from "../credentials";
import { CliError, EXIT, assertApiVersion, requestTimedOutError, usageError } from "../errors";
import { formatTable } from "../output";
import { createPkcePair, createState, stateMatches, type RandomSource } from "../pkce";
import { VERSION } from "../version";
import { formatDate, labelled, plural } from "./support";

const LOGIN = "auth login";
const LOGOUT = "auth logout";

/** Section 4.2: no callback within 300 seconds ends the flow with exit 3. */
export const LOOPBACK_TIMEOUT_MS = 300_000;
export const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** RFC 8628 section 3.5: `slow_down` raises the interval by this many seconds. */
const SLOW_DOWN_INCREMENT_S = 5;
/** The four expiry requests of section 3.2. `0` is the documented alias of `never`. */
export const LOGIN_EXPIRES = ["30", "90", "365", "never"] as const;
export type LoginExpires = (typeof LOGIN_EXPIRES)[number];
const DEFAULT_EXPIRES: LoginExpires = "90";
/** The server's bound on a key name (the authorize page and the device-start body both enforce it). */
const KEY_NAME_MAX = 64;
const STDIN_TOKEN_MAX_BYTES = 64 * 1024;
const LABEL_WIDTH = 14;
const VALUE_INDENT = " ".repeat(2 + LABEL_WIDTH);
const SCOPES_WRAP = 72;

// --- Final copy (section 3.2 and section 4.2) --------------------------------------------------

export const TIMED_OUT_COPY = "Sign-in timed out. Run wam auth login again, or use wam auth login --token.";

export const ACCOUNT_WIDE_WARNING: readonly string[] = [
  "This mints an account-wide key.",
  "",
  "  It reaches every organization your account belongs to, today and any you join later,",
  "  with no change to the key.",
  "  In each one it acts at your live role there, capped at member.",
  "  Revoking its reach into one organization means leaving that organization, or revoking",
  "  the whole key with wam auth logout.",
  "",
  "The next page lists every organization by name before it issues anything.",
];
export const CONTINUE_QUESTION = "Continue? (y/N)";
export const LOGIN_CANCELLED = "Cancelled. No key was created.";

const NEVER_EXPIRES_NOTICE: readonly string[] = [
  "This asks for a key that never expires.",
  "It stays valid until someone revokes it. The approval page can still choose a shorter expiry.",
];

// --- Injectable pieces the Context does not carry ------------------------------------------------

export interface LoginDeps {
  /** The loopback http server. Tests wrap it to read the host it was asked to listen on. */
  createServer: (listener: RequestListener) => Server;
  /** For the default key name, `<hostname> CLI`. */
  hostname: () => string;
  /** The wait between two device polls. */
  sleep: (ms: number) => Promise<void>;
  random: RandomSource;
  loopbackTimeoutMs: number;
  /** Overrides how a yes/no question is asked: true yes, false no, null EOF or a cancelled prompt. */
  prompt?: (question: string) => Promise<boolean | null>;
  /** Overrides how a pasted key is read at a terminal. Null is a cancelled prompt. */
  promptSecret?: (message: string) => Promise<string | null>;
}

export function defaultLoginDeps(): LoginDeps {
  return {
    createServer: (listener) => createHttpServer(listener),
    hostname: () => osHostname(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: randomBytes,
    loopbackTimeoutMs: LOOPBACK_TIMEOUT_MS,
  };
}

export interface LoginOptions {
  device?: boolean;
  /** `true` reads the key from stdin (or prompts at a terminal); a string is the key itself. */
  token?: boolean | string;
  accountWide?: boolean;
  name?: string;
  scopes?: string;
  expires?: string;
  /** `--no-browser` is `browser: false`. */
  browser?: boolean;
}

export interface LogoutOptions {
  all?: boolean;
}

// --- Flag validation (all of it local, all of it before any browser or request) -------------------

/** `READ_ONLY_SCOPES` plus `scans:write` (section 3.2), in the contract's own order. */
export function defaultLoginScopes(): ApiScope[] {
  const readOnly: readonly string[] = READ_ONLY_SCOPES;
  return API_SCOPES.filter((scope) => readOnly.includes(scope) || scope === "scans:write");
}

function parseScopesFlag(raw: string | undefined): ApiScope[] {
  if (raw === undefined) return defaultLoginScopes();
  const known: readonly string[] = API_SCOPES;
  const out: ApiScope[] = [];
  for (const part of raw.split(",")) {
    const scope = part.trim();
    if (scope === "") continue;
    if (!known.includes(scope)) {
      throw usageError(`--scopes has an unknown scope: ${scope}.`, `Valid scopes are: ${API_SCOPES.join(", ")}.`);
    }
    if (!out.includes(scope as ApiScope)) out.push(scope as ApiScope);
  }
  if (out.length === 0) {
    throw usageError("--scopes needs at least one scope.", `Valid scopes are: ${API_SCOPES.join(", ")}.`);
  }
  return out;
}

function parseExpiresFlag(raw: string | undefined): LoginExpires {
  if (raw === undefined) return DEFAULT_EXPIRES;
  const value = raw.trim();
  if (value === "0") return "never";
  if ((LOGIN_EXPIRES as readonly string[]).includes(value)) return value as LoginExpires;
  throw usageError(`--expires must be one of: ${LOGIN_EXPIRES.join(", ")}.`);
}

function parseNameFlag(raw: string | undefined, deps: LoginDeps): string {
  if (raw === undefined) {
    const suffix = " CLI";
    const host = deps.hostname().trim() || "wam";
    return `${host.slice(0, KEY_NAME_MAX - suffix.length)}${suffix}`;
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > KEY_NAME_MAX) {
    throw usageError(`--name must be 1 to ${KEY_NAME_MAX} characters.`);
  }
  return name;
}

export interface MintRequest {
  name: string;
  scopes: ApiScope[];
  expires: LoginExpires;
  accountWide: boolean;
}

/**
 * Validates the mint flags. `orgs:write` is mintable on an account-wide key only (08 section
 * 2.5), and the CLI refuses the combination first, naming the flag that would make it legal.
 */
export function parseMintRequest(opts: LoginOptions, deps: LoginDeps): MintRequest {
  const scopes = parseScopesFlag(opts.scopes);
  const expires = parseExpiresFlag(opts.expires);
  const accountWide = opts.accountWide === true;
  if (scopes.includes("orgs:write") && !accountWide) {
    throw usageError(
      "The orgs:write scope can only be carried by an account-wide key.",
      `Add --account-wide: wam auth login --account-wide --scopes ${scopes.join(",")}`,
    );
  }
  return { name: parseNameFlag(opts.name, deps), scopes, expires, accountWide };
}

// --- Prompts -------------------------------------------------------------------------------------

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

async function askYesNo(ctx: Context, deps: LoginDeps, question: string): Promise<boolean | null> {
  if (deps.prompt) return deps.prompt(question);
  const c = ctx.confirmDeps();
  if (c.stdinIsTTY) {
    try {
      const clack = await import("@clack/prompts");
      const answer = await clack.confirm({ message: question.replace(/\s*\(y\/N\)\s*$/, ""), initialValue: false });
      return clack.isCancel(answer) ? null : answer === true;
    } catch {
      // The prompt library could not render: fall back to one plain line.
    }
  }
  c.stderr.write(`${question} `);
  const line = await readLine(c.stdin);
  return line === null ? null : isYes(line);
}

/**
 * The confirmations a mint may need: the account-wide warning (final copy, section 3.2) and the
 * never-expires notice. Both are printed even under `--yes`, because the point is that the blast
 * radius is visible BEFORE the browser opens; one question covers both. Resolves false when the
 * human said no. Throws exit 2 when it would have to ask and cannot (section 6.3).
 */
async function confirmMint(ctx: Context, deps: LoginDeps, req: MintRequest): Promise<boolean> {
  const notices: string[] = [];
  if (req.accountWide) notices.push(...ACCOUNT_WIDE_WARNING);
  if (req.expires === "never") {
    if (notices.length > 0) notices.push("");
    notices.push(...NEVER_EXPIRES_NOTICE);
  }
  if (notices.length === 0) return true;

  if (!ctx.flags.yes && ctx.nonInteractive) {
    const what = req.accountWide ? "an account-wide key" : "a key that never expires";
    throw usageError(
      `This asks for ${what} and cannot prompt for confirmation here.`,
      "Pass --yes to confirm, or run it in an interactive terminal.",
    );
  }
  for (const line of notices) ctx.out.warn(line);
  if (ctx.flags.yes) return true;
  const answer = await askYesNo(ctx, deps, CONTINUE_QUESTION);
  if (answer === true) return true;
  ctx.out.warn(LOGIN_CANCELLED);
  return false;
}

// --- The /api/cli/* transport ----------------------------------------------------------------------

function apiBase(ctx: Context): string {
  return ctx.config().apiUrl.value.replace(/\/+$/, "");
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** Logs method, path, status and request id under `--debug`. Never a header and never a body. */
function tracedFetch(ctx: Context): typeof globalThis.fetch {
  const inner = ctx.primitives.fetch;
  if (!ctx.out.debugEnabled) return inner;
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let path = href;
    try {
      const u = new URL(href);
      path = `${u.pathname}${u.search}`;
    } catch {
      // Not an absolute URL; log it as given.
    }
    const method = init?.method ?? "GET";
    try {
      const res = await inner(input, init);
      const rid = res.headers.get("X-Request-Id");
      ctx.out.debug(`${method} ${path} -> ${res.status}${rid ? ` (${rid})` : ""}`);
      return res;
    } catch (err) {
      ctx.out.debug(`${method} ${path} -> ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
}

interface CliRouteReply {
  status: number;
  ok: boolean;
  headers: Headers;
  json: unknown;
  text: string;
}

/**
 * One POST to a /api/cli/* route. Never retried: the token exchange is single use, the device
 * poll is a documented long poll and not a retry, and a 429 means stop (section 9.2).
 */
async function postCliRoute(ctx: Context, path: string, body: unknown): Promise<CliRouteReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let reply: CliRouteReply;
  try {
    const res = await tracedFetch(ctx)(`${apiBase(ctx)}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": `wam-cli/${VERSION}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    reply = { status: res.status, ok: res.ok, headers: res.headers, json, text };
  } catch (err) {
    if (isAbortError(err)) throw requestTimedOutError(ctx.timeoutMs);
    throw ctx.mapError(err, LOGIN);
  } finally {
    clearTimeout(timer);
  }
  const version = Number(reply.headers.get(API_VERSION_HEADER)?.trim());
  assertApiVersion({ lastApiVersion: Number.isInteger(version) ? version : null });
  return reply;
}

interface CliRouteFailure {
  code: string;
  message: string;
  requestId: string | null;
  details: Record<string, unknown> | undefined;
  /** RFC 8628 section 3.5: `slow_down` carries the raised interval at the top level. */
  interval: number | null;
}

function readFailure(reply: CliRouteReply): CliRouteFailure | null {
  const body = reply.json;
  if (typeof body !== "object" || body === null) return null;
  const env = (body as { error?: unknown }).error;
  if (typeof env !== "object" || env === null) return null;
  const e = env as { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown };
  if (typeof e.code !== "string") return null;
  const details =
    typeof e.details === "object" && e.details !== null && !Array.isArray(e.details)
      ? (e.details as Record<string, unknown>)
      : undefined;
  const top = (body as { interval?: unknown }).interval;
  const nested = details?.interval;
  const interval = typeof top === "number" ? top : typeof nested === "number" ? nested : null;
  return {
    code: e.code,
    message: typeof e.message === "string" ? e.message : `HTTP ${reply.status}`,
    requestId: typeof e.requestId === "string" ? e.requestId : reply.headers.get("X-Request-Id"),
    details,
    interval,
  };
}

function withRequestId(lines: string[], requestId: string | null): string[] {
  if (!requestId || lines.length === 0) return lines;
  return [...lines.slice(0, -1), `${lines[lines.length - 1]} (request ${requestId})`];
}

/** The sign-in did not complete: exit 3 (section 3.2). The route's own codes never reach `--json`. */
function signInFailed(lines: string[], requestId: string | null = null): CliError {
  return new CliError("unauthorized", EXIT.AUTH, withRequestId(lines, requestId), { requestId });
}

function deniedError(requestId: string | null = null): CliError {
  return signInFailed(
    [
      "The sign-in was denied in the browser, so no key was created.",
      "Minting a CLI key needs the member role or higher in the organization. Run wam auth login to try again.",
    ],
    requestId,
  );
}

/** Any failure of a /api/cli/* route that is not part of the flow itself. */
function routeError(ctx: Context, reply: CliRouteReply, failure: CliRouteFailure | null): CliError {
  if (failure) {
    if (failure.code === "access_denied") return deniedError(failure.requestId);
    if (failure.code === "invalid_grant" || failure.code === "expired_token") {
      return signInFailed([failure.message], failure.requestId);
    }
  }
  const retryHeader = reply.headers.get("Retry-After")?.trim() ?? "";
  const detailsRetry = failure?.details?.retryAfterSeconds;
  const apiError = new ApiError({
    status: reply.status,
    code: failure?.code ?? "unknown",
    message: failure?.message ?? `Unexpected non-JSON response (HTTP ${reply.status})`,
    requestId: failure?.requestId ?? reply.headers.get("X-Request-Id"),
    details: failure?.details,
    retryAfterSeconds: /^\d+$/.test(retryHeader)
      ? Number(retryHeader)
      : typeof detailsRetry === "number"
        ? detailsRetry
        : null,
  });
  return ctx.mapError(apiError, LOGIN, { rateLimitLimit: reply.headers.get("X-RateLimit-Limit") });
}

/** What POST /api/cli/token and the approved device poll return (app/api/cli/token/route.ts). */
const tokenResponseSchema = z.object({
  token: z.string().min(1),
  prefix: z.string().min(1),
  last4: z.string().min(1),
  kind: z.enum(API_KEY_KINDS),
  org: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

const deviceStartSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
});

/** Fail closed, and never echo the body: it may hold a token. */
function unreadableReply(): CliError {
  return new CliError("unknown", EXIT.FAILURE, [
    "The server answered the sign-in with a response this CLI does not understand.",
    "Upgrade and try again: npm install -g @whereamimentioned/cli@latest",
  ]);
}

function parseTokenResponse(reply: CliRouteReply): TokenResponse {
  const parsed = tokenResponseSchema.safeParse(reply.json);
  if (!parsed.success) throw unreadableReply();
  return parsed.data;
}

// --- Loopback (section 4.2) --------------------------------------------------------------------------

type CallbackOutcome =
  | { type: "code"; code: string }
  | { type: "denied" }
  | { type: "state_mismatch" }
  | { type: "no_code" }
  | { type: "timeout" };

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5}</style>",
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    `<p>${body}</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Fixed pages. Nothing from the request is ever reflected into them. */
const PAGES = {
  done: page("You are signed in", "The wam CLI has what it needs. You can close this tab and go back to your terminal."),
  denied: page("Sign-in denied", "No key was created. You can close this tab and go back to your terminal."),
  invalid: page(
    "This sign-in could not be verified",
    "The request did not match the sign-in the wam CLI started. Go back to your terminal and run wam auth login again.",
  ),
  notFound: page("Nothing here", "This address only answers the wam CLI sign-in callback."),
} as const;

interface LoopbackServer {
  port: number;
  outcome: Promise<CallbackOutcome>;
  close(): Promise<void>;
}

function startLoopbackServer(deps: LoginDeps, expectedState: string): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let settle: (outcome: CallbackOutcome) => void = () => {};
    let settled = false;
    const outcome = new Promise<CallbackOutcome>((res) => {
      settle = (value) => {
        if (settled) return;
        settled = true;
        res(value);
      };
    });

    const server = deps.createServer((req, res) => {
      const respond = (status: number, html: string, then?: CallbackOutcome) => {
        res.writeHead(status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          Connection: "close",
        });
        // The outcome is released only once the page has been handed to the socket, so the
        // shutdown that follows it cannot cut the response short.
        res.end(html, () => {
          if (then) settle(then);
        });
      };

      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
      } catch {
        respond(404, PAGES.notFound);
        return;
      }
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || settled) {
        respond(404, PAGES.notFound);
        return;
      }
      if (!stateMatches(expectedState, url.searchParams.get("state"))) {
        respond(400, PAGES.invalid, { type: "state_mismatch" });
        return;
      }
      if (url.searchParams.get("error") !== null) {
        respond(200, PAGES.denied, { type: "denied" });
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        respond(400, PAGES.invalid, { type: "no_code" });
        return;
      }
      respond(200, PAGES.done, { type: "code", code });
    });

    const close = (): Promise<void> =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });

    server.once("error", (err) => reject(err));
    // Loopback only, never 0.0.0.0 (section 4.2 step 2). Port 0 asks the OS for a free one.
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address !== "object") {
        void close().then(() => reject(new Error("the loopback server reported no address")));
        return;
      }
      resolve({ port: address.port, outcome, close });
    });
  });
}

export function authorizeUrl(base: string, params: {
  challenge: string;
  redirectUri: string;
  state: string;
  request: MintRequest;
}): string {
  const query: Array<[string, string]> = [
    ["code_challenge", params.challenge],
    ["code_challenge_method", "S256"],
    ["redirect_uri", params.redirectUri],
    ["state", params.state],
    ["name", params.request.name],
    ["scopes", params.request.scopes.join(",")],
    ["expires", params.request.expires],
  ];
  // Present only under --account-wide. Its absence means `org` (section 4.2 step 3).
  if (params.request.accountWide) query.push(["kind", "user"]);
  return `${base}/cli/authorize?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

async function loopbackFlow(ctx: Context, deps: LoginDeps, opts: LoginOptions, request: MintRequest): Promise<TokenResponse> {
  const pkce = createPkcePair(deps.random);
  const state = createState(deps.random);

  let server: LoopbackServer;
  try {
    server = await startLoopbackServer(deps, state);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError("unknown", EXIT.FAILURE, [
      `Could not open a local port on ${LOOPBACK_HOST} for the sign-in callback (${reason}).`,
      "Use the device flow instead: wam auth login --device",
    ]);
  }

  let outcome: CallbackOutcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const base = apiBase(ctx);
    const url = authorizeUrl(base, {
      challenge: pkce.challenge,
      redirectUri: `http://${LOOPBACK_HOST}:${server.port}${CALLBACK_PATH}`,
      state,
      request,
    });

    // The URL is the one thing the human cannot do without, so it prints even under --quiet.
    if (opts.browser === false) {
      ctx.out.warn("Open this URL in your browser to sign in:");
      ctx.out.warn(`  ${url}`);
    } else {
      ctx.out.warn(`Opening ${base}/cli/authorize in your browser.`);
      ctx.out.warn("If it did not open, paste this URL:");
      ctx.out.warn(`  ${url}`);
      // Not awaited: some openers block until the browser exits, and the URL is printed anyway.
      void Promise.resolve()
        .then(() => ctx.primitives.openBrowser(url))
        .catch(() => {});
    }
    ctx.out.chatter("");
    ctx.out.chatter("Waiting for approval...");

    const timeout = new Promise<CallbackOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timeout" }), deps.loopbackTimeoutMs);
    });
    outcome = await Promise.race([server.outcome, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // Shut down immediately, whatever happened (section 4.2 step 6).
    await server.close();
  }

  switch (outcome.type) {
    case "timeout":
      throw new CliError("timed_out", EXIT.AUTH, [TIMED_OUT_COPY]);
    case "state_mismatch":
      throw signInFailed([
        "The sign-in callback did not carry the state this CLI sent, so it was rejected.",
        "Nothing was stored. Run wam auth login again.",
      ]);
    case "no_code":
      throw signInFailed([
        "The browser came back without a sign-in code.",
        "Nothing was stored. Run wam auth login again.",
      ]);
    case "denied":
      throw deniedError();
    case "code":
      break;
  }

  const reply = await postCliRoute(ctx, "/api/cli/token", { code: outcome.code, code_verifier: pkce.verifier });
  if (!reply.ok) throw routeError(ctx, reply, readFailure(reply));
  return parseTokenResponse(reply);
}

// --- Device (section 4.3) ----------------------------------------------------------------------------

function lifetimeText(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${plural(minutes, "minute", "minutes")}`;
  }
  return `${seconds} ${plural(seconds, "second", "seconds")}`;
}

function deviceExpiredError(requestId: string | null = null): CliError {
  return signInFailed(
    ["The sign-in code expired before it was approved.", "Run wam auth login --device again."],
    requestId,
  );
}

async function deviceFlow(ctx: Context, deps: LoginDeps, request: MintRequest): Promise<TokenResponse> {
  const startBody: Record<string, unknown> = {
    name: request.name,
    scopes: request.scopes,
    expires: request.expires,
  };
  // Only under --account-wide, exactly as on the authorize URL. Its absence means `org`.
  if (request.accountWide) startBody.kind = "user";

  const started = await postCliRoute(ctx, "/api/cli/device/start", startBody);
  if (!started.ok) throw routeError(ctx, started, readFailure(started));
  const parsed = deviceStartSchema.safeParse(started.json);
  if (!parsed.success) throw unreadableReply();
  const device = parsed.data;

  ctx.out.warn(`To sign in, open  ${device.verification_uri}`);
  ctx.out.warn("and enter the code:");
  ctx.out.warn("");
  ctx.out.warn(`    ${device.user_code}`);
  ctx.out.warn("");
  ctx.out.chatter(`Waiting (expires in ${lifetimeText(device.expires_in)})...`);

  let interval = device.interval;
  let waited = 0;
  for (;;) {
    if (waited >= device.expires_in) throw deviceExpiredError();
    await deps.sleep(interval * 1000);
    waited += interval;

    const reply = await postCliRoute(ctx, "/api/cli/device/token", { device_code: device.device_code });
    if (reply.ok) return parseTokenResponse(reply);

    const failure = readFailure(reply);
    // Only the documented 400s are part of the poll. A 429 is never one of them: it means stop.
    if (reply.status === 400 && failure) {
      if (failure.code === "authorization_pending") continue;
      if (failure.code === "slow_down") {
        interval = Math.max(interval + SLOW_DOWN_INCREMENT_S, failure.interval ?? 0);
        ctx.out.debug(`device poll: slow_down, polling every ${interval} seconds`);
        continue;
      }
      if (failure.code === "expired_token") throw deviceExpiredError(failure.requestId);
    }
    throw routeError(ctx, reply, failure);
  }
}

// --- Token mode ------------------------------------------------------------------------------------------

async function readAll(stdin: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stdin as AsyncIterable<string | Buffer>) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length > STDIN_TOKEN_MAX_BYTES) break;
  }
  return text;
}

async function promptForToken(deps: LoginDeps): Promise<string | null> {
  const message = "Paste your API key";
  if (deps.promptSecret) return deps.promptSecret(message);
  const clack = await import("@clack/prompts");
  const answer = await clack.password({ message });
  return clack.isCancel(answer) ? null : String(answer);
}

async function readPastedToken(ctx: Context, deps: LoginDeps, option: true | string): Promise<string> {
  let raw: string | null;
  if (typeof option === "string") raw = option;
  else if (!ctx.primitives.isTTY.stdin) raw = await readAll(ctx.primitives.stdin);
  else if (ctx.interactive) raw = await promptForToken(deps);
  else {
    throw usageError(
      "wam auth login --token reads the key from stdin and cannot prompt for it here.",
      "Pipe it in, for example from a secret manager: <command that prints the key> | wam auth login --token",
    );
  }
  const token = (raw ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (token === "") {
    throw usageError(
      "No API key was provided.",
      "Pipe one in: <command that prints the key> | wam auth login --token",
    );
  }
  if (/\s/.test(token)) throw usageError("That does not look like an API key: it contains whitespace.");
  return token;
}

// --- Describing the key that was just stored ------------------------------------------------------------

function clientFor(ctx: Context, token: string): WamClient {
  // No org: GET /api/v1/me needs none on an org key, and the organization list never takes one.
  return createWamClient({
    baseUrl: ctx.config().apiUrl.value,
    token,
    fetch: tracedFetch(ctx),
    userAgent: `wam-cli/${VERSION}`,
    timeoutMs: ctx.timeoutMs,
  });
}

/** The 403 an org key gets from GET /api/v1/organizations: `details.requiredKind` is "user". */
function isOrgKeyRefusal(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.code === "insufficient_scope" &&
    err.details?.requiredKind === "user"
  );
}

interface KeyDescription {
  kind: ApiKeyKind;
  /** GET /api/v1/me, on an org key. */
  me: Me | null;
  /** GET /api/v1/organizations, on an account-wide key. Printed as received. */
  organizations: Page<OrganizationSummary> | null;
}

/**
 * Reads what the server says about the key. On a known kind that is one request. When the kind is
 * not known (a pasted key), GET /api/v1/organizations is the discriminator, as in `auth status`:
 * a 200 proves an account-wide key and the 403 an org key gets proves the other. GET /api/v1/me is
 * never sent on an account-wide key here, because it would need an org nobody picked.
 */
async function describeKey(ctx: Context, client: WamClient, knownKind: ApiKeyKind | null): Promise<KeyDescription> {
  try {
    if (knownKind !== "org") {
      try {
        const organizations = await client.organizations.list();
        assertApiVersion(client);
        return { kind: "user", me: null, organizations };
      } catch (err) {
        if (knownKind === "user" || !isOrgKeyRefusal(err)) throw err;
      }
    }
    const me = await client.me();
    assertApiVersion(client);
    return { kind: me.key.kind, me, organizations: null };
  } catch (err) {
    throw ctx.mapError(err, LOGIN, {
      rateLimitLimit: client.lastResponse?.headers.get("X-RateLimit-Limit") ?? null,
    });
  }
}

// --- The summary (section 3.2) ----------------------------------------------------------------------------

interface SignedIn {
  record: CredentialRecord;
  storage: CredentialStorage;
  description: KeyDescription | null;
  /** What this CLI asked for, when it ran a browser flow. Neither field is editable on the page. */
  requested: MintRequest | null;
}

function storedInText(ctx: Context, storage: CredentialStorage, profile: string): string {
  const label = storageLabel(storage, ctx.primitives.platform);
  if (storage === "file") return `${label} (${ctx.credentialStore().filePath})`;
  if (ctx.primitives.platform === "darwin") return `${label} (service "${KEYRING_SERVICE}", account "${profile}")`;
  if (ctx.primitives.platform === "win32") return `${label} (target "${KEYRING_SERVICE}:${profile}")`;
  return `${label} (collection "${KEYRING_SERVICE}", item "${profile}")`;
}

function wrapList(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item},` : item;
    if (current !== "" && current.length + 1 + piece.length > width) {
      lines.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current} ${piece}`;
    }
  });
  if (current !== "") lines.push(current);
  return lines;
}

function row(label: string, value: string): string {
  return labelled(label, value, LABEL_WIDTH);
}

function keyName(s: SignedIn): string | null {
  return s.description?.me?.key.name ?? s.requested?.name ?? null;
}

function keyScopes(s: SignedIn): readonly string[] | null {
  return s.description?.me?.key.scopes ?? s.requested?.scopes ?? null;
}

function renderSignedIn(ctx: Context, s: SignedIn, profile: string): void {
  const { record, description } = s;
  const me = description?.me ?? null;
  const organizations = description?.organizations ?? null;
  const lines: string[] = ["Signed in."];

  if (record.kind === "user") {
    if (organizations) {
      const n = organizations.data.length;
      const count = `${n}${organizations.pagination.hasMore ? "+" : ""} ${plural(n, "organization", "organizations")}`;
      lines.push(row("Key kind", `Account-wide key, reaches ${count}`));
      if (n > 0) {
        const table = formatTable(
          organizations.data.map((o) => ({ org: `${o.name} (${o.slug})`, role: `acts as ${o.effectiveRole}` })),
          [
            { key: "org", header: "" },
            { key: "role", header: "" },
          ],
          { indent: VALUE_INDENT, header: false },
        ).split("\n");
        table[0] = `  ${"Organizations".padEnd(LABEL_WIDTH)}${table[0]!.slice(VALUE_INDENT.length)}`;
        lines.push(...table);
      }
    } else {
      lines.push(row("Key kind", "Account-wide key"));
    }
  } else if (record.kind === "org") {
    const slug = me?.org.slug ?? record.org;
    lines.push(row("Key kind", slug ? `Organization key, bound to ${slug}` : "Organization key"));
    if (me) {
      lines.push(row("Organization", `${me.org.name} (${me.org.slug})`));
      lines.push(
        row(
          "Role",
          me.actor.role === me.actor.effectiveRole
            ? me.actor.role
            : `${me.actor.role}, capped to ${me.actor.effectiveRole} by this key`,
        ),
      );
    }
  }

  const name = keyName(s);
  lines.push(row("Key", `${displayRecord(record)}${name !== null ? `  "${name}"` : ""}`));
  const scopes = keyScopes(s);
  if (scopes) {
    const wrapped = wrapList(scopes, SCOPES_WRAP);
    lines.push(row("Scopes", wrapped[0] ?? "(none)"));
    for (const extra of wrapped.slice(1)) lines.push(`${VALUE_INDENT}${extra}`);
  }
  // A pasted account-wide key has no endpoint to read its expiry from without an org, so the row
  // is left out rather than guessed.
  if (me || s.requested) lines.push(row("Expires", record.expiresAt === null ? "never" : formatDate(record.expiresAt)));
  lines.push(row("Stored in", storedInText(ctx, s.storage, profile)));

  for (const line of lines) ctx.out.data(line);

  if (record.kind === "org") {
    const slug = me?.org.slug ?? record.org;
    if (slug) {
      ctx.out.chatter("");
      ctx.out.chatter(`Set a default workspace with:  wam workspace use ${slug}/<workspace>`);
    }
  } else if (organizations && organizations.data.length > 0) {
    ctx.out.chatter("");
    if (organizations.pagination.hasMore) ctx.out.chatter("See every organization this key reaches: wam org list");
    ctx.out.chatter(`Pick an organization for this shell:  wam config set org ${organizations.data[0]!.slug}`);
  }
}

function signedInJson(s: SignedIn): Record<string, unknown> {
  const { record, description } = s;
  const me = description?.me ?? null;
  const doc: Record<string, unknown> = { ok: true };
  if (me) {
    doc.org = { slug: me.org.slug, name: me.org.name };
    doc.actor = me.actor;
  }
  const key: Record<string, unknown> = { prefix: record.prefix, last4: record.last4 };
  const name = keyName(s);
  if (name !== null) key.name = name;
  key.kind = record.kind;
  const scopes = keyScopes(s);
  if (scopes) key.scopes = scopes;
  if (me || s.requested) key.expiresAt = record.expiresAt;
  doc.key = key;
  // On an account-wide key only, and verbatim. Never an empty array standing in for "not applicable".
  if (description?.organizations) doc.organizations = description.organizations.data;
  doc.storage = s.storage;
  return doc;
}

// --- login ---------------------------------------------------------------------------------------------------

function recordFrom(ctx: Context, response: TokenResponse): CredentialRecord {
  return {
    ...makeCredentialRecord({
      token: response.token,
      kind: response.kind,
      apiUrl: ctx.config().apiUrl.value,
      org: response.org,
      expiresAt: response.expiresAt,
      now: ctx.primitives.now(),
    }),
    // The server's display columns, not a slice taken locally.
    prefix: response.prefix,
    last4: response.last4,
  };
}

function finishSignIn(ctx: Context, s: SignedIn, profile: string): void {
  if (ctx.out.json) ctx.out.jsonDocument(signedInJson(s));
  else renderSignedIn(ctx, s, profile);

  const envToken = ctx.primitives.env.WAM_TOKEN?.trim();
  if (envToken && envToken !== s.record.token) {
    ctx.out.warn("WAM_TOKEN is set in this environment and takes precedence over the stored credential.");
    ctx.out.warn("Unset it to use the key you just stored.");
  }
}

export async function runLogin(ctx: Context, opts: LoginOptions = {}, overrides: Partial<LoginDeps> = {}): Promise<void> {
  const deps: LoginDeps = { ...defaultLoginDeps(), ...overrides };
  // In the assembled program the global `--token` and this command's `--token` are one flag to
  // commander, so the value may arrive either way: `true` for the bare flag, a string for a key.
  // An empty value (`--token=`) is the bare flag too: there is no key in it to store.
  const given = opts.token === "" ? true : opts.token;
  const tokenOption = given !== undefined && given !== false ? given : ctx.flags.token;
  const tokenMode = tokenOption !== undefined;
  if (tokenMode && opts.device) throw usageError("Pass either --device or --token, not both.");

  const profile = ctx.config().profile.value;
  const store = ctx.credentialStore();

  if (tokenMode) {
    if (opts.accountWide || opts.name !== undefined || opts.scopes !== undefined || opts.expires !== undefined) {
      throw usageError(
        "--token stores a key that already exists, so --account-wide, --name, --scopes and --expires do not apply.",
        "Remove them, or drop --token to mint a new key in the browser.",
      );
    }
    const token = await readPastedToken(ctx, deps, tokenOption);
    // Verified before it is stored: a key the server does not accept never reaches the store.
    const description = await describeKey(ctx, clientFor(ctx, token), null);
    const base = makeCredentialRecord({
      token,
      kind: description.kind,
      apiUrl: ctx.config().apiUrl.value,
      org: description.me?.org.slug ?? null,
      expiresAt: description.me?.key.expiresAt ?? null,
      now: ctx.primitives.now(),
    });
    const record: CredentialRecord = description.me
      ? { ...base, prefix: description.me.key.prefix, last4: description.me.key.last4 }
      : base;
    const storage = await store.set(profile, record);
    finishSignIn(ctx, { record, storage, description, requested: null }, profile);
    return;
  }

  // Every flag is validated before a browser opens or a request is made.
  const request = parseMintRequest(opts, deps);

  const existing = await store.get(profile);
  if (!(await confirmMint(ctx, deps, request))) return;
  if (existing) {
    ctx.out.chatter(
      `Profile "${profile}" already holds ${displayRecord(existing.record)}. It will be replaced locally and stays valid on the server until it is revoked (wam auth logout does both).`,
    );
  }

  const response = opts.device ? await deviceFlow(ctx, deps, request) : await loopbackFlow(ctx, deps, opts, request);

  // Stored first: the key exists on the server from this moment, whatever happens below.
  let record = recordFrom(ctx, response);
  let storage = await store.set(profile, record);

  let description: KeyDescription | null = null;
  try {
    description = await describeKey(ctx, clientFor(ctx, response.token), response.kind);
  } catch (err) {
    const lines = err instanceof CliError ? err.lines : [err instanceof Error ? err.message : String(err)];
    ctx.out.warn("Signed in and stored the key, but could not read its details from the API:");
    for (const line of lines) ctx.out.warn(`  ${line}`);
  }
  // `kind` and `org` are a cache and GET /api/v1/me is authoritative (section 4.5).
  if (description?.me && (description.me.key.kind !== record.kind || description.me.org.slug !== record.org)) {
    record = { ...record, kind: description.me.key.kind, org: description.me.org.slug };
    storage = await store.set(profile, record);
  }

  finishSignIn(ctx, { record, storage, description, requested: request }, profile);
}

// --- logout ---------------------------------------------------------------------------------------------------

export async function runLogout(ctx: Context, opts: LogoutOptions = {}): Promise<void> {
  const cred = await ctx.requireCredential();
  const profile = ctx.config().profile.value;
  const store = ctx.credentialStore();
  const client = await ctx.client();

  // The server first. Nothing local is touched until the revoke has been attempted.
  let result: RevokeSelfResult | null = null;
  let failure: CliError | null = null;
  try {
    // Exactly `?all=cli` or nothing: any other value is a 422 (section 4.6). How far "all" reaches
    // on an org key against an account-wide key is the server's decision, never filtered here.
    result = await client.keys.revokeSelf(opts.all ? "cli" : undefined);
  } catch (err) {
    failure = ctx.mapError(err, LOGOUT);
  }

  // Then local state, whether or not the revoke succeeded.
  let cleared: CredentialStorage | null = null;
  let untouched: CredentialRecord | null = null;
  if (cred.source === "keychain" || cred.source === "file") {
    cleared = await store.delete(profile);
  } else {
    // The key came from --token or WAM_TOKEN. A stored credential is cleared only when it is that
    // same key: clearing a different one would orphan a live key without revoking it.
    const stored = await store.get(profile);
    if (stored && stored.record.token === cred.token) cleared = await store.delete(profile);
    else if (stored) untouched = stored.record;
  }
  const clearedLine =
    cleared !== null
      ? `Cleared the local credential (${storageLabel(cleared, ctx.primitives.platform)}).`
      : "There was no stored credential to clear.";

  if (failure) {
    // Exit 1 whatever the cause (section 3.2), so nobody takes a failed revoke for a logout.
    const localLine = cleared !== null ? clearedLine.replace(/\.$/, " anyway.") : clearedLine;
    const lines =
      failure.code === "unauthorized"
        ? [
            `The server did not accept ${cred.display}, so this command revoked nothing there.`,
            "It may already be revoked or expired. If it belongs to a different API origin, revoke it there.",
            localLine,
          ]
        : [`Could not revoke ${cred.display} on the server, so that key may still be live.`, ...failure.lines, localLine];
    throw new CliError(failure.code, EXIT.FAILURE, lines, {
      details: failure.details,
      requestId: failure.requestId,
    });
  }

  if (ctx.out.json) {
    ctx.out.jsonDocument({ ok: true, key: cred.display, server: result, cleared });
  } else {
    const n = result?.revoked ?? 0;
    ctx.out.chatter(
      opts.all
        ? `Revoked ${n} ${plural(n, "key", "keys")} on the server, ${cred.display} among them.`
        : `Revoked ${cred.display} on the server.`,
    );
    ctx.out.chatter(clearedLine);
  }
  if (untouched) {
    ctx.out.warn(
      `The stored credential ${displayRecord(untouched)} is a different key and was left in place. Run wam auth logout without ${cred.source} to revoke it.`,
    );
  }
  if (cred.source === "WAM_TOKEN") {
    ctx.out.warn("WAM_TOKEN is still set in this environment and no longer works. Unset it.");
  }
}

// --- Registration ------------------------------------------------------------------------------------------------

/**
 * Adds `login` and `logout` to the existing `auth` group. `deps` is for tests; production passes
 * none. The action reads `optsWithGlobals()` because commander hands a `--token` that appears
 * after `auth login` to the program-level option of the same name (section 3.0), so that is where
 * the flag, or the key given as its value, arrives.
 */
export function registerAuthLoginCommands(
  authGroup: Command,
  getContext: () => Context,
  deps: Partial<LoginDeps> = {},
): void {
  authGroup
    .command("login")
    .description("Sign in through the browser (default), with a device code, or by storing an existing API key")
    .option("--device", "Use the device code flow: for SSH, containers, WSL and Codespaces")
    .option("--token", "Read an existing API key from stdin (or prompt for it) instead of running a browser flow")
    .option("--account-wide", "Mint a key that reaches every organization your account belongs to. Asks first")
    .option("--name <label>", "The key name shown in the dashboard (default: <hostname> CLI)")
    .option("--scopes <csv>", `Requested scopes, from: ${API_SCOPES.join(", ")}`)
    // No `|` inside the placeholder: commander splits an option's flags on it.
    .option(
      "--expires <days>",
      `Requested key expiry: ${LOGIN_EXPIRES.join(", ")} (default: ${DEFAULT_EXPIRES}). The approval page can lower it`,
    )
    .option("--no-browser", "Print the URL instead of opening a browser")
    .addHelpText(
      "after",
      "\nExamples:\n  $ wam auth login --device\n  $ wam auth login --account-wide --scopes orgs:write,workspaces:read,scans:read,reports:read\n  $ wam auth login\n",
    )
    .action(async (_local: Record<string, unknown>, command: Command) => {
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const local = command.opts() as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const token =
        merged.token === true || merged.token === "" ? true : typeof merged.token === "string" ? merged.token : undefined;
      await runLogin(
        getContext(),
        {
          device: local.device === true,
          token,
          accountWide: local.accountWide === true,
          name: str(local.name),
          scopes: str(local.scopes),
          expires: str(local.expires),
          browser: local.browser !== false,
        },
        deps,
      );
    });

  authGroup
    .command("logout")
    .description("Revoke this key on the server, then clear the local credential")
    .option("--all", "Also revoke every other key you minted through the CLI. How far that reaches is the server's rule")
    .addHelpText("after", "\nExample:\n  $ wam auth logout\n")
    .action(async (_local: Record<string, unknown>, command: Command) => {
      await runLogout(getContext(), { all: command.opts().all === true });
    });
}
