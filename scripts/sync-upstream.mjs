#!/usr/bin/env bun
/**
 * sync-upstream.mjs — seamless upstream synchronization for the career-ops Bun fork.
 *
 * Automates pulling and merging changes from upstream (santifer/career-ops):
 *   1. Fetches latest changes from upstream remote.
 *   2. Merges upstream branch into the local Bun fork.
 *   3. Intelligently auto-resolves Node vs Bun merge conflicts.
 *   4. Runs bunify across all incoming/changed files.
 *   5. Guarantees CLI skill symlink integrity in Git index and working directory.
 *   6. Verifies syntax with `bun scripts/check-syntax.mjs`.
 *
 * Usage:
 *   bun scripts/sync-upstream.mjs                        # Sync from default upstream (origin/main)
 *   bun scripts/sync-upstream.mjs [remote] [branch]      # Sync from specific remote & branch
 *   bun scripts/sync-upstream.mjs --resolve-conflicts    # Auto-resolve existing conflicts & bunify
 *   bun scripts/sync-upstream.mjs --test                 # Run tests after syncing
 *   bun scripts/sync-upstream.mjs --dry-run              # Preview merge without committing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bunifyText, repairSkillSymlinks } from './bunify.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', ...opts });
  } catch (err) {
    if (opts.allowFail) return null;
    throw err;
  }
}

function runInherit(cmd, args = []) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

/**
 * Identify the upstream git remote.
 */
function getUpstreamRemote(userRemote) {
  if (userRemote) return userRemote;

  const remotesOutput = run('git remote -v', { allowFail: true }) || '';
  const lines = remotesOutput.split('\n');

  // Look for remote pointing to santifer/career-ops or career-ops-hq
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const [name, url] = parts;
      if (url.includes('santifer/career-ops') || url.includes('career-ops-hq/career-ops')) {
        return name;
      }
    }
  }

  // Fallback: check if 'upstream' exists, else 'origin'
  const remoteNames = run('git remote', { allowFail: true })?.split('\n').map(r => r.trim()).filter(Boolean) || [];
  if (remoteNames.includes('upstream')) return 'upstream';
  if (remoteNames.includes('origin')) return 'origin';
  return 'origin';
}

/**
 * Intelligent conflict resolution: resolves conflicts where upstream has 'node'
 * and local fork has 'bun', or applies bunify to upstream changes.
 */
export function resolveConflictsInFile(filePath) {
  const fullPath = join(ROOT, filePath);
  if (!existsSync(fullPath)) return { resolved: false, remaining: 0 };

  const content = readFileSync(fullPath, 'utf-8');
  if (!content.includes('<<<<<<<')) {
    return { resolved: true, remaining: 0 };
  }

  const lines = content.split('\n');
  const result = [];
  let inConflict = false;
  let headLines = [];
  let upstreamLines = [];
  let parsingUpstream = false;
  let remainingConflicts = 0;
  let resolvedConflicts = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      parsingUpstream = false;
      headLines = [];
      upstreamLines = [];
      continue;
    }

    if (line.startsWith('=======')) {
      parsingUpstream = true;
      continue;
    }

    if (line.startsWith('>>>>>>>')) {
      inConflict = false;
      const headText = headLines.join('\n');
      const upstreamText = upstreamLines.join('\n');

      // Check 1: Is HEAD text already the bunified version of upstream?
      const bunifiedUpstream = bunifyText(filePath, upstreamText);
      const bunifiedHead = bunifyText(filePath, headText);

      if (bunifiedUpstream === headText || bunifiedUpstream === bunifiedHead) {
        // Pure node-vs-bun conflict: keep bunified version
        result.push(bunifiedUpstream);
        resolvedConflicts++;
      } else if (filePath.endsWith('release.yml') && (upstreamText.includes('release-please') || headText.includes('release-please'))) {
        // Special case: preserve fork guard on release.yml
        let chosen = bunifiedUpstream;
        if (!chosen.includes("github.repository == 'santifer/career-ops'")) {
          chosen = chosen.replace(
            /(release-please:\s*\n)/,
            "$1    if: github.repository == 'santifer/career-ops'\n"
          );
        }
        result.push(chosen);
        resolvedConflicts++;
      } else if (bunifiedUpstream !== upstreamText && !headText.includes('// custom-fork-logic')) {
        // Upstream modified code with 'node'; adopt upstream's logic with bunification
        result.push(bunifiedUpstream);
        resolvedConflicts++;
      } else {
        // Genuine logical divergence that cannot be safely auto-resolved
        remainingConflicts++;
        result.push('<<<<<<< HEAD');
        result.push(headText);
        result.push('=======');
        result.push(upstreamText);
        result.push(line);
      }

      headLines = [];
      upstreamLines = [];
      continue;
    }

    if (inConflict) {
      if (parsingUpstream) {
        upstreamLines.push(line);
      } else {
        headLines.push(line);
      }
    } else {
      result.push(line);
    }
  }

  const newContent = result.join('\n');
  writeFileSync(fullPath, newContent, 'utf-8');

  return {
    resolved: remainingConflicts === 0,
    resolvedCount: resolvedConflicts,
    remaining: remainingConflicts,
  };
}

/**
 * Scan working copy for any files with merge conflict markers.
 */
