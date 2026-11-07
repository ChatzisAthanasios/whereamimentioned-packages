/**
 * `wam workspace` (10-CLI section 3.4): list, use, create.
 *
 * `list` and `use` are the reads (checkpoint 4); `create` is the write (checkpoint 5). All three
 * register on one `workspace` group.
 *
 * `create` spends nothing and still confirms, because nothing on this surface can delete a
 * workspace (section 8.1 rule 7). Its organization travels as `X-Wam-Org` and never in the body,
 * and it sends NO `Idempotency-Key`: a retried create makes a second workspace or hits the cap.
 *
 * `list` makes exactly three requests for one page, in this order: GET /api/v1/me (the ORG column,
 * the plan label and the prompt denominator), GET /api/v1/workspaces, GET /api/v1/credits. Every
 * per-workspace column is served by the list endpoint itself; nothing is fetched per row, which is
 * why a scan in flight shows `running` and its id and never a progress count.
 */
import type { Command } from "commander";
import type { Me, WorkspaceDetail, WorkspaceSummary } from "@whereamimentioned/api-client";
import { setUserConfigProfile } from "../config";
import { confirmCreate } from "../confirm";
import type { Context } from "../context";
import { usageError } from "../errors";
import type { TableColumn } from "../output";
import {
  call,
  formatDate,
  knownOrg,
  labelled,
  nextPageHint,
  orgScopedClient,
  parseLimit,
  plural,
  shortId,
  withOrg,
} from "./support";

const WORKSPACE_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "org", header: "ORG", align: "left" },
  { key: "workspace", header: "WORKSPACE", align: "left" },
  { key: "brand", header: "BRAND", align: "left" },
  { key: "region", header: "REGION", align: "left" },
  { key: "prompts", header: "PROMPTS", align: "left" },
  { key: "lastScan", header: "LAST SCAN", align: "left" },
  { key: "score", header: "SCORE", align: "right" },
];

/**
 * A scan in flight prints `running` and `activeScanId`, and its score is not known yet. Otherwise
 * the cell is the latest scan's date and status, from the list row alone.
 */
function lastScanCells(w: WorkspaceSummary): { lastScan: string; score: number | string } {
  if (w.activeScanId !== null) return { lastScan: `running ${shortId(w.activeScanId)}`, score: "-" };
  if (w.latestScan === null) return { lastScan: "-", score: "-" };
  const date = w.latestScan.finishedAt === null ? "" : `${formatDate(w.latestScan.finishedAt)}  `;
  return {
    lastScan: `${date}${w.latestScan.status}`,
    score: w.latestScan.score === null ? "-" : Math.round(w.latestScan.score),
  };
}

function workspaceRows(me: Me, workspaces: readonly WorkspaceSummary[]): Array<Record<string, unknown>> {
  return workspaces.map((w) => ({
    // Constant within one invocation: the org this request resolved, not a property of the key.
    org: me.org.slug,
    workspace: w.slug,
    brand: w.brandName ?? "-",
    region: w.defaultRegion,
    // The denominator is plan.promptsPerWorkspace from GET /api/v1/me, printed as received.
    prompts: `${w.enabledPromptCount}/${me.plan.promptsPerWorkspace}`,
    ...lastScanCells(w),
  }));
}

interface ListOptions {
  limit?: string;
  cursor?: string;
}

async function runWorkspaceList(ctx: Context, opts: ListOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const { client } = await orgScopedClient(ctx);

  if (ctx.out.json) {
    const page = await call(ctx, "workspace list", () => client.workspaces.list({ limit, cursor: opts.cursor }));
    ctx.out.jsonDocument(page);
    return;
  }

  const me = await call(ctx, "workspace list", () => client.me());
  const page = await call(ctx, "workspace list", () => client.workspaces.list({ limit, cursor: opts.cursor }));
  const credits = await call(ctx, "workspace list", () => client.credits());

  ctx.out.table(workspaceRows(me, page.data), WORKSPACE_COLUMNS);
  ctx.out.data("");
  // Both numbers are GET /api/v1/credits as received. The CLI never computes the scans figure.
  ctx.out.data(
    `Plan ${me.plan.label}, ${credits.balance} ${plural(credits.balance, "credit", "credits")} remaining (about ${credits.estimatedScansRemaining} ${plural(credits.estimatedScansRemaining, "scan", "scans")} at the maximum scan size for this tier).`,
  );
  nextPageHint(ctx, "wam workspace list", page.pagination.nextCursor);
}

const USE_ARGUMENT = /^([^/\s]+)\/([^/\s]+)$/;

