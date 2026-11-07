import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPrimitives, ExecResult } from "../context";
import { displayToken, makeCredentialRecord } from "../credentials";
import { main } from "../index";
import { FAKE_TOKEN, FIXED_NOW, fakePrimitives, fakeStdin, fakeStream, mkdirp, tempDir, type TempDir } from "../test-support";
import { compactTimestamp, findClaudeOnWindows, looksLikeJsonc, probeWindsurfPath } from "./mcp";

// The real fs throughout, with chmodSync wrapped so a test can see the call happen, or not happen,
// whatever the host: the bits on disk only prove anything on a POSIX runner.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

const BASE = "https://whereamimentioned.com/api/mcp";
const PLACEHOLDER = "Bearer ${WAM_TOKEN}";
const STAMP = "20260910T120000Z";
const EM_DASH = String.fromCharCode(0x2014);
/** prefix...last4, the only form a token may take in output (section 4.7). */
const SHOWN = displayToken(FAKE_TOKEN);

/** The section 3.8 table, typed out here independently of the implementation. */
interface Row {
  client: string;
  project: string | null;
  global: string;
  key: string;
  entry(url: string, auth: string): Record<string, unknown>;
  carriesToken: boolean;
}

const withHeaders = (url: string, auth: string) => ({ url, headers: { Authorization: auth } });

const TABLE: Row[] = [
  { client: "cursor", project: ".cursor/mcp.json", global: ".cursor/mcp.json", key: "mcpServers", entry: withHeaders, carriesToken: true },
  { client: "vscode", project: ".vscode/mcp.json", global: ".config/Code/User/mcp.json", key: "servers", entry: (url) => ({ type: "http", url }), carriesToken: false },
  { client: "windsurf", project: null, global: ".codeium/mcp_config.json", key: "mcpServers", entry: (url, auth) => ({ serverUrl: url, headers: { Authorization: auth } }), carriesToken: true },
  { client: "zed", project: null, global: ".config/zed/settings.json", key: "context_servers", entry: withHeaders, carriesToken: true },
  { client: "warp", project: ".warp/.mcp.json", global: ".warp/.mcp.json", key: "mcpServers", entry: withHeaders, carriesToken: true },
  { client: "opencode", project: "opencode.json", global: ".config/opencode/opencode.json", key: "mcp", entry: (url) => ({ type: "remote", url, enabled: true }), carriesToken: false },
  { client: "amp", project: ".amp/settings.json", global: ".config/amp/settings.json", key: "amp.mcpServers", entry: withHeaders, carriesToken: true },
  { client: "jetbrains", project: ".junie/mcp/mcp.json", global: ".junie/mcp/mcp.json", key: "mcpServers", entry: (url, auth) => ({ type: "streamable-http", url, headers: { Authorization: auth } }), carriesToken: true },
];

let tmp: TempDir;
let home: string;
let cwd: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  execCalls: Array<{ command: string; args: string[] }>;
}

interface RunOptions {
  env?: Record<string, string>;
  /** What the user types at the prompt. Setting it makes the run interactive. */
  answer?: string | null;
  exec?: (command: string, args: readonly string[]) => Promise<ExecResult>;
  platform?: string;
}

async function run(argv: string[], opts: RunOptions = {}): Promise<Run> {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const execCalls: Run["execCalls"] = [];
  const interactive = opts.answer !== undefined;
  const overrides: Partial<ContextPrimitives> = {
    homedir: home,
    cwd,
    env: opts.env ?? {},
    stdout,
    stderr,
    stdin: fakeStdin(opts.answer ?? null),
    isTTY: { stdout: interactive, stdin: false },
    platform: opts.platform ?? "linux",
    fileMode: () => 0o600,
    exec: async (command, args) => {
      execCalls.push({ command, args: [...args] });
      return opts.exec ? opts.exec(command, args) : { stdout: "", stderr: "", code: 0 };
    },
  };
  const code = await main(argv, fakePrimitives(overrides));
  return { code, stdout: stdout.text, stderr: stderr.text, execCalls };
}

