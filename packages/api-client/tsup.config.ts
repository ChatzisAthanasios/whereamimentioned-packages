import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20.19",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  // Everything the contract needs lives inside this package (enums.ts, report-data.ts), so the
  // declarations bundle without resolving anything outside src/. zod stays external.
  dts: true,
});
