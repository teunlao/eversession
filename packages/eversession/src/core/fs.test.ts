import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBackup, fileExists, writeFileAtomic } from "./fs.js";

describe("core/fs", () => {
  it("writeFileAtomic creates directories and leaves no temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-fs-"));
    const nested = join(dir, "a", "b", "file.txt");

    await writeFileAtomic(nested, "hello");
    expect(await readFile(nested, "utf8")).toBe("hello");

    const files = await readdir(join(dir, "a", "b"));
    expect(files).toEqual(["file.txt"]);

    await rm(dir, { recursive: true, force: true });
  });

  it("createBackup copies the original file next to it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-fs-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, "data\n", "utf8");

    const { backupPath } = await createBackup(file);
    expect(backupPath.startsWith(file + ".backup-")).toBe(true);
    expect(await readFile(backupPath, "utf8")).toBe("data\n");

    await rm(dir, { recursive: true, force: true });
  });

  it("fileExists returns true/false without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-reactor-fs-"));
    const existing = join(dir, "exists.txt");
    const missing = join(dir, "missing.txt");
    await writeFile(existing, "ok", "utf8");

    expect(await fileExists(existing)).toBe(true);
    expect(await fileExists(missing)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});
