<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { onMount } from "svelte";

  type ApiResponse = {
    node: string;
    platform: string;
    arch: string;
    cwd: string;
    evs: {
      globalRootDir: string;
      globalConfigPath: string;
      activeRunsDir: string;
    };
  };

  const state = $state({
    loading: true,
    error: "",
    data: undefined as ApiResponse | undefined,
  });

  async function load(): Promise<void> {
    state.loading = true;
    state.error = "";
    try {
      const res = await fetch("/api/diagnostics", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = (await res.json()) as ApiResponse;
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
    <CardTitle>Diagnostics</CardTitle>
    <CardDescription>Read-only environment and path introspection for Studio.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if state.error}
      <p class="text-sm text-destructive">Error: {state.error}</p>
    {/if}

    <div class="flex items-center gap-2">
      <Button onclick={() => void load()} disabled={state.loading}>Refresh</Button>
    </div>

    {#if state.loading && !state.data}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else if state.data}
      <pre class="max-h-[520px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
{JSON.stringify(state.data, null, 2)}
      </pre>
    {:else}
      <p class="text-sm text-muted-foreground">No data.</p>
    {/if}
  </CardContent>
</Card>
