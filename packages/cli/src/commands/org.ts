/**
 * `wam org` (10-CLI section 3.4): list, create.
 *
 * Neither command addresses an organization: both send no `X-Wam-Org` (the api-client suppresses
 * it on the two organization routes) and neither calls `ctx.requireOrg()`.
 *
 * `wam org list`: an org key gets the server's 403 `insufficient_scope`, which `mapError` renders
 * as the section 9 copy with exit 3 after exactly one request.
 *
 * `wam org create` spends nothing and still confirms, because nothing on this surface can delete
 * what it makes (section 8.1 rule 7): its prompt states that reason and never a money warning. It
 * sends a derived `Idempotency-Key` (section 7.3), is never retried, and prints the API's
 * `subscribeUrl` and `message` verbatim, the URL first, because the sentence ends "at the URL
 * above". A new organization is on the free floor and is never described as usable or ready.
 */
import type { Command } from "commander";
import {
  ORG_TYPES,
  type CreateOrganizationResult,
  type OrgType,
  type OrganizationSummary,
  type Page,
} from "@whereamimentioned/api-client";
import { CANCELLED, askLine, confirmCreate } from "../confirm";
import type { Context } from "../context";
import { CliError, EXIT, usageError } from "../errors";
import { deriveOrgCreateIdempotencyKey, parseIdempotencyKeyFlag } from "../idempotency";
import type { TableColumn } from "../output";
import { call, joinNames, labelled, nextPageHint, parseChoice, parseLimit, plural } from "./support";

/** The five columns of sections 3.2 (the reach table) and 3.4, from one row of GET /api/v1/organizations. */
export const ORGANIZATION_COLUMNS: ReadonlyArray<TableColumn> = [
  { key: "slug", header: "ORG", align: "left" },
  { key: "name", header: "NAME", align: "left" },
  { key: "tier", header: "TIER", align: "left" },
  { key: "effectiveRole", header: "YOUR ROLE", align: "left" },
  { key: "workspaceCount", header: "WORKSPACES", align: "right" },
];

/** `tier` and `effectiveRole` are printed as received: a wide key is not a promoted key. */
export function organizationRows(orgs: readonly OrganizationSummary[]): Array<Record<string, unknown>> {
  return orgs.map((o) => ({
    slug: o.slug,
    name: o.name,
    tier: o.tier,
    effectiveRole: o.effectiveRole,
    workspaceCount: o.workspaceCount,
  }));
}

/** The slugs of the rows on the free floor. A `free` row is an answer, never hidden. */
export function freeFloorSlugs(orgs: readonly OrganizationSummary[]): string[] {
  return orgs.filter((o) => o.tier === "free").map((o) => o.slug);
}

interface ListOptions {
  limit?: string;
  cursor?: string;
}

async function runOrgList(ctx: Context, opts: ListOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const client = await ctx.client();
  const page: Page<OrganizationSummary> = await call(ctx, "org list", () =>
    client.organizations.list({ limit, cursor: opts.cursor }),
  );

  if (ctx.out.json) {
    ctx.out.jsonDocument(page);
    return;
  }

  ctx.out.table(organizationRows(page.data), ORGANIZATION_COLUMNS);
  const n = page.data.length;
  const free = freeFloorSlugs(page.data);
  let footer = `${n} ${plural(n, "organization", "organizations")}.`;
  if (free.length > 0) {
    footer += ` ${joinNames(free)} ${plural(free.length, "is", "are")} on the free floor and cannot run scans yet.`;
  }
  ctx.out.data("");
  ctx.out.data(footer);
  nextPageHint(ctx, "wam org list", page.pagination.nextCursor);
}

// --- create ------------------------------------------------------------------------------------

const COMMAND_CREATE = "org create";

interface CreateOptions {
  type?: string;
  idempotencyKey?: string;
}

/**
 * `--type` is required and has no default: a machine that did not choose between a brand and an
 * agency organization has not made the decision the field records. An interactive shell is asked;
 * anywhere else it is exit 2. Resolves null when the question was left unanswered.
 */
async function resolveOrgType(ctx: Context, raw: string | undefined): Promise<OrgType | null> {
  const given = parseChoice("--type", raw, ORG_TYPES);
  if (given !== undefined) return given;
  if (ctx.nonInteractive) {
    throw usageError(
      `wam org create needs --type, one of: ${ORG_TYPES.join(", ")}. It cannot ask for it here.`,
      `Try: wam org create "Acme Labs" --type ${ORG_TYPES[ORG_TYPES.length - 1]} --yes`,
    );
  }
  const answer = await askLine(ctx.confirmDeps(), `Organization type (${ORG_TYPES.join(" or ")}):`);
  if (answer === null || answer === "") {
    ctx.out.warn(CANCELLED);
    return null;
  }
  return parseChoice("--type", answer.toLowerCase(), ORG_TYPES) ?? null;
}

