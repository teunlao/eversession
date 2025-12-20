import type { Command } from "commander";

import { asString } from "../core/json.js";
import { loadPinsFile, resolvePinsPath, type PinnedAgent, type PinnedSession } from "../integrations/pins/storage.js";

type AgentFilter = "all" | PinnedAgent;

function safeParseTimeMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function formatIsoLocalHuman(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function parseDateMs(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

function matchesQuery(pin: PinnedSession, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    pin.name.toLowerCase().includes(needle) ||
    pin.sessionId.toLowerCase().includes(needle) ||
    pin.sessionPath.toLowerCase().includes(needle)
  );
}

type PinsCommandOptions = {
  agent?: string;
  q?: string;
  since?: string;
  until?: string;
  json?: boolean;
  pinsPath?: string;
};

export function registerPinsCommand(program: Command): void {
  program
    .command("pins")
    .description("List pinned sessions")
    .option("--agent <agent>", "all|claude|codex (default: all)", "all")
    .option("--q <text>", "search by name/id/path")
    .option("--since <date>", "filter pins with pinnedAt >= date (ISO 8601 or YYYY-MM-DD)")
    .option("--until <date>", "filter pins with pinnedAt <= date (ISO 8601 or YYYY-MM-DD)")
    .option("--json", "output JSON")
    .option("--pins-path <path>", "override pins file path (advanced)")
    .action(async (opts: PinsCommandOptions) => {
      const agent = (asString(opts.agent) ?? "all") as AgentFilter;
      if (agent !== "all" && agent !== "claude" && agent !== "codex") {
        process.stderr.write("[evs pins] Invalid --agent value (expected all|claude|codex).\n");
        process.exitCode = 2;
        return;
      }

      const q = typeof opts.q === "string" ? opts.q.trim() : "";
      const sinceMs = opts.since ? parseDateMs(opts.since) : undefined;
      if (opts.since && sinceMs === undefined) {
        process.stderr.write("[evs pins] Invalid --since value (expected ISO 8601 or YYYY-MM-DD).\n");
        process.exitCode = 2;
        return;
      }
      const untilMs = opts.until ? parseDateMs(opts.until) : undefined;
      if (opts.until && untilMs === undefined) {
        process.stderr.write("[evs pins] Invalid --until value (expected ISO 8601 or YYYY-MM-DD).\n");
        process.exitCode = 2;
        return;
      }

      const pinsPath = resolvePinsPath(opts.pinsPath);

      let pinsFile;
      try {
        pinsFile = await loadPinsFile(pinsPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[evs pins] Failed to read pins file: ${msg}\n`);
        process.exitCode = 2;
        return;
      }

      let pins = pinsFile.pins.slice();

      if (agent !== "all") pins = pins.filter((p) => p.agent === agent);
      if (q.length > 0) pins = pins.filter((p) => matchesQuery(p, q));
      if (sinceMs !== undefined) pins = pins.filter((p) => safeParseTimeMs(p.pinnedAt) >= sinceMs);
      if (untilMs !== undefined) pins = pins.filter((p) => safeParseTimeMs(p.pinnedAt) <= untilMs);

      pins.sort((a, b) => safeParseTimeMs(b.pinnedAt) - safeParseTimeMs(a.pinnedAt));

      if (opts.json) {
        process.stdout.write(JSON.stringify(pins, null, 2) + "\n");
        process.exitCode = 0;
        return;
      }

      if (pins.length === 0) {
        process.stdout.write("No pins.\n");
        process.exitCode = 0;
        return;
      }

      const writePin = (pin: PinnedSession): void => {
        process.stdout.write(`${pin.name}\n`);
        process.stdout.write(`  agent: ${pin.agent}\n`);
        process.stdout.write(`  id: ${pin.sessionId}\n`);
        process.stdout.write(`  pinnedAt: ${formatIsoLocalHuman(pin.pinnedAt)}\n`);
        process.stdout.write(`  path: ${pin.sessionPath}\n`);
      };

      for (let i = 0; i < pins.length; i += 1) {
        if (i > 0) process.stdout.write("\n");
        writePin(pins[i]!);
      }
      process.exitCode = 0;
    });
}
