/**
 * `wam completion <shell>` (10-CLI section 3.10): bash | zsh | fish | powershell.
 *
 * The script goes to stdout and nothing else does, so `eval "$(wam completion zsh)"` works
 * unmodified; the installation instructions go to stderr. The update notice is suppressed for
 * this command by name (section 11.2), because a notice inside an `eval` would corrupt it.
 *
 * Both the script and the suggestions come from `@bomb.sh/tab`, fed from the one commander
 * definition tree: the walk below mirrors tab's own commander adapter (visible commands, visible
 * options, choices as value completions), on a fresh `RootCommand` per invocation. The adapter
 * itself is not used because it registers its own `completion` command, prints through
 * `console.log` and derives the callback executable from `process.argv`; here the command is
 * registered like every other one, output goes through the Context, and the scripts call back
 * `wam complete -- <words>`, which is the hidden command at the bottom of this file.
 */
import { Argument, type Command } from "commander";
import type { Command as TabCommand, RootCommand } from "@bomb.sh/tab";
import type { Context } from "../context";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** The command the generated scripts complete, and the one they call back for suggestions. */
const BINARY = "wam";

/** Section 3.10: printed to stderr, never to stdout. */
export const INSTALL_INSTRUCTIONS: Readonly<Record<CompletionShell, readonly string[]>> = {
  bash: [
    "Load it in this shell:   eval \"$(wam completion bash)\"",
    "Keep it:                 echo 'eval \"$(wam completion bash)\"' >> ~/.bashrc",
    "The script needs the bash-completion package.",
  ],
  zsh: [
    "Load it in this shell:   eval \"$(wam completion zsh)\"",
    "Keep it:                 echo 'eval \"$(wam completion zsh)\"' >> ~/.zshrc",
    "compinit has to run first: autoload -Uz compinit && compinit",
  ],
  fish: [
    "Load it in this shell:   wam completion fish | source",
    "Keep it:                 wam completion fish > ~/.config/fish/completions/wam.fish",
  ],
  powershell: [
    "Load it in this shell:   wam completion powershell | Out-String | Invoke-Expression",
    "Keep it:                 add that line to the file $PROFILE points at",
  ],
};

/**
 * tab prints through `console.log`, and the stream rule (section 6.1) says every byte goes
 * through the Context. Its calls are synchronous, so the swap below cannot interleave with
 * anything else.
 */
function captureTabOutput(run: () => void): string {
  const lines: string[] = [];
  /* eslint-disable no-console -- the one place console is touched: redirecting tab's output into the Context */
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  /* eslint-enable no-console */
  return lines.join("\n");
}

function addOptions(target: TabCommand, source: Command, seen: Set<string>): void {
  for (const option of source.createHelp().visibleOptions(source)) {
    const long = option.long?.slice(2);
    if (!long || seen.has(long)) continue;
    seen.add(long);
    const short = option.short && !option.short.startsWith("--") ? option.short.slice(1) : undefined;
    const takesValue = option.required || option.optional;
    const choices = option.argChoices ?? [];
    if (takesValue && choices.length > 0) {
      target.option(long, option.description, (complete) => choices.forEach((choice) => complete(choice, "")), short);
    } else if (takesValue) {
      // A handler, even an empty one, is what tells tab the next word is this option's value.
      target.option(long, option.description, () => {}, short);
    } else {
      target.option(long, option.description, short);
    }
  }
}

function addArguments(target: TabCommand, source: Command): void {
  for (const argument of source.registeredArguments) {
    const choices = argument.argChoices ?? [];
    if (choices.length > 0) {
      target.argument(argument.name(), (complete) => choices.forEach((choice) => complete(choice, "")), argument.variadic);
    } else {
      target.argument(argument.name(), undefined, argument.variadic);
    }
  }
}

function walk(root: RootCommand, program: Command, command: Command, path: string): void {
  for (const sub of command.createHelp().visibleCommands(command)) {
    const subPath = path === "" ? sub.name() : `${path} ${sub.name()}`;
    const target = root.command(subPath, sub.description());
    const seen = new Set<string>();
    addOptions(target, sub, seen);
    // The global flags of section 3.0 are accepted after any subcommand, so they complete there too.
    addOptions(target, program, seen);
    addArguments(target, sub);
    walk(root, program, sub, subPath);
  }
}

/** The tab tree for the whole program. Hidden commands (the callback below) never appear in it. */
export async function buildCompletionTree(program: Command): Promise<RootCommand> {
  const { RootCommand: TabRoot } = await import("@bomb.sh/tab");
  const root = new TabRoot();
  addOptions(root, program, new Set());
  addArguments(root, program);
  walk(root, program, program, "");
  return root;
}

export function registerCompletionCommands(program: Command, getContext: () => Context): void {
  program
    .command("completion")
    .description("Print a shell completion script (bash, zsh, fish, powershell)")
    .addArgument(new Argument("<shell>", "The shell to generate the script for").choices([...COMPLETION_SHELLS]))
    .addHelpText(
      "after",
      `
The script is the only thing on stdout. Installation instructions go to stderr.

Examples:
  $ eval "$(wam completion zsh)"
  $ wam completion fish > ~/.config/fish/completions/wam.fish
`,
    )
    .action(async (shell: CompletionShell) => {
      const ctx = getContext();
      const root = await buildCompletionTree(program);
      const script = captureTabOutput(() => root.setup(BINARY, BINARY, shell));
      if (ctx.out.json) {
        ctx.out.jsonDocument({ shell, script });
        return;
      }
      ctx.out.data(script);
      for (const line of INSTALL_INSTRUCTIONS[shell]) ctx.out.chatter(line);
    });

  // What the generated scripts call on every TAB: `wam complete -- <words>`. Suggestions and the
  // trailing directive line go to stdout; it is hidden from help and from the completions.
  program
    .command("complete", { hidden: true })
    .description("Print completion suggestions for a partial command line (called by the completion scripts)")
    .argument("[words...]")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (words: string[]) => {
      const ctx = getContext();
      const root = await buildCompletionTree(program);
      ctx.out.data(captureTabOutput(() => root.parse([...words])));
    });
}
