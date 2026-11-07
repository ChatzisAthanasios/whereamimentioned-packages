# @whereamimentioned/cli

## 0.1.1

### Patch Changes

- 2d7c10e: `wam scan status`, `wam scan watch`, `wam scan evidence` and `wam report get --scan` accept an unambiguous prefix of a scan id, so the 8-character ID column of `wam scan list` pastes back into them. A prefix is resolved client side against the workspace's scan list; a full id is still sent as typed with no lookup. Exactly one match proceeds, none is the not-found error (exit 1) with copy that says a prefix is accepted, several is a usage error (exit 2) listing the candidates. This change was already in the 0.1.0 tarball, which was built after it merged, but 0.1.0's notes did not list it.
- `@whereamimentioned/api-client` gains a README (install, a usage example, the error model and what the client does and does not do), so its npm page is no longer empty. This is also the first release published through the GitHub Actions pipeline with provenance; 0.1.0 was published by hand.
- Updated dependencies
  - @whereamimentioned/api-client@0.1.1

## 0.1.0

### Minor Changes

- d05a373: First public release of the three packages, versioned together.

  - `@whereamimentioned/cli`: the `wam` command line. Seven `wam site` checks that need no account (AI crawler access, llms.txt validation and generation, sitemap generation, structured data, meta descriptions, content chunking), sign-in over a loopback PKCE flow with `--device` and `--token` alternatives, `scan estimate`, `scan run --wait --fail-under`, `scan status`, `scan list`, `scan evidence`, `report get`, organization, workspace, competitor and prompt commands, `mcp url`, `mcp install --client` for the MCP clients it knows, shell completions, a stable `--json` output contract and a documented exit-code table. Sends no telemetry.
  - `@whereamimentioned/mcp`: the stdio bridge that forwards MCP requests to the hosted server at `https://whereamimentioned.com/api/mcp` for clients that cannot add a remote URL. Holds no tool definitions of its own.
  - `@whereamimentioned/api-client`: the typed client and response types for `https://whereamimentioned.com/api/v1`, which the other two packages are built against.

### Patch Changes

- Updated dependencies [d05a373]
  - @whereamimentioned/api-client@0.1.0
