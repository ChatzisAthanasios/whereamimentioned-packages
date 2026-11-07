/**
 * The package version, as a build-time constant.
 *
 * The import below is resolved by tsup (esbuild) at build time and inlined into dist/index.js,
 * so the published binary carries the version of the package.json it was built from and reads no
 * file at startup. tsup.config.ts is fixed by 10-CLI section 2.3 and has no `define` block, which
 * is why the constant comes from this module rather than from a compile-time define.
 */
import { version } from "../package.json";

export const VERSION: string = version;
