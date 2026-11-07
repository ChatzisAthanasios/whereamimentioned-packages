/**
 * wam-mcp: the stdio bridge to the hosted whereamimentioned MCP server (09-MCP-SERVER section 3.4).
 *
 * A dumb proxy, on purpose. It reads newline-delimited JSON-RPC frames from stdin, POSTs each one
 * to the hosted endpoint, and writes each response frame to stdout, one per line. It holds no tool
 * definitions, no schemas, no database access and no business logic, so it cannot drift from the
 * remote server: whatever the endpoint lists is what a stdio client sees.
 *
 * The one thing it knows is the protocol era (09 section 2.1). The hosted endpoint speaks revision
 * 2026-07-28 only: every request carries a per-request `_meta` envelope plus the mirrored
 * `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, and there is no initialize
 * handshake. A stdio client on a 2025-era revision opens with `initialize`, so the bridge answers
 * that one locally from the endpoint's `server/discover`, drops the `notifications/initialized`
 * that follows, and adds the envelope to every later frame that lacks one. A client that already
 * speaks 2026-07-28 has its frames forwarded untouched. Neither path inspects tool names or
 * arguments beyond mirroring `params.name` into the `Mcp-Name` header the transport requires.
 *
 * It never fetches anything except the endpoint. The site tools take user-supplied URLs, and the
 * SSRF guard that protects them must run where the trust boundary is (the hosted app), not on the
 * user's own machine inside their private network.
 *
 * Env:
 *   WAM_TOKEN       API key. If absent, the bridge still runs and only the anonymous tools appear.
 *   WAM_MCP_URL     Endpoint override, for staging. Default https://whereamimentioned.com/api/mcp
 *   WAM_ORG         Appended as a URL path segment: pins the org (and the tool list).
 *   WAM_WORKSPACE   Appended after WAM_ORG: pins the workspace.
 *   WAM_READONLY    If "1", appends the /readonly path suffix, which drops every write tool.
 */
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { version } from "../package.json";

export const VERSION: string = version;
export const DEFAULT_MCP_URL = "https://whereamimentioned.com/api/mcp";
/** The only protocol revision the hosted server speaks (09 section 0.1). Sent on every POST. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** The two reserved `_meta` keys of the 2026-07-28 per-request envelope. */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** The headers the 2026-07-28 transport requires to mirror the body, validated by the server. */
export const MCP_METHOD_HEADER = "Mcp-Method";
export const MCP_NAME_HEADER = "Mcp-Name";

/** Which `params` field `Mcp-Name` mirrors, per method. Methods absent here carry no `Mcp-Name`. */
const MCP_NAME_SOURCE: Record<string, string> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

/** What a 2025-era client is told when it named no version of its own. */
const LEGACY_FALLBACK_VERSION = "2025-06-18";

export interface BridgeEnv {
  WAM_TOKEN?: string;
  WAM_MCP_URL?: string;
  WAM_ORG?: string;
  WAM_WORKSPACE?: string;
  WAM_READONLY?: string;
}

export interface BridgeIo {
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  fetch: typeof globalThis.fetch;
}

/**
 * Per-connection state: the capabilities a 2025-era client declared in `initialize`, echoed into
 * the envelope of every frame the bridge completes for it. Empty until an initialize arrives,
 * which is also what a modern client that never sends one gets.
 */
export interface BridgeSession {
  clientCapabilities: Record<string, unknown>;
}

export function newSession(): BridgeSession {
  return { clientCapabilities: {} };
}

const ENV_TABLE = [
  ["WAM_TOKEN", "(none)", "API key. If absent, the bridge still runs and only the anonymous tools appear."],
  ["WAM_MCP_URL", DEFAULT_MCP_URL, "Endpoint override, for staging."],
  ["WAM_ORG", "(none)", "Appended as a URL path segment. Pins the org and the tool list."],
  ["WAM_WORKSPACE", "(none)", "Appended after WAM_ORG. Pins the workspace."],
  ["WAM_READONLY", "(unset)", "If 1, appends the /readonly path suffix, which drops every write tool."],
] as const;

