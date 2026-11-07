import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20.19",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  // Line 1 of dist/index.js, so `npx @whereamimentioned/mcp` resolves without --package.
  banner: { js: "#!/usr/bin/env node" },
});
