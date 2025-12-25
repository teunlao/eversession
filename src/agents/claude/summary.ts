import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer";
import { asString } from "../../core/json.js";
import type { ClaudeEntryLine, ClaudeSession } from "./session.js";

export type ModelType = "haiku" | "sonnet" | "opus";

export interface SummaryOptions {
  model?: ModelType;
  /** Target summary size as percentage of source (default: 20) */
  targetPercent?: number;
}

export interface SummaryResult {
  summary: string;
  tokenCount: number;
  model: ModelType;
}

export interface SummaryPrompt {
  prompt: string;
  promptTokens: number;
  sourceLines: number;
  targetLines: number;
}

const COMPACT_PROMPT = `# Session Compact Expert

## Who you are

You are an expert in compacting Claude Code sessions. Your task is to turn a long conversation log into a structured summary that preserves EVERYTHING important for restoring context.

**MAIN RULE:** Preserve specifics. Not "studied the SDK" but "studied \`query()\` with parameters \`permissionMode\`, \`allowedTools\`, \`pathToClaudeCodeExecutable\`".

## What you receive

**Input data:** A conversation log between the user and Claude in the format:
\`\`\`
[user]: user message
[assistant]: Claude response
[user]: next message
...
\`\`\`

**Metadata:**
- Source size: {{SOURCE_LINES}} lines
- Target size: ~{{TARGET_LINES}} lines (guideline; can exceed to keep key details)

## What you must return

**CRITICALLY IMPORTANT:**
- Return ONLY the summary text
- DO NOT use any tools (Read, Write, Bash, etc.)
- DO NOT create files
- DO NOT write code
- DO NOT include meta reasoning ("I see...", "Let's...", "I noticed...")
- DO NOT ask for more data
- Output structured markdown summary only
- Start IMMEDIATELY with "## What we did"

**Output format:** Markdown text with the structure:

\`\`\`markdown
## What we did

1. **Task name 1** - short description of what was done
   - Specific details
   - Files: \`path/to/file.js\`

2. **Task name 2** - description
   - Details

## Files reviewed (reference)

If you read files to copy patterns:

- \`path/to/reference.ts\` - what was useful:
  - Function \`functionName()\` - what it does
  - Parameters: \`param1\`, \`param2\` - what they do
  - Pattern: description

## Key files (created/changed)

- \`path/to/file1.js\` - what it is, why it was created/changed
- \`path/to/file2.ts\` - description

## Solutions found

Concrete findings that will help later:

- **How to do X:** use \`function()\` with parameter \`Y\`
- **Where to find Z:** in \`path/file.ts\`, function \`name()\`
- **Important parameter:** \`paramName: value\` - what it does

## Technical decisions

- **Decision 1:** Why it was chosen
- **Decision 2:** Alternatives considered

## Commands and commits

- \`command example\` - what it does
- Commit \`abc1234\` - what was committed

## Problems and fixes

- **Problem:** Description
- **Cause:** Why
- **Fix:** How it was fixed

## Current status

- What works
- What's not done
- Next steps
\`\`\`

## Compaction rules

### KEEP (maximum detail):

1. **Concrete actions** - what was created, changed, deleted
2. **File paths** - FULL paths, never shorten
3. **Function/class names** - exact names: \`parseJSON()\`, \`ClaudeAgentService\`
4. **Parameters and options** - exact values: \`permissionMode: 'bypassPermissions'\`
5. **Code snippets** - if you found an important pattern, keep key lines
6. **Reference files** - which files were read, what was useful
7. **Commands** - CLI commands that were run
8. **Commits** - hashes and descriptions
9. **Bugs and fixes** - what broke and how it was fixed
10. **API discoveries** - which params/methods and how to use them

### SKIP:

1. **Reasoning chatter** - "let's think", "hmm, interesting"
2. **Intermediate attempts** - failed options (if not important)
3. **Repetition** - same info multiple times
4. **Politeness** - "okay", "got it", "will do"
5. **Tool call boilerplate** - "used Read tool" (just list the file)

### DO NOT:

1. Do NOT write "Summary:" or "Here is summary:" - start immediately with content
2. Do NOT generalize when specifics are required
3. Do NOT use tools - TEXT ONLY
4. Do NOT invent anything not in the conversation
5. Do NOT shorten function/parameter/path names

## Messages

{{MESSAGES}}`;

