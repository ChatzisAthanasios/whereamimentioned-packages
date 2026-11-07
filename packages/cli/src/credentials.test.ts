import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOTH_TOKEN_SOURCES_WARNING,
  CredentialStore,
  credentialsFilePath,
  displayRecord,
  displayToken,
  loadSystemKeyring,
  makeCredentialRecord,
  resolveCredential,
  storageLabel,
  type CredentialRecord,
  type KeyringLike,
} from "./credentials";
import { CliError } from "./errors";
import { FAKE_TOKEN, FIXED_NOW, mkdirp, tempDir, type TempDir } from "./test-support";

// The native binding must never load in tests: the module import itself fails here.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("no native keyring in this test");
});

const IS_WINDOWS = process.platform === "win32";

let tmp: TempDir;
let home: string;

function record(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    ...makeCredentialRecord({
      token: FAKE_TOKEN,
      kind: "org",
      apiUrl: "https://whereamimentioned.com",
      org: "acme",
      expiresAt: "2026-11-26T00:00:00.000Z",
      now: FIXED_NOW,
    }),
    ...overrides,
  };
}

function memoryKeyring(): KeyringLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(profile) {
      return entries.get(profile) ?? null;
    },
    async set(profile, secret) {
      entries.set(profile, secret);
    },
    async delete(profile) {
      return entries.delete(profile);
    },
  };
}

function throwingKeyring(): KeyringLike {
  const boom = async () => {
    throw new Error("org.freedesktop.secrets: no D-Bus session");
  };
  return { get: boom, set: boom, delete: boom };
}

/**
 * The store is exercised as `linux` everywhere. On a Windows host the real permission bits are
 * meaningless (0666 for every file), so unless a test injects a mode the file is reported as the
 * 0600 a correct POSIX write produces; on a POSIX host the real bits are read.
 */
function makeStore(opts: { keyring?: KeyringLike | null; platform?: string; fileMode?: (p: string) => number | null } = {}) {
  return new CredentialStore({
    env: {},
    cwd: home,
    homedir: home,
    platform: opts.platform ?? "linux",
    keyring: async () => (opts.keyring === undefined ? null : opts.keyring),
    fileMode: opts.fileMode ?? (IS_WINDOWS ? () => 0o600 : undefined),
  });
}

beforeEach(() => {
  tmp = tempDir("wam-cred-");
  home = mkdirp(join(tmp.dir, "home"));
});

afterEach(() => {
  tmp.cleanup();
});

describe("display", () => {
  it("shows prefix...last4 and never the token", () => {
    const shown = displayToken(FAKE_TOKEN);
    expect(shown).toBe(`${FAKE_TOKEN.slice(0, 17)}...${FAKE_TOKEN.slice(-4)}`);
    expect(shown).not.toContain(FAKE_TOKEN);
    expect(shown.length).toBeLessThan(FAKE_TOKEN.length);
    expect(displayRecord(record())).toBe(shown);
  });

  it("shows only the environment prefix of a token too short to split", () => {
    expect(displayToken("wam_live_short")).toBe("wam_live_...");
  });

  it("names the backend per platform", () => {
    expect(storageLabel("keychain", "darwin")).toBe("macOS Keychain");
    expect(storageLabel("keychain", "win32")).toBe("Windows Credential Manager");
    expect(storageLabel("keychain", "linux")).toBe("Secret Service");
    expect(storageLabel("file", "linux")).toBe("credentials.json");
  });

  it("builds the section 4.5 record", () => {
    expect(record()).toEqual({
      token: FAKE_TOKEN,
      prefix: FAKE_TOKEN.slice(0, 17),
      last4: FAKE_TOKEN.slice(-4),
      kind: "org",
      apiUrl: "https://whereamimentioned.com",
      org: "acme",
      expiresAt: "2026-11-26T00:00:00.000Z",
      createdAt: FIXED_NOW.toISOString(),
    });
  });
});

