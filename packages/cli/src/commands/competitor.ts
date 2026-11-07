/**
 * `wam competitor` (10-CLI section 3.7): list, add.
 *
 * `list` is the read (checkpoint 4) and `add` is the write (checkpoint 5), both on one
 * `competitor` group. `add` needs `competitors:write` and role `member`; both the scope and
 * POST /api/v1/workspaces/{workspaceSlug}/competitors are 08's. It spends no credit, fetches
 * nothing from the domain it is given, and takes effect on the next scan. The name and domain are
 * printed as the API stored them (trimmed and lowercased there), never as they were typed.
 */
import type { Command } from "commander";
import type { Competitor, CreateCompetitorBody } from "@whereamimentioned/api-client";
import type { Context } from "../context";
import { usageError } from "../errors";
import type { TableColumn } from "../output";
import { call, nextPageHint, orgScopedClient, parseLimit } from "./support";

const COMPETITOR_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "name", header: "NAME", align: "left" },
  { key: "domain", header: "DOMAIN", align: "left" },
  { key: "aliases", header: "ALIASES", align: "left" },
];

function competitorRows(competitors: readonly Competitor[]): Array<Record<string, unknown>> {
  return competitors.map((c) => ({
    name: c.name,
    domain: c.domain ?? "-",
    aliases: c.aliases.join(", "),
  }));
}

interface ListOptions {
  limit?: string;
  cursor?: string;
}

async function runCompetitorList(ctx: Context, opts: ListOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  const page = await call(
    ctx,
    "competitor list",
    () => client.competitors.list(workspace, { limit, cursor: opts.cursor }),
    { workspace },
  );

  if (ctx.out.json) {
    ctx.out.jsonDocument(page);
    return;
  }
  ctx.out.table(competitorRows(page.data), COMPETITOR_COLUMNS);
  nextPageHint(ctx, "wam competitor list", page.pagination.nextCursor);
}

// --- add ---------------------------------------------------------------------------------------

interface AddOptions {
  domain?: string;
  alias: string[];
}

/** Commander's reducer for a repeatable option. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function runCompetitorAdd(ctx: Context, rawName: string, opts: AddOptions): Promise<void> {
  const name = rawName.trim();
  if (name === "") throw usageError("The competitor name must not be empty.");
  const { client } = await orgScopedClient(ctx);
  const workspace = ctx.requireWorkspace();

  const body: CreateCompetitorBody = { name };
  if (opts.domain !== undefined && opts.domain.trim() !== "") body.domain = opts.domain.trim();
  if (opts.alias.length > 0) body.aliases = opts.alias;

  // A competitor with the same name or domain is a 409 `conflict`, printed with the API's message.
  const created = await call(ctx, "competitor add", () => client.competitors.create(workspace, body), { workspace });

  if (ctx.out.json) {
    ctx.out.jsonDocument(created);
    return;
  }
  const domain = created.domain === null ? "" : ` (${created.domain})`;
  ctx.out.data(`Competitor ${created.name}${domain} added. It takes effect on the next scan.`);
  if (created.aliases.length > 0) ctx.out.data(`  Aliases  ${created.aliases.join(", ")}`);
}

export function registerCompetitorCommands(program: Command, getContext: () => Context): void {
  const competitor = program.command("competitor").description("List and add competitors");

  competitor
    .command("list")
    .description("List the competitors tracked in the workspace. Spends no credits")
    .option("--limit <n>", "Rows per page, 1 to 100 (default 25)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .addHelpText("after", "\nExample:\n  $ wam competitor list --workspace acme-eu\n")
    .action((opts: ListOptions) => runCompetitorList(getContext(), opts));

  competitor
    .command("add <name>")
    .description("Track a competitor in the workspace, from the next scan on. Spends no credits")
    .option("--domain <domain>", "The competitor's domain, for citation matching. Nothing is fetched from it")
    .option("--alias <alias>", "Another name the competitor goes by. Repeatable", collect, [])
    .addHelpText("after", '\nExample:\n  $ wam competitor add "Rival Co" --domain rival.example --alias Rival --alias "Rival Inc"\n')
    .action((name: string, opts: AddOptions) => runCompetitorAdd(getContext(), name, opts));
}