/**
 * The block of section 3.4. `subscribeUrl` and `message` are the API's, byte for byte, and the URL
 * comes first because the message says "at the URL above". `Usable` is the body's own boolean:
 * the CLI never rewords "not usable" into anything cheerier.
 */
export function organizationCreatedLines(org: CreateOrganizationResult): string[] {
  const lines = [
    `Created ${org.name} (${org.slug}), type ${org.type}, tier ${org.tier}.`,
    "",
    labelled("Usable", org.usable ? "yes" : "no", 12),
    labelled("Subscribe", org.subscribeUrl, 12),
  ];
  if (org.message !== undefined) lines.push("", org.message);
  lines.push(
    "",
    org.usable ? "Your key already reaches it:" : "Your key already reaches it. After someone subscribes:",
    `  wam workspace create "<name>" --org ${org.slug}`,
  );
  return lines;
}

async function runOrgCreate(ctx: Context, rawName: string, opts: CreateOptions): Promise<void> {
  const name = rawName.trim();
  if (name === "") throw usageError("The organization name must not be empty.");
  // Checked before any request: a malformed key is exit 2, not a round trip to a 422.
  const explicitKey = parseIdempotencyKeyFlag(opts.idempotencyKey);

  // An org key can never do this, and the CLI knows the kind of a stored credential (section 4.5),
  // so it says so before asking anyone to confirm. A bare WAM_TOKEN carries no kind: the server's
  // 403 answers for it, with the same copy.
  const credential = await ctx.requireCredential();
  if (credential.record?.kind === "org") {
    throw new CliError("insufficient_scope", EXIT.AUTH, [
      "This key is bound to one organization, so it cannot list or create organizations.",
      "Sign in again with an account-wide key: wam auth login --account-wide",
    ]);
  }

  const type = await resolveOrgType(ctx, opts.type);
  if (type === null) return;

  // No money wording: this spends nothing. It confirms because nothing here can undo it.
  if (!(await confirmCreate(ctx.confirmDeps(), { what: "an organization on your account" }))) return;

  const key =
    explicitKey ??
    deriveOrgCreateIdempotencyKey({ name, type }, { env: ctx.primitives.env, now: ctx.primitives.now() });

  // Takes no org: the api-client sends no X-Wam-Org on this route. One POST, never retried.
  const client = await ctx.client();
  const created = await call(ctx, COMMAND_CREATE, () => client.organizations.create({ name, type }, key));

  // 200 with X-Idempotent-Replay: the organization of this same run, not a second one (section 7.3).
  if (client.lastResponse?.replayed === true) {
    ctx.out.warn(
      `An organization for this run already exists (${created.slug}). Returning it instead of creating a second one.`,
    );
  }

  if (ctx.out.json) {
    ctx.out.jsonDocument(created);
    return;
  }
  for (const line of organizationCreatedLines(created)) ctx.out.data(line);
}

export function registerOrgCommands(program: Command, getContext: () => Context): void {
  const org = program.command("org").description("List and create organizations");

  org
    .command("list")
    .description("List every organization this key reaches (account-wide keys only)")
    .option("--limit <n>", "Rows per page, 1 to 100 (default 25)")
    .option("--cursor <cursor>", "Continue from the nextCursor of a previous page")
    .addHelpText("after", "\nExample:\n  $ wam org list --limit 50\n")
    .action((opts: ListOptions) => runOrgList(getContext(), opts));

  org
    .command("create <name>")
    .description("Create an organization on your account (account-wide keys with orgs:write only). Spends no credits")
    .option("--type <type>", `Required. One of: ${ORG_TYPES.join(", ")}`)
    .option("--idempotency-key <key>", "Override the derived Idempotency-Key: 1 to 128 characters from A-Z a-z 0-9 _ . : and -")
    .addHelpText(
      "after",
      "\nAn organization cannot be deleted from the CLI or the API, so this asks first. Where the CLI\ncannot ask (CI, a pipe, --json), -y, --yes is required. The new organization is not usable until\na human subscribes at the URL this prints.\n\nExample:\n  $ wam org create \"Acme Labs\" --type brand --yes\n",
    )
    .action((name: string, opts: CreateOptions) => runOrgCreate(getContext(), name, opts));
}
