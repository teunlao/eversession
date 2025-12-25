export { defaultEvsConfig, resolveEvsConfigForCwd, type EvsConfig, type ResolvedEvsConfig } from "./core/project-config.js";
export {
  listActiveRunRecordPaths,
  readActiveRunRecordFile,
  isPidAlive,
  type EvsActiveRunAgent,
  type EvsActiveRunRecord,
} from "./core/active-run-registry.js";

