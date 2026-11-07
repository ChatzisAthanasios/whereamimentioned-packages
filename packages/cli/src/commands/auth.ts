/**
 * `wam auth` (10-CLI section 3.2): login (loopback | device | token), logout, status.
 *
 * This module ships `status` and its top-level alias `wam whoami` (checkpoint 4). `login` and
 * `logout` (checkpoint 6) are registered on the same group, at the marked place in
 * `registerAuthCommands`.
 *
 * `status` prints what three endpoints said and nothing it worked out for itself:
 *  - the key kind is `key.kind` from GET /api/v1/me, never a reading of the token prefix;
 *  - the "about N scans" figure is `estimatedScansRemaining` from GET /api/v1/credits, verbatim;
 *  - the reach table is GET /api/v1/organizations, called on an account-wide key only.
 * It never prints the token beyond prefix...last4, and it never invents an email address, a
 * last-used time or a "last used in" organization, because no endpoint serves them.
 */
import type { Command } from "commander";
import {
  ApiError,
  type Credits,
  type Me,
  type OrganizationSummary,
  type Page,
  type WamClient,
} from "@whereamimentioned/api-client";
import type { Context } from "../context";
import { storageLabel, type ResolvedCredential } from "../credentials";
import { formatTable } from "../output";
import { registerAuthLoginCommands } from "./auth-login";
import { ORGANIZATION_COLUMNS, freeFloorSlugs, organizationRows } from "./org";
import { call, formatDate, joinNames, labelled, plural } from "./support";

const COMMAND = "auth status";
const LABEL_WIDTH = 15;
const VALUE_INDENT = " ".repeat(2 + LABEL_WIDTH);
const SCOPES_WRAP = 72;
const DAY_MS = 86_400_000;

interface StatusData {
  me: Me | null;
  credits: Credits | null;
  /** Present on an account-wide key only. Null means "not applicable", never "none". */
  organizations: Page<OrganizationSummary> | null;
}

/** The 403 an org key gets from GET /api/v1/organizations: `details.requiredKind` is "user". */
function isOrgKeyRefusal(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.code === "insufficient_scope" &&
    err.details?.requiredKind === "user"
  );
}

/**
 * Which endpoints to call, in which order (section 3.2).
 *
 * On an account-wide key, GET /api/v1/me requires `X-Wam-Org`. So with no org resolved the CLI
 * never sends it: it lists the organizations instead and prints the reach table on its own. When
 * the kind is not known locally (a bare WAM_TOKEN), GET /api/v1/organizations is the
 * discriminator: a 200 proves an account-wide key, and the 403 an org key gets proves the other.
 */
async function gather(ctx: Context, client: WamClient, cred: ResolvedCredential): Promise<StatusData> {
  const orgResolved = ctx.config().org.value !== null;
  const storedKind = cred.record?.kind ?? null;

  if (!orgResolved && storedKind !== "org") {
    try {
      const organizations = await client.organizations.list();
      return { me: null, credits: null, organizations };
    } catch (err) {
      // Only an unknown kind may turn out to be an org key. A stored account-wide key that is
      // refused here is an error like any other.
      if (storedKind === "user" || !isOrgKeyRefusal(err)) throw ctx.mapError(err, COMMAND);
    }
  }

  const me = await call(ctx, COMMAND, () => client.me());
  const credits = await call(ctx, COMMAND, () => client.credits());
  const organizations =
    me.key.kind === "user" ? await call(ctx, COMMAND, () => client.organizations.list()) : null;
  return { me, credits, organizations };
}

function localStorage(cred: ResolvedCredential): string {
  if (cred.source === "WAM_TOKEN") return "env";
  if (cred.source === "--token") return "flag";
  return cred.source;
}

function credentialLabel(ctx: Context, cred: ResolvedCredential): string {
  if (cred.source === "WAM_TOKEN") return "WAM_TOKEN environment variable";
  if (cred.source === "--token") return "--token flag";
  return storageLabel(cred.source, ctx.primitives.platform);
}

function expiresText(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return "never";
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return expiresAt;
  const days = Math.floor((at - now.getTime()) / DAY_MS);
  if (at <= now.getTime()) return `${formatDate(expiresAt)}  (expired)`;
  return `${formatDate(expiresAt)}  (${days} ${plural(days, "day", "days")})`;
}

function wrapList(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item},` : item;
    if (current !== "" && current.length + 1 + piece.length > width) {
      lines.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current} ${piece}`;
    }
  });
  if (current !== "") lines.push(current);
  return lines;
}

function defaultText(ctx: Context): string {
  const { org, workspace } = ctx.config();
  if (org.value === null && workspace.value === null) return "(none set)";
  if (org.value !== null && workspace.value !== null) {
    const from =
      org.source === workspace.source
        ? `(from ${org.source})`
        : `(org from ${org.source}, workspace from ${workspace.source})`;
    return `${org.value}/${workspace.value}   ${from}`;
  }
  if (org.value !== null) return `${org.value}   (org from ${org.source}, no workspace set)`;
  return `${workspace.value}   (workspace from ${workspace.source}, no org set)`;
}

function reachLines(page: Page<OrganizationSummary>): string[] {
  const table = formatTable(organizationRows(page.data), ORGANIZATION_COLUMNS, { indent: VALUE_INDENT });
  const lines = table.split("\n");
  lines[0] = `  ${"Reaches".padEnd(LABEL_WIDTH)}${lines[0]!.slice(VALUE_INDENT.length)}`;
  const out = ["", ...lines];
  const free = freeFloorSlugs(page.data);
  if (free.length > 0) {
    out.push(
      "",
      free.length === 1
        ? `  ${free[0]} is on the free floor, so it cannot run scans until someone subscribes.`
        : `  ${joinNames(free)} are on the free floor, so they cannot run scans until someone subscribes.`,
    );
  }
  if (page.pagination.nextCursor !== null) {
    out.push("", `  More organizations: wam org list --cursor ${page.pagination.nextCursor}`);
  }
  return out;
}

