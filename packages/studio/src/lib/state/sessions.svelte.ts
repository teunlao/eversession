export type ApiSessionAgent = "claude" | "codex";

export type ApiSession = {
  agent: ApiSessionAgent;
  id: string;
  path: string;
  mtimeMs: number;
  mtime: string;
  cwd?: string;
  source: "claude-project" | "codex-rollout";
  evs: {
    tracked: boolean;
    sessionDir?: string;
    logPath?: string;
    statePath?: string;
    lastActivityMs?: number;
    lastActivity?: string;
    state?: unknown;
  };
};

export type ApiSessionsResponse = {
  cwd: string;
  sessions: ApiSession[];
};

export type ApiJsonlTailItem =
  | { kind: "json"; line: number; value: unknown }
  | { kind: "invalid_json"; line: number; error: string };

export type ApiSessionDetail = {
  path: string;
  id?: string;
  agent: "claude" | "codex" | "unknown";
  confidence?: string;
  mtimeMs: number;
  mtime: string;
  sizeBytes: number;
  lastActivity?: string;
  tail: {
    tail: ApiJsonlTailItem[];
    invalidJsonLines: number;
  };
  evs?: {
    tracked: boolean;
    sessionDir?: string;
    logPath?: string;
    statePath?: string;
    state?: unknown;
    logTail?: {
      tail: ApiJsonlTailItem[];
      invalidJsonLines: number;
    };
  };
};

export class SessionsState {
  state = $state({
    loading: true,
    error: "",
    cwd: "",
    q: "",
    sessions: [] as ApiSession[],

    dialogOpen: false,
    dialogTab: "transcript",
    selected: undefined as ApiSession | undefined,

    detailLoading: false,
    detailError: "",
    detail: undefined as ApiSessionDetail | undefined,
  });

  initFromUrl(url: URL): void {
    this.state.cwd = url.searchParams.get("cwd") ?? "";
    this.state.q = url.searchParams.get("q") ?? "";
  }

  async loadSessions(baseUrl: URL): Promise<void> {
    this.state.loading = true;
    this.state.error = "";

    try {
      const url = new URL("/api/sessions", baseUrl);
      if (this.state.cwd.trim().length > 0) url.searchParams.set("cwd", this.state.cwd.trim());
      url.searchParams.set("limit", "200");

      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as ApiSessionsResponse;
      this.state.sessions = data.sessions;
      this.state.cwd = data.cwd;
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.loading = false;
    }
  }

  async openSession(baseUrl: URL, session: ApiSession): Promise<void> {
    this.state.dialogOpen = true;
    this.state.dialogTab = "transcript";
    this.state.selected = session;
    this.state.detail = undefined;
    this.state.detailError = "";

    await this.loadDetail(baseUrl, session);
  }

  async loadDetail(baseUrl: URL, session: ApiSession): Promise<void> {
    this.state.detailLoading = true;
    this.state.detailError = "";

    try {
      const url = new URL("/api/session", baseUrl);
      url.searchParams.set("path", session.path);
      url.searchParams.set("id", session.id);
      url.searchParams.set("tailLines", "220");
      url.searchParams.set("logLines", "220");

      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      this.state.detail = (await res.json()) as ApiSessionDetail;
    } catch (err) {
      this.state.detailError = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.detailLoading = false;
    }
  }
}

