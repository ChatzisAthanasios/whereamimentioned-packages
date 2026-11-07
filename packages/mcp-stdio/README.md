# @whereamimentioned/mcp

`wam-mcp`: a stdio bridge to the hosted whereamimentioned MCP server, for MCP clients that cannot
add a remote URL or that still speak a 2025-era protocol revision.

```
npx @whereamimentioned/mcp --help
npx @whereamimentioned/mcp --version
```

It is a dumb proxy. Every JSON-RPC frame read from stdin is POSTed to the hosted endpoint and every
response frame is written to stdout, one per line. It holds no tool definitions, no schemas and no
business logic, so the tools it lists are exactly the tools the remote server lists. It never
fetches anything except the endpoint.

The one thing it understands is the protocol revision. The hosted endpoint speaks 2026-07-28 only,
which has no initialize handshake and carries a per-request envelope. A client on a 2025-era
revision gets its `initialize` answered by the bridge from the endpoint's `server/discover`, its
`notifications/initialized` dropped, and the envelope added to every later frame. A client that
already speaks 2026-07-28 has its frames forwarded untouched.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WAM_TOKEN` | (none) | API key. Without it the bridge still runs and only the anonymous site tools appear. |
| `WAM_MCP_URL` | `https://whereamimentioned.com/api/mcp` | Endpoint override, for staging. |
| `WAM_ORG` | (none) | Appended as a URL path segment. Pins the org and the tool list. |
| `WAM_WORKSPACE` | (none) | Appended after `WAM_ORG`. Pins the workspace. |
| `WAM_READONLY` | (unset) | If `1`, appends the `/readonly` path suffix, which drops every write tool. |

Install snippets for each client are at https://whereamimentioned.com/docs/mcp.

## Requirements

Node 20.19 or newer.
