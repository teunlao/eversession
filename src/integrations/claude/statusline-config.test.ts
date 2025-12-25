import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { readAutoCompactConfigFromProjectSettings } from "./statusline.js";

async function writeProjectSettings(dir: string, settings: unknown): Promise<void> {
  const claudeDir = path.join(dir, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

describe("integrations/claude/statusline readAutoCompactConfigFromProjectSettings", () => {
  it("extracts auto-compact config from Stop hook command", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evs-statusline-config-"));

    await writeProjectSettings(dir, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "evs auto-compact start --threshold 140k --amount-tokens 40% --max-tokens 32k --model haiku --busy-timeout 10s",
                timeout: 90,
              },
            ],
          },
        ],
      },
    });

    const cfg = await readAutoCompactConfigFromProjectSettings(dir);
    expect(cfg).toEqual({
      thresholdTokens: 140_000,
      amountTokens: "40%",
      maxTokens: "32k",
      model: "haiku",
      busyTimeout: "10s",
    });
  });

  it("returns undefined threshold when Stop hooks disagree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evs-statusline-config-"));

    await writeProjectSettings(dir, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "evs auto-compact start --threshold 140k --amount-tokens 40%" },
              { type: "command", command: "evs auto-compact start --threshold 150k --amount-tokens 40%" },
            ],
          },
        ],
      },
    });

    const cfg = await readAutoCompactConfigFromProjectSettings(dir);
    expect(cfg?.thresholdTokens).toBeUndefined();
    expect(cfg?.amountTokens).toBe("40%");
  });
});
