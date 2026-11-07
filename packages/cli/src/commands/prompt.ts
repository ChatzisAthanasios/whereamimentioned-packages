/**
 * `wam prompt` (10-CLI section 3.7): list, add, enable, disable, remove.
 *
 * `list` is the read (checkpoint 4); `add`, `enable`, `disable` and `remove` are the writes
 * (checkpoint 5). All five register on one `prompt` group. None of them spends a credit.
 *
 * The footer holds two numbers and the CLI owns neither. The cap is `promptsPerWorkspace` from the
 * prompts-list envelope, printed as received: there is no tier-to-cap table anywhere in the CLI.
 * The enabled count is `enabledPromptCount` from GET /api/v1/workspaces/{slug}, never a count of
 * the rows on the current page, which is capped at `--limit` and would under-report.
 *
 * `list` shows the first eight characters of an id, so the three commands that take an id accept
 * that short form and resolve it against the workspace's own list before they write. The API
 * answers a malformed id with the same 404 as a missing one, and `remove` treats a 404 as success,
 * so sending a short id straight through would report a removal that never happened.
 */
import type { Command } from "commander";
import {
  ApiError,
  INTENT_STAGES,
  PROMPT_SOURCES,
  type CreatePromptBody,
  type Prompt,
  type WamClient,
} from "@whereamimentioned/api-client";
import { confirmRemove } from "../confirm";
import type { Context } from "../context";
import { CliError, EXIT, usageError } from "../errors";
import type { TableColumn } from "../output";
import { call, nextPageHint, orgScopedClient, parseBooleanFlag, parseChoice, parseLimit, shortId } from "./support";

const PROMPT_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "id", header: "ID", align: "left" },
  { key: "stage", header: "STAGE", align: "left" },
  { key: "source", header: "SOURCE", align: "left" },
  { key: "on", header: "ON", align: "left" },
  { key: "text", header: "TEXT", align: "left" },
];

function promptRows(prompts: readonly Prompt[]): Array<Record<string, unknown>> {
  return prompts.map((p) => ({
    id: shortId(p.id),
    stage: p.intentStage,
    source: p.source,
    on: p.enabled ? "yes" : "no",
    text: p.text.replace(/\s+/g, " ").trim(),
  }));
}

/**
 * `12 of 150 prompts enabled. Tier cap is 150 per workspace on this plan.` Shared with the
 * `enable` and `disable` footers of checkpoint 5, whose PATCH response carries neither number:
 * `cap` is `promptsPerWorkspace` as some response served it, and the enabled count is read here.
 */
export async function promptFooter(
  ctx: Context,
  client: WamClient,
  workspace: string,
  cap: number,
  command: string,
): Promise<string> {
  const detail = await call(ctx, command, () => client.workspaces.get(workspace), { workspace });
  return `${detail.enabledPromptCount} of ${cap} prompts enabled. Tier cap is ${cap} per workspace on this plan.`;
}

interface ListOptions {
  enabled?: string;
  source?: string;
  stage?: string;
  limit?: string;
  cursor?: string;
}

async function runPromptList(ctx: Context, opts: ListOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const enabled = parseBooleanFlag("--enabled", opts.enabled);
  const source = parseChoice("--source", opts.source, PROMPT_SOURCES);
  const stage = parseChoice("--stage", opts.stage, INTENT_STAGES);
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  // The filters are the endpoint's own and are applied server side, ahead of the page.
  const page = await call(
    ctx,
    "prompt list",
    () => client.prompts.list(workspace, { limit, cursor: opts.cursor, enabled, source, stage }),
    { workspace },
  );

  if (ctx.out.json) {
    ctx.out.jsonDocument(page);
    return;
  }

  const footer = await promptFooter(ctx, client, workspace, page.promptsPerWorkspace, "prompt list");
  ctx.out.table(promptRows(page.data), PROMPT_COLUMNS);
  ctx.out.data("");
  ctx.out.data(footer);
  nextPageHint(ctx, "wam prompt list", page.pagination.nextCursor);
}

// --- Resolving an id ---------------------------------------------------------------------------

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The list endpoint's own page ceiling, and a stop so a bad cursor can never loop forever. */
const RESOLVE_PAGE_LIMIT = 100;
const RESOLVE_MAX_PAGES = 20;

