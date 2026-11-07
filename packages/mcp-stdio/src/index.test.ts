import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  DEFAULT_MCP_URL,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  VERSION,
  adaptFrame,
  buildHeaders,
  forward,
  helpText,
  newSession,
  resolveEndpoint,
  run,
} from "./index";

const SOURCE = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

function collector() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => chunks.push(s) };
}

/** A stdin that records whether anyone ever tried to read it. */
function watchedStdin(lines: string[] = []) {
  let touched = false;
  const stream = new Readable({
    read() {
      touched = true;
      for (const line of lines) this.push(`${line}\n`);
      this.push(null);
    },
  });
  return { stream, wasRead: () => touched };
}

function stubFetch(reply: (body: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(String(init?.body ?? ""));
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function jsonRpcReply(body: string): Response {
  const id = (JSON.parse(body) as { id?: unknown }).id ?? null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { echoed: JSON.parse(body) } }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("the bridge is a dumb proxy", () => {
  it("holds no tool definitions and no schemas", () => {
    expect(SOURCE).not.toMatch(/registerTool/);
    expect(SOURCE).not.toMatch(/from ["']zod["']/);
    expect(SOURCE).not.toMatch(/@modelcontextprotocol/);
    expect(SOURCE).not.toMatch(/@whereamimentioned\/api-client/);
  });

  it("forwards a 2026-07-28 frame verbatim, with the protocol version, the mirrored method header and the Authorization header", async () => {
    const frame = `{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"_meta":{"${PROTOCOL_VERSION_META_KEY}":"2026-07-28","${CLIENT_CAPABILITIES_META_KEY}":{}}}}`;
    const { fetchImpl, calls } = stubFetch(jsonRpcReply);
    const out = await forward(frame, DEFAULT_MCP_URL, buildHeaders({ WAM_TOKEN: "wam_test_abc" }), fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEFAULT_MCP_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(frame);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer wam_test_abc");
    expect(headers["MCP-Protocol-Version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(headers["MCP-Protocol-Version"]).toBe("2026-07-28");
    expect(headers[MCP_METHOD_HEADER]).toBe("tools/list");
    expect(headers).not.toHaveProperty(MCP_NAME_HEADER);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`wam-mcp/${VERSION}`);
    // One line, exactly, whatever whitespace the endpoint used.
    expect(out).not.toBeNull();
    expect(out).not.toContain("\n");
    expect(JSON.parse(out!)).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: JSON.parse(frame) } });
  });

  it("adds the per-request envelope to a frame that lacks one and mirrors params.name into Mcp-Name", async () => {
    const frame = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_meta_description","arguments":{"url":"https://example.com/"}}}';
    const { fetchImpl, calls } = stubFetch(jsonRpcReply);
    await forward(frame, DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    const sent = JSON.parse(String(calls[0].init.body)) as { id: number; method: string; params: Record<string, unknown> };
    expect(sent.id).toBe(3);
    expect(sent.method).toBe("tools/call");
    expect(sent.params.name).toBe("check_meta_description");
    expect(sent.params.arguments).toEqual({ url: "https://example.com/" });
    expect(sent.params._meta).toEqual({ [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: {} });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[MCP_METHOD_HEADER]).toBe("tools/call");
    expect(headers[MCP_NAME_HEADER]).toBe("check_meta_description");
  });

  it("sends no Authorization header when WAM_TOKEN is absent", () => {
    expect(buildHeaders({})).not.toHaveProperty("Authorization");
    expect(buildHeaders({ WAM_TOKEN: "  " })).not.toHaveProperty("Authorization");
  });

  it("writes nothing for a notification the endpoint answers with no body", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 202 }));
    const out = await forward('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":4}}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>)[MCP_METHOD_HEADER]).toBe("notifications/cancelled");
  });

  it("drops a 2025-era notifications/initialized without a request: the modern endpoint has nothing to receive", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 202 }));
    const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("turns a non-JSON endpoint answer into a JSON-RPC error frame carrying the request id", async () => {
    const { fetchImpl } = stubFetch(() => new Response("<html>login</html>", { status: 502 }));
    const out = await forward('{"jsonrpc":"2.0","id":"abc","method":"tools/list"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(JSON.parse(out!)).toMatchObject({ jsonrpc: "2.0", id: "abc", error: { code: -32000, data: { status: 502 } } });
  });

  it("turns the 401 envelope (09 section 4.7: no jsonrpc, no id) into an error frame the client can resolve", async () => {
    const message = "Missing or invalid API key. Create one at https://whereamimentioned.com/<org>/settings/api-keys";
    const challenge = 'Bearer resource_metadata="https://whereamimentioned.com/.well-known/oauth-protected-resource", scope="scans:read"';
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message, requestId: "req_01JQ8Z3F7K4W2N9XR5PM3BQTVD" } }), {
          status: 401,
          headers: { "content-type": "application/json", "WWW-Authenticate": challenge },
        }),
    );
    const out = await forward('{"jsonrpc":"2.0","id":"abc","method":"tools/call","params":{"name":"list_workspaces"}}', DEFAULT_MCP_URL, buildHeaders({ WAM_TOKEN: "wam_live_expired" }), fetchImpl);
    expect(out).not.toBeNull();
    expect(out).not.toContain("\n");
    expect(JSON.parse(out!)).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: {
        code: -32000,
        message,
        data: { status: 401, code: "unauthorized", requestId: "req_01JQ8Z3F7K4W2N9XR5PM3BQTVD", wwwAuthenticate: challenge },
      },
    });
  });

  it("turns an empty non-2xx body into an error frame instead of writing nothing", async () => {
    const { fetchImpl } = stubFetch(() => new Response(null, { status: 500 }));
    const out = await forward('{"jsonrpc":"2.0","id":5,"method":"tools/list"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32000, data: { status: 500 } } });
  });

  it("carries a transport 429's Retry-After into the error frame", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests", requestId: "req_x" } }), {
          status: 429,
          headers: { "content-type": "application/json", "Retry-After": "17" },
        }),
    );
    const out = await forward('{"jsonrpc":"2.0","id":6,"method":"tools/list"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(JSON.parse(out!)).toMatchObject({
      id: 6,
      error: { message: "Too many requests", data: { status: 429, code: "rate_limited", retryAfterSeconds: 17 } },
    });
  });

  it("wraps a JSON body that is neither a frame nor an envelope, with a preview", async () => {
    const { fetchImpl } = stubFetch(() => new Response('{"error":"Method Not Allowed"}', { status: 405 }));
    const out = await forward('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    const parsed = JSON.parse(out!) as { id: unknown; error: { data: Record<string, unknown> } };
    expect(parsed.id).toBe(7);
    expect(parsed.error.data.status).toBe(405);
    expect(parsed.error.data.bodyPreview).toBe('{"error":"Method Not Allowed"}');
  });

  it("passes a real JSON-RPC error frame through unchanged even on a non-2xx status", async () => {
    const body = { jsonrpc: "2.0", id: 8, error: { code: -32600, message: "Invalid Request" } };
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify(body, null, 2), { status: 400 }));
    const out = await forward('{"jsonrpc":"2.0","id":8,"method":"nope"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(out).toBe(JSON.stringify(body));
  });

  it("still writes nothing for an empty 200", async () => {
    const { fetchImpl } = stubFetch(() => new Response("", { status: 200 }));
    const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(out).toBeNull();
  });
});

