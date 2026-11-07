# @whereamimentioned/api-client

The typed client and response types for the whereamimentioned public API at
`https://whereamimentioned.com/api/v1`, and for the free site tools at `/api/site`. The `wam` command
line (`@whereamimentioned/cli`) and the MCP bridge (`@whereamimentioned/mcp`) are built on it. It is
published on its own for scripts and integrations that want the API without the CLI.

whereamimentioned asks AI assistants the questions your buyers ask, checks whether your brand is in
the answers, and scores how often you show up against the competitors that appear instead.

Documentation: https://whereamimentioned.com/docs

## Install

```
npm install @whereamimentioned/api-client
```

Node 20.19 or newer. ESM only.

## Use

```ts
import { createWamClient } from "@whereamimentioned/api-client";

const wam = createWamClient({
  baseUrl: "https://whereamimentioned.com",
  token: process.env.WAM_TOKEN, // an API key; leave it out for the free site tools
  org: "acme", // your organization slug, sent on every org-scoped call
  userAgent: "my-integration/1.0",
});

// The key, the organization it belongs to, and the plan.
const me = await wam.me();

// Scans and reports live in a workspace, addressed by its slug.
const scans = await wam.scans.list("acme-main");
const latest = scans.data[0];
if (latest) {
  const report = await wam.scans.report(latest.id, "json");
}

// The site tools need no key.
const access = await wam.site.checkCrawlers("https://example.com");
```

API keys come from your organization's settings in the dashboard (Settings > API keys). The API and
the CLI are included on every paid plan. The site tools need no account.

## Errors

Every non-2xx response, and any 2xx whose body is not JSON, is thrown as an `ApiError` with the
status, the API's error code, the request id for support, and `retryAfterSeconds` when the server
sent one. A request that exceeds the timeout throws `ApiTimeoutError`.

```ts
import { ApiError } from "@whereamimentioned/api-client";

try {
  await wam.scans.estimate("acme-main");
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.status, err.code, err.requestId);
  }
}
```

## What it does, and nothing more

- Sends the bearer token and the API version header on every `/api/v1` call, and the organization
  header on the calls that are scoped to one.
- Sends an idempotency key on the two routes that require it (creating a scan, creating an
  organization), and you supply that key.
- Retries idempotent GETs only, at most twice, on 502, 503, 504 and network failures. A POST is
  never retried. A 429 is never retried: `retryAfterSeconds` tells you when.
- Aborts any request after `timeoutMs` (default 30 seconds).
- Exposes the last response's status and headers as `lastResponse`, including whether a create was
  an idempotent replay.

It does not validate response bodies at runtime. The types are the wire contract, and the server
is tested against the same schemas.
