# Maintaining the Bun Fork

This repository is a Bun-native fork of [santifer/career-ops](https://github.com/santifer/career-ops).

It runs entirely under the [Bun](https://bun.sh) runtime instead of Node.js, providing faster script execution and test runs without requiring separate Node installations.

---

## Quick Start: Pulling Upstream Changes

When upstream releases a new version or adds new features, syncing your fork takes a single command:

```bash
bun run sync-upstream
```

Or run the script directly:

```bash
bun scripts/sync-upstream.mjs
```

### What `sync-upstream` Does Automatically

1. **Fetches Upstream:** Pulls the latest commits from the upstream remote (defaults to `origin/main` or `upstream/main`).
2. **Merges Upstream:** Initiates `git merge` into your current branch.
3. **Auto-Resolves Node vs Bun Conflicts:** Upstream changes that conflict purely due to `node` vs `bun` syntax (such as process execution calls or CLI invocations) are auto-resolved to Bun equivalents.
4. **Transforms New Files (`bunify`):** Any newly added or updated upstream files are automatically transformed to Bun conventions.
5. **Protects CLI Skill Symlinks:** Enforces Git mode `120000` and points the 7 CLI skill entrypoints to the canonical 43-byte pointer (`../../../.agents/skills/career-ops/SKILL.md`), preventing Windows path length issues.
6. **Validates Syntax:** Automatically executes `bun scripts/check-syntax.mjs`.

If there are non-trivial logical conflicts, the script leaves conflict markers in place and lists the files that require manual inspection.

---

## Standalone Tools

### 1. `bun run bunify` (`scripts/bunify.mjs`)

You can run `bunify` at any time to audit or apply Bun transformations across the repository:

```bash
# Preview files that need bunification without modifying:
bun scripts/bunify.mjs --check

# Bunify all modified/uncommitted files:
bun scripts/bunify.mjs --changed

# Bunify staged files only:
bun scripts/bunify.mjs --staged

# Bunify specific files:
bun scripts/bunify.mjs scan.mjs modes/scan.md

# Bunify the entire repository:
bun scripts/bunify.mjs --all
```

#### What Transformations Are Applied:
- **Shebangs:** `#!/usr/bin/env node` → `#!/usr/bin/env bun`
- **Child Process Calls:** `run('node', ...)` → `run('bun', ...)`, `spawn('node')` → `spawn('bun')`, `execSync('node ...')` → `execSync('bun ...')`
- **Package Scripts:** `package.json` scripts updated to use `bun` and `bunx`
- **CI Workflows:** `.github/workflows/*.yml` converted to use `oven-sh/setup-bun@v2` with `bun-version: 'latest'`
- **Release Safety:** Retains `if: github.repository == 'santifer/career-ops'` in `.github/workflows/release.yml` so fork CI doesn't attempt upstream releases
- **Symlink Invariant:** Never overwrites symlinks with file contents; guarantees git mode `120000` and relative pointer integrity

### 2. Manual Conflict Resolution Helper

If you started a git merge or rebase manually and hit conflicts:

```bash
bun scripts/sync-upstream.mjs --resolve-conflicts
```

This scans all unmerged files, resolves the Node vs Bun differences, runs `bunify`, and stages the resolved files.

---

## Pushing Changes to Your Fork

Once the sync and tests complete:

```bash
# 1. Verify quick test suite
bun test-all.mjs --quick

# 2. Commit the merge
git commit -m "chore: merge upstream vX.Y.Z into bun fork"

# 3. Push to your fork
git push fork main
```
