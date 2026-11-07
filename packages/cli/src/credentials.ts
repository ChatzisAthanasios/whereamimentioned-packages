/**
 * Credential storage (10-CLI section 4.5) and credential precedence (section 4.7).
 *
 * Primary: the OS keyring through `@napi-rs/keyring`, imported LAZILY inside a try so a machine
 * without a native binding, a D-Bus session or a keychain still works. Fallback, whenever the
 * keyring is unavailable or throws: `credentials.json` under the user config directory, written
 * `0600` inside a `0700` directory on POSIX and refused when it is found looser than that. On
 * Windows the file inherits the profile ACL and no mode check runs.
 *
 * The record is the section 4.5 format. `kind` is a cache of what `GET /api/v1/me` said (the
 * server stays authoritative); `org` is a default, not a binding.
 *
 * Precedence: `--token`, then `WAM_TOKEN`, then the store for the active profile. Nothing in this
 * module ever returns a token for display: `displayToken` shows prefix...last4 and no more.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { API_KEY_KINDS, type ApiKeyKind } from "@whereamimentioned/api-client";
import { userConfigDir, type ConfigEnvironment } from "./config";
import { unsafeCredentialFileError, usageError } from "./errors";
import type { Env } from "./output";

export const CREDENTIALS_FILENAME = "credentials.json";
/** Keychain service (macOS), collection (Linux) and the first half of the Windows target. */
export const KEYRING_SERVICE = "whereamimentioned";

export type CredentialStorage = "keychain" | "file";

export const credentialRecordSchema = z
  .object({
    token: z.string().min(1),
    prefix: z.string(),
    last4: z.string(),
    kind: z.enum(API_KEY_KINDS).nullable(),
    apiUrl: z.string(),
    org: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

export const credentialsFileSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(z.string(), credentialRecordSchema),
  })
  .strict();
export type CredentialsFile = z.infer<typeof credentialsFileSchema>;

/** The three operations the store needs from a keyring. Any of them may throw; the store falls back. */
export interface KeyringLike {
  get(profile: string): Promise<string | null>;
  set(profile: string, secret: string): Promise<void>;
  delete(profile: string): Promise<boolean>;
}

/** Resolves to null when the keyring cannot be loaded at all. */
export type KeyringLoader = () => Promise<KeyringLike | null>;

/**
 * The real keyring, loaded on first use and never at startup. `@napi-rs/keyring` is `external`
 * in tsup.config.ts, so this stays a runtime import of the platform binding.
 */
export const loadSystemKeyring: KeyringLoader = async () => {
  try {
    const mod = await import("@napi-rs/keyring");
    const entry = (profile: string) => new mod.Entry(KEYRING_SERVICE, profile);
    return {
      async get(profile) {
        return entry(profile).getPassword() ?? null;
      },
      async set(profile, secret) {
        entry(profile).setPassword(secret);
      },
      async delete(profile) {
        return entry(profile).deletePassword();
      },
    };
  } catch {
    return null;
  }
};

// --- Display ---------------------------------------------------------------------------------

/**
 * The length of the prefix the server stores and shows for a key: the 9-character environment tag
 * (`wam_live_` or `wam_test_`) plus the first 8 characters of the body (src/auth/api-key.ts).
 */
export const TOKEN_PREFIX_LENGTH = 17;

/** The display prefix, e.g. `wam_live_7Ka3Qp2m` (section 4.5): the same 17 characters the server calls `prefix`. */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}

/**
 * `wam_live_7Ka3Qp2m...9fQz`, the only form a token ever takes in output (section 4.7). A token
 * too short for prefix and last4 to be disjoint shows its environment prefix only.
 */
export function displayToken(token: string): string {
  if (token.length < 24) return `${token.slice(0, 9)}...`;
  return `${tokenPrefix(token)}...${tokenLast4(token)}`;
}

export function displayRecord(record: Pick<CredentialRecord, "prefix" | "last4">): string {
  return `${record.prefix}...${record.last4}`;
}

/** The backend name for `Stored in`, `Credential` and `Cleared the local credential (...)`. */
export function storageLabel(storage: CredentialStorage, platform: string): string {
  if (storage === "file") return CREDENTIALS_FILENAME;
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "Secret Service";
}

export function makeCredentialRecord(input: {
  token: string;
  kind: ApiKeyKind | null;
  apiUrl: string;
  org: string | null;
  expiresAt: string | null;
  now: Date;
}): CredentialRecord {
  return {
    token: input.token,
    prefix: tokenPrefix(input.token),
    last4: tokenLast4(input.token),
    kind: input.kind,
    apiUrl: input.apiUrl,
    org: input.org,
    expiresAt: input.expiresAt,
    createdAt: input.now.toISOString(),
  };
}

// --- The store -------------------------------------------------------------------------------

export function credentialsFilePath(e: ConfigEnvironment): string {
  return join(userConfigDir(e), CREDENTIALS_FILENAME);
}

export interface CredentialStoreDeps extends ConfigEnvironment {
  keyring: KeyringLoader;
  /**
   * The permission bits of a path, for the POSIX safety check. Defaults to `fs.statSync`;
   * injectable so the refusal path is testable on Windows, where the real bits are meaningless.
   */
  fileMode?: (path: string) => number | null;
}

