/**
 * `wam auth login --token` with no value reads the key from stdin (10-CLI section 3.2), while the
 * global `--token <token>` of section 3.0 lives on the program and would otherwise reject a bare
 * `--token` or swallow the next flag as its value. These pin the one rewrite that reconciles the
 * two, and that it applies to `auth login` and to nothing else.
 */
import { describe, expect, it } from "vitest";
import { main, normalizeBareLoginToken, preparseGlobalFlags } from "./index";
import { fakePrimitives, fakeStream } from "./test-support";

describe("normalizeBareLoginToken", () => {
  it("rewrites a trailing bare --token on auth login", () => {
    expect(normalizeBareLoginToken(["auth", "login", "--token"])).toEqual(["auth", "login", "--token="]);
  });

  it("rewrites a bare --token that is followed by another flag, so the flag is not taken as the key", () => {
    expect(normalizeBareLoginToken(["auth", "login", "--token", "--profile", "work"])).toEqual([
      "auth",
      "login",
      "--token=",
      "--profile",
      "work",
    ]);
  });

  it("leaves a --token that carries a value alone", () => {
    const argv = ["auth", "login", "--token", "wam_test_abc"];
    expect(normalizeBareLoginToken(argv)).toEqual(argv);
    expect(normalizeBareLoginToken(["auth", "login", "--token=wam_test_abc"])).toEqual(["auth", "login", "--token=wam_test_abc"]);
  });

  it("tolerates global flags before the command path", () => {
    expect(normalizeBareLoginToken(["--json", "auth", "login", "--token"])).toEqual(["--json", "auth", "login", "--token="]);
  });

  it("touches no other command: a bare --token there stays a missing-argument usage error", () => {
    for (const argv of [["scan", "list", "--token"], ["auth", "status", "--token"], ["auth", "logout", "--token"]]) {
      expect(normalizeBareLoginToken(argv)).toEqual(argv);
    }
  });
});

describe("the global credential override after the rewrite", () => {
  it("an empty --token= is no override: the credential still comes from WAM_TOKEN or the store", () => {
    const pre = preparseGlobalFlags(normalizeBareLoginToken(["auth", "login", "--token", "--profile", "work"]));
    expect(pre.flags.token).toBeUndefined();
    expect(pre.flags.profile).toBe("work");
    expect(pre.operands).toEqual(["auth", "login"]);
  });

  it("a bare --token on another command is still exit 2", async () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await main(["scan", "list", "--token"], fakePrimitives({ stdout, stderr }));
    expect(code).toBe(2);
    expect(stdout.text).toBe("");
  });
});

describe("auth login and logout are registered on the auth group", () => {
  it("wam auth --help lists login, logout and status", async () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await main(["auth", "--help"], fakePrimitives({ stdout, stderr }));
    expect(code).toBe(0);
    const help = stdout.text + stderr.text;
    for (const name of ["login", "logout", "status"]) expect(help).toContain(name);
  });

  it("orgs:write without --account-wide is refused locally with exit 2", async () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await main(["auth", "login", "--scopes", "orgs:write"], fakePrimitives({ stdout, stderr }));
    expect(code).toBe(2);
    expect(stderr.text).toContain("--account-wide");
  });
});
