<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table";

  type ApiHandshake =
    | { agent: "claude"; ts: string; sessionId: string; transcriptPath: string }
    | { agent: "codex"; ts: string; threadId: string; cwd: string; turnId?: string };

  type ApiActiveRun = {
    agent: "claude" | "codex";
    runId: string;
    pid: number;
    cwd: string;
    startedAt: string;
    reloadMode: "manual" | "auto" | "off";
    alive: boolean;
    handshake?: ApiHandshake;
  };

  type ApiResponse = { runs: ApiActiveRun[] };

  const state = $state({
    loading: true,
    error: "",
    runs: [] as ApiActiveRun[],
    lastUpdated: "" as string | undefined,
  });

  async function load(): Promise<void> {
    state.loading = true;
    state.error = "";

    try {
      const res = await fetch("/api/active", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiResponse;
      state.runs = data.runs;
      state.lastUpdated = new Date().toISOString();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    void load();
    timer = setInterval(() => void load(), 2000);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<Card>
  <CardHeader>
    <CardTitle>Active</CardTitle>
    <CardDescription>
      Supervisor runs detected via <code class="font-mono text-xs">~/.evs/active</code> + handshake validation.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if state.error}
      <p class="text-sm text-destructive">Error: {state.error}</p>
    {/if}

    <div class="flex items-center gap-2">
      <Button onclick={() => void load()} disabled={state.loading}>Refresh</Button>
      {#if state.lastUpdated}
        <span class="text-xs text-muted-foreground">updated: {state.lastUpdated}</span>
      {/if}
    </div>

    {#if state.loading && state.runs.length === 0}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if state.runs.length === 0}
      <p class="text-sm text-muted-foreground">No active runs.</p>
    {:else}
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>PID</TableHead>
              <TableHead>CWD</TableHead>
              <TableHead>Reload</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Alive</TableHead>
              <TableHead>Session</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each state.runs as run (run.agent + ":" + run.runId)}
              <TableRow>
                <TableCell class="font-medium">{run.agent}</TableCell>
                <TableCell><span class="font-mono text-xs">{run.runId}</span></TableCell>
                <TableCell><span class="font-mono text-xs">{run.pid}</span></TableCell>
                <TableCell><span class="font-mono text-xs">{run.cwd}</span></TableCell>
                <TableCell>{run.reloadMode}</TableCell>
                <TableCell><span class="font-mono text-xs">{run.startedAt}</span></TableCell>
                <TableCell>{run.alive ? "yes" : "no"}</TableCell>
                <TableCell>
                  {#if run.handshake?.agent === "claude"}
                    <div class="space-y-1">
                      <div class="font-mono text-xs">{run.handshake.sessionId}</div>
                      <div class="font-mono text-xs text-muted-foreground">{run.handshake.transcriptPath}</div>
                    </div>
                  {:else if run.handshake?.agent === "codex"}
                    <div class="space-y-1">
                      <div class="font-mono text-xs">{run.handshake.threadId}</div>
                      <div class="font-mono text-xs text-muted-foreground">{run.handshake.cwd}</div>
                    </div>
                  {:else}
                    <span class="text-muted-foreground">(no handshake yet)</span>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  </CardContent>
</Card>
