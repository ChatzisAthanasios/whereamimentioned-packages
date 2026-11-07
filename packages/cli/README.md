# @whereamimentioned/cli

`wam`: track and score your brand's visibility in AI answers, from the terminal and from CI.

whereamimentioned asks AI assistants the questions your buyers ask, checks whether your brand is in
the answers, and scores how often you show up against the competitors that appear instead. The CLI
is the same product from a shell: free site checks that need no account, sign-in, scans and reports,
a gate for CI, and the installer for the MCP server.

Full documentation: https://whereamimentioned.com/docs/cli

## Install

```
npx @whereamimentioned/cli --help
```

Or install it once:

```
npm install -g @whereamimentioned/cli
wam --help
```

Always install or run it by the scoped package name. The unscoped `wam` on npm is an unrelated
package. The binary is `wam`, with `wamctl` as an alias for machines where `wam` is already taken on
the PATH. Requires Node 20.19 or newer.

## Free site checks, no account needed

Seven commands work with no account, no key and no config, from a cold `npx`. They spend no credits.

```
wam site check-crawlers <url>                          which AI crawlers your robots.txt lets in
wam site validate-llms-txt <url>                       score and findings for an existing llms.txt
wam site generate-llms-txt <url> [--full] [-o <file>]  crawl the site and write an llms.txt
wam site generate-sitemap <url> [-o <file>]            crawl the site and write a sitemap.xml
wam site validate-schema <url>                         validate the page's structured data
wam site check-meta <url> [--keyword <keyword>]        check the page's meta description
wam site analyze-chunks <url>                          how the page's content chunks for retrieval
```

```
npx @whereamimentioned/cli site check-crawlers example.com
```

Every URL is fetched by the server, never by the CLI, so the checks see your site from the public
internet and not from inside your network. `generate-llms-txt` and `generate-sitemap` write the
generated file to stdout, so `> llms.txt` works, and put every count and notice on stderr; with `-o`
they write the file and print a summary to stderr. Add `--json` to any of them for the full
structured result.

## Sign in

```
wam auth login
```

The default flow opens your browser at whereamimentioned.com. You pick an organization and approve,
and the key comes back to the CLI over a loopback port on your own machine (a PKCE code exchange, no
client secret, nothing to paste). Two alternatives:

- `wam auth login --device` for SSH sessions, containers, WSL and Codespaces, where no browser can
  reach back to the machine. It prints a URL and a short code; you enter the code in a browser
  anywhere.
- `wam auth login --token` reads a key you already minted in the dashboard, from stdin or a prompt.

By default the key is an organization key, bound to the organization you picked.
`wam auth login --account-wide` mints a key that reaches every organization your account belongs
to; the CLI spells out what that means and asks before the browser opens. An account-wide key gives
you no more permission anywhere, only more places to use it: in each organization it acts at your
own role there.

`wam auth status` (alias `wam whoami`) shows the key, the organization, the credit balance and where
the credential is stored. `wam auth logout` revokes the key on the server, then clears it locally.

**CI never calls `wam auth login`.** It sets `WAM_TOKEN` and nothing else. Mint that key with a
plain `wam auth login` on your own machine or in the dashboard, and keep it an organization key: a
CI secret that reaches every organization you belong to has a blast radius the job never needed.

## Scans, reports and the rest

```
wam scan estimate
wam scan run [--wait] [--yes] [--fail-under <n>] [--timeout <seconds>]
             [--poll <seconds>] [--no-follow] [--idempotency-key <key>]
wam scan status <scanId> [--wait] [--timeout <seconds>] [--poll <seconds>]
wam scan list [--limit <n>] [--cursor <c>] [--status <queued|running|done|failed>]
wam scan evidence <scanId> [--limit <1..100>] [--cursor <c>] [--model <id>]
wam report get [--scan <scanId>] [--format json|csv|pdf] [-o <file>] [--fail-under <n>]
wam org list
wam org create <name> [--type brand|agency] [--yes] [--idempotency-key <key>]
wam workspace list
wam workspace use <org/workspace>
wam workspace create <name> [--yes]
wam competitor list
wam competitor add <name> [--domain <domain>] [--alias <alias>]...
wam prompt list [--enabled true|false] [--source generated|template|custom] [--stage <stage>]
wam prompt add <text> [--stage <awareness|research|comparison|purchase|branded>]
wam prompt enable <id>
wam prompt disable <id>
wam prompt remove <id>
wam config list | get <key> | set <key> <value> | unset <key> | path
wam mcp url [--readonly] [--scope org|workspace|none]
wam mcp install --client <client> [--readonly] [--scope org|workspace|none] [--global] [--print] [--yes]
wam completion bash | zsh | fish | powershell
```

`wam <group> --help` lists the subcommands and every command's help ends with a copy-pasteable
example.