export interface StoredCredential {
  record: CredentialRecord;
  storage: CredentialStorage;
}

function statMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export class CredentialStore {
  readonly filePath: string;
  private readonly deps: CredentialStoreDeps;
  private keyringPromise: Promise<KeyringLike | null> | null = null;

  constructor(deps: CredentialStoreDeps) {
    this.deps = deps;
    this.filePath = credentialsFilePath(deps);
  }

  private get posix(): boolean {
    return this.deps.platform !== "win32";
  }

  private keyring(): Promise<KeyringLike | null> {
    if (!this.keyringPromise) {
      this.keyringPromise = this.deps.keyring().catch(() => null);
    }
    return this.keyringPromise;
  }

  async get(profile: string): Promise<StoredCredential | null> {
    const kr = await this.keyring();
    if (kr) {
      try {
        const secret = await kr.get(profile);
        if (secret !== null) {
          const parsed = credentialRecordSchema.safeParse(JSON.parse(secret));
          if (parsed.success) return { record: parsed.data, storage: "keychain" };
        }
      } catch {
        // Fall through to the file: a keyring that throws is the documented fallback trigger.
      }
    }
    const file = this.readFile();
    const record = file?.profiles[profile];
    return record ? { record, storage: "file" } : null;
  }

  async set(profile: string, record: CredentialRecord): Promise<CredentialStorage> {
    const kr = await this.keyring();
    if (kr) {
      try {
        await kr.set(profile, JSON.stringify(record));
        return "keychain";
      } catch {
        // Fall through to the file.
      }
    }
    const file = this.readFile() ?? { version: 1 as const, profiles: {} };
    file.profiles[profile] = record;
    this.writeFile(file);
    return "file";
  }

  /** Removes the profile from every backend it is found in; returns the first one that held it. */
  async delete(profile: string): Promise<CredentialStorage | null> {
    let found: CredentialStorage | null = null;
    const kr = await this.keyring();
    if (kr) {
      try {
        if (await kr.delete(profile)) found = "keychain";
      } catch {
        // Nothing to delete there, or no keyring to delete from.
      }
    }
    const file = this.readFile();
    if (file && file.profiles[profile]) {
      delete file.profiles[profile];
      if (Object.keys(file.profiles).length === 0) {
        try {
          unlinkSync(this.filePath);
        } catch {
          this.writeFile(file);
        }
      } else {
        this.writeFile(file);
      }
      found = found ?? "file";
    }
    return found;
  }

  /** Where a credential for the profile currently lives, for `wam auth status`. */
  async storageOf(profile: string): Promise<CredentialStorage | null> {
    return (await this.get(profile))?.storage ?? null;
  }

  private assertSafeMode(): void {
    if (!this.posix) return;
    const mode = (this.deps.fileMode ?? statMode)(this.filePath);
    if (mode === null) return;
    if ((mode & 0o077) !== 0) throw unsafeCredentialFileError(mode, this.filePath);
  }

  private readFile(): CredentialsFile | null {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    this.assertSafeMode();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw usageError(`Could not parse ${this.filePath}. Fix or delete it and sign in again.`);
    }
    const parsed = credentialsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw usageError(`Could not parse ${this.filePath}. Fix or delete it and sign in again.`);
    }
    return parsed.data;
  }

  private writeFile(file: CredentialsFile): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.posix) {
      // umask can defeat the mode arguments above, so both are re-asserted (section 4.5).
      chmodSync(dir, 0o700);
      chmodSync(this.filePath, 0o600);
    }
  }
}

// --- Precedence -------------------------------------------------------------------------------

export type CredentialSource = "--token" | "WAM_TOKEN" | CredentialStorage;

export interface ResolvedCredential {
  token: string;
  source: CredentialSource;
  /** The stored record when the source is the store; null for `--token` and `WAM_TOKEN`. */
  record: CredentialRecord | null;
  /** prefix...last4 and nothing more. */
  display: string;
  profile: string;
}

export const BOTH_TOKEN_SOURCES_WARNING = "Both --token and WAM_TOKEN are set. Using --token.";

/** Section 4.7: `--token`, then `WAM_TOKEN`, then the store. Warns on stderr when both are set. */
export async function resolveCredential(input: {
  tokenFlag?: string;
  env: Env;
  store: CredentialStore;
  profile: string;
  warn: (line: string) => void;
}): Promise<ResolvedCredential | null> {
  const flag = input.tokenFlag?.trim();
  const envToken = input.env.WAM_TOKEN?.trim();
  if (flag) {
    if (envToken) input.warn(BOTH_TOKEN_SOURCES_WARNING);
    return { token: flag, source: "--token", record: null, display: displayToken(flag), profile: input.profile };
  }
  if (envToken) {
    return { token: envToken, source: "WAM_TOKEN", record: null, display: displayToken(envToken), profile: input.profile };
  }
  const stored = await input.store.get(input.profile);
  if (!stored) return null;
  return {
    token: stored.record.token,
    source: stored.storage,
    record: stored.record,
    display: displayRecord(stored.record),
    profile: input.profile,
  };
}
