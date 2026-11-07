import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  DEFAULT_API_URL,
  findProjectConfig,
  parseConfigValue,
  readProjectConfig,
  readUserConfig,
  resolveConfig,
  setUserConfigValue,
  unsetUserConfigValue,
  userConfigDir,
  userConfigPath,
  type ConfigEnvironment,
} from "./config";
import { CliError } from "./errors";
import { mkdirp, tempDir, type TempDir } from "./test-support";

let tmp: TempDir;
let root: string;
let home: string;
let env: ConfigEnvironment;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function userPath(): string {
  return join(home, ".config", "whereamimentioned", "config.json");
}

function expectCliError(fn: () => unknown, exitCode: number): CliError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(exitCode);
    return err as CliError;
  }
  throw new Error("expected a CliError");
}

beforeEach(() => {
  tmp = tempDir("wam-config-");
  root = mkdirp(join(tmp.dir, "repo"));
  mkdirp(join(root, ".git"));
  home = mkdirp(join(tmp.dir, "home"));
  env = { env: {}, cwd: root, homedir: home, platform: "linux" };
});

afterEach(() => {
  tmp.cleanup();
});

describe("paths", () => {
  it("uses XDG_CONFIG_HOME, then ~/.config, on POSIX", () => {
    expect(userConfigDir(env)).toBe(join(home, ".config", "whereamimentioned"));
    expect(userConfigDir({ ...env, env: { XDG_CONFIG_HOME: join(tmp.dir, "xdg") } })).toBe(
      join(tmp.dir, "xdg", "whereamimentioned"),
    );
  });

  it("uses %APPDATA% on Windows", () => {
    const win = { ...env, platform: "win32", env: { APPDATA: join(tmp.dir, "AppData", "Roaming") } };
    expect(userConfigPath(win)).toBe(join(tmp.dir, "AppData", "Roaming", "whereamimentioned", "config.json"));
  });

  it("WAM_CONFIG_DIR overrides both", () => {
    const dir = join(tmp.dir, "custom");
    expect(userConfigDir({ ...env, env: { WAM_CONFIG_DIR: dir } })).toBe(dir);
    expect(userConfigDir({ ...env, platform: "win32", env: { WAM_CONFIG_DIR: dir, APPDATA: "C:/x" } })).toBe(dir);
  });
});

describe("project config discovery", () => {
  it("walks up from cwd to the nearest wam.json", () => {
    writeJson(join(root, "wam.json"), { org: "acme" });
    const deep = mkdirp(join(root, "a", "b", "c"));
    expect(findProjectConfig(deep)).toBe(join(root, "wam.json"));
  });

  it("stops at a directory containing .git", () => {
    // A wam.json above the repo root must not be found from inside the repo.
    writeJson(join(tmp.dir, "wam.json"), { org: "outside" });
    const deep = mkdirp(join(root, "src"));
    expect(findProjectConfig(deep)).toBeNull();
  });

  it("finds a wam.json in the .git directory itself before stopping", () => {
    writeJson(join(root, "wam.json"), { org: "acme" });
    expect(findProjectConfig(root)).toBe(join(root, "wam.json"));
  });
});

describe("project config parsing", () => {
  it("rejects an unknown key with exit 2 and the section 9 copy naming the file", () => {
    writeJson(join(root, "wam.json"), { workSpace: "x" });
    const err = expectCliError(() => readProjectConfig(join(root, "wam.json"), env), 2);
    expect(err.code).toBe("usage_error");
    expect(err.lines).toEqual([
      'Unknown option "workSpace" in ./wam.json.',
      "Valid options are: org, workspace, failUnder.",
    ]);
  });

  it("refuses apiUrl in wam.json with exit 2: a cloned project must not choose where the key is sent", () => {
    writeJson(join(root, "wam.json"), { org: "acme", apiUrl: "https://attacker.example" });
    const err = expectCliError(() => readProjectConfig(join(root, "wam.json"), env), 2);
    expect(err.code).toBe("usage_error");
    expect(err.lines[0]).toBe("./wam.json must not set apiUrl: a committed project file cannot choose where your API key is sent.");
    expect(err.lines[1]).toContain("WAM_API_URL");
    expect(err.lines[1]).toContain("wam config set apiUrl");
    // Resolution refuses too: the value never reaches a client, whatever else the file says.
    const resolved = expectCliError(() => resolveConfig({}, env), 2);
    expect(resolved.lines[0]).toContain("must not set apiUrl");
    expect(JSON.stringify(resolved.lines)).not.toContain("attacker.example");
  });

  it("treats a token field as a parse error with an explicit message", () => {
    writeJson(join(root, "wam.json"), { org: "acme", token: "wam_live_xxx" });
    const err = expectCliError(() => readProjectConfig(join(root, "wam.json"), env), 2);
    expect(err.lines[0]).toBe("./wam.json must not contain a token.");
    expect(err.lines[1]).toContain("WAM_TOKEN");
    expect(err.message).not.toContain("wam_live_xxx");
  });

  it("rejects an out-of-range failUnder", () => {
    writeJson(join(root, "wam.json"), { failUnder: 250 });
    const err = expectCliError(() => readProjectConfig(join(root, "wam.json"), env), 2);
    expect(err.lines[0]).toContain('"failUnder"');
    expect(err.lines[0]).toContain("./wam.json");
  });

  it("rejects malformed JSON with exit 2", () => {
    writeFileSync(join(root, "wam.json"), "{ not json", "utf8");
    const err = expectCliError(() => readProjectConfig(join(root, "wam.json"), env), 2);
    expect(err.lines[0]).toMatch(/^Could not parse \.\/wam\.json/);
  });

  it("accepts $schema and strips a BOM", () => {
    writeFileSync(
      join(root, "wam.json"),
      `${String.fromCharCode(0xfeff)}${JSON.stringify({ $schema: "https://whereamimentioned.com/schema/wam.config.json", org: "acme" })}`,
      "utf8",
    );
    expect(readProjectConfig(join(root, "wam.json"), env).org).toBe("acme");
  });
});