### What spends credits, and what does not

`wam scan run` is the one command that spends credits. It always estimates first and prints the cost
before anything is charged, then asks; the default answer is no. In a non-interactive context (a
pipe, CI, `--json`) it will not prompt: pass `--yes`, or it exits 2 without spending anything. There
is no retry and no automatic rescan anywhere in the CLI. Every scan is started by exactly one
explicit command.

Everything else is free: `scan estimate`, `scan status`, `scan list`, `scan evidence`,
`report get`, `prompt list`, `competitor list`, `org list`, `workspace list` and every `wam site`
command spend zero credits. `wam org create` and `wam workspace create` spend nothing either; they
still ask for confirmation because neither can be undone from the CLI.

### Output

stdout is data, stderr is chatter. `--json` prints a single JSON document on stdout (NDJSON under
`--wait`) and is a stability contract, so `wam report get --json | jq .score` works with no
`2>/dev/null`. Under `--json` an error is itself the data: it goes to stdout as a JSON object, with
the same exit code.

## In CI

```yaml
# .github/workflows/ai-visibility.yml
name: AI visibility

on:
  schedule:
    # Weekly, Monday 07:00 UTC. See the cost note below before making this more frequent.
    - cron: "0 7 * * 1"
  workflow_dispatch:

# Prevents two scheduled runs overlapping. The API would 409 anyway, but this is cheaper.
concurrency:
  group: ai-visibility
  cancel-in-progress: false

jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22

      # Fail early and cheaply if the balance cannot cover a scan. Costs nothing.
      - name: Check the balance
        env:
          WAM_TOKEN: ${{ secrets.WAM_TOKEN }}
          WAM_ORG: acme
          WAM_WORKSPACE: acme-eu
        run: npx --yes @whereamimentioned/cli@0.1 scan estimate --json

      - name: Run the scan
        id: scan
        env:
          WAM_TOKEN: ${{ secrets.WAM_TOKEN }}
          WAM_ORG: acme
          WAM_WORKSPACE: acme-eu
        run: |
          npx --yes @whereamimentioned/cli@0.1 scan run \
            --wait --yes \
            --fail-under 55 \
            --timeout 2400 \
            --json | tee scan.ndjson
          tail -n 1 scan.ndjson > scan-result.json

      - name: Fetch the full report
        if: always() && steps.scan.outcome != 'skipped'
        env:
          WAM_TOKEN: ${{ secrets.WAM_TOKEN }}
          WAM_ORG: acme
          WAM_WORKSPACE: acme-eu
        run: npx --yes @whereamimentioned/cli@0.1 report get --json -o report.json

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ai-visibility
          path: |
            scan.ndjson
            report.json
```

What that workflow does on purpose:

- `WAM_TOKEN` is an organization key, not an account-wide one. Nothing on the server can enforce
  that; it is a rule for whoever mints the secret.
- `@0.1` pins the minor. While the package is `0.x`, a breaking change to the output lands in the
  minor, so `@0` would protect nothing. Move the pins to `@1` on the day `1.0.0` ships.
- `--yes` is mandatory. Without it, `scan run` refuses in a non-interactive context and exits 2, so
  no workflow spends credits by accident.
- The estimate step runs first and exits 4 when the balance is short, before anything is charged.
- `--timeout 2400` is below the job's `timeout-minutes`. On timeout the CLI exits 1 with the scan id
  and the scan keeps running server side, so the next run can still read the report.
- `--fail-under 55` is an example threshold. Put yours on the flag or in `wam.json` as `failUnder`.
  It compares the AI visibility score and exits 7 when the score is below it.
- A retried step does not start a second scan. The idempotency key is derived from the organization,
  the workspace, the date and the CI run id, so a re-run follows the scan that already exists.

## Exit codes

Nothing above 125 is used, because the shell reserves 126, 127 and 128 and above.

| Code | Meaning | Typical cause |
|---|---|---|
| 0 | Success | |
| 1 | Generic failure | Unexpected server 500, unhandled condition |
| 2 | Usage error | Unknown flag, missing argument, bad value, no workspace resolved, no org resolved on an account-wide key |
| 3 | Auth required or expired | No credential, a credential the server no longer accepts (revoked or expired), insufficient scope, insufficient role, tier gate |
| 4 | Insufficient credits | HTTP 402 from the scan-create route |
| 5 | Rate limited | HTTP 429 |
| 6 | Scan failed | The scan reached `status: "failed"` while being followed |
| 7 | Threshold not met | `--fail-under` was set and the score was below it |
| 8 | Scan already running | A 409 `scan_already_running` and `--no-follow` was passed |
| 9 | Conflict | The server rejected the request as conflicting (409 `conflict`): the priced terms moved, or an `Idempotency-Key` was reused with different terms |
| 10 | Ceiling reached | A 409 `conflict` at a limit that waiting does not clear: the plan's workspace cap, or the 25 organizations one account may own |
| 11 | No paid organization | A 403 `feature_not_available` from `wam org create`, because the account owns no organization on a paid plan |