describe("keyring loading", () => {
  it("resolves to null when the native module cannot be imported", async () => {
    expect(await loadSystemKeyring()).toBeNull();
  });
});

describe("the store", () => {
  it("falls back to the file when the keyring is unavailable, and reads it back", async () => {
    const store = makeStore({ keyring: null });
    expect(await store.set("default", record())).toBe("file");
    const path = credentialsFilePath({ env: {}, cwd: home, homedir: home, platform: "linux" });
    expect(store.filePath).toBe(path);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.profiles.default.prefix).toBe(FAKE_TOKEN.slice(0, 17));
    expect(await store.get("default")).toEqual({ record: record(), storage: "file" });
  });

  it("falls back to the file when the keyring throws", async () => {
    const store = makeStore({ keyring: throwingKeyring() });
    expect(await store.set("default", record())).toBe("file");
    expect((await store.get("default"))?.storage).toBe("file");
  });

  it("uses the keyring when it works and writes no file", async () => {
    const kr = memoryKeyring();
    const store = makeStore({ keyring: kr });
    expect(await store.set("default", record())).toBe("keychain");
    expect(kr.entries.get("default")).toBe(JSON.stringify(record()));
    expect(existsSync(store.filePath)).toBe(false);
    expect(await store.get("default")).toEqual({ record: record(), storage: "keychain" });
    expect(await store.storageOf("default")).toBe("keychain");
  });

  it("reads the file when the keyring holds nothing for the profile", async () => {
    await makeStore({ keyring: null }).set("default", record());
    const store = makeStore({ keyring: memoryKeyring() });
    expect((await store.get("default"))?.storage).toBe("file");
  });

  it("keeps profiles isolated and deletes one without touching the other", async () => {
    const store = makeStore({ keyring: null });
    await store.set("default", record({ org: "acme" }));
    await store.set("client-b", record({ org: "northwind" }));
    expect((await store.get("default"))?.record.org).toBe("acme");
    expect((await store.get("client-b"))?.record.org).toBe("northwind");
    expect(await store.delete("default")).toBe("file");
    expect(await store.get("default")).toBeNull();
    expect((await store.get("client-b"))?.record.org).toBe("northwind");
    expect(await store.delete("client-b")).toBe("file");
    expect(existsSync(store.filePath)).toBe(false);
    expect(await store.delete("client-b")).toBeNull();
  });

  it("deletes from the keyring and reports it", async () => {
    const kr = memoryKeyring();
    const store = makeStore({ keyring: kr });
    await store.set("default", record());
    expect(await store.delete("default")).toBe("keychain");
    expect(await store.get("default")).toBeNull();
  });

  it("returns null for an unknown profile", async () => {
    expect(await makeStore({ keyring: null }).get("nope")).toBeNull();
  });

  it("refuses a corrupt file rather than guessing", async () => {
    const store = makeStore({ keyring: null });
    await store.set("default", record());
    const { writeFileSync } = await import("node:fs");
    writeFileSync(store.filePath, "{ nope", "utf8");
    await expect(store.get("default")).rejects.toBeInstanceOf(CliError);
  });

  it.skipIf(IS_WINDOWS)("writes the file 0600 inside a 0700 directory on POSIX", async () => {
    const store = makeStore({ keyring: null });
    await store.set("default", record());
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(store.filePath, "..")).mode & 0o777).toBe(0o700);
  });

  it.skipIf(IS_WINDOWS)("refuses a real 0644 file on POSIX with the chmod copy", async () => {
    const store = makeStore({ keyring: null });
    await store.set("default", record());
    const { chmodSync } = await import("node:fs");
    chmodSync(store.filePath, 0o644);
    await expect(makeStore({ keyring: null }).get("default")).rejects.toMatchObject({
      exitCode: 3,
      lines: [
        "Credential file has unsafe permissions (0644). Fix it and try again:",
        `  chmod 600 ${store.filePath}`,
      ],
    });
  });

  // On Windows the real permission bits mean nothing, so the refusal logic is exercised by
  // injecting the mode the POSIX stat would have returned. Runs everywhere.
  it("refuses a file reported as 0644 with exit 3 and the exact copy (mode injected)", async () => {
    await makeStore({ keyring: null, fileMode: () => 0o600 }).set("default", record());
    const store = makeStore({ keyring: null, fileMode: () => 0o644 });
    const err = await store.get("default").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect((err as CliError).code).toBe("no_credential");
    expect((err as CliError).lines).toEqual([
      "Credential file has unsafe permissions (0644). Fix it and try again:",
      `  chmod 600 ${store.filePath}`,
    ]);
  });

  it("accepts 0600 and refuses 0640 and 0666 (mode injected)", async () => {
    await makeStore({ keyring: null, fileMode: () => 0o600 }).set("default", record());
    expect((await makeStore({ keyring: null, fileMode: () => 0o600 }).get("default"))?.storage).toBe("file");
    await expect(makeStore({ keyring: null, fileMode: () => 0o640 }).get("default")).rejects.toMatchObject({
      lines: expect.arrayContaining(["Credential file has unsafe permissions (0640). Fix it and try again:"]),
    });
    await expect(makeStore({ keyring: null, fileMode: () => 0o666 }).get("default")).rejects.toMatchObject({ exitCode: 3 });
  });

  it("performs no permission check on Windows", async () => {
    const win = { keyring: null, platform: "win32", fileMode: () => 0o666 };
    await makeStore(win).set("default", record());
    expect((await makeStore(win).get("default"))?.storage).toBe("file");
  });
});

