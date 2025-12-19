import * as os from "node:os";
import * as path from "node:path";

export function defaultCodexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}
