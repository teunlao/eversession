<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import type { ApiJsonlTailItem } from "$lib/state/sessions.svelte";
  import { LogsState } from "$lib/state/logs.svelte";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table";
  import { onMount } from "svelte";

  function setSearchParams(next: Record<string, string | undefined>): void {
    const url = new URL(page.url);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value.trim().length === 0) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function stringifyJsonl(items: ApiJsonlTailItem[]): string {
    return items
      .map((t) => {
        if (t.kind === "invalid_json") return `#${t.line} INVALID_JSON ${t.error}`;
        try {
          return `#${t.line} ${JSON.stringify(t.value)}`;
        } catch {
          return `#${t.line} [unserializable JSON]`;
        }
      })
      .join("\n");
  }

  const ctrl = new LogsState();

  const trackedSessions = $derived.by(() => ctrl.state.sessions.filter((s) => s.evs.tracked).slice(0, 80));

  onMount(() => {
    ctrl.initFromUrl(page.url);
    void ctrl.loadSessions(page.url).then(() => {
      if (ctrl.state.sessionId.trim().length > 0) {
        setSearchParams({ sessionId: ctrl.state.sessionId });
        void ctrl.loadLogs(page.url, ctrl.state.sessionId);
        return;
      }
      const first = trackedSessions[0];
      if (first) {
        setSearchParams({ sessionId: first.id });
        void ctrl.loadLogs(page.url, first.id);
      }
    });
  });
</script>

<Card>
  <CardHeader>
    <CardTitle>Logs</CardTitle>
    <CardDescription>EVS central logs from <code class="font-mono text-xs">~/.claude/.eversession/sessions/*/log.jsonl</code>.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if ctrl.state.sessionsError}
      <p class="text-sm text-destructive">Error: {ctrl.state.sessionsError}</p>
    {/if}

    <form
      class="flex flex-col gap-3 lg:flex-row lg:items-center"
      onsubmit={(e) => {
        e.preventDefault();
        setSearchParams({ sessionId: ctrl.state.sessionId });
        void ctrl.loadLogs(page.url, ctrl.state.sessionId);
      }}
    >
      <label class="flex flex-1 items-center gap-2">
        <span class="w-20 text-sm text-muted-foreground">Session ID</span>
        <Input bind:value={ctrl.state.sessionId} placeholder="uuid / thread-id" />
      </label>
      <Button type="submit" disabled={ctrl.state.logsLoading || ctrl.state.sessionId.trim().length === 0}>
        Load
      </Button>
    </form>

    {#if ctrl.state.logsError}
      <p class="text-sm text-destructive">Error: {ctrl.state.logsError}</p>
    {/if}

    {#if ctrl.state.logsLoading && !ctrl.state.logs}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if ctrl.state.logs}
      <div class="space-y-2">
        <div class="text-xs text-muted-foreground">
          logPath=<span class="font-mono text-xs">{ctrl.state.logs.logPath}</span>
          {#if ctrl.state.logs.invalidJsonLines > 0}
            · invalidJsonLines={ctrl.state.logs.invalidJsonLines}
          {/if}
        </div>
        <ScrollArea class="h-[520px] rounded-md border">
          <pre class="p-3 font-mono text-xs leading-relaxed">
{stringifyJsonl(ctrl.state.logs.tail)}
          </pre>
        </ScrollArea>
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">Pick a session to view logs.</p>
    {/if}
  </CardContent>
</Card>

<Card class="mt-6">
  <CardHeader>
    <CardTitle>Recent tracked sessions</CardTitle>
    <CardDescription>
      Sessions that have EVS artifacts (state/logs). Current CWD detected by Studio: <code class="font-mono text-xs"
        >{ctrl.state.cwd}</code
      >.
    </CardDescription>
  </CardHeader>
  <CardContent>
    {#if ctrl.state.sessionsLoading && ctrl.state.sessions.length === 0}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if trackedSessions.length === 0}
      <p class="text-sm text-muted-foreground">No tracked sessions found.</p>
    {:else}
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each trackedSessions as s (s.agent + ":" + s.id)}
              <TableRow>
                <TableCell class="font-medium">{s.agent}</TableCell>
                <TableCell><span class="font-mono text-xs">{s.id}</span></TableCell>
                <TableCell class="font-mono text-xs">{s.evs.lastActivity ?? s.mtime}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{s.source}</Badge>
                </TableCell>
                <TableCell class="text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onclick={() => {
                      setSearchParams({ sessionId: s.id });
                      void ctrl.loadLogs(page.url, s.id);
                    }}
                  >
                    View
                  </Button>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  </CardContent>
</Card>
