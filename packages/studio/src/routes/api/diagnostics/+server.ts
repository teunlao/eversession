import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import { evsActiveRunsDir, evsGlobalRootDir } from "eversession/core/active-run-registry.js";
import { evsGlobalConfigPath } from "eversession/core/project-config.js";

export const GET: RequestHandler = async () => {
  return json({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    evs: {
      globalRootDir: evsGlobalRootDir(),
      globalConfigPath: evsGlobalConfigPath(),
      activeRunsDir: evsActiveRunsDir(),
    },
  });
};

