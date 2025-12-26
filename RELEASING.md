# Releasing EverSession

Releases are automated via GitHub Actions + Changesets.

## Prerequisites

1. Set `NPM_TOKEN` in GitHub repository secrets (npm automation token with publish rights).
2. In repo settings, enable: “Allow GitHub Actions to create and approve pull requests”.

## Normal release flow

1. Create a changeset:

```bash
pnpm changeset
```

2. Commit and push to `main` (or merge a PR that includes the changeset).
3. The **Release** workflow will open/update a “Version Packages” PR.
4. Merge that PR → GitHub Actions publishes to npm and creates a GitHub Release.

## Snapshot releases (manual)

Use GitHub Actions → **Release Snapshot** to publish a `snapshot`/`alpha`/`beta` tag from any branch.
