import type { ApiJsonlTailItem, ApiSession, ApiSessionsResponse } from "./sessions.svelte.js";

export type ApiLogsResponse = {
  sessionId: string;
  logPath: string;
  tail: ApiJsonlTailItem[];
  invalidJsonLines: number;
  error?: string;
};

export class LogsState {
  state = $state({
    sessionsLoading: true,
    sessionsError: "",
    sessions: [] as ApiSession[],
    cwd: "",

    sessionId: "",

    logsLoading: false,
    logsError: "",
    logs: undefined as ApiLogsResponse | undefined,
  });

  initFromUrl(url: URL): void {
    this.state.sessionId = url.searchParams.get("sessionId") ?? "";
  }

  async loadSessions(baseUrl: URL): Promise<void> {
    this.state.sessionsLoading = true;
    this.state.sessionsError = "";

    try {
      const url = new URL("/api/sessions", baseUrl);
      url.searchParams.set("limit", "120");

      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as ApiSessionsResponse;
      this.state.sessions = data.sessions;
      this.state.cwd = data.cwd;
    } catch (err) {
      this.state.sessionsError = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.sessionsLoading = false;
    }
  }

  async loadLogs(baseUrl: URL, sessionId: string): Promise<void> {
    const trimmed = sessionId.trim();
    this.state.sessionId = trimmed;
    this.state.logsLoading = true;
    this.state.logsError = "";
    this.state.logs = undefined;

    try {
      const url = new URL("/api/logs", baseUrl);
      url.searchParams.set("sessionId", trimmed);
      url.searchParams.set("tailLines", "280");

      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.state.logs = (await res.json()) as ApiLogsResponse;
    } catch (err) {
      this.state.logsError = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.logsLoading = false;
    }
  }
}