async function runWorkspaceUse(ctx: Context, target: string): Promise<void> {
  const match = USE_ARGUMENT.exec(target.trim());
  if (!match) {
    throw usageError(
      `"${target}" is not an org/workspace pair.`,
      "Pass both slugs, separated by a slash: wam workspace use acme/acme-eu",
    );
  }
  const org = match[1]!;
  const workspace = match[2]!;

  // Validate before writing, under X-Wam-Org = the org in the argument, so a typo fails now and
  // not at the next scan. The server answers 404 for an org this key cannot reach.
  const scoped = withOrg(ctx, org);
  const client = await scoped.client();
  try {
    await client.workspaces.get(workspace);
  } catch (err) {
    throw scoped.mapError(err, "workspace use", { org, workspace });
  }

  const profile = ctx.config().profile.value;
  const { path } = setUserConfigProfile(ctx.configEnvironment(), profile, { org, workspace });

  if (ctx.out.json) {
    ctx.out.jsonDocument({ ok: true, org, workspace, profile, path });
    return;
  }
  ctx.out.chatter(`Default workspace set to ${org}/${workspace}.`);
  ctx.out.chatter(`Written to ${path}`);
}

// --- create ------------------------------------------------------------------------------------

const COMMAND_CREATE = "workspace create";

/**
 * The block of section 3.4, from the 201 body alone (`serializeWorkspaceDetail`). There is no
 * prompt denominator here: the create response does not carry the plan's cap, and a round trip to
 * draw a fraction on an empty workspace is not worth making.
 */
export function workspaceCreatedLines(org: string, w: WorkspaceDetail): string[] {
  return [
    `Created ${w.name} (${w.slug}) in ${org}.`,
    labelled("Prompts", String(w.promptCount), 13),
    labelled("Competitors", String(w.competitorCount), 13),
    labelled("Scans", w.latestScan === null ? "none yet" : w.latestScan.status, 13),
  ];
}

async function runWorkspaceCreate(ctx: Context, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (name === "") throw usageError("The workspace name must not be empty.");

  // Exit 2 here, before any request, on an account-wide key with no org resolved (section 3.0).
  const { client } = await orgScopedClient(ctx);

  // The one write nobody can take back names its organization explicitly (section 12.1). A stored
  // org key, --org, WAM_ORG and config all supply the slug locally. A bare org key does not, so
  // the key's own organization is read from GET /api/v1/me: it is the only one it could land in.
  let org = knownOrg(ctx);
  if (org === null) {
    const me = await call(ctx, COMMAND_CREATE, () => client.me());
    org = me.org.slug;
  }

  // No money wording: this spends nothing. It confirms because nothing here can undo it.
  if (!(await confirmCreate(ctx.confirmDeps(), { what: `a workspace in ${org}` }))) return;

  // The org travels as X-Wam-Org and never in the body, and NO Idempotency-Key is sent: 08 section
  // 7.1 accepts that header on two endpoints and this is not one of them. One POST, never retried.
  const slug = org;
  const created = await call(ctx, COMMAND_CREATE, () => client.workspaces.create(slug, { name }), { org: slug });

  if (ctx.out.json) {
    ctx.out.jsonDocument(created);
    return;
  }
  for (const line of workspaceCreatedLines(slug, created)) ctx.out.data(line);
  ctx.out.chatter("");
  ctx.out.chatter(`Next:  wam workspace use ${slug}/${created.slug}`);
}

export function registerWorkspaceCommands(program: Command, getContext: () => Context): void {
  const workspace = program.command("workspace").description("List, select and create workspaces");

  workspace
    .command("list")
    .description("List the workspaces of the resolved organization, with prompts and the latest scan")
    .option("--limit <n>", "Rows per page, 1 to 100 (default 25)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .addHelpText("after", "\nExample:\n  $ wam workspace list --org acme\n")
    .action((opts: ListOptions) => runWorkspaceList(getContext(), opts));

  workspace
    .command("use <org/workspace>")
    .description("Set the default organization and workspace in the user config, after checking they exist")
    .addHelpText("after", "\nExample:\n  $ wam workspace use acme/acme-eu\n")
    .action((target: string) => runWorkspaceUse(getContext(), target));

  workspace
    .command("create <name>")
    .description("Create a workspace in the resolved organization. Spends no credits")
    .addHelpText(
      "after",
      "\nA workspace cannot be deleted from the CLI or the API, so this asks first. Where the CLI cannot\nask (CI, a pipe, --json), -y, --yes is required. A retried create makes a second workspace: do\nnot wrap this in a retry, and do not put it in a scheduled workflow.\n\nExample:\n  $ wam workspace create \"Acme Labs EU\" --org acme-labs\n",
    )
    .action((name: string) => runWorkspaceCreate(getContext(), name));
}
