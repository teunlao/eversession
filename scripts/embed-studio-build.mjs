import { cp, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "packages", "studio", "build");
const dst = path.join(root, "packages", "eversession", "dist", "studio");

try {
  const st = await stat(src);
  if (!st.isDirectory()) throw new Error("not a directory");
} catch {
  process.stderr.write(`[embed-studio] Studio build not found: ${src}\n`);
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
process.stdout.write(`[embed-studio] Copied ${src} -> ${dst}\n`);