function resolveAllConflicts() {
  const statusOutput = run('git status --porcelain', { allowFail: true }) || '';
  const conflictedFiles = statusOutput
    .split('\n')
    .filter(line => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('UD ') || line.startsWith('DU '))
    .map(line => line.slice(3).trim())
    .filter(Boolean);

  if (conflictedFiles.length === 0) {
    // Also check any file that might contain conflict markers
    const grepOutput = run('git diff --name-only', { allowFail: true }) || '';
    const modified = grepOutput.split('\n').map(f => f.trim()).filter(Boolean);
    for (const f of modified) {
      try {
        const txt = readFileSync(join(ROOT, f), 'utf-8');
        if (txt.includes('<<<<<<<')) conflictedFiles.push(f);
      } catch {}
    }
  }

  let totalResolved = 0;
  let unresolvedList = [];

  for (const file of conflictedFiles) {
    const res = resolveConflictsInFile(file);
    if (res.resolved) {
      totalResolved += res.resolvedCount;
      try {
        run(`git add "${file}"`);
      } catch {}
    } else {
      unresolvedList.push(file);
    }
  }

  return { conflictedFiles, totalResolved, unresolvedList };
}

/**
 * Main command execution.
 */
export function main() {
  const args = process.argv.slice(2);
  const isResolveOnly = args.includes('--resolve-conflicts');
  const isTest = args.includes('--test');
  const positional = args.filter(a => !a.startsWith('--'));

  const remote = getUpstreamRemote(positional[0]);
  const branch = positional[1] || 'main';

  console.log(`\n========================================`);
  console.log(` career-ops Bun Fork Upstream Sync`);
  console.log(`========================================\n`);

  if (isResolveOnly) {
    console.log(`Resolving merge conflicts...`);
    const { conflictedFiles, totalResolved, unresolvedList } = resolveAllConflicts();
    console.log(`Checked ${conflictedFiles.length} conflicted file(s). Auto-resolved: ${totalResolved} conflict block(s).`);

    // Bunify changed files
    runInherit('bun', ['scripts/bunify.mjs', '--changed']);
    repairSkillSymlinks(ROOT);

    if (unresolvedList.length > 0) {
      console.warn(`\n[!] ${unresolvedList.length} file(s) have logical conflicts requiring manual review:`);
      for (const f of unresolvedList) console.warn(`    - ${f}`);
      process.exit(1);
    }

    console.log(`\n✓ All conflicts resolved and bunified!`);
    return;
  }

  // 1. Verify working directory is clean
  const status = run('git status --porcelain', { allowFail: true })?.trim();
  if (status) {
    console.error(`[Error] Working directory has uncommitted changes. Please commit or stash before syncing:`);
    console.error(status);
    process.exit(1);
  }

  // 2. Fetch upstream
  console.log(`Fetching upstream from '${remote}/${branch}'...`);
  run(`git fetch ${remote} ${branch}`);

  const upstreamRef = `FETCH_HEAD`;

  // 3. Check if already up to date
  const headCommit = run('git rev-parse HEAD').trim();
  const upstreamCommit = run(`git rev-parse ${upstreamRef}`).trim();

  const isAncestor = run(`git merge-base --is-ancestor ${upstreamRef} HEAD`, { allowFail: true });
  if (isAncestor !== null) {
    console.log(`✓ Your fork is already up to date with ${remote}/${branch} (${upstreamCommit.slice(0, 7)}).`);
    repairSkillSymlinks(ROOT);
    return;
  }

  // 4. Attempt merge
  console.log(`Merging ${remote}/${branch} into current branch...`);
  let mergeFailed = false;
  try {
    run(`git merge --no-commit --no-ff ${upstreamRef}`);
    console.log(`Merge completed without Git conflicts.`);
  } catch (err) {
    mergeFailed = true;
    console.log(`Merge produced conflicts (expected for Node -> Bun transitions).`);
  }

  // 5. Auto-resolve conflicts
  if (mergeFailed) {
    console.log(`Auto-resolving Node vs Bun differences...`);
    const { conflictedFiles, totalResolved, unresolvedList } = resolveAllConflicts();
    console.log(`Auto-resolved ${totalResolved} conflict block(s) across ${conflictedFiles.length} file(s).`);

    if (unresolvedList.length > 0) {
      console.warn(`\n[!] ${unresolvedList.length} file(s) have non-trivial conflicts requiring manual review:`);
      for (const f of unresolvedList) console.warn(`    - ${f}`);
      console.log(`\nAfter reviewing, run:\n  bun scripts/bunify.mjs --staged\n  git commit`);
      process.exit(1);
    }
  }

  // 6. Bunify all changed files
  console.log(`Applying Bun runtime transformations to updated files...`);
  runInherit('bun', ['scripts/bunify.mjs', '--changed']);

  // 7. Enforce symlinks
  console.log(`Verifying CLI skill symlinks integrity...`);
  const repairs = repairSkillSymlinks(ROOT);
  if (repairs.length > 0) {
    console.log(`Repaired ${repairs.length} symlink pointer(s).`);
  }

  // 8. Run syntax check
  console.log(`\nRunning syntax check...`);
  const syntaxCheck = runInherit('bun', ['scripts/check-syntax.mjs']);
  if (syntaxCheck.status !== 0) {
    console.error(`\n[!] Syntax check failed. Please review errors above.`);
    process.exit(1);
  }

  // 9. Optional test suite run
  if (isTest) {
    console.log(`\nRunning quick test suite...`);
    runInherit('bun', ['test-all.mjs', '--quick']);
  }

  console.log(`\n========================================`);
  console.log(`✓ Upstream sync successful!`);
  console.log(`========================================`);
  console.log(`Next steps:`);
  console.log(`  1. Review changes: git diff --stat --staged`);
  console.log(`  2. Commit merge:   git commit -m "chore: merge upstream into bun fork"`);
  console.log(`  3. Push to fork:   git push fork main\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