function tree(): string[] {
  return (readdirSync(tmp.dir, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, "/")).sort();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const TOKEN_ENV = { WAM_TOKEN: FAKE_TOKEN };

beforeEach(() => {
  tmp = tempDir("wam-mcp-");
  home = mkdirp(join(tmp.dir, "home"));
  cwd = mkdirp(join(tmp.dir, "repo"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  tmp.cleanup();
});

describe("wam mcp url (section 3.8)", () => {
  it("prints only the URL on stdout, and the bare endpoint when nothing is resolved", async () => {
    expect(await run(["mcp", "url"])).toMatchObject({ code: 0, stdout: `${BASE}\n`, stderr: "" });
    expect((await run(["mcp", "url", "--readonly"])).stdout).toBe(`${BASE}/readonly\n`);
  });

  it("defaults to the workspace when one is resolved, else the org, else neither", async () => {
    const both = await run(["mcp", "url", "--org", "acme", "--workspace", "acme-eu"]);
    expect(both).toMatchObject({ code: 0, stdout: `${BASE}/acme/acme-eu\n`, stderr: "" });
    expect((await run(["mcp", "url"], { env: { WAM_ORG: "acme", WAM_WORKSPACE: "acme-eu" } })).stdout).toBe(`${BASE}/acme/acme-eu\n`);
    expect((await run(["mcp", "url", "--org", "acme"])).stdout).toBe(`${BASE}/acme\n`);
    expect((await run(["mcp", "url", "--org", "acme", "--workspace", "acme-eu", "--readonly"])).stdout).toBe(`${BASE}/acme/acme-eu/readonly\n`);
  });

  it("honours each --scope, with and without --readonly", async () => {
    const pinned = ["--org", "acme", "--workspace", "acme-eu"];
    expect((await run(["mcp", "url", "--scope", "workspace", ...pinned])).stdout).toBe(`${BASE}/acme/acme-eu\n`);
    expect((await run(["mcp", "url", "--scope", "org", ...pinned])).stdout).toBe(`${BASE}/acme\n`);
    expect((await run(["mcp", "url", "--scope", "none", ...pinned])).stdout).toBe(`${BASE}\n`);
    expect((await run(["mcp", "url", "--scope", "org", "--readonly", ...pinned])).stdout).toBe(`${BASE}/acme/readonly\n`);
    expect((await run(["mcp", "url", "--scope", "none", "--readonly", ...pinned])).stdout).toBe(`${BASE}/readonly\n`);
  });

  it("a scope that cannot be satisfied is a usage error with nothing on stdout", async () => {
    const noWorkspace = await run(["mcp", "url", "--scope", "workspace", "--org", "acme"]);
    expect(noWorkspace).toMatchObject({ code: 2, stdout: "" });
    expect(noWorkspace.stderr).toContain("No workspace selected.");
    const noOrg = await run(["mcp", "url", "--scope", "org"]);
    expect(noOrg).toMatchObject({ code: 2, stdout: "" });
    expect(noOrg.stderr).toContain("No organization selected, so the MCP URL cannot be pinned to one.");
    const bogus = await run(["mcp", "url", "--scope", "team"]);
    expect(bogus).toMatchObject({ code: 2, stdout: "" });
    expect(bogus.stderr).toContain("Allowed choices are org, workspace, none");
  });

  it("a workspace with no organization stays unpinned and says so on stderr only", async () => {
    const r = await run(["mcp", "url", "--workspace", "acme-eu"]);
    expect(r).toMatchObject({ code: 0, stdout: `${BASE}\n` });
    expect(r.stderr).toContain("A workspace is selected (acme-eu) but no organization is");
  });

  it("honours WAM_MCP_URL, and WAM_API_URL when it is not set", async () => {
    const staged = await run(["mcp", "url", "--org", "acme", "--readonly"], { env: { WAM_MCP_URL: "https://staging.example.com/api/mcp/" } });
    expect(staged).toMatchObject({ code: 0, stdout: "https://staging.example.com/api/mcp/acme/readonly\n", stderr: "" });
    expect((await run(["mcp", "url"], { env: { WAM_API_URL: "http://localhost:3000" } })).stdout).toBe("http://localhost:3000/api/mcp\n");
    const both = await run(["mcp", "url"], { env: { WAM_API_URL: "http://localhost:3000", WAM_MCP_URL: "https://mcp.example.com/x" } });
    expect(both.stdout).toBe("https://mcp.example.com/x\n");
    const bad = await run(["mcp", "url"], { env: { WAM_MCP_URL: "not a url" } });
    expect(bad).toMatchObject({ code: 2, stdout: "" });
    expect(bad.stderr).toContain("WAM_MCP_URL must be an absolute URL");
  });

  it("falls back to the stored credential's default org", async () => {
    const record = makeCredentialRecord({ token: FAKE_TOKEN, kind: "org", apiUrl: "https://whereamimentioned.com", org: "northwind", expiresAt: null, now: FIXED_NOW });
    seed(join(home, ".config", "whereamimentioned", "credentials.json"), JSON.stringify({ version: 1, profiles: { default: record } }));
    expect((await run(["mcp", "url"])).stdout).toBe(`${BASE}/northwind\n`);
    expect((await run(["mcp", "url", "--workspace", "nw-eu"])).stdout).toBe(`${BASE}/northwind/nw-eu\n`);
    expect((await run(["mcp", "url", "--scope", "none"])).stdout).toBe(`${BASE}\n`);
  });

  it("--json emits one document", async () => {
    const r = await run(["mcp", "url", "--org", "acme", "--workspace", "acme-eu", "--readonly", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ url: `${BASE}/acme/acme-eu/readonly`, scope: "workspace", org: "acme", workspace: "acme-eu", readonly: true });
  });
});

describe("wam mcp install: the nine clients (section 3.8 table)", () => {
  for (const row of TABLE) {
    it(`${row.client}: --print emits the ${row.key} key and the right remote shape, and touches nothing`, async () => {
      const before = tree();
      const r = await run(["mcp", "install", "--client", row.client, "--print", "--org", "acme"], { env: TOKEN_ENV });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ [row.key]: { whereamimentioned: row.entry(`${BASE}/acme`, PLACEHOLDER) } });
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
      expect(r.stderr).toContain("Nothing was written.");
      expect(tree()).toEqual(before);
    });

    it(`${row.client}: a real write lands in the right file under the ${row.key} key`, async () => {
      const r = await run(["mcp", "install", "--client", row.client, "--yes"], { env: TOKEN_ENV });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      const path = row.project ? join(cwd, row.project) : join(home, row.global);
      // A project-scoped file gets the placeholder; windsurf and zed only have a user-level file.
      const auth = row.project ? PLACEHOLDER : `Bearer ${FAKE_TOKEN}`;
      expect(readJson(path)).toEqual({ [row.key]: { whereamimentioned: row.entry(BASE, auth) } });
      expect(readFileSync(path, "utf8")).toMatch(/^\{\n {2}"/);
      expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
      expect(r.stderr).toContain(`Wrote ${row.project ?? `~/${row.global}`}\n`);
      expect(r.stderr).not.toContain("Backup written to");
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    });

    it(`${row.client}: --global writes the user-level file`, async () => {
      const r = await run(["mcp", "install", "--client", row.client, "--global", "--yes"], { env: TOKEN_ENV });
      expect(r.code).toBe(0);
      const auth = `Bearer ${FAKE_TOKEN}`;
      expect(readJson(join(home, row.global))).toEqual({ [row.key]: { whereamimentioned: row.entry(BASE, auth) } });
      if (row.project) expect(existsSync(join(cwd, row.project))).toBe(false);
      expect(readFileSync(join(home, row.global), "utf8").includes(FAKE_TOKEN)).toBe(row.carriesToken);
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    });
  }

  it("the top-level keys and transport discriminators differ exactly as the table says", async () => {
    const shape = async (client: string) => {
      const doc = JSON.parse((await run(["mcp", "install", "--client", client, "--print"])).stdout) as Record<string, Record<string, Record<string, unknown>>>;
      const key = Object.keys(doc)[0]!;
      return { key, entry: doc[key]!.whereamimentioned! };
    };
    expect(await shape("cursor")).toMatchObject({ key: "mcpServers" });
    expect((await shape("cursor")).entry).not.toHaveProperty("type");
    expect(await shape("vscode")).toEqual({ key: "servers", entry: { type: "http", url: BASE } });
    expect(await shape("opencode")).toEqual({ key: "mcp", entry: { type: "remote", url: BASE, enabled: true } });
    expect((await shape("jetbrains")).entry.type).toBe("streamable-http");
    expect((await shape("windsurf")).entry).toHaveProperty("serverUrl", BASE);
    expect((await shape("windsurf")).entry).not.toHaveProperty("url");
    expect((await shape("zed")).key).toBe("context_servers");
    expect((await shape("amp")).key).toBe("amp.mcpServers");
  });

  it("the vscode user profile path follows the platform", async () => {
    await run(["mcp", "install", "--client", "vscode", "--global"], { platform: "darwin" });
    expect(existsSync(join(home, "Library", "Application Support", "Code", "User", "mcp.json"))).toBe(true);
    const appData = mkdirp(join(tmp.dir, "roaming"));
    await run(["mcp", "install", "--client", "vscode", "--global"], { platform: "win32", env: { APPDATA: appData } });
    expect(readJson(join(appData, "Code", "User", "mcp.json"))).toEqual({ servers: { whereamimentioned: { type: "http", url: BASE } } });
    await run(["mcp", "install", "--client", "vscode", "--global"], { platform: "win32" });
    expect(existsSync(join(home, "AppData", "Roaming", "Code", "User", "mcp.json"))).toBe(true);
  });

  it("an unknown client and a missing --client are usage errors", async () => {
    const unknown = await run(["mcp", "install", "--client", "emacs"]);
    expect(unknown).toMatchObject({ code: 2, stdout: "" });
    expect(unknown.stderr).toContain("Allowed choices are claude-code, cursor, vscode, windsurf, zed, warp, opencode, amp, jetbrains");
    const missing = await run(["mcp", "install"]);
    expect(missing).toMatchObject({ code: 2, stdout: "" });
    expect(missing.stderr).toContain("required option '--client <client>' not specified");
  });

  it("the URL written honours --scope, --readonly and WAM_MCP_URL", async () => {
    await run(["mcp", "install", "--client", "cursor", "--org", "acme", "--workspace", "acme-eu", "--readonly"]);
    expect(readJson(join(cwd, ".cursor", "mcp.json"))).toEqual({ mcpServers: { whereamimentioned: withHeaders(`${BASE}/acme/acme-eu/readonly`, PLACEHOLDER) } });
    await run(["mcp", "install", "--client", "warp", "--org", "acme", "--workspace", "acme-eu", "--scope", "org"], { env: { WAM_MCP_URL: "https://staging.example.com/api/mcp" } });
    expect(readJson(join(cwd, ".warp", ".mcp.json"))).toEqual({ mcpServers: { whereamimentioned: withHeaders("https://staging.example.com/api/mcp/acme", PLACEHOLDER) } });
  });
});

describe("the shapes agree with the docs page (09 section 11.5)", () => {
  const docsSnippets = join(fileURLToPath(new URL("../../../../", import.meta.url)), "app", "(marketing)", "docs", "mcp", "snippets.ts");

  // The packages mirror carries no app/ directory, so this comparison only runs in the main repo.
  it.skipIf(!existsSync(docsSnippets))("cursor and vscode match the published snippets, key for key", async () => {
    const docs = (await import(/* @vite-ignore */ pathToFileURL(docsSnippets).href)) as Record<string, { code: string }>;
    const stripToken = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/Bearer [^"]+/g, "Bearer X"));
    const cursor = JSON.parse((await run(["mcp", "install", "--client", "cursor", "--print"])).stdout);
    expect(stripToken(cursor)).toEqual(stripToken(JSON.parse(docs.CURSOR_JSON!.code)));
    const vscode = JSON.parse((await run(["mcp", "install", "--client", "vscode", "--print"])).stdout);
    expect(vscode).toEqual(JSON.parse(docs.VSCODE_JSON!.code));
    // Same family as the docs' Cline shape (mcpServers, an explicit type, url, headers), with the
    // hyphenated discriminator JetBrains wants instead of Cline's camel-cased one.
    const cline = JSON.parse(docs.CLINE_JSON!.code) as { mcpServers: { whereamimentioned: Record<string, unknown> } };
    const jetbrains = JSON.parse((await run(["mcp", "install", "--client", "jetbrains", "--print"])).stdout) as typeof cline;
    expect(Object.keys(jetbrains.mcpServers.whereamimentioned)).toEqual(Object.keys(cline.mcpServers.whereamimentioned));
    expect(cline.mcpServers.whereamimentioned.type).toBe("streamableHttp");
    expect(jetbrains.mcpServers.whereamimentioned.type).toBe("streamable-http");
  });
});

describe("the Windsurf probe (section 3.8 rule 5)", () => {
  const documented = () => join(home, ".codeium", "mcp_config.json");
  const scoped = () => join(home, ".codeium", "windsurf", "mcp_config.json");
  const entry = { mcpServers: { whereamimentioned: { serverUrl: BASE, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } } } };

  it("writes to the windsurf-scoped file when only that one exists", async () => {
    seed(scoped(), "{}\n");
    const r = await run(["mcp", "install", "--client", "windsurf", "--yes"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(readJson(scoped())).toEqual(entry);
    expect(existsSync(documented())).toBe(false);
    expect(r.stderr).toContain("Wrote ~/.codeium/windsurf/mcp_config.json\n");
    expect(r.stderr).not.toContain("Both ");
  });

  it("falls back to the documented path when neither exists", async () => {
    const r = await run(["mcp", "install", "--client", "windsurf", "--yes"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(readJson(documented())).toEqual(entry);
    expect(existsSync(scoped())).toBe(false);
    expect(r.stderr).toContain("Wrote ~/.codeium/mcp_config.json\n");
  });

  it("writes the documented one when only it exists", async () => {
    seed(documented(), "{}\n");
    await run(["mcp", "install", "--client", "windsurf", "--yes"], { env: TOKEN_ENV });
    expect(readJson(documented())).toEqual(entry);
    expect(existsSync(scoped())).toBe(false);
  });

  it("writes the documented one when both exist, and warns on stderr naming the other", async () => {
    seed(documented(), "{}\n");
    seed(scoped(), '{"mcpServers":{}}\n');
    const r = await run(["mcp", "install", "--client", "windsurf", "--yes", "--quiet"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(readJson(documented())).toEqual(entry);
    expect(readFileSync(scoped(), "utf8")).toBe('{"mcpServers":{}}\n');
    // A warning, so it survives --quiet.
    expect(r.stderr).toContain("Both ~/.codeium/mcp_config.json and ~/.codeium/windsurf/mcp_config.json exist.");
    expect(r.stderr).toContain("add the same entry to ~/.codeium/windsurf/mcp_config.json");
    expect(r.stdout).toBe("");
  });

  it("probeWindsurfPath reports the order directly", () => {
    expect(probeWindsurfPath(home)).toEqual({ path: documented(), alsoExists: null });
    seed(scoped(), "{}");
    expect(probeWindsurfPath(home)).toEqual({ path: scoped(), alsoExists: null });
    seed(documented(), "{}");
    expect(probeWindsurfPath(home)).toEqual({ path: documented(), alsoExists: scoped() });
  });
});

describe("merge, never overwrite (section 3.8 rules 2 and 4)", () => {
  const original = `{
\t"$schema": "https://example.com/schema.json",
\t"mcpServers": {
\t\t"linear": { "url": "https://mcp.linear.app/mcp" },
\t\t"local-db": { "command": "npx", "args": ["-y", "some-db-server"], "env": { "DSN": "postgres://localhost/app" } }
\t},
\t"editor": { "fontSize": 13, "rulers": [80, 100] },
\t"telemetry": false
}\r\n`;

  it("keeps two other servers and every unrelated top-level key, in order", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, original);
    const r = await run(["mcp", "install", "--client", "cursor", "--org", "acme"]);
    expect(r.code).toBe(0);
    const written = readJson(path);
    expect(written).toEqual({
      $schema: "https://example.com/schema.json",
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        "local-db": { command: "npx", args: ["-y", "some-db-server"], env: { DSN: "postgres://localhost/app" } },
        whereamimentioned: withHeaders(`${BASE}/acme`, PLACEHOLDER),
      },
      editor: { fontSize: 13, rulers: [80, 100] },
      telemetry: false,
    });
    expect(Object.keys(written)).toEqual(["$schema", "mcpServers", "editor", "telemetry"]);
    expect(Object.keys(written.mcpServers as object)).toEqual(["linear", "local-db", "whereamimentioned"]);
  });

  it("replaces an existing whereamimentioned entry in place and leaves its neighbours alone", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, JSON.stringify({ mcpServers: { whereamimentioned: { url: "https://old.example.com", stale: true }, linear: { url: "https://mcp.linear.app/mcp" } } }));
    await run(["mcp", "install", "--client", "cursor"]);
    const servers = readJson(path).mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["whereamimentioned", "linear"]);
    expect(servers.whereamimentioned).toEqual(withHeaders(BASE, PLACEHOLDER));
    expect(servers.linear).toEqual({ url: "https://mcp.linear.app/mcp" });
  });

  it("adds the top-level key to a file that has other settings but no servers yet", async () => {
    const path = join(home, ".config", "amp", "settings.json");
    seed(path, JSON.stringify({ "amp.notifications.enabled": true }));
    await run(["mcp", "install", "--client", "amp", "--global", "--yes"], { env: TOKEN_ENV });
    expect(readJson(path)).toEqual({
      "amp.notifications.enabled": true,
      "amp.mcpServers": { whereamimentioned: withHeaders(BASE, `Bearer ${FAKE_TOKEN}`) },
    });
  });

  it("writes a backup with the original bytes before the edit, and says where", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, original);
    const r = await run(["mcp", "install", "--client", "cursor"]);
    const backup = `${path}.wam-backup-${STAMP}`;
    expect(readFileSync(backup).equals(Buffer.from(original, "utf8"))).toBe(true);
    expect(r.stderr).toContain(`Backup written to .cursor/mcp.json.wam-backup-${STAMP}\n`);
    expect(compactTimestamp(new Date("2026-08-28T09:18:02.417Z"))).toBe("20260828T091802Z");
  });

  it("never overwrites an earlier backup taken in the same second", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, original);
    await run(["mcp", "install", "--client", "cursor"]);
    const afterFirst = readFileSync(path, "utf8");
    await run(["mcp", "install", "--client", "cursor", "--readonly"]);
    expect(readFileSync(`${path}.wam-backup-${STAMP}`, "utf8")).toBe(original);
    expect(readFileSync(`${path}.wam-backup-${STAMP}-1`, "utf8")).toBe(afterFirst);
  });

  it("a byte order mark at the start of the file is tolerated, not mistaken for broken JSON", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, `${String.fromCharCode(0xfeff)}{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}`);
    const r = await run(["mcp", "install", "--client", "cursor"]);
    expect(r.code).toBe(0);
    expect(Object.keys(readJson(path).mcpServers as object)).toEqual(["linear", "whereamimentioned"]);
  });

  it("an empty existing file is treated as an empty object, and still backed up", async () => {
    const path = join(cwd, "opencode.json");
    seed(path, "");
    const r = await run(["mcp", "install", "--client", "opencode"]);
    expect(r.code).toBe(0);
    expect(readJson(path)).toEqual({ mcp: { whereamimentioned: { type: "remote", url: BASE, enabled: true } } });
    expect(existsSync(`${path}.wam-backup-${STAMP}`)).toBe(true);
  });

  it("prints the exact success output of section 3.8, all of it on stderr", async () => {
    seed(join(cwd, ".cursor", "mcp.json"), "{}\n");
    const r = await run(["mcp", "install", "--client", "cursor", "--org", "acme", "--workspace", "acme-eu"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "Wrote .cursor/mcp.json",
        "",
        "  {",
        '    "mcpServers": {',
        '      "whereamimentioned": {',
        '        "url": "https://whereamimentioned.com/api/mcp/acme/acme-eu",',
        '        "headers": { "Authorization": "Bearer ${WAM_TOKEN}" }',
        "      }",
        "    }",
        "  }",
        "",
        "This file is project scoped, so the token is not written into it.",
        "Export it in your shell:  export WAM_TOKEN=wam_live_...",
        `Backup written to .cursor/mcp.json.wam-backup-${STAMP}`,
        "Restart Cursor to pick it up.",
        "",
      ].join("\n"),
    );
  });
});