export function buildCompactPrompt(messages: string, sourceLines: number, targetLines: number): string {
  return COMPACT_PROMPT.replace("{{MESSAGES}}", messages)
    .replace("{{SOURCE_LINES}}", String(sourceLines))
    .replace("{{TARGET_LINES}}", String(targetLines));
}

export function formatEntriesForPrompt(entries: ClaudeEntryLine[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const type = asString(entry.value.type);
    if (!type || type === "file-history-snapshot") continue;

    const message = entry.value.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const role = asString(message.role) ?? type;
    let text = "";

    const content = message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && typeof b.text === "string") {
          text += b.text + "\n";
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          text += b.thinking + "\n";
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          text += `[tool: ${b.name}]\n`;
          if ("input" in b) text += JSON.stringify(b.input) + "\n";
        } else if (b.type === "tool_result") {
          const resultContent = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          text += `[result: ${resultContent}]\n`;
        }
      }
    }

    if (text.trim()) {
      lines.push(`[${role}]: ${text.trim()}`);
    }
  }

  return lines.join("\n\n");
}

export function buildClaudeSummaryPrompt(entriesToCompact: ClaudeEntryLine[], options: SummaryOptions = {}): SummaryPrompt {
  const targetPercent = options.targetPercent ?? 20;

  const formattedMessages = formatEntriesForPrompt(entriesToCompact);
  const sourceLines = formattedMessages.split("\n").length;
  const targetLines = Math.max(20, Math.floor(sourceLines * (targetPercent / 100)));

  const prompt = buildCompactPrompt(formattedMessages, sourceLines, targetLines);
  const promptTokens = anthropicCountTokens(prompt);

  return { prompt, promptTokens, sourceLines, targetLines };
}

export function fitClaudeEntriesToMaxPromptTokens(params: {
  entries: ClaudeEntryLine[];
  requestedCount: number;
  maxPromptTokens: number;
  options?: SummaryOptions;
}): { count: number; promptTokens: number; requestedPromptTokens: number } {
  const requestedCount = Math.max(0, Math.min(Math.floor(params.requestedCount), params.entries.length));
  const maxPromptTokens = Math.floor(params.maxPromptTokens);
  const options = params.options ?? {};

  const countTokensForCount = (count: number): number => {
    const n = Math.max(0, Math.min(Math.floor(count), requestedCount));
    return buildClaudeSummaryPrompt(params.entries.slice(0, n), options).promptTokens;
  };

  const requestedPromptTokens = countTokensForCount(requestedCount);
  if (!Number.isFinite(maxPromptTokens) || maxPromptTokens <= 0) {
    return { count: requestedCount, promptTokens: requestedPromptTokens, requestedPromptTokens };
  }

  if (requestedPromptTokens <= maxPromptTokens) {
    return { count: requestedCount, promptTokens: requestedPromptTokens, requestedPromptTokens };
  }

  let low = 0;
  let high = requestedCount;
  let bestCount = 0;
  let bestTokens = countTokensForCount(0);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const tokens = countTokensForCount(mid);
    if (tokens <= maxPromptTokens) {
      bestCount = mid;
      bestTokens = tokens;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Guard against rare non-monotonicity (e.g. metadata digit changes): ensure returned count fits.
  while (bestCount > 0 && bestTokens > maxPromptTokens) {
    bestCount -= 1;
    bestTokens = countTokensForCount(bestCount);
  }

  return { count: bestCount, promptTokens: bestTokens, requestedPromptTokens };
}

export async function generateClaudeSummary(
  _session: ClaudeSession,
  entriesToCompact: ClaudeEntryLine[],
  options: SummaryOptions = {},
): Promise<SummaryResult> {
  const model = options.model ?? "haiku";
  const prompt = buildClaudeSummaryPrompt(entriesToCompact, options).prompt;

  let summary = "";

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    for await (const message of query({
      prompt,
      options: {
        model,
        allowedTools: [],
        permissionMode: "bypassPermissions",
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block && typeof block.text === "string") {
            summary += block.text;
          }
        }
      }
    }
  } catch (error) {
    throw new Error(`LLM call failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  if (!summary.trim()) {
    throw new Error("Empty summary generated");
  }

  const tokenCount = anthropicCountTokens(summary);

  return {
    summary: summary.trim(),
    tokenCount,
    model,
  };
}