function reachCount(page: Page<OrganizationSummary>): string {
  const n = page.data.length;
  return `${n}${page.pagination.hasMore ? "+" : ""} ${plural(n, "organization", "organizations")}`;
}

function render(ctx: Context, cred: ResolvedCredential, data: StatusData): void {
  const { me, credits, organizations } = data;
  const config = ctx.config();
  const now = ctx.primitives.now();
  const lines: string[] = [];

  let host = config.apiUrl.value;
  try {
    host = new URL(config.apiUrl.value).host;
  } catch {
    // Already validated by config.ts; print it as given if it somehow does not parse.
  }
  lines.push(`Signed in to ${host}`, "");

  if (me) {
    lines.push(
      labelled(
        "Key kind",
        me.key.kind === "user"
          ? `Account-wide key, reaches ${organizations ? reachCount(organizations) : "several organizations"}`
          : `Organization key, bound to ${me.org.slug}`,
      ),
    );
    const resolvedNote = me.key.kind === "user" ? `   (resolved for this command, from ${config.org.source})` : "";
    lines.push(labelled("Organization", `${me.org.name} (${me.org.slug})${resolvedNote}`));
    lines.push(
      labelled(
        "Role",
        me.actor.role === me.actor.effectiveRole
          ? me.actor.role
          : `${me.actor.role}, capped to ${me.actor.effectiveRole} by this key`,
      ),
    );
    lines.push(labelled("Plan", me.plan.label));
    if (credits) {
      lines.push(
        labelled(
          "Credits",
          `${credits.balance}   (about ${credits.estimatedScansRemaining} ${plural(credits.estimatedScansRemaining, "scan", "scans")} at the maximum scan size for this tier)`,
        ),
      );
    }
    // The server's display columns, never a slice of the token held locally.
    lines.push(labelled("Key", `${me.key.prefix}...${me.key.last4}  "${me.key.name}"`));
    const scopeLines = wrapList(me.key.scopes, SCOPES_WRAP);
    lines.push(labelled("Scopes", scopeLines[0] ?? "(none)"));
    for (const extra of scopeLines.slice(1)) lines.push(`${VALUE_INDENT}${extra}`);
    lines.push(labelled("Expires", expiresText(me.key.expiresAt, now)));
  } else {
    // An account-wide key with no organization resolved: the four resolved-org rows are skipped
    // and GET /api/v1/me was never sent.
    lines.push(
      labelled("Key kind", `Account-wide key, reaches ${organizations ? reachCount(organizations) : "several organizations"}`),
    );
    lines.push(labelled("Key", cred.display));
    if (cred.record) lines.push(labelled("Expires", expiresText(cred.record.expiresAt, now)));
  }

  lines.push(labelled("Credential", credentialLabel(ctx, cred)));
  lines.push(labelled("Default", defaultText(ctx)));
  if (organizations) lines.push(...reachLines(organizations));
  if (!me) {
    lines.push(
      "",
      "  No organization is selected, so the organization, role, plan and credits are not shown.",
      "  Pass --org <slug> to see them for one of the organizations above.",
    );
  }

  for (const line of lines) ctx.out.data(line);
}

function renderJson(ctx: Context, cred: ResolvedCredential, data: StatusData): void {
  const config = ctx.config();
  const doc: Record<string, unknown> = {};
  if (data.me) {
    // Each body under the endpoint that produced it. /me's own `credits` is superseded by the
    // whole GET /api/v1/credits body below.
    doc.key = data.me.key;
    doc.org = data.me.org;
    doc.actor = data.me.actor;
    doc.plan = data.me.plan;
  }
  if (data.credits) doc.credits = data.credits;
  // Present on an account-wide key ONLY. Absent on an org key, never an empty array standing in
  // for "not applicable".
  if (data.organizations) doc.organizations = data.organizations.data;
  doc.local = {
    storage: localStorage(cred),
    profile: config.profile.value,
    org: config.org.value,
    workspace: config.workspace.value,
    configSources: config.consulted.filter((s) => s.exists).map((s) => s.display),
  };
  ctx.out.jsonDocument(doc);
}

export async function runAuthStatus(ctx: Context): Promise<void> {
  const cred = await ctx.requireCredential();
  const client = await ctx.client();
  const data = await gather(ctx, client, cred);
  if (ctx.out.json) renderJson(ctx, cred, data);
  else render(ctx, cred, data);
}

export function registerAuthCommands(program: Command, getContext: () => Context): void {
  const auth = program.command("auth").description("Sign in to whereamimentioned, sign out, or show who you are");

  // --- Checkpoint 6 (sign-in): `auth login` and `auth logout`, from ./auth-login. -----------------
  registerAuthLoginCommands(auth, getContext);

  auth
    .command("status")
    .description("Show the key, organization, plan and credits this CLI is using. Never prints the token")
    .addHelpText("after", "\nExample:\n  $ wam auth status --org acme\n")
    .action(() => runAuthStatus(getContext()));

  program
    .command("whoami")
    .description("Alias of wam auth status")
    .addHelpText("after", "\nExample:\n  $ wam whoami --json\n")
    .action(() => runAuthStatus(getContext()));
}
