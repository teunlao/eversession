import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Command } from "commander";

import { fileExists } from "../core/fs.js";

type StudioFlags = {
  port?: string;
  open?: boolean;
};

const DEFAULT_STUDIO_PORT = 5199;

function parsePort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}

function bestEffortOpenUrl(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // ignore
  }
}

function resolvePackageRoot(fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  return path.resolve(here, "..", "..");
}

async function resolveStudioHandlerPath(fromFileUrl: string): Promise<string | undefined> {
  const pkgRoot = resolvePackageRoot(fromFileUrl);
  const candidates = [
    // Published package: embedded studio build.
    path.join(pkgRoot, "dist", "studio", "handler.js"),
    // Monorepo dev: sibling package build output.
    path.join(pkgRoot, "..", "studio", "build", "handler.js"),
  ];

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }

  return undefined;
}

type StudioHandler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

async function loadStudioHandler(fromFileUrl: string): Promise<StudioHandler | undefined> {
  const handlerPath = await resolveStudioHandlerPath(fromFileUrl);
  if (!handlerPath) return undefined;

  const mod = (await import(pathToFileURL(handlerPath).href)) as { handler?: unknown };
  const handler = mod.handler;
  if (typeof handler !== "function") return undefined;
  return handler as StudioHandler;
}

export function registerStudioCommand(program: Command): void {
  program
    .command("studio")
    .description("Start EVS Studio (local read-only UI)")
    .option("--port <port>", `port to listen on (default: ${DEFAULT_STUDIO_PORT})`)
    .option("--open", "open Studio in the default browser")
    .action(async (opts: StudioFlags) => {
      const port = parsePort(opts.port) ?? DEFAULT_STUDIO_PORT;
      if (!Number.isFinite(port)) {
        process.stderr.write("[evs studio] Invalid --port.\n");
        process.exitCode = 2;
        return;
      }

      const handler = await loadStudioHandler(import.meta.url);
      if (!handler) {
        process.stderr.write("[evs studio] Studio build not found.\n");
        process.stderr.write("Build it first:\n  pnpm -C packages/studio build\n");
        process.exitCode = 1;
        return;
      }

      const host = "127.0.0.1";
      const url = `http://${host}:${port}`;

      const server = http.createServer((req, res) => {
        try {
          const out = handler(req, res);
          if (out && typeof (out as Promise<unknown>).then === "function") {
            (out as Promise<unknown>).catch(() => {
              if (!res.headersSent) res.statusCode = 500;
              res.end("Internal Server Error");
            });
          }
        } catch {
          if (!res.headersSent) res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });

      server.on("error", (err: unknown) => {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
        if (code === "EADDRINUSE") {
          process.stderr.write(`[evs studio] Port ${port} is already in use. Try: evs studio --port <port>\n`);
          process.exitCode = 1;
          return;
        }
        process.stderr.write(`[evs studio] Server error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      });

      const stop = (): void => {
        try {
          server.close();
        } catch {
          // ignore
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      await new Promise<void>((resolve, reject) => {
        server.listen(port, host, () => resolve());
        server.once("error", reject);
      });

      process.stdout.write(`[evs studio] Listening on ${url}\n`);
      if (opts.open) bestEffortOpenUrl(url);
    });
}
