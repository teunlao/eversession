export function stripClaudeSessionSelectionArgs(args: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg) continue;

    if (arg === "--continue" || arg === "-c") continue;

    if (arg === "--resume" || arg === "-r") {
      i++; // skip value
      continue;
    }

    if (arg.startsWith("--resume=")) continue;
    if (arg.startsWith("-r") && arg.length > 2) continue;

    // Session selection / branching flags should not persist across supervisor restarts.
    // Otherwise, each reload can fork/rewind again and diverge from the current active session.
    if (arg === "--fork-session") continue;

    if (arg === "--resume-session-at") {
      i++; // skip value
      continue;
    }
    if (arg.startsWith("--resume-session-at=")) continue;

    if (arg === "--rewind-files") {
      i++; // skip value
      continue;
    }
    if (arg.startsWith("--rewind-files=")) continue;

    out.push(arg);
  }

  return out;
}
