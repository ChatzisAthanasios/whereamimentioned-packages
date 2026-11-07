/**
 * The PKCE values of the loopback sign-in (10-CLI section 4.2 step 1).
 *
 * `code_verifier` is base64url of 32 random bytes from `node:crypto`, `code_challenge` is
 * base64url(sha256(verifier)) (RFC 7636 S256, the only method the server accepts), and `state` is
 * base64url of another 32 random bytes. base64url of 32 bytes is 43 characters of
 * `A-Z a-z 0-9 - _`, which is exactly what the server's verifier, challenge and state patterns
 * accept (app/api/cli/_lib/cli-auth.ts).
 *
 * The verifier never leaves this process except in the body of POST /api/cli/token, and it is
 * never printed. The challenge and the state travel on the authorize URL by design.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PKCE_METHOD = "S256";
const RANDOM_BYTES = 32;

export type RandomSource = (size: number) => Buffer;

/** base64url(sha256(verifier)), the same expression the token route recomputes. */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function randomBase64Url(random: RandomSource = randomBytes): string {
  return random(RANDOM_BYTES).toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: typeof PKCE_METHOD;
}

export function createPkcePair(random: RandomSource = randomBytes): PkcePair {
  const verifier = randomBase64Url(random);
  return { verifier, challenge: codeChallengeFor(verifier), method: PKCE_METHOD };
}

/** The 32-byte `state` the callback must echo back unchanged. */
export function createState(random: RandomSource = randomBytes): string {
  return randomBase64Url(random);
}

/** Constant-time comparison of the state the browser brought back. A length mismatch is a mismatch. */
export function stateMatches(expected: string, presented: string | null | undefined): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
