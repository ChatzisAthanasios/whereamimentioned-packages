# @whereamimentioned/mcp

## 0.1.1

### Patch Changes

- `@whereamimentioned/api-client` gains a README (install, a usage example, the error model and what the client does and does not do), so its npm page is no longer empty. This is also the first release published through the GitHub Actions pipeline with provenance; 0.1.0 was published by hand.

## 0.1.0

### Minor Changes

- d05a373: First public release of the three packages, versioned together.

  - `@whereamimentioned/cli`: the `wam` command line. Seven `wam site` checks that need no account (AI crawler access, llms.txt validation and generation, sitemap generation, structured data, meta descriptions, content chunking), sign-in over a loopback PKCE flow with `--device` and `--token` alternatives, `scan estimate`, `scan run --wait --fail-under`, `scan status`, `scan list`, `scan evidence`, `report get`, organization, workspace, competitor and prompt commands, `mcp url`, `mcp install --client` for the MCP clients it knows, shell completions, a stable `--json` output contract and a documented exit-code table. Sends no telemetry.
  - `@whereamimentioned/mcp`: the stdio bridge that forwards MCP requests to the hosted server at `https://whereamimentioned.com/api/mcp` for clients that cannot add a remote URL. Holds no tool definitions of its own.
  - `@whereamimentioned/api-client`: the typed client and response types for `https://whereamimentioned.com/api/v1`, which the other two packages are built against.
