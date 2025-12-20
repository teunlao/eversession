import { asString } from "../../core/json.js";
import type { AnalyzeDetail } from "../analyze.js";
import { type BoundarySegment, getContentBlocks, getSessionStats, getToolResultIds, getToolUseIds } from "./model.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";
import { countClaudeMessagesTokens } from "./tokens.js";

export type ClaudeToolStats = {
  toolUseBlocks: number;
  toolResultBlocks: number;
  uniqueToolUseIds: number;
  uniqueToolResultIds: number;
};

export type ClaudeAnalyzeReport = {
  agent: "claude";
  invalidJsonLines: number;
  entryTypeCounts: Record<string, number>;
  toolStats: ClaudeToolStats;
  isSidechain: boolean;
  agentIds: string[];
  sessionIds: string[];
  // Fields from getSessionStats
  boundaries: number;
  visibleEntries: number;
  visibleMessages: number;
  segments: BoundarySegment[];
};

function computeToolStats(entries: ClaudeEntryLine[]): ClaudeToolStats {
  let toolUseBlocks = 0;
  let toolResultBlocks = 0;
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const e of entries) {
    const uses = getToolUseIds(e);
    toolUseBlocks += uses.length;
    for (const id of uses) toolUseIds.add(id);

    const results = getToolResultIds(e);
    toolResultBlocks += results.length;
    for (const id of results) toolResultIds.add(id);
  }

  return {
    toolUseBlocks,
    toolResultBlocks,
    uniqueToolUseIds: toolUseIds.size,
    uniqueToolResultIds: toolResultIds.size,
  };
}

export function analyzeClaudeSession(session: ClaudeSession): ClaudeAnalyzeReport {
  const invalidJsonLines = session.lines.filter((l) => l.kind === "invalid_json").length;
  const entries = session.lines.filter((l): l is ClaudeEntryLine => l.kind === "entry");

  // Use centralized getSessionStats from model.ts
  const stats = getSessionStats(entries);
  const toolStats = computeToolStats(entries);

  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  let isSidechain = false;

  for (const e of entries) {
    const sid = asString(e.value.sessionId);
    if (sid) sessionIds.add(sid);

    const side = e.value.isSidechain === true;
    if (side) isSidechain = true;

    const aid = asString(e.value.agentId);
    if (aid) agentIds.add(aid);

    // Touch content to ensure parsing doesn't choke on arrays/strings
    void getContentBlocks(e);
  }

  return {
    agent: "claude",
    invalidJsonLines,
    entryTypeCounts: stats.byType,
    toolStats,
    isSidechain,
    agentIds: [...agentIds].sort(),
    sessionIds: [...sessionIds].sort(),
    boundaries: stats.boundaries,
    visibleEntries: stats.visibleEntries,
    visibleMessages: stats.visibleMessages,
    segments: stats.segments,
  };
}

function formatK(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(value);
  const k = value / 1000;
  if (k < 10) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}

export async function buildClaudeAnalyzeDetail(session: ClaudeSession): Promise<AnalyzeDetail> {
  const analysis = analyzeClaudeSession(session);
  const messageTokens = await countClaudeMessagesTokens(session);

  const summary: string[] = [];
  summary.push("agent=claude format=jsonl");
  summary.push(`session_ids=${analysis.sessionIds.length} sidechain=${analysis.isSidechain}`);
  summary.push(`invalid_json=${analysis.invalidJsonLines}`);
  summary.push(
    `boundaries=${analysis.boundaries} visible_entries=${analysis.visibleEntries} visible_messages=${analysis.visibleMessages}`,
  );
  summary.push(`messages_tokens=${formatK(messageTokens)} (like /context → Messages)`);

  if (analysis.segments.length > 0) {
    summary.push("segments:");
    for (const seg of analysis.segments) {
      const label = seg.boundaryUuid === "(start)" ? "(start)" : `boundary@${seg.boundaryLine}`;
      summary.push(`  ${label}: entries=${seg.entriesInSegment} messages=${seg.messagesInSegment}`);
    }
  }

  const types = Object.entries(analysis.entryTypeCounts)
    .sort(([aKey], [bKey]) => aKey.localeCompare(bKey))
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  summary.push(`types: ${types}`);
  summary.push(
    `tools: tool_use_blocks=${analysis.toolStats.toolUseBlocks} tool_result_blocks=${analysis.toolStats.toolResultBlocks}`,
  );

  return {
    format: "jsonl",
    analysis,
    summary,
    extras: {
      messageTokens,
      messageTokensScope: "Claude Code /context → Messages",
    },
  };
}