describe("the token (section 3.8 rule 1)", () => {
  it("project scope never writes a literal token, whatever the credential source", async () => {
    for (const row of TABLE.filter((r) => r.project !== null)) {
      const r = await run(["mcp", "install", "--client", row.client, "--token", FAKE_TOKEN], { env: { WAM_TOKEN: `wam_test_${"Q".repeat(43)}` } });
      expect(r.code).toBe(0);
      const text = readFileSync(join(cwd, row.project!), "utf8");
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain("Q".repeat(20));
      expect(text).not.toContain("wam_test_");
      if (row.carriesToken) expect(text).toContain("Bearer ${WAM_TOKEN}");
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    }
  });

  it("project scope needs no credential at all and prints the export reminder", async () => {
    const r = await run(["mcp", "install", "--client", "warp"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("This file is project scoped, so the token is not written into it.\n");
    expect(r.stderr).toContain("Export it in your shell:  export WAM_TOKEN=wam_live_...\n");
    expect(r.stderr).toContain("Restart Warp to pick it up.\n");
  });

  it("--global without --yes where it cannot prompt is exit 2 and writes nothing", async () => {
    const before = tree();
    const r = await run(["mcp", "install", "--client", "cursor", "--global"], { env: TOKEN_ENV });
    expect(r).toMatchObject({ code: 2, stdout: "" });
    expect(r.stderr).toBe(
      "This command writes your API key into ~/.cursor/mcp.json and cannot prompt for confirmation here.\n" +
        "Pass --yes to confirm, or --print to see the snippet and write nothing.\n",
    );
    expect(tree()).toEqual(before);
  });

  it("--global asks first: No, an empty line and EOF all cancel with exit 0 and write nothing", async () => {
    for (const answer of ["n\n", "\n", "nope\n", null]) {
      const before = tree();
      const r = await run(["mcp", "install", "--client", "cursor", "--global"], { env: TOKEN_ENV, answer });
      expect(r).toMatchObject({ code: 0, stdout: "" });
      expect(r.stderr).toContain(`This writes your API key (${SHOWN}) into ~/.cursor/mcp.json in plain text.\n`);
      expect(r.stderr).toContain("Write it? (y/N)");
      expect(r.stderr).toContain("Cancelled. Nothing was written.\n");
      expect(r.stderr).not.toContain("Wrote ");
      expect(tree()).toEqual(before);
    }
  });

  it("--global writes the literal token after a yes, and shows only prefix...last4", async () => {
    const r = await run(["mcp", "install", "--client", "cursor", "--global"], { env: TOKEN_ENV, answer: "y\n" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(readJson(join(home, ".cursor", "mcp.json"))).toEqual({ mcpServers: { whereamimentioned: withHeaders(BASE, `Bearer ${FAKE_TOKEN}`) } });
    expect(r.stderr).toContain("Wrote ~/.cursor/mcp.json\n");
    expect(r.stderr).toContain(`"headers": { "Authorization": "Bearer ${SHOWN}" }`);
    expect(r.stderr).toContain("The token was written into this file in plain text.");
    expect(r.stderr).not.toContain("project scoped");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
  });

  it("--global with no credential is exit 3 and writes nothing", async () => {
    const before = tree();
    const r = await run(["mcp", "install", "--client", "cursor", "--global", "--yes"]);
    expect(r).toMatchObject({ code: 3, stdout: "" });
    expect(r.stderr).toContain("Not signed in.");
    expect(tree()).toEqual(before);
  });

  it("windsurf and zed have no project file, so they confirm like --global does", async () => {
    const before = tree();
    const blocked = await run(["mcp", "install", "--client", "zed"], { env: TOKEN_ENV });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("Zed has no project-scoped config file, so this uses the user-level one.\n");
    expect(blocked.stderr).toContain("writes your API key into ~/.config/zed/settings.json");
    expect(tree()).toEqual(before);
  });

  it("a shape with no Authorization header needs no credential and no confirmation, even with --global", async () => {
    const r = await run(["mcp", "install", "--client", "vscode", "--global"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No Authorization header is written for VS Code");
    expect(r.stderr).not.toContain("WAM_TOKEN");
  });

  it("--json on a global write reports the path and never the token", async () => {
    const r = await run(["mcp", "install", "--client", "cursor", "--global", "--yes", "--json"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      client: "cursor",
      target: "global",
      path: join(home, ".cursor", "mcp.json"),
      written: true,
      backup: null,
      url: BASE,
      topLevelKey: "mcpServers",
      snippet: { mcpServers: { whereamimentioned: withHeaders(BASE, `Bearer ${SHOWN}`) } },
    });
  });
});

describe("the mode of a user-level file that carries the token", () => {
  const chmod = () => vi.mocked(chmodSync);
  const callsOn = (path: string) => chmod().mock.calls.filter(([p]) => p === path);

  beforeEach(() => {
    chmod().mockClear();
  });

  it("tightens an EXISTING file to 0600 after the write on posix, where writeFileSync's mode does not apply", async () => {
    const path = join(home, ".cursor", "mcp.json");
    seed(path, '{"mcpServers":{}}\n');
    const r = await run(["mcp", "install", "--client", "cursor", "--global", "--yes"], { env: TOKEN_ENV, platform: "linux" });
    expect(r.code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(FAKE_TOKEN);
    expect(callsOn(path)).toEqual([[path, 0o600]]);
    // The runner's own bits, where it has them: a seeded file starts at the umask default, not 0600.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("is skipped on win32, where chmod has no bits to set", async () => {
    const path = join(home, ".cursor", "mcp.json");
    seed(path, '{"mcpServers":{}}\n');
    const r = await run(["mcp", "install", "--client", "cursor", "--global", "--yes"], { env: TOKEN_ENV, platform: "win32" });
    expect(r.code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(FAKE_TOKEN);
    expect(callsOn(path)).toEqual([]);
  });

  it("leaves a project file, and a user-level file with no Authorization header, at their own mode", async () => {
    seed(join(cwd, ".cursor", "mcp.json"), "{}\n");
    expect((await run(["mcp", "install", "--client", "cursor"])).code).toBe(0);
    expect((await run(["mcp", "install", "--client", "vscode", "--global"])).code).toBe(0);
    expect(chmod()).not.toHaveBeenCalled();
  });
});

describe("JSONC is refused, never rewritten (section 3.8 rule 2)", () => {
  const commented = `{
  // my servers
  "context_servers": {
    "other": { "url": "https://other.example.com/mcp" }
  }
}
`;
  const trailing = `{
  "context_servers": {
    "other": { "url": "https://other.example.com/mcp" },
  }
}
`;

  for (const [name, content] of [["a comment line", commented], ["a trailing comma", trailing], ["a block comment", '/* zed */ {"theme":"One Dark"}']] as const) {
    it(`${name}: falls back to the snippet on stdout and leaves the file untouched`, async () => {
      const path = join(home, ".config", "zed", "settings.json");
      seed(path, content);
      const before = tree();
      const r = await run(["mcp", "install", "--client", "zed", "--yes"], { env: TOKEN_ENV });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ context_servers: { whereamimentioned: withHeaders(BASE, PLACEHOLDER) } });
      expect(r.stderr).toContain("~/.config/zed/settings.json contains comments or trailing commas (JSONC), and rewriting it would destroy them.\n");
      expect(r.stderr).toContain('Nothing was written. Add the entry below yourself, under "context_servers":\n');
      expect(r.stderr).not.toContain("Wrote ");
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(tree()).toEqual(before);
    });
  }

  it("a file that does not parse, or is not an object, is refused the same way", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    for (const content of ['{"mcpServers": ', "[]", '{"mcpServers": []}']) {
      seed(path, content);
      const before = tree();
      const r = await run(["mcp", "install", "--client", "cursor"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ mcpServers: { whereamimentioned: withHeaders(BASE, PLACEHOLDER) } });
      expect(r.stderr).toContain("Nothing was written.");
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(tree()).toEqual(before);
    }
  });

  it("slashes and commas inside strings are not mistaken for JSONC", async () => {
    expect(looksLikeJsonc('{"url": "https://example.com/a//b", "note": "x, }", "glob": "/* not a comment */"}')).toBe(false);
    expect(looksLikeJsonc('{"a": "quote \\" // still a string"}')).toBe(false);
    expect(looksLikeJsonc('{"a": 1 // why\n}')).toBe(true);
    expect(looksLikeJsonc('{"a": [1, 2, ]}')).toBe(true);
    const path = join(cwd, ".cursor", "mcp.json");
    seed(path, '{"mcpServers": {"linear": {"url": "https://mcp.linear.app/mcp"}}}');
    expect((await run(["mcp", "install", "--client", "cursor"])).code).toBe(0);
    expect(Object.keys(readJson(path).mcpServers as object)).toEqual(["linear", "whereamimentioned"]);
  });

  it("under --json the refusal is the error object, with the snippet in its details", async () => {
    const path = join(cwd, ".vscode", "mcp.json");
    seed(path, '{\n  // servers\n  "servers": {}\n}\n');
    const r = await run(["mcp", "install", "--client", "vscode", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, exitCode: 1, error: { details: { path, topLevelKey: "servers", snippet: { servers: { whereamimentioned: { type: "http", url: BASE } } } } } });
    expect(doc.error.message).toContain("contains comments or trailing commas");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("claude-code shells out and never writes a file (section 3.8 table)", () => {
  it("calls claude mcp add with the exact argv after confirmation", async () => {
    const before = tree();
    const r = await run(["mcp", "install", "--client", "claude-code", "--org", "acme", "--yes"], { env: TOKEN_ENV });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.execCalls).toEqual([
      {
        command: "claude",
        args: ["mcp", "add", "--transport", "http", "whereamimentioned", `${BASE}/acme`, "--header", `Authorization: Bearer ${FAKE_TOKEN}`],
      },
    ]);
    expect(r.stderr).toContain(`Ran claude mcp add --transport http whereamimentioned ${BASE}/acme --header "Authorization: Bearer ${SHOWN}"\n`);
    expect(r.stderr).toContain("Restart Claude Code to pick it up.\n");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
    expect(tree()).toEqual(before);
  });

  it("never runs without the confirmation: exit 2 when it cannot prompt, exit 0 on a No", async () => {
    const blocked = await run(["mcp", "install", "--client", "claude-code"], { env: TOKEN_ENV });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("This command passes your API key to claude mcp add and cannot prompt for confirmation here.");
    expect(blocked.execCalls).toEqual([]);
    const declined = await run(["mcp", "install", "--client", "claude-code"], { env: TOKEN_ENV, answer: "n\n" });
    expect(declined.code).toBe(0);
    expect(declined.stderr).toContain(`This passes your API key (${SHOWN}) to claude mcp add`);
    expect(declined.stderr).toContain("Cancelled. Nothing was changed.\n");
    expect(declined.execCalls).toEqual([]);
    const accepted = await run(["mcp", "install", "--client", "claude-code"], { env: TOKEN_ENV, answer: "yes\n" });
    expect(accepted.code).toBe(0);
    expect(accepted.execCalls).toHaveLength(1);
  });

  it("needs a credential, and --global changes nothing", async () => {
    const none = await run(["mcp", "install", "--client", "claude-code", "--yes"]);
    expect(none.code).toBe(3);
    expect(none.execCalls).toEqual([]);
    const before = tree();
    const global = await run(["mcp", "install", "--client", "claude-code", "--global", "--yes"], { env: TOKEN_ENV });
    expect(global.code).toBe(0);
    expect(global.execCalls).toHaveLength(1);
    expect(tree()).toEqual(before);
  });

  it("--print shows the command with the placeholder and runs nothing", async () => {
    const before = tree();
    const r = await run(["mcp", "install", "--client", "claude-code", "--print", "--readonly"], { env: TOKEN_ENV });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`claude mcp add --transport http whereamimentioned ${BASE}/readonly --header "Authorization: Bearer \${WAM_TOKEN}"\n`);
    expect(r.execCalls).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    expect(tree()).toEqual(before);
  });

  it("a failing claude is exit 1, and its output is shown with the token redacted", async () => {
    const r = await run(["mcp", "install", "--client", "claude-code", "--yes"], {
      env: TOKEN_ENV,
      exec: async (_command, args) => ({ stdout: "", stderr: `bad header ${args[args.length - 1]}\nmore`, code: 3 }),
    });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toContain("claude mcp add failed with exit code 3.\n");
    expect(r.stderr).toContain(`bad header Authorization: Bearer ${SHOWN}\n`);
    expect(r.stderr).toContain("run again with --print to see the command");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
  });

  it("a claude that could not be started for another reason names the errno, not a made-up exit code", async () => {
    const r = await run(["mcp", "install", "--client", "claude-code", "--yes"], {
      env: TOKEN_ENV,
      exec: async () => ({ stdout: "", stderr: "", code: 1, spawnError: "EACCES" }),
    });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toContain("claude could not be started (EACCES).\n");
    expect(r.stderr).not.toContain("exit code 1");
  });

  it("on posix, ENOENT is reported as claude missing from the PATH, with the --print way out", async () => {
    const r = await run(["mcp", "install", "--client", "claude-code", "--yes"], {
      env: TOKEN_ENV,
      exec: async () => ({ stdout: "", stderr: "", code: 1, spawnError: "ENOENT" }),
    });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.execCalls).toEqual([expect.objectContaining({ command: "claude" })]);
    expect(r.stderr).toContain("claude was not found on your PATH.\n");
    expect(r.stderr).toContain("wam mcp install --client claude-code --print prints the exact command to paste into your shell.");
    expect(r.stderr).not.toContain("exit code");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
  });
});

describe("claude-code on Windows: the native claude.exe, never the npm shim", () => {
  let bin: string;
  const ARGS = ["mcp", "add", "--transport", "http", "whereamimentioned", BASE, "--header", `Authorization: Bearer ${FAKE_TOKEN}`];
  const enoent = async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 1, spawnError: "ENOENT" });
  const einval = async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 1, spawnError: "EINVAL" });
  const SHIM_LINES = [
    "A shim needs a shell, and the API key is in the arguments. Install Claude Code's native build, which puts a claude.exe on your PATH, or paste the command yourself.",
    "wam mcp install --client claude-code --print prints the exact command to paste into your shell.",
  ];

  beforeEach(() => {
    bin = mkdirp(join(tmp.dir, "bin"));
  });

  const onWindows = (extra: Partial<RunOptions> = {}, argv: string[] = []) =>
    run(["mcp", "install", "--client", "claude-code", "--yes", ...argv], { env: { ...TOKEN_ENV, Path: bin }, platform: "win32", ...extra });

  it("happy path: runs a claude.exe found on the PATH by its full path, and prefers it to a shim beside it", async () => {
    writeFileSync(join(bin, "claude.exe"), "");
    writeFileSync(join(bin, "claude.cmd"), "@echo off\r\n");
    const before = tree();
    const r = await onWindows();
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.execCalls).toEqual([{ command: join(bin, "claude.exe"), args: ARGS }]);
    expect(r.stderr).toContain(`Ran claude mcp add --transport http whereamimentioned ${BASE} --header "Authorization: Bearer ${SHOWN}"\n`);
    expect(r.stderr).toContain("Restart Claude Code to pick it up.\n");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
    expect(tree()).toEqual(before);
  });

  it("the .cmd case: only an npm claude.cmd (or .bat) on the PATH is named and refused, and nothing is spawned", async () => {
    for (const shim of ["claude.cmd", "claude.bat"]) {
      const shimPath = join(bin, shim);
      writeFileSync(shimPath, "@echo off\r\n");
      const r = await onWindows();
      expect(r).toMatchObject({ code: 1, stdout: "" });
      expect(r.execCalls).toEqual([]);
      expect(r.stderr).toContain(`claude was found only as an npm shim (${shimPath}), which this CLI does not launch.\n`);
      for (const line of SHIM_LINES) expect(r.stderr).toContain(`${line}\n`);
      expect(r.stderr).not.toContain(FAKE_TOKEN);
      expect(r.stderr).not.toContain(EM_DASH);
      rmSync(shimPath);
    }
  });

  it("ENOENT: nothing on the PATH and the spawn of claude.exe fails, so claude was not found at all", async () => {
    const r = await onWindows({ exec: enoent });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.execCalls).toEqual([{ command: "claude.exe", args: ARGS }]);
    expect(r.stderr).toContain("claude was not found: neither a claude.exe nor an npm claude.cmd shim is on your PATH.\n");
    expect(r.stderr).toContain("Install Claude Code, or paste the command yourself. wam mcp install --client claude-code --print prints the exact command to paste into your shell.\n");
    expect(r.stderr).not.toContain("exit code");
    expect(r.stderr).not.toContain(FAKE_TOKEN);
  });

  it("EINVAL: Node refusing a .cmd or .bat without a shell is reported as the shim it is", async () => {
    const r = await onWindows({ exec: einval });
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.execCalls).toHaveLength(1);
    expect(r.stderr).toContain("claude resolved to a .cmd or .bat shim, which this CLI does not launch.\n");
    for (const line of SHIM_LINES) expect(r.stderr).toContain(`${line}\n`);
    expect(r.stderr).not.toContain("exit code");
  });

  it("--json carries the refusal as the error object, naming the shim in its details", async () => {
    const shimPath = join(bin, "claude.cmd");
    writeFileSync(shimPath, "");
    const r = await onWindows({}, ["--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      exitCode: 1,
      error: { code: "unknown", details: { client: "claude-code", reason: "shim", path: shimPath } },
    });
    expect(r.stdout).not.toContain(FAKE_TOKEN);
  });

  it("findClaudeOnWindows reads PATH whatever its case, strips quotes around an entry, and skips empty ones", () => {
    expect(findClaudeOnWindows({})).toEqual({ kind: "none" });
    expect(findClaudeOnWindows({ PATH: bin })).toEqual({ kind: "none" });
    writeFileSync(join(bin, "claude.cmd"), "");
    expect(findClaudeOnWindows({ PATH: bin })).toEqual({ kind: "shim", path: join(bin, "claude.cmd") });
    writeFileSync(join(bin, "claude.exe"), "");
    expect(findClaudeOnWindows({ PATH: bin })).toEqual({ kind: "exe", path: join(bin, "claude.exe") });
    expect(findClaudeOnWindows({ Path: `;"${join(tmp.dir, "nowhere")}";"${bin}";` })).toEqual({ kind: "exe", path: join(bin, "claude.exe") });
    expect(findClaudeOnWindows({ path: bin })).toEqual({ kind: "exe", path: join(bin, "claude.exe") });
  });
});