describe("resolveCredential", () => {
  it("prefers --token, warns when WAM_TOKEN is also set, and returns no record", async () => {
    const warnings: string[] = [];
    const store = makeStore({ keyring: null });
    await store.set("default", record());
    const flagToken = `wam_test_${"F".repeat(43)}`;
    const resolved = await resolveCredential({
      tokenFlag: flagToken,
      env: { WAM_TOKEN: `wam_test_${"E".repeat(43)}` },
      store,
      profile: "default",
      warn: (l) => warnings.push(l),
    });
    expect(resolved).toMatchObject({ token: flagToken, source: "--token", record: null, profile: "default" });
    expect(resolved?.display).toBe(displayToken(flagToken));
    expect(warnings).toEqual([BOTH_TOKEN_SOURCES_WARNING]);
  });

  it("then WAM_TOKEN, without a warning", async () => {
    const warnings: string[] = [];
    const envToken = `wam_test_${"E".repeat(43)}`;
    const resolved = await resolveCredential({
      env: { WAM_TOKEN: envToken },
      store: makeStore({ keyring: null }),
      profile: "default",
      warn: (l) => warnings.push(l),
    });
    expect(resolved).toMatchObject({ token: envToken, source: "WAM_TOKEN", record: null });
    expect(warnings).toEqual([]);
  });

  it("then the store for the active profile, reporting the backend", async () => {
    const store = makeStore({ keyring: null });
    await store.set("client-b", record({ org: "northwind" }));
    const resolved = await resolveCredential({ env: {}, store, profile: "client-b", warn: () => {} });
    expect(resolved).toMatchObject({ token: FAKE_TOKEN, source: "file", profile: "client-b" });
    expect(resolved?.record?.org).toBe("northwind");
    expect(resolved?.display).toBe(displayRecord(record()));
    expect(await resolveCredential({ env: {}, store, profile: "default", warn: () => {} })).toBeNull();
  });

  it("never puts the token in the display string", async () => {
    const store = makeStore({ keyring: null });
    await store.set("default", record());
    const resolved = await resolveCredential({ env: {}, store, profile: "default", warn: () => {} });
    expect(resolved?.display).not.toContain(FAKE_TOKEN);
    // The 9-character environment tag plus 8 of the body: the server's own `prefix` (17 characters).
    expect(resolved?.display).toMatch(/^wam_test_.{8}\.\.\..{4}$/);
  });
});
