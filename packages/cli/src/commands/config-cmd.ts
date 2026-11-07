/**
 * `wam config` (10-CLI section 3.3): list, get, set, unset, path.
 *
 * `set` and `unset` write only the user config, never a committed `wam.json`. `list` prints the
 * winning source for each key. Settable keys are `org`, `workspace`, `apiUrl` and `failUnder`;
 * anything else is exit 2.
 */
import type { Command } from "commander";
import {
  CONFIG_KEYS,
  displayPath,
  isConfigKey,
  parseConfigValue,
  setUserConfigValue,
  unsetUserConfigValue,
  type ResolvedConfig,
} from "../config";
import type { Context } from "../context";
import { usageError } from "../errors";

const READABLE_KEYS = [...CONFIG_KEYS, "profile"] as const;
type ReadableKey = (typeof READABLE_KEYS)[number];

function isReadableKey(key: string): key is ReadableKey {
  return (READABLE_KEYS as readonly string[]).includes(key);
}

function unknownReadableKey(key: string) {
  return usageError(`Unknown config key "${key}".`, `Valid keys are: ${READABLE_KEYS.join(", ")}.`);
}

function unknownSettableKey(key: string) {
  return usageError(`"${key}" is not a settable config key.`, `Settable keys are: ${CONFIG_KEYS.join(", ")}.`);
}

function entries(config: ResolvedConfig): Array<{ key: ReadableKey; value: string | number | null; source: string }> {
  return [
    { key: "org", value: config.org.value, source: config.org.source },
    { key: "workspace", value: config.workspace.value, source: config.workspace.source },
    { key: "apiUrl", value: config.apiUrl.value, source: config.apiUrl.source },
    { key: "failUnder", value: config.failUnder.value, source: config.failUnder.source },
    { key: "profile", value: config.profile.value, source: config.profile.source },
  ];
}

export function registerConfigCommands(program: Command, getContext: () => Context): void {
  const config = program
    .command("config")
    .description("Read and write the CLI configuration")
    .addHelpText(
      "after",
      `
Settable keys: ${CONFIG_KEYS.join(", ")}. Values are written to the user config, never to wam.json.

Examples:
  $ wam config list
  $ wam config set org acme
`,
    );

  config
    .command("list")
    .description("Print the resolved config and where each value came from")
    .addHelpText("after", "\nExample:\n  $ wam config list\n")
    .action(() => {
      const ctx = getContext();
      const resolved = ctx.config();
      const rows = entries(resolved);
      if (ctx.out.json) {
        const doc: Record<string, unknown> = {};
        for (const row of rows) doc[row.key] = { value: row.value, source: row.source };
        ctx.out.jsonDocument(doc);
        return;
      }
      ctx.out.table(
        rows.map((row) => ({ key: row.key, value: row.value ?? "(not set)", source: row.source })),
        [
          { key: "key", header: "KEY", align: "left" },
          { key: "value", header: "VALUE", align: "left" },
          { key: "source", header: "SOURCE", align: "left" },
        ],
        { header: false },
      );
    });

  config
    .command("get <key>")
    .description("Print one resolved value, raw, with no formatting")
    .addHelpText("after", "\nExample:\n  $ wam config get workspace\n")
    .action((key: string) => {
      const ctx = getContext();
      if (!isReadableKey(key)) throw unknownReadableKey(key);
      const row = entries(ctx.config()).find((r) => r.key === key)!;
      if (ctx.out.json) {
        ctx.out.jsonDocument({ key: row.key, value: row.value, source: row.source });
        return;
      }
      if (row.value !== null) ctx.out.data(String(row.value));
    });

  config
    .command("set <key> <value>")
    .description("Write a value to the user config (never to wam.json)")
    .addHelpText("after", "\nExample:\n  $ wam config set org acme\n")
    .action((key: string, value: string) => {
      const ctx = getContext();
      if (!isConfigKey(key)) throw unknownSettableKey(key);
      const parsed = parseConfigValue(key, value);
      const profile = ctx.config().profile.value;
      const { path } = setUserConfigValue(ctx.configEnvironment(), profile, key, parsed);
      const display = displayPath(path, ctx.configEnvironment());
      if (ctx.out.json) {
        ctx.out.jsonDocument({ ok: true, key, value: parsed, profile, path });
        return;
      }
      ctx.out.chatter(`Set ${key} to ${parsed} in ${display} (profile ${profile}).`);
    });

  config
    .command("unset <key>")
    .description("Remove a value from the user config")
    .addHelpText("after", "\nExample:\n  $ wam config unset failUnder\n")
    .action((key: string) => {
      const ctx = getContext();
      if (!isConfigKey(key)) throw unknownSettableKey(key);
      const profile = ctx.config().profile.value;
      const { path, removed } = unsetUserConfigValue(ctx.configEnvironment(), profile, key);
      const display = displayPath(path, ctx.configEnvironment());
      if (ctx.out.json) {
        ctx.out.jsonDocument({ ok: true, key, removed, profile, path });
        return;
      }
      ctx.out.chatter(removed ? `Unset ${key} in ${display} (profile ${profile}).` : `${key} was not set in ${display}.`);
    });

  config
    .command("path")
    .description("Print the config files that were consulted, in precedence order")
    .addHelpText("after", "\nExample:\n  $ wam config path\n")
    .action(() => {
      const ctx = getContext();
      const resolved = ctx.config();
      if (ctx.out.json) {
        ctx.out.jsonDocument({
          project: resolved.projectConfigPath,
          user: resolved.userConfigPath,
          consulted: resolved.consulted.map((s) => ({ kind: s.kind, path: s.path, exists: s.exists })),
        });
        return;
      }
      for (const source of resolved.consulted) {
        if (source.kind === "project" && !source.exists) continue;
        ctx.out.data(source.path);
      }
    });
}
