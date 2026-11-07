/**
 * Confirmations (10-CLI section 8.1): the cost prompt before a scan, and the "cannot be undone"
 * prompt before the two creates.
 *
 * Rules, all of them exact:
 *  - the default answer is No; `y` or `yes` proceeds; anything else, an empty line or EOF cancels
 *    with exit 0 and "Cancelled. No credits were spent." (a neutral "Cancelled." for the creates);
 *  - `--yes` skips the prompt;
 *  - a non-interactive context without `--yes` is a usage error (exit 2) naming the flag;
 *  - the create prompts state their real reason, that nothing on this surface can delete what
 *    they make, and never a money warning (section 8.1 rule 7).
 *
 * `@clack/prompts` is loaded lazily and only when stdin is a terminal. Otherwise one line is read
 * from the injected stdin, so `echo y | wam scan run` works and tests never spawn.
 */
import { createInterface } from "node:readline";
import { usageError } from "./errors";
import type { WritableLike } from "./output";

export const SPEND_QUESTION = "This spends real credits. Run the scan? (y/N)";
export const CREATE_QUESTION = "Create it? (y/N)";
export const CANCELLED_SPEND = "Cancelled. No credits were spent.";
export const CANCELLED = "Cancelled.";
export const CANNOT_DELETE = "It cannot be deleted from the CLI or the API.";

export interface ConfirmDeps {
  /** Section 6.3's decision, made once by the Context. */
  interactive: boolean;
  /** `--yes` / `-y`. */
  yes: boolean;
  stdinIsTTY: boolean;
  stdin: NodeJS.ReadableStream;
  stderr: WritableLike;
  /**
   * Overrides how a question is asked. Resolves true for yes, false for no, null for EOF or a
   * cancelled prompt. Tests inject this; production leaves it unset.
   */
  prompt?: (question: string) => Promise<boolean | null>;
}

/** `y` or `yes`, case-insensitively, after trimming. Everything else is No. */
export function isYes(answer: string | null): boolean {
  if (answer === null) return false;
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

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

async function askWithClack(question: string): Promise<boolean | null> {
  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({ message: question.replace(/\s*\(y\/N\)\s*$/, ""), initialValue: false });
  if (clack.isCancel(answer)) return null;
  return answer === true;
}

async function ask(deps: ConfirmDeps, question: string): Promise<boolean | null> {
  if (deps.prompt) return deps.prompt(question);
  if (deps.stdinIsTTY) {
    try {
      return await askWithClack(question);
    } catch {
      // The prompt library could not render (no terminal after all): fall back to a plain line.
    }
  }
  deps.stderr.write(`${question} `);
  const line = await readLine(deps.stdin);
  return line === null ? null : isYes(line);
}

/**
 * The money prompt. Resolves true to proceed. On No, empty, EOF or cancel it prints the
 * cancellation line to stderr and resolves false; the caller then exits 0 having spent nothing.
 * Throws exit 2 when it would have to prompt and cannot.
 */
export async function confirmSpend(
  deps: ConfirmDeps,
  opts: { credits: number; question?: string },
): Promise<boolean> {
  if (deps.yes) return true;
  if (!deps.interactive) {
    throw usageError(
      `This command spends about ${opts.credits} credits and cannot prompt for confirmation here.`,
      "Pass --yes to confirm, or run wam scan estimate to see the cost first.",
    );
  }
  const answer = await ask(deps, opts.question ?? SPEND_QUESTION);
  if (answer === true) return true;
  deps.stderr.write(`${CANCELLED_SPEND}\n`);
  return false;
}

/**
 * One free-text answer, for the one question that is not yes or no (`wam org create` asking for
 * `--type` in an interactive shell). The question goes to stderr; null is EOF. Callers decide
 * whether they may ask at all: this never checks `interactive`.
 */
export async function askLine(deps: ConfirmDeps, question: string): Promise<string | null> {
  deps.stderr.write(`${question} `);
  const line = await readLine(deps.stdin);
  return line === null ? null : line.trim();
}

export const REMOVE_QUESTION = "Remove it? (y/N)";

/**
 * The prompt before `wam prompt remove` (section 3.7). `what` is the object clause, e.g.
 * "prompt 7b12ee40 from workspace acme-eu". Same answer rules as the other two, and its own
 * reason: nothing is spent and nothing is created, something is taken away.
 */
export async function confirmRemove(deps: ConfirmDeps, opts: { what: string }): Promise<boolean> {
  if (deps.yes) return true;
  if (!deps.interactive) {
    throw usageError(
      `This command removes ${opts.what} and cannot prompt for confirmation here.`,
      "Pass --yes to confirm.",
    );
  }
  deps.stderr.write(`This removes ${opts.what}.\n`);
  const answer = await ask(deps, REMOVE_QUESTION);
  if (answer === true) return true;
  deps.stderr.write(`${CANCELLED}\n`);
  return false;
}

/**
 * The create prompt of section 3.4. `what` is the object clause, e.g. "an organization on your
 * account" or "a workspace in acme-labs". Same answer rules as `confirmSpend`, a different reason.
 */
export async function confirmCreate(deps: ConfirmDeps, opts: { what: string }): Promise<boolean> {
  if (deps.yes) return true;
  const reason = `This creates ${opts.what}. ${CANNOT_DELETE}`;
  if (!deps.interactive) {
    throw usageError(
      `This command creates ${opts.what} and cannot prompt for confirmation here. ${CANNOT_DELETE}`,
      "Pass --yes to confirm.",
    );
  }
  deps.stderr.write(`${reason}\n`);
  const answer = await ask(deps, CREATE_QUESTION);
  if (answer === true) return true;
  deps.stderr.write(`${CANCELLED}\n`);
  return false;
}
