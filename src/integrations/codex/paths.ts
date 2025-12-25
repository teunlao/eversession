import * as path from "node:path";

import { resolveCodexHome } from "./config.js";

export function defaultCodexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), "sessions");
}
