export const BRAND = {
  name: "EverSession",
  short: "EVS",
  cli: {
    primary: "evs",
    secondary: "eversession",
  },
  storage: {
    claudeBaseDirName: ".eversession",
    statuslineDumpFileName: ".evs.statusline.stdin.jsonl",
    localSessionLogSuffix: ".evs.log",
    localSessionLockSuffix: ".evs.lock",
  },
  env: {
    statuslineDumpPath: "EVS_STATUSLINE_DUMP_PATH",
    claude: {
      controlDir: "EVS_CLAUDE_CONTROL_DIR",
      runId: "EVS_CLAUDE_RUN_ID",
      reloadMode: "EVS_CLAUDE_RELOAD_MODE",
      transcriptPath: "EVS_CLAUDE_TRANSCRIPT_PATH",
      transcriptUuid: "EVS_CLAUDE_TRANSCRIPT_UUID",
      sessionId: "EVS_CLAUDE_SESSION_ID",
      hookCwd: "EVS_CLAUDE_HOOK_CWD",
      projectDir: "EVS_CLAUDE_PROJECT_DIR",
      bin: "EVS_CLAUDE_BIN",
    },
  },
} as const;

export function isEvsCliCommandPrefix(prefix: string): boolean {
  const normalized = prefix.trim();
  return normalized === BRAND.cli.primary || normalized === BRAND.cli.secondary;
}
