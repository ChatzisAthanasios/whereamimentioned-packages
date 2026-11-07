/**
 * The default browser opener (10-CLI section 4.2 step 3). The authorize URL carries seven query
 * parameters joined by ampersands, so it must reach the opener as ONE argument that no shell
 * re-parses: through `cmd /c start`, the first ampersand ends the URL and the approval page sees
 * only `code_challenge`.
 */
import { describe, expect, it } from "vitest";
import { defaultOpenBrowser, type ExecResult } from "./context";

const URL_WITH_QUERY =
  "https://whereamimentioned.com/cli/authorize?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&state=xyz&name=Box&scopes=scans%3Aread&expires=90";

function recorder() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const exec = async (command: string, args: readonly string[]): Promise<ExecResult> => {
    calls.push({ command, args });
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, exec };
}

describe("defaultOpenBrowser", () => {
  it("on Windows hands the whole URL to rundll32 as one argument and never goes through cmd", async () => {
    const { calls, exec } = recorder();
    await defaultOpenBrowser("win32", exec)(URL_WITH_QUERY);
    expect(calls).toEqual([{ command: "rundll32", args: ["url.dll,FileProtocolHandler", URL_WITH_QUERY] }]);
    expect(calls[0].command).not.toBe("cmd");
  });

  it("uses open on macOS and xdg-open elsewhere, with the URL intact", async () => {
    const mac = recorder();
    await defaultOpenBrowser("darwin", mac.exec)(URL_WITH_QUERY);
    expect(mac.calls).toEqual([{ command: "open", args: [URL_WITH_QUERY] }]);
    const linux = recorder();
    await defaultOpenBrowser("linux", linux.exec)(URL_WITH_QUERY);
    expect(linux.calls).toEqual([{ command: "xdg-open", args: [URL_WITH_QUERY] }]);
  });
});
