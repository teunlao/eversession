import { spawn } from "node:child_process";
import notifier from "node-notifier";

export type OsNotification = {
  title: string;
  message: string;
};

export async function sendOsNotification(notification: OsNotification): Promise<void> {
  const viaLib = await tryNodeNotifier(notification);
  if (viaLib) return;

  // Fallbacks when the library isn't available (or fails to load).
  const platform = process.platform;
  if (platform === "darwin") {
    await trySpawn("osascript", [
      "-e",
      `display notification ${JSON.stringify(notification.message)} with title ${JSON.stringify(notification.title)}`,
    ]);
    return;
  }

  if (platform === "linux") {
    await trySpawn("notify-send", [notification.title, notification.message]);
    return;
  }

  // Windows (and others): best-effort no-op (we still log to the EverSession session log).
}

async function tryNodeNotifier(notification: OsNotification): Promise<boolean> {
  try {
    await new Promise<void>((resolve) => {
      notifier.notify({ title: notification.title, message: notification.message }, () => resolve());
      // Some notifiers never call cb; resolve anyway after a short delay.
      setTimeout(resolve, 750).unref?.();
    });

    return true;
  } catch {
    return false;
  }
}

function trySpawn(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}
