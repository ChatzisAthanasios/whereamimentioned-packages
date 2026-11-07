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
  banner: { js: "#!/usr/bin/env node" },
  // Native binding. Bundling it would break the platform-specific .node resolution.
  external: ["@napi-rs/keyring"],
});