export function helpText(): string {
  const width = Math.max(...ENV_TABLE.map(([name]) => name.length));
  const rows = ENV_TABLE.map(
    ([name, def, meaning]) => `  ${name.padEnd(width)}  ${meaning}\n  ${"".padEnd(width)}  default: ${def}`,
  );
  return [
    `wam-mcp ${VERSION}`,
    "",
    "stdio bridge to the whereamimentioned MCP server. Reads JSON-RPC frames from stdin, one per",
    "line, forwards each to the hosted endpoint, and writes the response frames to stdout.",
    "",
    "Usage:",
    "  wam-mcp            start the bridge (reads stdin until EOF)",
    "  wam-mcp --version  print the version and exit",
    "  wam-mcp --help     print this text and exit",
    "",
    "Environment:",
    ...rows,
    "",
    "Docs: https://whereamimentioned.com/docs/mcp",
    "",
  ].join("\n");
}

/** The endpoint, with the org, workspace and readonly path segments of 09 section 4.2 appended. */
export function resolveEndpoint(env: BridgeEnv, warn: (msg: string) => void = () => {}): string {
  const base = (env.WAM_MCP_URL?.trim() || DEFAULT_MCP_URL).replace(/\/+$/, "");
  const org = env.WAM_ORG?.trim();
  const workspace = env.WAM_WORKSPACE?.trim();
  const segments: string[] = [];
  if (org) {
    segments.push(encodeURIComponent(org));
    if (workspace) segments.push(encodeURIComponent(workspace));
  } else if (workspace) {
    warn("wam-mcp: WAM_WORKSPACE is set but WAM_ORG is not; a workspace can only be pinned inside an org. Ignoring it.");
  }
  if (env.WAM_READONLY?.trim() === "1") segments.push("readonly");
  return [base, ...segments].join("/");
}

/** The headers every POST carries. The per-frame `Mcp-Method` / `Mcp-Name` pair is added by `adaptFrame`. */
export function buildHeaders(env: BridgeEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "User-Agent": `wam-mcp/${VERSION}`,
  };
  const token = env.WAM_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface ParsedFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseFrame(frame: string): ParsedFrame | null {
  try {
    const parsed: unknown = JSON.parse(frame);
    return isPlainObject(parsed) ? (parsed as ParsedFrame) : null;
  } catch {
    return null;
  }
}

function requestIdOf(frame: string): string | number | null {
  const parsed = parseFrame(frame);
  const id = parsed?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function errorFrame(id: string | number | null, message: string, data: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data } });
}

/** A JSON-RPC 2.0 frame, whatever its HTTP status: the endpoint answers a bad frame with 4xx plus one. */
function isJsonRpcFrame(v: unknown): boolean {
  return isPlainObject(v) && v.jsonrpc === "2.0";
}

/** The per-frame headers of the 2026-07-28 transport: `Mcp-Method`, and `Mcp-Name` where the method has a source. */
function frameHeaders(method: string, params: unknown): Record<string, string> {
  const headers: Record<string, string> = { [MCP_METHOD_HEADER]: method };
  const source = Object.hasOwn(MCP_NAME_SOURCE, method) ? MCP_NAME_SOURCE[method] : undefined;
  if (source !== undefined && isPlainObject(params)) {
    const value = params[source];
    if (typeof value === "string") headers[MCP_NAME_HEADER] = value;
  }
  return headers;
}

function hasEnvelope(params: unknown): boolean {
  return isPlainObject(params) && isPlainObject(params._meta) && PROTOCOL_VERSION_META_KEY in params._meta;
}

