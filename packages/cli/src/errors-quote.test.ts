/**
 * The two 409 `conflict` shapes `wam scan run` can meet around a quote (08 section 6.5, 10 section
 * 9): terms that moved carry `details.fields`; a quote the server refused outright (expired, bad
 * signature, not its own, minted for another key) carries `details.reason` and no fields. Both
 * exit 9 with the same remedy, but only the first may claim that fields changed.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@whereamimentioned/api-client";
import { EXIT, mapApiError } from "./errors";

function conflict(message: string, details: Record<string, unknown>): ApiError {
  return new ApiError({
    status: 409,
    code: "conflict",
    message,
    requestId: "req_01JQ8Z3F7K4W2N9XR5PM3BQTVD",
    details,
    retryAfterSeconds: null,
  });
}

describe("mapApiError: quote conflicts on scan run", () => {
  it("moved terms name the fields that changed", () => {
    const err = mapApiError(conflict("The scan the server priced is no longer the scan it would run.", { fields: ["modelIds", "promptCount"] }), "scan run");
    expect(err.exitCode).toBe(EXIT.CONFLICT);
    expect(err.lines[0]).toBe("The scan the server priced is no longer the scan it would run.");
    expect(err.lines[1]).toBe("The fields that changed: modelIds, promptCount.");
    expect(err.lines.join("\n")).toContain("Run wam scan estimate again, then wam scan run.");
  });

  it("a refused quote prints the server's sentence and never claims fields changed", () => {
    for (const [reason, message] of [
      ["expired", "The quote has expired. Request a new estimate and confirm again."],
      ["wrong_key", "The quote was issued to a different API key. Request a new estimate with this key."],
    ] as const) {
      const err = mapApiError(conflict(message, { reason }), "scan run");
      expect(err.exitCode).toBe(EXIT.CONFLICT);
      expect(err.lines[0]).toBe(message);
      const text = err.lines.join("\n");
      expect(text).toContain("Run wam scan estimate again, then wam scan run.");
      expect(text).not.toContain("fields that changed");
      expect(text).not.toContain("not reported");
      expect(text).toContain("req_01JQ8Z3F7K4W2N9XR5PM3BQTVD");
    }
  });

  it("a reused idempotency key still names the original scan and never reads details.scanId", () => {
    const err = mapApiError(
      conflict("Idempotency-Key was already used.", { originalScanId: "3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb", fields: ["promptCount"], scanId: "should-not-be-read" }),
      "scan run",
    );
    expect(err.exitCode).toBe(EXIT.CONFLICT);
    expect(err.lines.join("\n")).toContain("3f9c1e42-08a1-4f6e-9b21-7d0c5a3e91bb");
    expect(err.lines.join("\n")).not.toContain("should-not-be-read");
  });
});