## Telemetry

This CLI sends no telemetry. It transmits nothing beyond the API calls needed to serve the command
you ran: no usage pings, no crash reporting, no anonymous metrics, no first-run beacon. The one other
network request is the update check against the npm registry, at most once a day, on stderr and never
blocking; it is off under `--json`, `--quiet`, in a pipe, when `CI` is set, or when
`WAM_NO_UPDATE_NOTIFIER` is set. The CLI never self-updates.

## Credential storage

Keys are stored in the operating system's credential store, one entry per profile (the default
profile is `default`): the macOS Keychain, the Windows Credential Manager, or Secret Service (GNOME
Keyring, KWallet) on Linux, under the service name `whereamimentioned`. A profile holds one
credential, so you can keep one key per organization and switch with `--profile`, or hold one
account-wide key and switch organizations with `--org`. Both patterns work.

Where the credential store is not available (headless Linux, containers, no D-Bus session), the CLI
falls back to a file: `${XDG_CONFIG_HOME:-~/.config}/whereamimentioned/credentials.json` on Linux and
macOS, `%APPDATA%\whereamimentioned\credentials.json` on Windows. On Linux and macOS the file is
written with mode `0600` inside a `0700` directory, and if it is later found with looser permissions
the CLI refuses to read it and prints the `chmod` that fixes it. `wam auth status` always says which
of the two backends is in use, because a silently failing keyring is the usual reason for "why does
it keep asking me to log in". The CLI never prints the token, not under `--debug` and not in an error.

## Configuration

Precedence, highest first: the command-line flag (`--org`, `--workspace`, `--api-url`,
`--profile`), the environment variable, the nearest `wam.json` found by walking up from the current
directory, the user config (`${XDG_CONFIG_HOME:-~/.config}/whereamimentioned/config.json`, or
`%APPDATA%\whereamimentioned\config.json` on Windows), then the built-in default. `wam config list`
prints the winning source for each key.

A committed `wam.json` pins the organization and workspace for a repo, so every checkout and every CI
run agree:

```json
{
  "$schema": "https://whereamimentioned.com/schema/wam.config.json",
  "org": "acme",
  "workspace": "acme-eu",
  "failUnder": 55
}
```

An unknown key in that file is a usage error (exit 2), not a silent ignore, and it has no field for a
token: a token in `wam.json` is a parse error. It cannot set `apiUrl` either: a committed file must
not get to decide where your key is sent, so set the server with `WAM_API_URL`, `--api-url` or
`wam config set apiUrl` instead, and an `apiUrl` in `wam.json` is refused with exit 2. `wam config set`
writes to the user config only, never to the project file.

## Environment variables

| Variable | Meaning |
|---|---|
| `WAM_TOKEN` | The API key. Highest-precedence credential source. |
| `WAM_API_URL` | API origin override. Default `https://whereamimentioned.com`. |
| `WAM_ORG` | Org slug override. |
| `WAM_WORKSPACE` | Workspace slug override. |
| `WAM_PROFILE` | Credential and config profile name. Default `default`. |
| `WAM_CONFIG_DIR` | Override the user config and credential directory wholesale. |
| `WAM_NO_UPDATE_NOTIFIER` | Any non-empty value disables the update check. |
| `WAM_MCP_URL` | Only read by `wam mcp url` / `wam mcp install`, for staging. |
| `NO_COLOR` | Standard. Presence disables colour regardless of value. |
| `CI` | Standard. Presence implies `--non-interactive`. |

Credential precedence: the `--token` flag, then `WAM_TOKEN`, then the credential store or file for
the active profile. Prefer `WAM_TOKEN` over `--token`: arguments leak into shell history and process
listings.

## Installing the MCP server

The CLI is the installer for the whereamimentioned MCP server, because no single config snippet works
everywhere: the top-level key and the transport name differ per client.

```
wam mcp install --client cursor
```

`--client` accepts `claude-code`, `cursor`, `vscode`, `windsurf`, `zed`, `warp`, `opencode`, `amp`
and `jetbrains`. The command merges the `whereamimentioned` entry into the client's existing config
and writes a backup next to it first. A project-scoped file never receives the raw token: it gets
`${WAM_TOKEN}` and a reminder to export it. Only `--global` writes the literal token, and only after
you confirm. `--print` writes the snippet to stdout and touches nothing. `wam mcp url` prints the
endpoint URL for the current organization and workspace, and nothing else, so it composes.

The server itself is documented at https://whereamimentioned.com/docs/mcp.
