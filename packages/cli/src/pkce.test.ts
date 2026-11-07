/**
 * The PKCE values of `wam auth login` (10-CLI section 4.2 step 1, and the auth row of section 14).
 *
 * The server recomputes the challenge in app/api/cli/_lib/cli-auth.ts as
 * `createHash("sha256").update(verifier, "utf8").digest("base64url")` and validates the three
 * values against the patterns repeated below. This file stays inside packages/cli on purpose (the
 * package is mirrored without the app), so the server's expression and patterns are restated here
 * rather than imported.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PKCE_METHOD, codeChallengeFor, createPkcePair, createState, randomBase64Url, stateMatches } from "./pkce";

/** app/api/cli/_lib/cli-auth.ts: BASE64URL_32_RE, CODE_VERIFIER_RE and STATE_RE. */
const SERVER_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const SERVER_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const SERVER_STATE_RE = /^[\x21-\x7e]{1,512}$/;

function serverChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("codeChallengeFor", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is the same S256 the token route recomputes, for any verifier this CLI can produce", () => {
    for (let i = 0; i < 25; i++) {
      const pair = createPkcePair();
      expect(pair.challenge).toBe(serverChallengeFor(pair.verifier));
    }
  });
});

describe("createPkcePair and createState", () => {
  it("produces a verifier, a challenge and a state the server's patterns accept", () => {
    const pair = createPkcePair();
    expect(pair.method).toBe("S256");
    expect(PKCE_METHOD).toBe("S256");
    expect(pair.verifier).toMatch(SERVER_VERIFIER_RE);
    expect(pair.verifier).toHaveLength(43);
    expect(pair.challenge).toMatch(SERVER_CHALLENGE_RE);
    const state = createState();
    expect(state).toMatch(SERVER_STATE_RE);
    expect(state).toHaveLength(43);
  });

  it("asks the random source for 32 bytes each time, and encodes them as base64url", () => {
    const sizes: number[] = [];
    const bytes = Buffer.alloc(32, 0xfb);
    const random = (size: number) => {
      sizes.push(size);
      return bytes;
    };
    const pair = createPkcePair(random);
    const state = createState(random);
    expect(sizes).toEqual([32, 32]);
    expect(pair.verifier).toBe(bytes.toString("base64url"));
    expect(state).toBe(bytes.toString("base64url"));
    // 0xfb bytes encode to `-` and `_` in base64url, where plain base64 would give `+` and `/`.
    expect(pair.verifier).not.toMatch(/[+/=]/);
    expect(randomBase64Url(random)).toBe(pair.verifier);
  });

  it("never repeats a verifier or a state", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(createPkcePair().verifier);
      seen.add(createState());
    }
    expect(seen.size).toBe(100);
  });
});

describe("stateMatches", () => {
  it("accepts the exact state and nothing else", () => {
    const state = createState();
    expect(stateMatches(state, state)).toBe(true);
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, state.slice(0, -1))).toBe(false);
    expect(stateMatches(state, state.toUpperCase() === state ? state.toLowerCase() : state.toUpperCase())).toBe(false);
    expect(stateMatches(state, "")).toBe(false);
    expect(stateMatches(state, null)).toBe(false);
    expect(stateMatches(state, undefined)).toBe(false);
  });
});
