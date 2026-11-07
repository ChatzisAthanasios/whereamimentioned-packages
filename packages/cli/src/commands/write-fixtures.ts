/**
 * Test support for the write commands (checkpoint 5). Not a test file itself.
 *
 * It adds three things to ./fixtures.ts without changing it: contract-parsed bodies for the write
 * routes, a recorder that also keeps each request BODY (the money tests assert what was and was
 * not sent), and a runner that can make the invocation interactive, feed it answers on stdin and
 * move its clock, so a confirmation is answered by a fake user and never by a wall clock.
 *
 * Model names here are deliberately neutral and no test compares one for equality with a real
 * model (10-CLI section 15 item 7).
 */
import { Readable } from "node:stream";
import {
  competitor,
  createOrganizationResult,
  createScanResult,
  prompt,
  scanEstimate,
  workspaceDetail,
} from "@whereamimentioned/api-client";
import { main } from "../index";
import { FIXED_NOW, fakePrimitives, fakeStream } from "../test-support";
import { SCAN_ID, fakeApi, type CliRun, type FakeApi, type RecordedCall, type Sandbox } from "./fixtures";

// --- Bodies --------------------------------------------------------------------------------------

export const QUOTE_TOKEN = "cXVvdGU.bWFj";
export const FRESH_QUOTE_TOKEN = "ZnJlc2g.bWFj";

export const ESTIMATE = scanEstimate.parse({
  credits: 42,
  prompts: 6,
  models: [
    { id: "vendor/model-one", displayName: "Model One" },
    { id: "vendor/model-two", displayName: "Model Two" },
    { id: "vendor/model-three", displayName: "Model Three" },
    { id: "vendor/model-four", displayName: "Model Four" },
    { id: "vendor/model-five", displayName: "Model Five" },
    { id: "vendor/model-six", displayName: "Model Six" },
    { id: "vendor/model-seven", displayName: "Model Seven" },
  ],
  repetitions: 1,
  mode: "grounded",
  balance: 312,
  sufficient: true,
  usesOwnKey: false,
  // 300 seconds after the fixed test clock, as 08 section 6.5 signs it.
  quote: { token: QUOTE_TOKEN, expiresAt: new Date(FIXED_NOW.getTime() + 300_000).toISOString() },
});

/** What a second estimate returns: a different price and a different quote, so a test can tell them apart. */
export const ESTIMATE_FRESH = scanEstimate.parse({
  ...ESTIMATE,
  credits: 49,
  quote: { token: FRESH_QUOTE_TOKEN, expiresAt: new Date(FIXED_NOW.getTime() + 601_000).toISOString() },
});

export const ESTIMATE_SHORT = scanEstimate.parse({ ...ESTIMATE, balance: 11, sufficient: false });

export const SCAN_CREATED = createScanResult.parse({
  id: SCAN_ID,
  status: "queued",
  credits: 42,
  prompts: 6,
  models: 7,
  balanceAfter: 270,
  pollUrl: `/api/v1/scans/${SCAN_ID}`,
});

export const ORG_MESSAGE =
  "The organization was created on the free floor and cannot run scans yet. A human needs to subscribe at the URL above, because checkout finishes on a Stripe-hosted page.";

export const ORG_CREATED = createOrganizationResult.parse({
  id: "org_labs",
  slug: "acme-labs",
  name: "Acme Labs",
  type: "brand",
  tier: "free",
  usable: false,
  subscribeUrl: "https://whereamimentioned.com/acme-labs/billing",
  message: ORG_MESSAGE,
});

export const WORKSPACE_CREATED = workspaceDetail.parse({
  id: "ws_labs_eu",
  slug: "acme-labs-eu",
  name: "Acme Labs EU",
  brandName: null,
  defaultRegion: "us",
  defaultLanguage: "en",
  usesOwnKey: false,
  promptCount: 0,
  enabledPromptCount: 0,
  latestScan: null,
  activeScanId: null,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
  competitorCount: 0,
});

export const PROMPT_ID = "7b12ee40-0000-4000-8000-000000000003";

export const PROMPT_CREATED = prompt.parse({
  id: PROMPT_ID,
  text: "which tools track brand mentions in AI answers",
  intentStage: "comparison",
  persona: "agency owner",
  type: "category",
  topic: null,
  isBranded: false,
  tags: [],
  source: "custom",
  enabled: true,
  createdAt: "2026-09-10T12:00:00.000Z",
});

export const COMPETITOR_CREATED = competitor.parse({
  id: "cmp_9",
  name: "rival co",
  domain: "rival.example",
  aliases: ["Rival", "Rival Inc"],
  createdAt: "2026-09-10T12:00:00.000Z",
});

// --- A recorder that keeps bodies ------------------------------------------------------------------

export interface RecordedRequest extends RecordedCall {
  /** The parsed JSON body, or undefined when the request had none. */
  body: unknown;
}

export interface RecordingApi extends FakeApi {
  requests: RecordedRequest[];
  /** Every request to `METHOD path`, in order. */
  sent(method: string, path: string): RecordedRequest[];
}

/** `fakeApi()` plus the body of every request, parsed. Routes are added with `.on` as usual. */
export function recordingApi(): RecordingApi {
  const inner = fakeApi();
  const requests: RecordedRequest[] = [];
  const api = inner as RecordingApi;
  const innerFetch = inner.fetch;
  api.requests = requests;
  api.sent = (method, path) => requests.filter((r) => r.method === method && r.path === path);
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await innerFetch(input, init);
    const call = inner.calls[inner.calls.length - 1]!;
    const raw = init?.body;
    requests.push({ ...call, body: typeof raw === "string" && raw !== "" ? JSON.parse(raw) : undefined });
    return res;
  }) as typeof globalThis.fetch;
  return api;
}

// --- A runner with a fake user ---------------------------------------------------------------------

export interface FakeClock {
  now: () => Date;
  advance(ms: number): void;
}

export function fakeClock(start: Date = FIXED_NOW): FakeClock {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance(ms) {
      at += ms;
    },
  };
}

/**
 * A stdin that answers one question per chunk. `before` runs as each answer is "typed", which is
 * where a test moves the clock to make the user slow. Chunks stay separate so each prompt's reader
 * gets exactly its own line.
 */
export function answers(lines: readonly string[], before?: (index: number) => void): NodeJS.ReadableStream {
  async function* feed() {
    for (let i = 0; i < lines.length; i += 1) {
      // A turn of the event loop, so the question is on stderr before its answer arrives.
      await new Promise((resolve) => setImmediate(resolve));
      before?.(i);
      yield `${lines[i]}\n`;
    }
  }
  return Readable.from(feed());
}

export interface RunOptions {
  env?: Record<string, string>;
  api?: FakeApi;
  /** A terminal on stdout, so the invocation is interactive (section 6.3). Default false. */
  tty?: boolean;
  stdin?: NodeJS.ReadableStream;
  now?: () => Date;
}

/** `Sandbox.run` with the three things a confirmation test needs: a TTY, a stdin and a clock. */
export async function runCli(box: Sandbox, argv: string[], opts: RunOptions = {}): Promise<CliRun> {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const api = opts.api ?? fakeApi();
  const code = await main(
    argv,
    fakePrimitives({
      homedir: box.home,
      cwd: box.cwd,
      env: opts.env ?? {},
      stdout,
      stderr,
      fetch: api.fetch,
      fileMode: () => 0o600,
      // stdin stays a pipe even on a TTY run, so the answer is read as a line and never by a
      // terminal prompt library.
      isTTY: { stdout: opts.tty === true, stdin: false },
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );
  return { code, stdout: stdout.text, stderr: stderr.text };
}