interface ResolvedPrompt {
  /** The full id, or null when a short id matched nothing. */
  id: string | null;
  /** `promptsPerWorkspace` as the list served it, when the list was read. */
  cap: number | null;
}

/**
 * A full id is used as given and costs no request. Anything else is a prefix, matched against
 * every page of GET .../prompts: exactly one match is the id, several is a usage error naming
 * them, none is `id: null` for the caller to report.
 */
async function resolvePromptId(
  ctx: Context,
  client: WamClient,
  workspace: string,
  raw: string,
  command: string,
): Promise<ResolvedPrompt> {
  const given = raw.trim();
  if (given === "") throw usageError("The prompt id must not be empty.");
  if (FULL_ID.test(given)) return { id: given, cap: null };

  const prefix = given.toLowerCase();
  const matches: string[] = [];
  let cap: number | null = null;
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < RESOLVE_MAX_PAGES; pageNo += 1) {
    const at = cursor;
    const page = await call(
      ctx,
      command,
      () => client.prompts.list(workspace, { limit: RESOLVE_PAGE_LIMIT, cursor: at }),
      { workspace },
    );
    cap = page.promptsPerWorkspace;
    for (const p of page.data) if (p.id.toLowerCase().startsWith(prefix)) matches.push(p.id);
    if (page.pagination.nextCursor === null) break;
    cursor = page.pagination.nextCursor;
  }

  if (matches.length > 1) {
    throw usageError(
      `The id ${given} matches ${matches.length} prompts: ${matches.join(", ")}.`,
      "Pass more characters of the id. See them with: wam prompt list --json",
    );
  }
  return { id: matches[0] ?? null, cap };
}

/** A 404 family error (exit 3, like every other "not found or not visible" row of section 9). */
function promptNotFoundError(id: string, workspace: string, requestId: string | null = null): CliError {
  const hint = "See the prompts of this workspace: wam prompt list";
  return new CliError(
    "not_found",
    EXIT.AUTH,
    [
      `Prompt ${id} was not found in workspace ${workspace}, or this key cannot see it.`,
      requestId ? `${hint} (request ${requestId})` : hint,
    ],
    { requestId },
  );
}

// --- add ---------------------------------------------------------------------------------------

interface AddOptions {
  stage?: string;
  persona?: string;
  disabled?: boolean;
}

async function runPromptAdd(ctx: Context, rawText: string, opts: AddOptions): Promise<void> {
  const stage = parseChoice("--stage", opts.stage, INTENT_STAGES);
  const text = rawText.trim();
  if (text === "") throw usageError("The prompt text must not be empty.");
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  // Only what was asked for: the API defaults the stage to research and forces the source to custom.
  const body: CreatePromptBody = { text };
  if (stage !== undefined) body.intentStage = stage;
  if (opts.persona !== undefined) body.persona = opts.persona;
  if (opts.disabled === true) body.enabled = false;

  // A full allowance is a 403 feature_not_available with details.limit, which maps to exit 3 here
  // (and to exit 11 only for `wam org create`): the branch is on the command, not the code alone.
  const created = await call(ctx, "prompt add", () => client.prompts.create(workspace, body), { workspace });

  if (ctx.out.json) {
    ctx.out.jsonDocument(created);
    return;
  }
  ctx.out.data(
    `Prompt ${shortId(created.id)} added: ${created.intentStage}, ${created.source}, ${created.enabled ? "enabled" : "disabled"}.`,
  );
}

// --- enable / disable ---------------------------------------------------------------------------