describe("user config parsing", () => {
  it("rejects an unknown profile key naming the user file", () => {
    writeJson(userPath(), { version: 1, profiles: { default: { orgg: "acme" } } });
    const err = expectCliError(() => readUserConfig(userPath(), env), 2);
    expect(err.lines).toEqual([
      'Unknown option "orgg" in ~/.config/whereamimentioned/config.json.',
      "Valid options are: org, workspace, apiUrl, failUnder.",
    ]);
  });

  it("rejects an unknown top-level key with the top-level options", () => {
    writeJson(userPath(), { version: 1, activeProfil: "x", profiles: {} });
    const err = expectCliError(() => readUserConfig(userPath(), env), 2);
    expect(err.lines[1]).toBe("Valid options are: version, activeProfile, profiles.");
  });

  it("returns null when the file does not exist", () => {
    expect(readUserConfig(userPath(), env)).toBeNull();
  });
});

describe("precedence", () => {
  beforeEach(() => {
    writeJson(join(root, "wam.json"), { org: "project-org", workspace: "project-ws", failUnder: 55 });
    writeJson(userPath(), {
      version: 1,
      profiles: { default: { org: "user-org", workspace: "user-ws", apiUrl: "https://user.example/" } },
    });
  });

  it("flag beats env beats project file beats user file beats default", () => {
    const withAll = resolveConfig({ org: "flag-org" }, { ...env, env: { WAM_ORG: "env-org" } });
    expect(withAll.org).toEqual({ value: "flag-org", source: "--org" });

    const withEnv = resolveConfig({}, { ...env, env: { WAM_ORG: "env-org" } });
    expect(withEnv.org).toEqual({ value: "env-org", source: "WAM_ORG" });

    const withProject = resolveConfig({}, env);
    expect(withProject.org).toEqual({ value: "project-org", source: "./wam.json" });
    expect(withProject.workspace).toEqual({ value: "project-ws", source: "./wam.json" });
    expect(withProject.failUnder).toEqual({ value: 55, source: "./wam.json" });
    // apiUrl can never come from the project file, so the user file wins for it, trailing slash removed.
    expect(withProject.apiUrl).toEqual({ value: "https://user.example", source: "~/.config/whereamimentioned/config.json" });

    writeFileSync(join(root, "wam.json"), "{}", "utf8");
    const withUser = resolveConfig({}, env);
    expect(withUser.org).toEqual({ value: "user-org", source: "~/.config/whereamimentioned/config.json" });

    writeJson(userPath(), { version: 1, profiles: {} });
    const defaults = resolveConfig({}, env);
    expect(defaults.org).toEqual({ value: null, source: "(default)" });
    expect(defaults.apiUrl).toEqual({ value: DEFAULT_API_URL, source: "(default)" });
    expect(defaults.failUnder).toEqual({ value: null, source: "(default)" });
  });

  it("an empty environment variable counts as unset", () => {
    const resolved = resolveConfig({}, { ...env, env: { WAM_ORG: "" } });
    expect(resolved.org.source).toBe("./wam.json");
  });

  it("reports a project file found above cwd with a relative display", () => {
    const deep = mkdirp(join(root, "packages", "x"));
    const resolved = resolveConfig({}, { ...env, cwd: deep });
    expect(resolved.org.source).toBe("../../wam.json");
  });

  it("profile: --profile beats WAM_PROFILE beats activeProfile beats default", () => {
    writeJson(userPath(), {
      version: 1,
      activeProfile: "client-b",
      profiles: { default: { org: "user-org" }, "client-b": { org: "northwind" }, flagged: { org: "flagged-org" } },
    });
    writeFileSync(join(root, "wam.json"), "{}", "utf8");
    expect(resolveConfig({ profile: "flagged" }, { ...env, env: { WAM_PROFILE: "default" } }).org.value).toBe("flagged-org");
    expect(resolveConfig({}, { ...env, env: { WAM_PROFILE: "default" } }).org.value).toBe("user-org");
    const active = resolveConfig({}, env);
    expect(active.profile).toEqual({ value: "client-b", source: "~/.config/whereamimentioned/config.json" });
    expect(active.org.value).toBe("northwind");
    writeJson(userPath(), { version: 1, profiles: {} });
    expect(resolveConfig({}, env).profile).toEqual({ value: "default", source: "(default)" });
  });

  it("lists every consulted source in precedence order, including the missing ones", () => {
    writeFileSync(join(root, "wam.json"), "{}", "utf8");
    const resolved = resolveConfig({}, env);
    expect(resolved.consulted.map((s) => [s.kind, s.exists])).toEqual([
      ["project", true],
      ["user", true],
    ]);
    const bare = mkdirp(join(tmp.dir, "bare"));
    const none = resolveConfig({}, { ...env, cwd: bare, homedir: mkdirp(join(tmp.dir, "home2")) });
    expect(none.consulted.map((s) => [s.kind, s.exists])).toEqual([
      ["project", false],
      ["user", false],
    ]);
  });

  it("rejects a malformed --api-url and WAM_API_URL with exit 2", () => {
    expectCliError(() => resolveConfig({ apiUrl: "not a url" }, env), 2);
    const err = expectCliError(() => resolveConfig({}, { ...env, env: { WAM_API_URL: "ftp://x" } }), 2);
    expect(err.lines[0]).toContain("WAM_API_URL");
  });

  it("a config error surfaces as exit 2 from resolveConfig", () => {
    writeJson(join(root, "wam.json"), { workSpace: "x" });
    const err = expectCliError(() => resolveConfig({}, env), 2);
    expect(err.lines[0]).toBe('Unknown option "workSpace" in ./wam.json.');
  });
});