describe("2025-era clients (09 section 2.1: served by the bridge, not by the endpoint)", () => {
  const DISCOVER_RESULT = {
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
    instructions: "hello",
    resultType: "complete",
    _meta: { [SERVER_INFO_META_KEY]: { name: "whereamimentioned", version: "0.1.0" } },
  };

  function discoverReply(body: string): Response {
    const req = JSON.parse(body) as { id: unknown; method: string };
    if (req.method !== "server/discover") return new Response("wrong method", { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: DISCOVER_RESULT }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("answers initialize from the endpoint's server/discover, as the InitializeResult the client expects", async () => {
    const session = newSession();
    const initialize =
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{}},"clientInfo":{"name":"old-client","version":"1.0"}}}';
    const { fetchImpl, calls } = stubFetch(discoverReply);
    const out = await forward(initialize, DEFAULT_MCP_URL, buildHeaders({}), fetchImpl, session);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0].init.body)) as { id: number; method: string; params: Record<string, unknown> };
    expect(sent.method).toBe("server/discover");
    expect(sent.id).toBe(0);
    expect(sent.params._meta).toEqual({ [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: { roots: {} } });
    expect((calls[0].init.headers as Record<string, string>)[MCP_METHOD_HEADER]).toBe("server/discover");
    expect(JSON.parse(out!)).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: DISCOVER_RESULT.capabilities,
        serverInfo: { name: "whereamimentioned", version: "0.1.0" },
        instructions: "hello",
      },
    });
    // The declared client capabilities ride along in every later envelope of the session.
    expect(session.clientCapabilities).toEqual({ roots: {} });
    await forward('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl, session);
    const next = JSON.parse(String(calls[1].init.body)) as { params: { _meta: Record<string, unknown> } };
    expect(next.params._meta[CLIENT_CAPABILITIES_META_KEY]).toEqual({ roots: {} });
  });

  it("passes an auth failure on server/discover through as the error frame, so a bad WAM_TOKEN fails initialize loudly", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", requestId: "req_x" } }), {
          status: 429,
          headers: { "content-type": "application/json", "Retry-After": "9" },
        }),
    );
    const out = await forward('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}', DEFAULT_MCP_URL, buildHeaders({}), fetchImpl);
    expect(JSON.parse(out!)).toMatchObject({ id: 0, error: { message: "slow down", data: { status: 429, retryAfterSeconds: 9 } } });
  });

  it("adaptFrame classifies the three cases and leaves non-request frames alone", () => {
    const session = newSession();
    expect(adaptFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}', session)).toEqual({ kind: "drop" });
    expect(adaptFrame("not json", session)).toEqual({ kind: "forward", body: "not json", headers: {} });
    expect(adaptFrame('{"jsonrpc":"2.0","id":1,"result":{}}', session)).toEqual({ kind: "forward", body: '{"jsonrpc":"2.0","id":1,"result":{}}', headers: {} });
    const init = adaptFrame('{"jsonrpc":"2.0","id":"a","method":"initialize","params":{}}', session);
    expect(init.kind).toBe("initialize");
    if (init.kind === "initialize") {
      expect(init.requestedVersion).toBe("2025-06-18");
      expect(init.headers).toEqual({ [MCP_METHOD_HEADER]: "server/discover" });
    }
    const get = adaptFrame('{"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"weekly_visibility_pulse","arguments":{}}}', session);
    expect(get.kind).toBe("forward");
    if (get.kind === "forward") expect(get.headers).toEqual({ [MCP_METHOD_HEADER]: "prompts/get", [MCP_NAME_HEADER]: "weekly_visibility_pulse" });
  });
});

