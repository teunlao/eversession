import { claudeAdapter } from "../../agents/claude/adapter.js";
import { countClaudeMessagesTokens } from "../../agents/claude/tokens.js";

export async function countClaudeMessageTokensFromFile(transcriptPath: string): Promise<number | undefined> {
  try {
    const parsed = await claudeAdapter.parse(transcriptPath);
    if (!parsed.ok) return undefined;
    return await countClaudeMessagesTokens(parsed.session);
  } catch {
    return undefined;
  }
}