describe("wam config set / unset", () => {
  it("writes only the user config, under the profile, and list reflects it", () => {
    writeJson(join(root, "wam.json"), { org: "project-org" });
    const before = JSON.stringify(readProjectConfig(join(root, "wam.json"), env));
    setUserConfigValue(env, "default", "workspace", "acme-eu");
    setUserConfigValue(env, "default", "failUnder", 40);
    expect(readUserConfig(userPath(), env)).toEqual({
      version: 1,
      profiles: { default: { workspace: "acme-eu", failUnder: 40 } },
    });
    expect(JSON.stringify(readProjectConfig(join(root, "wam.json"), env))).toBe(before);
    const resolved = resolveConfig({}, env);
    expect(resolved.workspace).toEqual({ value: "acme-eu", source: "~/.config/whereamimentioned/config.json" });
    expect(resolved.org).toEqual({ value: "project-org", source: "./wam.json" });
  });

  it("unset removes the key and reports whether it was set", () => {
    setUserConfigValue(env, "default", "org", "acme");
    expect(unsetUserConfigValue(env, "default", "org").removed).toBe(true);
    expect(unsetUserConfigValue(env, "default", "org").removed).toBe(false);
    expect(readUserConfig(userPath(), env)?.profiles.default).toEqual({});
  });

  it("keeps profiles isolated", () => {
    setUserConfigValue(env, "default", "org", "acme");
    setUserConfigValue(env, "client-b", "org", "northwind");
    const cfg = readUserConfig(userPath(), env)!;
    expect(cfg.profiles.default?.org).toBe("acme");
    expect(cfg.profiles["client-b"]?.org).toBe("northwind");
  });
});

describe("parseConfigValue", () => {
  it("validates each settable key", () => {
    expect(CONFIG_KEYS).toEqual(["org", "workspace", "apiUrl", "failUnder"]);
    expect(parseConfigValue("failUnder", "55")).toBe(55);
    expect(parseConfigValue("apiUrl", "https://staging.example/")).toBe("https://staging.example");
    expect(parseConfigValue("org", "  acme ")).toBe("acme");
    expectCliError(() => parseConfigValue("failUnder", "abc"), 2);
    expectCliError(() => parseConfigValue("failUnder", "101"), 2);
    expectCliError(() => parseConfigValue("failUnder", "-1"), 2);
    expectCliError(() => parseConfigValue("apiUrl", "nope"), 2);
    expectCliError(() => parseConfigValue("workspace", "   "), 2);
  });
});
