import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadJsonlFile, readJsonlLines, stringifyJsonl } from "./jsonl.js";

describe("core/jsonl", () => {
  it("stringifyJsonl writes one JSON object per line with trailing newline", () => {
    expect(stringifyJsonl([{ a: 1 }, "x", 2])).toBe('{"a":1}\n"x"\n2\n');
  });

  it("readJsonlLines skips blank lines and yields invalid_json for parse errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-jsonl-"));
    const file = join(dir, "sample.jsonl");
    await writeFile(file, ['{"a":1}', "", "not json", "  ", '{"b":2}'].join("\n") + "\n", "utf8");

    const out: { kind: string; line: number }[] = [];
    for await (const line of readJsonlLines(file)) out.push({ kind: line.kind, line: line.line });

    expect(out).toEqual([
      { kind: "json", line: 1 },
      { kind: "invalid_json", line: 3 },
      { kind: "json", line: 5 },
    ]);

    await rm(dir, { recursive: true, force: true });
  });

  it("loadJsonlFile collects all yielded lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-jsonl-"));
    const file = join(dir, "sample.jsonl");
    await writeFile(file, ['{"a":1}', '{"b":2}'].join("\n") + "\n", "utf8");

    const lines = await loadJsonlFile(file);
    expect(lines.map((l) => l.kind)).toEqual(["json", "json"]);

    await rm(dir, { recursive: true, force: true });
  });
});