/** The PATCH response carries neither footer number, so both are read, and never fatally. */
async function toggleFooter(
  ctx: Context,
  client: WamClient,
  workspace: string,
  knownCap: number | null,
  command: string,
): Promise<string | null> {
  try {
    const cap = knownCap ?? (await client.prompts.list(workspace, { limit: 1 })).promptsPerWorkspace;
    return await promptFooter(ctx, client, workspace, cap, command);
  } catch (err) {
    // The write already happened. A failed side read must not turn it into an error.
    ctx.out.debug(`prompt footer skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function runPromptToggle(ctx: Context, rawId: string, enabled: boolean): Promise<void> {
  const command = enabled ? "prompt enable" : "prompt disable";
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  const target = await resolvePromptId(ctx, client, workspace, rawId, command);
  if (target.id === null) throw promptNotFoundError(rawId.trim(), workspace);
  const id = target.id;

  let updated: Prompt;
  try {
    updated = await client.prompts.patch(workspace, id, { enabled });
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") throw promptNotFoundError(id, workspace, err.requestId);
    throw ctx.mapError(err, command, { workspace });
  }

  if (ctx.out.json) {
    ctx.out.jsonDocument(updated);
    return;
  }
  ctx.out.data(
    updated.enabled
      ? `Prompt ${shortId(updated.id)} enabled. It is eligible for the next scan.`
      : `Prompt ${shortId(updated.id)} disabled. It will not consume credits in the next scan.`,
  );
  const footer = await toggleFooter(ctx, client, workspace, target.cap, command);
  if (footer !== null) ctx.out.data(footer);
}

// --- remove ------------------------------------------------------------------------------------

async function runPromptRemove(ctx: Context, rawId: string): Promise<void> {
  const command = "prompt remove";
  const given = rawId.trim();
  if (given === "") throw usageError("The prompt id must not be empty.");
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  // Asked before any request, so a context that cannot ask exits 2 having sent nothing.
  if (!(await confirmRemove(ctx.confirmDeps(), { what: `prompt ${given} from workspace ${workspace}` }))) return;

  const target = await resolvePromptId(ctx, client, workspace, given, command);
  if (target.id === null) {
    // The same outcome as the 404 below: the prompt is not there, which is what was asked for.
    if (ctx.out.json) ctx.out.jsonDocument({ deleted: true, id: given });
    else ctx.out.data(`No prompt with an id starting with ${given} is in workspace ${workspace}, so there is nothing to remove.`);
    return;
  }
  const id = target.id;

  // The api-client treats a 404 as success: the prompt is gone either way (08 section 4.8).
  await call(ctx, command, () => client.prompts.remove(workspace, id), { workspace });

  if (ctx.out.json) {
    ctx.out.jsonDocument({ deleted: true, id });
    return;
  }
  ctx.out.data(`Prompt ${shortId(id)} removed.`);
}

export function registerPromptCommands(program: Command, getContext: () => Context): void {
  const prompt = program.command("prompt").description("List, add, enable, disable and remove prompts");

  prompt
    .command("list")
    .description("List the workspace's prompts and how many are enabled against the plan's cap. Spends no credits")
    .option("--enabled <true|false>", "Only prompts that are, or are not, enabled")
    .option("--source <source>", `Only prompts from this source: ${PROMPT_SOURCES.join(", ")}`)
    .option("--stage <stage>", `Only prompts at this intent stage: ${INTENT_STAGES.join(", ")}`)
    .option("--limit <n>", "Rows per page, 1 to 100 (default 25)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .addHelpText("after", "\nExample:\n  $ wam prompt list --enabled true --stage research\n")
    .action((opts: ListOptions) => runPromptList(getContext(), opts));

  prompt
    .command("add <text>")
    .description("Add a custom prompt to the workspace. Spends no credits")
    .option("--stage <stage>", `The intent stage, one of: ${INTENT_STAGES.join(", ")} (default research)`)
    .option("--persona <persona>", "Who is asking, in a few words")
    .option("--disabled", "Add it switched off, so the next scan does not ask it")
    .addHelpText("after", '\nExample:\n  $ wam prompt add "best AI visibility tools for agencies" --stage comparison\n')
    .action((text: string, opts: AddOptions) => runPromptAdd(getContext(), text, opts));

  prompt
    .command("enable <id>")
    .description("Switch a prompt on. Takes the id, or the short id wam prompt list shows. Spends no credits")
    .addHelpText("after", "\nExample:\n  $ wam prompt enable 7b12ee40\n")
    .action((id: string) => runPromptToggle(getContext(), id, true));

  prompt
    .command("disable <id>")
    .description("Switch a prompt off, so it does not consume credits in the next scan. Spends no credits")
    .addHelpText("after", "\nExample:\n  $ wam prompt disable 7b12ee40\n")
    .action((id: string) => runPromptToggle(getContext(), id, false));

  prompt
    .command("remove <id>")
    .description("Remove a prompt from the workspace. Asks first, unless -y, --yes is passed. Spends no credits")
    .addHelpText(
      "after",
      "\nA prompt that is already gone counts as removed. Where the CLI cannot ask (CI, a pipe, --json),\n-y, --yes is required.\n\nExample:\n  $ wam prompt remove 7b12ee40 --yes\n",
    )
    .action((id: string) => runPromptRemove(getContext(), id));
}
