import { describe, expect, it, vi } from "vitest";
import {
  CANCELLED,
  CANCELLED_SPEND,
  CANNOT_DELETE,
  CREATE_QUESTION,
  SPEND_QUESTION,
  confirmCreate,
  confirmSpend,
  isYes,
  type ConfirmDeps,
} from "./confirm";
import { CliError } from "./errors";
import { fakeStdin, fakeStream, type FakeStream } from "./test-support";

function deps(input: string | null, overrides: Partial<ConfirmDeps> = {}): ConfirmDeps & { stderr: FakeStream } {
  return {
    interactive: true,
    yes: false,
    stdinIsTTY: false,
    stdin: fakeStdin(input),
    stderr: fakeStream(),
    ...overrides,
  } as ConfirmDeps & { stderr: FakeStream };
}

describe("isYes", () => {
  it("accepts y and yes in any case, nothing else", () => {
    for (const ok of ["y", "Y", "yes", "YES", " yes "]) expect(isYes(ok)).toBe(true);
    for (const no of ["", "n", "no", "maybe", "yeah", "true", null]) expect(isYes(no)).toBe(false);
  });
});

describe("confirmSpend (section 8.1)", () => {
  it("the default answer is No: an empty line cancels, prints the line, and spends nothing", async () => {
    const d = deps("\n");
    expect(await confirmSpend(d, { credits: 42 })).toBe(false);
    expect(d.stderr.text).toBe(`${SPEND_QUESTION} ${CANCELLED_SPEND}\n`);
  });

  it("EOF cancels the same way", async () => {
    const d = deps(null);
    expect(await confirmSpend(d, { credits: 42 })).toBe(false);
    expect(d.stderr.text).toContain(CANCELLED_SPEND);
  });

  it("y and yes proceed; anything else cancels", async () => {
    expect(await confirmSpend(deps("y\n"), { credits: 42 })).toBe(true);
    expect(await confirmSpend(deps("yes\n"), { credits: 42 })).toBe(true);
    expect(await confirmSpend(deps("Y\n"), { credits: 42 })).toBe(true);
    expect(await confirmSpend(deps("n\n"), { credits: 42 })).toBe(false);
    expect(await confirmSpend(deps("yolo\n"), { credits: 42 })).toBe(false);
  });

  it("the prompt and its echo go to stderr, never stdout", async () => {
    const d = deps("y\n");
    await confirmSpend(d, { credits: 42 });
    expect(d.stderr.text).toBe(`${SPEND_QUESTION} `);
  });

  it("--yes skips the prompt entirely", async () => {
    const prompt = vi.fn(async () => true);
    const d = deps(null, { yes: true, prompt });
    expect(await confirmSpend(d, { credits: 42 })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(d.stderr.text).toBe("");
  });

  it("non-interactive without --yes is exit 2 with the exact copy and asks nothing", async () => {
    const prompt = vi.fn(async () => true);
    const d = deps("y\n", { interactive: false, prompt });
    const err = await confirmSpend(d, { credits: 42 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).code).toBe("usage_error");
    expect((err as CliError).lines).toEqual([
      "This command spends about 42 credits and cannot prompt for confirmation here.",
      "Pass --yes to confirm, or run wam scan estimate to see the cost first.",
    ]);
    expect(prompt).not.toHaveBeenCalled();
    expect(d.stderr.text).toBe("");
  });

  it("uses the injected prompt when one is given, and treats null as cancelled", async () => {
    const yes = deps(null, { prompt: async () => true });
    expect(await confirmSpend(yes, { credits: 1 })).toBe(true);
    const cancelled = deps(null, { prompt: async () => null });
    expect(await confirmSpend(cancelled, { credits: 1 })).toBe(false);
    expect(cancelled.stderr.text).toBe(`${CANCELLED_SPEND}\n`);
  });

  it("a custom question is passed through", async () => {
    const prompt = vi.fn(async () => true);
    await confirmSpend(deps(null, { prompt }), { credits: 1, question: "Spend it? (y/N)" });
    expect(prompt).toHaveBeenCalledWith("Spend it? (y/N)");
  });
});

describe("confirmCreate (section 3.4 and 8.1 rule 7)", () => {
  it("states the real reason, asks, and cancels neutrally on No", async () => {
    const d = deps("\n");
    expect(await confirmCreate(d, { what: "an organization on your account" })).toBe(false);
    expect(d.stderr.text).toBe(
      `This creates an organization on your account. ${CANNOT_DELETE}\n${CREATE_QUESTION} ${CANCELLED}\n`,
    );
    expect(d.stderr.text).not.toContain("credit");
  });

  it("proceeds on y", async () => {
    const d = deps("y\n");
    expect(await confirmCreate(d, { what: "a workspace in acme-labs" })).toBe(true);
    expect(d.stderr.text).toContain("This creates a workspace in acme-labs. It cannot be deleted from the CLI or the API.");
  });

  it("non-interactive without --yes is exit 2, names --yes, and never mentions money", async () => {
    const err = await confirmCreate(deps(null, { interactive: false }), { what: "a workspace in acme-labs" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).lines).toEqual([
      `This command creates a workspace in acme-labs and cannot prompt for confirmation here. ${CANNOT_DELETE}`,
      "Pass --yes to confirm.",
    ]);
    expect((err as CliError).message).not.toMatch(/credit/i);
  });

  it("--yes skips the prompt and prints nothing", async () => {
    const d = deps(null, { yes: true });
    expect(await confirmCreate(d, { what: "an organization on your account" })).toBe(true);
    expect(d.stderr.text).toBe("");
  });
});
