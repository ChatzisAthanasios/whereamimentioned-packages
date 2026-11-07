/**
 * Shared fakes for the CLI's tests. Not a test file itself (vitest only collects `*.test.ts`).
 *
 * Every command is exercised in-process with a fake Context built from these primitives; nothing
 * here spawns a process, touches the real home directory or reaches the network.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ContextOverrides, ContextPrimitives } from "./context";

export interface FakeStream {
  write(chunk: string): boolean;
  readonly text: string;
  lines(): string[];
}

export function fakeStream(): FakeStream {
  let buf = "";
  return {
    write(chunk: string) {
      buf += chunk;
      return true;
    },
    get text() {
      return buf;
    },
    lines() {
      return buf.split("\n").filter((l) => l !== "");
    },
  };
}

/** A stdin that yields `text` then EOF; `null` is immediate EOF. */
export function fakeStdin(text: string | null): NodeJS.ReadableStream {
  return Readable.from(text === null ? [] : [text]);
}

export interface TempDir {
  dir: string;
  cleanup(): void;
}

export function tempDir(prefix = "wam-cli-"): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export const FIXED_NOW = new Date("2026-09-10T12:00:00.000Z");

/** A 52-character token shaped like a real one; never a real one. */
export const FAKE_TOKEN = `wam_test_${"Ab1".repeat(14)}Z`;

/**
 * Primitives with nothing real behind them: no TTY, empty env, a fetch that fails loudly, no
 * keyring, a fixed clock, a temp home and cwd. Override per test.
 */
export function fakePrimitives(overrides: Partial<ContextPrimitives> = {}): ContextOverrides {
  const home = overrides.homedir ?? tempDir("wam-home-").dir;
  const cwd = overrides.cwd ?? mkdirp(join(home, "project"));
  return {
    argv: [],
    env: {},
    cwd,
    stdout: fakeStream(),
    stderr: fakeStream(),
    stdin: fakeStdin(null),
    isTTY: { stdout: false, stdin: false },
    fetch: async () => {
      throw new Error("fetch is not stubbed in this test");
    },
    keyring: async () => null,
    now: () => FIXED_NOW,
    openBrowser: async () => {},
    homedir: home,
    platform: "linux",
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    ...overrides,
  };
}
