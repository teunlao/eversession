import { access, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BackupResult = {
  backupPath: string;
};

function timestampForFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export async function createBackup(path: string): Promise<BackupResult> {
  const backupPath = `${path}.backup-${timestampForFilename()}`;
  await copyFile(path, backupPath);
  return { backupPath };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${timestampForFilename()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, path);
}