describe("endpoint resolution", () => {
  it("defaults to the hosted endpoint and appends org, workspace and readonly as path segments", () => {
    expect(resolveEndpoint({})).toBe(DEFAULT_MCP_URL);
    expect(resolveEndpoint({ WAM_ORG: "acme" })).toBe(`${DEFAULT_MCP_URL}/acme`);
    expect(resolveEndpoint({ WAM_ORG: "acme", WAM_WORKSPACE: "main" })).toBe(`${DEFAULT_MCP_URL}/acme/main`);
    expect(resolveEndpoint({ WAM_READONLY: "1" })).toBe(`${DEFAULT_MCP_URL}/readonly`);
    expect(resolveEndpoint({ WAM_ORG: "acme", WAM_READONLY: "1" })).toBe(`${DEFAULT_MCP_URL}/acme/readonly`);
    expect(resolveEndpoint({ WAM_ORG: "acme", WAM_WORKSPACE: "main", WAM_READONLY: "1" })).toBe(
      `${DEFAULT_MCP_URL}/acme/main/readonly`,
    );
    expect(resolveEndpoint({ WAM_READONLY: "0" })).toBe(DEFAULT_MCP_URL);
  });

  it("honours WAM_MCP_URL for staging and strips a trailing slash", () => {
    expect(resolveEndpoint({ WAM_MCP_URL: "https://staging.example.test/api/mcp/", WAM_ORG: "acme" })).toBe(
      "https://staging.example.test/api/mcp/acme",
    );
  });

  it("ignores WAM_WORKSPACE without WAM_ORG and says so on stderr", () => {
    const warn = vi.fn();
    expect(resolveEndpoint({ WAM_WORKSPACE: "main" }, warn)).toBe(DEFAULT_MCP_URL);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the proxy loop", () => {
  it("never fetches any URL other than WAM_MCP_URL, one POST per frame, one response line per frame", async () => {
    const endpoint = "https://staging.example.test/api/mcp";
    const frames = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      "",
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_ai_crawler_access","arguments":{"url":"http://192.168.1.1/"}}}',
    ];
    const { fetchImpl, calls } = stubFetch(jsonRpcReply);
    const stdout = collector();
    const stderr = collector();
    const stdin = watchedStdin(frames);
    const code = await run([], { WAM_MCP_URL: endpoint, WAM_ORG: "acme", WAM_TOKEN: "wam_test_x" }, {
      stdin: stdin.stream,
      stdout,
      stderr,
      fetch: fetchImpl,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).toBe(`${endpoint}/acme`);
    // The user-supplied URL inside the tool arguments is never fetched by the bridge.
    expect(calls.some((c) => c.url.includes("192.168.1.1"))).toBe(false);
    // The two requests go out in order, each completed with the envelope and otherwise unchanged.
    const sent = calls.map((c) => JSON.parse(String(c.init.body)) as { id: number; method: string; params: Record<string, unknown> });
    expect(sent.map((s) => [s.id, s.method])).toEqual([
      [1, "tools/list"],
      [2, "tools/call"],
    ]);
    expect(sent[1].params.arguments).toEqual({ url: "http://192.168.1.1/" });
    for (const s of sent) expect(s.params._meta).toHaveProperty(PROTOCOL_VERSION_META_KEY, "2026-07-28");
    const lines = stdout.chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id).sort()).toEqual([1, 2]);
    expect(stderr.chunks).toEqual([]);
  });

  it("answers an unreachable endpoint with an error frame instead of dying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const stdout = collector();
    const stderr = collector();
    const code = await run([], {}, {
      stdin: watchedStdin(['{"jsonrpc":"2.0","id":9,"method":"tools/list"}']).stream,
      stdout,
      stderr,
      fetch: fetchImpl,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.chunks[0])).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32000 } });
    expect(stderr.chunks.join("")).toContain("fetch failed");
  });
});

describe("--version and --help", () => {
  it.each([["--version"], ["--help"]])("%s prints and exits 0 without reading stdin or fetching", async (flag) => {
    const { fetchImpl } = stubFetch(jsonRpcReply);
    const stdout = collector();
    const stdin = watchedStdin(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    const code = await run([flag], { WAM_TOKEN: "wam_test_x" }, {
      stdin: stdin.stream,
      stdout,
      stderr: collector(),
      fetch: fetchImpl,
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdin.wasRead()).toBe(false);
    const out = stdout.chunks.join("");
    if (flag === "--version") {
      expect(out).toBe(`${VERSION}\n`);
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    } else {
      expect(out).toBe(helpText());
      for (const name of ["WAM_TOKEN", "WAM_MCP_URL", "WAM_ORG", "WAM_WORKSPACE", "WAM_READONLY"]) {
        expect(out).toContain(name);
      }
      expect(out).not.toContain("\u2014");
    }
  });
});