function withEnvelope(params: unknown, session: BridgeSession): Record<string, unknown> {
  const base = isPlainObject(params) ? params : {};
  const meta = isPlainObject(base._meta) ? base._meta : {};
  return {
    ...base,
    _meta: {
      ...meta,
      [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: session.clientCapabilities,
    },
  };
}

export type AdaptedFrame =
  /** POST `body` with `headers` added to the base set; the response frame is the client's answer. */
  | { kind: "forward"; body: string; headers: Record<string, string> }
  /** A 2025-era `notifications/initialized`: the modern endpoint has nothing to receive. */
  | { kind: "drop" }
  /** A 2025-era `initialize`: POST `body` (a `server/discover`) and translate its result locally. */
  | { kind: "initialize"; id: string | number | null; requestedVersion: string; body: string; headers: Record<string, string> };

/**
 * What to do with one frame from stdin. A frame that is not a JSON object, or not a request or
 * notification, is forwarded verbatim for the endpoint to judge. A request or notification that
 * already carries the 2026-07-28 envelope is forwarded verbatim too, with the mirrored headers. A
 * 2025-era `initialize` records the client's capabilities and becomes a `server/discover`; its
 * `notifications/initialized` is dropped; anything else gets the envelope added.
 */
export function adaptFrame(frame: string, session: BridgeSession): AdaptedFrame {
  const parsed = parseFrame(frame);
  if (parsed === null || typeof parsed.method !== "string") return { kind: "forward", body: frame, headers: {} };
  const method = parsed.method;
  const params = parsed.params;
  const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null;

  if (hasEnvelope(params)) return { kind: "forward", body: frame, headers: frameHeaders(method, params) };

  if (method === "initialize") {
    const p = isPlainObject(params) ? params : {};
    session.clientCapabilities = isPlainObject(p.capabilities) ? p.capabilities : {};
    const requestedVersion = typeof p.protocolVersion === "string" ? p.protocolVersion : LEGACY_FALLBACK_VERSION;
    const discover = { jsonrpc: "2.0", id, method: "server/discover", params: withEnvelope({}, session) };
    return {
      kind: "initialize",
      id,
      requestedVersion,
      body: JSON.stringify(discover),
      headers: frameHeaders("server/discover", discover.params),
    };
  }

  if (method === "notifications/initialized") return { kind: "drop" };

  const completed = { ...parsed, params: withEnvelope(params, session) };
  return { kind: "forward", body: JSON.stringify(completed), headers: frameHeaders(method, completed.params) };
}

/**
 * The hosted app's HTTP error envelope (08 section 4.2 / 09 section 4.7), when the body is one.
 * Fail closed: only the named fields are read, and the body is never spread into the frame.
 */
function envelopeOf(
  v: unknown,
): { code: string; message: string; requestId?: string; details?: unknown } | undefined {
  if (!isPlainObject(v) || !("error" in v)) return undefined;
  const error = v.error;
  if (!isPlainObject(error)) return undefined;
  if (typeof error.code !== "string" || typeof error.message !== "string") return undefined;
  return {
    code: error.code,
    message: error.message,
    requestId: typeof error.requestId === "string" ? error.requestId : undefined,
    details: error.details,
  };
}

/** The Retry-After header as an integer of seconds, else undefined. */
function retryAfterOf(res: Response): number | undefined {
  const value = res.headers.get("retry-after")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * POST one body and turn whatever comes back into exactly one response line, or null when the
 * endpoint accepted a notification with no body (a 2xx, which needs no reply).
 *
 * Anything that is not a JSON-RPC frame is wrapped into one, so the client's pending request always
 * resolves: the 401/403 envelope of 09 section 4.7 (which has no `jsonrpc` and no `id`), a transport
 * 429, an empty non-2xx, a proxy page. Without that an invalid WAM_TOKEN would make every
 * authenticated tool call hang rather than error.
 */
async function post(
  body: string,
  id: string | number | null,
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<string | null> {
  const res = await fetchImpl(endpoint, { method: "POST", headers, body });
  const text = await res.text();
  if (text.trim() === "") {
    // Only a 2xx with no body is a notification the endpoint accepted (202 per Streamable HTTP).
    if (res.ok) return null;
    return errorFrame(id, `whereamimentioned MCP endpoint answered HTTP ${res.status} with an empty body`, {
      status: res.status,
      retryAfterSeconds: retryAfterOf(res),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorFrame(id, `whereamimentioned MCP endpoint answered HTTP ${res.status} with a non-JSON body`, {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
  }
  // A real frame passes through whatever the HTTP status, re-serialised compactly so it is
  // guaranteed to occupy exactly one line.
  if (isJsonRpcFrame(parsed)) return JSON.stringify(parsed);
  // Anything else is the hosted app's HTTP error envelope: 401, 403, transport 429.
  const env = envelopeOf(parsed);
  return errorFrame(
    id,
    env?.message ?? `whereamimentioned MCP endpoint answered HTTP ${res.status} with a non-JSON-RPC body`,
    {
      status: res.status,
      code: env?.code,
      requestId: env?.requestId,
      details: env?.details,
      wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined,
      retryAfterSeconds: retryAfterOf(res),
      bodyPreview: env ? undefined : text.slice(0, 200),
    },
  );
}

/**
 * A `server/discover` result as the InitializeResult a 2025-era client expects: the version it
 * asked for (the bridge is the 2025 server it is talking to), the endpoint's capabilities,
 * serverInfo and instructions. Anything that is not a discover result is passed through as-is,
 * so an auth or transport failure reaches the client as the error frame it already is.
 */
function initializeResultFrom(discoverLine: string | null, id: string | number | null, requestedVersion: string): string {
  if (discoverLine === null) {
    return errorFrame(id, "whereamimentioned MCP endpoint answered server/discover with no body", {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(discoverLine);
  } catch {
    return discoverLine;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.result)) return discoverLine;
  const result = parsed.result;
  const meta = isPlainObject(result._meta) ? result._meta : {};
  const serverInfo = isPlainObject(meta[SERVER_INFO_META_KEY])
    ? meta[SERVER_INFO_META_KEY]
    : { name: "whereamimentioned", version: VERSION };
  const initialize: Record<string, unknown> = {
    protocolVersion: requestedVersion,
    capabilities: isPlainObject(result.capabilities) ? result.capabilities : {},
    serverInfo,
  };
  if (typeof result.instructions === "string") initialize.instructions = result.instructions;
  return JSON.stringify({ jsonrpc: "2.0", id, result: initialize });
}

/**
 * Forwards one frame. Returns the response frame as a single line, or null when there is nothing
 * to write (an accepted notification, or a dropped 2025-era `notifications/initialized`).
 */
export async function forward(
  frame: string,
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  session: BridgeSession = newSession(),
): Promise<string | null> {
  const adapted = adaptFrame(frame, session);
  if (adapted.kind === "drop") return null;
  const merged = { ...headers, ...adapted.headers };
  if (adapted.kind === "initialize") {
    const line = await post(adapted.body, adapted.id, endpoint, merged, fetchImpl);
    return initializeResultFrom(line, adapted.id, adapted.requestedVersion);
  }
  return post(adapted.body, requestIdOf(frame), endpoint, merged, fetchImpl);
}

/**
 * Runs the bridge. `--version` and `--help` are the only arguments it understands, and both return
 * before stdin is opened or any request is made. Anything else is ignored and the proxy loop starts.
 */
export async function run(argv: readonly string[], env: BridgeEnv, io: BridgeIo): Promise<number> {
  if (argv.includes("--version")) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv.includes("--help")) {
    io.stdout.write(helpText());
    return 0;
  }

  const endpoint = resolveEndpoint(env, (msg) => io.stderr.write(`${msg}\n`));
  const headers = buildHeaders(env);
  const session = newSession();
  const inFlight = new Set<Promise<void>>();

  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const frame = line.trim();
    if (!frame) continue;
    const job = forward(frame, endpoint, headers, io.fetch, session)
      .then((out) => {
        if (out !== null) io.stdout.write(`${out}\n`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`wam-mcp: request to ${endpoint} failed: ${message}\n`);
        io.stdout.write(`${errorFrame(requestIdOf(frame), "whereamimentioned MCP endpoint unreachable", { endpoint, message })}\n`);
      })
      .finally(() => {
        inFlight.delete(job);
      });
    inFlight.add(job);
  }
  await Promise.all(inFlight);
  return 0;
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
  run(process.argv.slice(2), process.env as BridgeEnv, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    fetch: (input, init) => globalThis.fetch(input, init),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`wam-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