describe("--print touches nothing (section 3.8 rule 3)", () => {
  it("leaves an existing config, and the directory tree, exactly as they were", async () => {
    const path = join(cwd, ".cursor", "mcp.json");
    const content = '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}';
    seed(path, content);
    const before = tree();
    for (const extra of [[], ["--global"], ["--global", "--yes"]]) {
      const r = await run(["mcp", "install", "--client", "cursor", "--print", ...extra], { env: TOKEN_ENV });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ mcpServers: { whereamimentioned: withHeaders(BASE, PLACEHOLDER) } });
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    }
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(tree()).toEqual(before);
  });

  it("prints even when the existing file is JSONC, and needs no credential for a global snippet", async () => {
    seed(join(home, ".config", "zed", "settings.json"), "// zed\n{}\n");
    const r = await run(["mcp", "install", "--client", "zed", "--print"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ context_servers: { whereamimentioned: withHeaders(BASE, PLACEHOLDER) } });
  });

  it("--print --json is one document carrying the snippet", async () => {
    const r = await run(["mcp", "install", "--client", "opencode", "--print", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, client: "opencode", target: "project", written: false, topLevelKey: "mcp", snippet: { mcp: { whereamimentioned: { type: "remote", url: BASE, enabled: true } } } });
  });
});

describe("help (section 11.1)", () => {
  it("wam mcp --help lists the subcommands, and every help ends with a copy-pasteable example", async () => {
    const group = await run(["mcp", "--help"]);
    expect(group.code).toBe(0);
    expect(group.stdout).toMatch(/^ {2}url \[options\]/m);
    expect(group.stdout).toMatch(/^ {2}install \[options\]/m);
    for (const argv of [["mcp", "--help"], ["mcp", "url", "--help"], ["mcp", "install", "--help"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout.trimEnd().split("\n").pop()).toMatch(/^ {2}\$ wam mcp /);
      expect(r.stdout).not.toContain(EM_DASH);
      expect(r.stdout).not.toMatch(/npx wam\b/);
    }
    const install = (await run(["mcp", "install", "--help"])).stdout;
    for (const flag of ["--client <client>", "--readonly", "--scope <scope>", "--global", "--print"]) expect(install).toContain(flag);
    expect(install).toContain("-y, --yes");
    expect(install).toContain('"Bearer ${WAM_TOKEN}"');
  });

  it("no user-visible string of a run contains an em dash", async () => {
    seed(join(cwd, ".cursor", "mcp.json"), "{}");
    const runs = [
      await run(["mcp", "install", "--client", "cursor"]),
      await run(["mcp", "install", "--client", "cursor", "--global"], { env: TOKEN_ENV, answer: "n\n" }),
      await run(["mcp", "install", "--client", "opencode", "--global"]),
      await run(["mcp", "install", "--client", "claude-code", "--print"]),
    ];
    for (const r of runs) expect(r.stdout + r.stderr).not.toContain(EM_DASH);
  });
});
