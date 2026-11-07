import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The vitest config of the public packages mirror (10-CLI section 10.2). Authored in the private
 * repo at docs/mirror/vitest.config.mts and copied to the mirror root by the sync. It runs the
 * three packages' own test files and nothing else: the app's suites are a gate on the tag in the
 * private repo, and packages/cli/src/e2e.test.ts skips itself when app/ is absent.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/*/dist/**"],
  },
  resolve: {
    alias: {
      // The contract package resolves from source, so no dist build is needed to run tests.
      "@whereamimentioned/api-client": path.resolve(process.cwd(), "packages/api-client/src/index.ts"),
    },
  },
});
