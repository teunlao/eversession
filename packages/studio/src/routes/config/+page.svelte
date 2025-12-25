<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { onMount } from "svelte";

  type ApiResponse = {
    cwd: string;
    config: unknown;
    files: unknown;
    sourceByPath: Record<string, "default" | "global" | "local">;
  };

  const state = $state({
    loading: true,
    error: "",
    cwd: "",
    data: undefined as ApiResponse | undefined,
  });

  async function load(cwd?: string): Promise<void> {
    state.loading = true;
    state.error = "";
    try {
      const url = new URL("/api/config", window.location.origin);
      if (cwd && cwd.trim().length > 0) url.searchParams.set("cwd", cwd.trim());
      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiResponse;
      state.data = data;
      state.cwd = data.cwd;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
    }
  }

  onMount(() => void load());
</script>
<Card>
  <CardHeader>
    <CardTitle>Config</CardTitle>
    <CardDescription>
      Resolved config = defaults ⟶ global <code class="font-mono text-xs">~/.evs/config.json</code> ⟶ local{" "}
      <code class="font-mono text-xs">.evs/config.json</code>.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if state.error}
      <p class="text-sm text-destructive">Error: {state.error}</p>
    {/if}

    <form
      class="flex flex-col gap-3 sm:flex-row sm:items-center"
      onsubmit={(e) => {
        e.preventDefault();
        void load(state.cwd);
      }}
    >
      <label class="flex flex-1 items-center gap-2">
        <span class="w-12 text-sm text-muted-foreground">CWD</span>
        <Input bind:value={state.cwd} placeholder="/path/to/project" />
      </label>
      <Button class="sm:self-end" disabled={state.loading}>Load</Button>
    </form>

    {#if state.loading && !state.data}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if state.data}
      <div class="space-y-3">
        <div class="space-y-2">
          <h2 class="text-sm font-semibold">Files</h2>
          <pre class="max-h-[320px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
{JSON.stringify(state.data.files, null, 2)}
          </pre>
        </div>

        <div class="space-y-2">
          <h2 class="text-sm font-semibold">Config</h2>
          <pre class="max-h-[320px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
{JSON.stringify(state.data.config, null, 2)}
          </pre>
        </div>

        <div class="space-y-2">
          <h2 class="text-sm font-semibold">Source Map</h2>
          <pre class="max-h-[320px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
{JSON.stringify(state.data.sourceByPath, null, 2)}
          </pre>
        </div>
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">No data.</p>
    {/if}
  </CardContent>
</Card>
