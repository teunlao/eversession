import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { deriveSessionIdFromPath, expandHome, lockPathForSession, logPathForSession } from "./paths.js";

describe("core/paths", () => {
  it("expandHome expands ~ and ~/...", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/x/y")).toBe(path.join(os.homedir(), "x", "y"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });

  it("deriveSessionIdFromPath strips .jsonl suffix only", () => {
    expect(deriveSessionIdFromPath("/tmp/abc.jsonl")).toBe("abc");
    expect(deriveSessionIdFromPath("/tmp/abc.txt")).toBe("abc.txt");
    expect(deriveSessionIdFromPath("/tmp/abc")).toBe("abc");
  });

  it("log/lock paths are derived from session id and dir", () => {
    const sessionPath = "/tmp/sessions/123.jsonl";
    expect(logPathForSession(sessionPath)).toBe(path.join("/tmp/sessions", "123.evs.log"));
    expect(lockPathForSession(sessionPath)).toBe(path.join("/tmp/sessions", "123.evs.lock"));
  });
});
