<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import type { ApiJsonlTailItem } from "$lib/state/sessions.svelte";
  import { SessionsState } from "$lib/state/sessions.svelte";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table";
  import { Tabs, TabsContent, TabsList, TabsTrigger } from "$lib/components/ui/tabs";
  import { onMount } from "svelte";

  function setSearchParams(next: Record<string, string | undefined>): void {
    const url = new URL(page.url);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value.trim().length === 0) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function formatBytes(bytes: number): string {
    const b = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(1)} GB`;
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

  const ctrl = new SessionsState();

  const filtered = $derived.by(() => {
    const q = ctrl.state.q.trim().toLowerCase();
    if (q.length === 0) return ctrl.state.sessions;
    return ctrl.state.sessions.filter((s) => {
      const hay = [s.agent, s.id, s.path, s.cwd ?? "", s.source].join(" ").toLowerCase();
      return hay.includes(q);
    });
  });

  const visible = $derived.by(() => filtered.slice(0, 120));

  onMount(() => {
    ctrl.initFromUrl(page.url);
    void ctrl.loadSessions(page.url);
  });
</script>

<Card>
  <CardHeader>
    <CardTitle>Sessions</CardTitle>
    <CardDescription>
      Read-only listing of Claude project transcripts + Codex rollouts, enriched with EVS tracking when available.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if ctrl.state.error}
      <p class="text-sm text-destructive">Error: {ctrl.state.error}</p>
    {/if}

    <form
      class="flex flex-col gap-3 lg:flex-row lg:items-center"
      onsubmit={(e) => {
        e.preventDefault();
        setSearchParams({ cwd: ctrl.state.cwd, q: ctrl.state.q });
        void ctrl.loadSessions(page.url);
      }}
    >
      <label class="flex flex-1 items-center gap-2">
        <span class="w-12 text-sm text-muted-foreground">CWD</span>
        <Input bind:value={ctrl.state.cwd} placeholder="/path/to/project (optional)" />
      </label>

      <label class="flex flex-1 items-center gap-2">
        <span class="w-12 text-sm text-muted-foreground">Search</span>
        <Input bind:value={ctrl.state.q} placeholder="id / path / agent" />
      </label>

      <div class="flex items-center gap-2 lg:self-end">
        <Button type="submit" disabled={ctrl.state.loading}>Refresh</Button>
      </div>
    </form>

    {#if ctrl.state.loading && ctrl.state.sessions.length === 0}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if ctrl.state.sessions.length === 0}
      <p class="text-sm text-muted-foreground">No sessions found.</p>
    {:else}
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>EVS</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each visible as s (s.agent + ":" + s.id + ":" + s.path)}
              <TableRow>
                <TableCell class="font-medium">{s.agent}</TableCell>
                <TableCell><span class="font-mono text-xs">{s.id}</span></TableCell>
                <TableCell>
                  <div class="space-y-1">
                    <div class="font-mono text-xs">{s.evs.lastActivity ?? s.mtime}</div>
                    <div class="text-xs text-muted-foreground">{s.source}</div>
                  </div>
                </TableCell>
                <TableCell><span class="font-mono text-xs">{s.path}</span></TableCell>
                <TableCell>
                  {#if s.evs.tracked}
                    <Badge variant="secondary">tracked</Badge>
                  {:else}
                    <Badge variant="outline">none</Badge>
                  {/if}
                </TableCell>
                <TableCell class="text-right">
                  <Button size="sm" onclick={() => void ctrl.openSession(page.url, s)}>Open</Button>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>

      <p class="text-xs text-muted-foreground">
        Showing {visible.length} of {filtered.length} (client-side filter). Use search params: <code
          class="font-mono"
          >?cwd=…&q=…</code
        >.
      </p>
    {/if}
  </CardContent>
</Card>

<Dialog bind:open={ctrl.state.dialogOpen}>
  <DialogContent class="max-h-[90vh] max-w-[95vw] overflow-hidden sm:max-w-5xl">
    <DialogHeader>
      <DialogTitle>Session</DialogTitle>
      <DialogDescription>
        {#if ctrl.state.selected}
          <span class="font-mono text-xs break-all">{ctrl.state.selected.agent}:{ctrl.state.selected.id}</span>
        {/if}
      </DialogDescription>
    </DialogHeader>

    {#if ctrl.state.detailError}
      <p class="text-sm text-destructive">Error: {ctrl.state.detailError}</p>
    {/if}

    {#if ctrl.state.detailLoading && !ctrl.state.detail}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if ctrl.state.detail}
      <div class="space-y-3">
        <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div class="rounded-md border p-3">
            <div class="text-xs text-muted-foreground">Transcript</div>
            <div class="mt-1 space-y-1">
              <div class="font-mono text-xs break-all">{ctrl.state.detail.path}</div>
              <div class="text-xs text-muted-foreground">
                agent={ctrl.state.detail.agent}
                {#if ctrl.state.detail.confidence}
                  (confidence={ctrl.state.detail.confidence})
                {/if}
              </div>
              <div class="text-xs text-muted-foreground">
                mtime={ctrl.state.detail.mtime} · size={formatBytes(ctrl.state.detail.sizeBytes)}
              </div>
              {#if ctrl.state.detail.lastActivity}
                <div class="text-xs text-muted-foreground">lastActivity={ctrl.state.detail.lastActivity}</div>
              {/if}
            </div>
          </div>

          <div class="rounded-md border p-3">
            <div class="text-xs text-muted-foreground">EVS</div>
            <div class="mt-1 space-y-1">
              {#if ctrl.state.detail.evs?.tracked}
                <div class="text-xs text-muted-foreground">
                  tracked · dir=<span class="font-mono text-xs break-all">{ctrl.state.detail.evs.sessionDir}</span>
                </div>
                {#if ctrl.state.detail.evs.statePath}
                  <div class="text-xs text-muted-foreground">
                    state=<span class="font-mono text-xs break-all">{ctrl.state.detail.evs.statePath}</span>
                  </div>
                {/if}
                {#if ctrl.state.detail.evs.logPath}
                  <div class="text-xs text-muted-foreground">
                    log=<span class="font-mono text-xs break-all">{ctrl.state.detail.evs.logPath}</span>
                  </div>
                {/if}
              {:else}
                <div class="text-xs text-muted-foreground">not tracked</div>
              {/if}
            </div>
          </div>
        </div>

        <Tabs bind:value={ctrl.state.dialogTab}>
          <TabsList class="w-fit">
            <TabsTrigger value="transcript">Transcript tail</TabsTrigger>
            <TabsTrigger value="evs-log" disabled={!ctrl.state.detail.evs?.logTail}>EVS log tail</TabsTrigger>
            <TabsTrigger value="evs-state" disabled={!ctrl.state.detail.evs?.state}>EVS state</TabsTrigger>
          </TabsList>

          <TabsContent value="transcript" class="mt-0">
            <ScrollArea class="h-[420px] w-full rounded-md border">
              <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
{stringifyJsonl(ctrl.state.detail.tail.tail)}
              </pre>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="evs-log" class="mt-0">
            <ScrollArea class="h-[420px] w-full rounded-md border">
              <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
{ctrl.state.detail.evs?.logTail ? stringifyJsonl(ctrl.state.detail.evs.logTail.tail) : ""}
              </pre>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="evs-state" class="mt-0">
            <ScrollArea class="h-[420px] w-full rounded-md border">
              <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
{JSON.stringify(ctrl.state.detail.evs?.state ?? null, null, 2)}
              </pre>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">Select a session to view details.</p>
    {/if}
  </DialogContent>
</Dialog>
