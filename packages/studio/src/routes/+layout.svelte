<script lang="ts">
  import { page } from "$app/stores";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { cn } from "$lib/utils.js";
  import Moon from "@lucide/svelte/icons/moon";
  import Sun from "@lucide/svelte/icons/sun";
  import { ModeWatcher, mode, toggleMode } from "mode-watcher";

  import "./layout.css";

  const sections = [
    { href: "/", label: "Active" },
    { href: "/sessions", label: "Sessions" },
    { href: "/logs", label: "Logs" },
    { href: "/config", label: "Config" },
    { href: "/diagnostics", label: "Diagnostics" }
  ] as const;
</script>

<ModeWatcher />

<div class="min-h-svh bg-background text-foreground">
  <header class="border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
    <div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
      <a class="font-semibold tracking-tight" href="/">EVS Studio</a>

      <nav class="flex items-center gap-1">
        {#each sections as s}
          <Button
            href={s.href}
            variant="ghost"
            size="sm"
            class={cn(
              "h-8 px-3",
              $page.url.pathname === s.href && "bg-accent text-accent-foreground"
            )}
          >
            {s.label}
          </Button>
        {/each}
      </nav>

      <div class="ml-auto flex items-center gap-2">
        <Input class="w-64" placeholder="Search (current section)" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          title="Toggle theme"
          onclick={toggleMode}
        >
          {#if mode.current === "dark"}
            <Sun class="size-4" />
          {:else}
            <Moon class="size-4" />
          {/if}
        </Button>
      </div>
    </div>
  </header>

  <main class="mx-auto max-w-6xl px-4 py-6">
    <slot />
  </main>
</div>
