import type { RequestHandler } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";

import { resolveEvsConfigForCwd } from "eversession";

export const GET: RequestHandler = async ({ url }) => {
  const cwdParam = url.searchParams.get("cwd")?.trim();
  const cwd = cwdParam && cwdParam.length > 0 ? cwdParam : process.cwd();

  const resolved = await resolveEvsConfigForCwd(cwd);
  return json({
    cwd,
    config: resolved.config,
    files: resolved.files,
    sourceByPath: resolved.sourceByPath,
  });
};
