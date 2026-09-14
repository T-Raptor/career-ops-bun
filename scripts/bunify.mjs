#!/usr/bin/env bun
/**
 * bunify.mjs — automated runtime transformation for the career-ops Bun fork.
 *
 * Transforms upstream Node/npm conventions into Bun equivalents:
 *   - Shebangs: #!/usr/bin/env node -> #!/usr/bin/env bun
 *   - Child process execution: run('node') -> run('bun'), spawn('node') -> spawn('bun'), etc.
 *   - Command examples & docs: `node <script>.mjs` -> `bun <script>.mjs`
 *   - package.json: scripts use bun/bunx
 *   - Workflows: setup-bun action, bun install, fork repository guards
 *   - CRITICAL: Symlink protection — ensures the 7 CLI skill entrypoints retain
 *     mode 120000 and the canonical 43-byte pointer in git.
 *
 * Usage:
 *   bun scripts/bunify.mjs                  # Bunify all modified/tracked files
 *   bun scripts/bunify.mjs --all            # Bunify all repository files
 *   bun scripts/bunify.mjs --staged         # Bunify staged files only
 *   bun scripts/bunify.mjs --changed        # Bunify uncommitted changes
 *   bun scripts/bunify.mjs --check          # Dry-run; exit 1 if files need bunifying
 *   bun scripts/bunify.mjs <file...>        # Bunify specific files
 */

import { readFileSync, writeFileSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_ENTRYPOINTS } from '../scaffolder/bin/skill-entrypoints.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');

const POINTER_HASH = '82b454738b2a048650713a9e6a9f502e156c0440';
const POINTER_TARGET = '../../../.agents/skills/career-ops/SKILL.md';

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'output',
  'data',
  'coverage',
  'test-results',
  'scratch',
]);

const EXCLUDE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff2', '.pdf', '.db', '.sqlite',
  '.zip', '.tar', '.gz', '.tgz'
]);

const SKILL_PATHS = new Set(SKILL_ENTRYPOINTS.map((e) => e.path));

/**
 * Transform text content from Node to Bun runtime conventions.
 */
export function bunifyText(filePath, content) {
  // Normalize relative path with forward slashes
  const rel = filePath.replace(/\\/g, '/');

  // Never touch symlinks or skill entrypoints as regular text
  if (SKILL_PATHS.has(rel)) return content;

  let text = content;

  // 1. Shebang
  text = text.replace(/^#!\s*\/usr\/bin\/(?:env\s+)?node\b/m, '#!/usr/bin/env bun');

  // 2. package.json handling
  if (rel === 'package.json' || rel.endsWith('/package.json')) {
    try {
      const parsed = JSON.parse(text);
      let changed = false;
      if (parsed.scripts) {
        for (const [k, v] of Object.entries(parsed.scripts)) {
          if (typeof v === 'string') {
            const nv = v
              .replace(/\bnode\s+/g, 'bun ')
              .replace(/\bnpx\s+/g, 'bunx ')
              .replace(/\bnpm\s+run\s+/g, 'bun run ')
              .replace(/\bnpm\s+test\b/g, 'bun test');
            if (nv !== v) {
              parsed.scripts[k] = nv;
              changed = true;
            }
          }
        }
      }
      if (parsed.engines && parsed.engines.node) {
        delete parsed.engines.node;
        parsed.engines.bun = '>=1.0.0';
        changed = true;
      }
      if (changed) {
        return JSON.stringify(parsed, null, 2) + '\n';
      }
    } catch {
      // If JSON parse fails, fallback to regex
    }
  }

  // 3. JavaScript / TypeScript / MJS
  if (rel.endsWith('.mjs') || rel.endsWith('.js') || rel.endsWith('.ts') || rel.endsWith('.tsx')) {
    // Process spawning
    text = text.replace(/\brun\(\s*['"]node['"]\s*,/g, "run('bun',");
    text = text.replace(/\bspawn\(\s*['"]node['"]\s*,/g, "spawn('bun',");
    text = text.replace(/\bspawnSync\(\s*['"]node['"]\s*,/g, "spawnSync('bun',");
    text = text.replace(/\bexecFile\(\s*['"]node['"]\s*,/g, "execFile('bun',");
    text = text.replace(/\bexecFileSync\(\s*['"]node['"]\s*,/g, "execFileSync('bun',");
    text = text.replace(/\[\s*['"]node['"]\s*,/g, "['bun',");

    // Command strings in exec / execSync
    text = text.replace(/\bexecSync\(\s*['"]node\s+/g, "execSync('bun ");
    text = text.replace(/\bexecSync\(\s*`node\s+/g, "execSync(`bun ");
    text = text.replace(/\bexec\(\s*['"]node\s+/g, "exec('bun ");
    text = text.replace(/\bexec\(\s*`node\s+/g, "exec(`bun ");

    // Script CLI commands in help strings / comments / logs
    text = text.replace(/\bnode\s+([a-zA-Z0-9_\-\.\/]+\.mjs)\b/g, 'bun $1');
    text = text.replace(/\bnode\s+([a-zA-Z0-9_\-\.\/]+\.js)\b/g, 'bun $1');
    text = text.replace(/\bnpm\s+run\s+([a-zA-Z0-9_\-]+)\b/g, 'bun run $1');
    text = text.replace(/\bnpm\s+test\b/g, 'bun test');
    text = text.replace(/\bnpx\s+([a-zA-Z0-9_\-\@\/]+)\b/g, 'bunx $1');
  }

  // 4. GitHub Actions Workflows
  if (rel.includes('.github/workflows/')) {
    text = text.replace(/uses:\s*actions\/setup-node@v\d+/g, 'uses: oven-sh/setup-bun@v2');
    text = text.replace(/node-version:\s*['"]?\d+['"]?/g, "bun-version: 'latest'");
    text = text.replace(/(\brun:\s*)npm\s+run\s+/g, '$1bun run ');
    text = text.replace(/(\brun:\s*)npm\s+install\s+/g, '$1bun install ');
    text = text.replace(/(\brun:\s*)npm\s+install$/gm, '$1bun install');
    text = text.replace(/(\brun:\s*)node\s+/g, '$1bun ');
    text = text.replace(/(\brun:\s*)npx\s+/g, '$1bunx ');

    // Release workflow guard for fork safety
    if (rel.endsWith('release.yml') && !text.includes("github.repository == 'santifer/career-ops'")) {
      text = text.replace(
        /(jobs:\s*\n\s*release-please:\s*\n)/,
        "$1    if: github.repository == 'santifer/career-ops'\n"
      );
    }
  }

  // 5. Documentation & Markdown files
  if (rel.endsWith('.md')) {
    text = text.replace(/`node\s+([a-zA-Z0-9_\-\.\/]+\.mjs)/g, '`bun $1');
    text = text.replace(/`node\s+([a-zA-Z0-9_\-\.\/]+\.js)/g, '`bun $1');
    text = text.replace(/`npm\s+run\s+([a-zA-Z0-9_\-]+)`/g, '`bun run $1`');
    text = text.replace(/`npm\s+test`/g, '`bun test`');
    text = text.replace(/`npx\s+([a-zA-Z0-9_\-\@\/]+)/g, '`bunx $1');
    text = text.replace(/\bnode\s+([a-zA-Z0-9_\-]+\.mjs)\b/g, 'bun $1');
    text = text.replace(/\bnpm\s+run\s+([a-zA-Z0-9_\-]+)\b/g, 'bun run $1');
  }

  return text;
}

/**
 * Enforce that all 7 CLI skill entrypoints are valid symlinks in Git with mode 120000.
 */
export function repairSkillSymlinks(root = ROOT) {
  const repairs = [];
  for (const entry of SKILL_ENTRYPOINTS) {
    const fullPath = join(root, ...entry.path.split('/'));

    // Check git index status
    let staged = null;
    try {
      const output = execSync(`git ls-files -s "${entry.path}"`, {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (output) {
        const [mode, sha] = output.split(/\s+/);
        staged = { mode, sha };
      }
    } catch {
      // not a git repo or lookup failed
    }

    const needsIndexFix = !staged || staged.mode !== '120000' || staged.sha !== POINTER_HASH;

    // Check disk content
    let contentOnDisk = '';
    try {
      if (existsSync(fullPath)) {
        contentOnDisk = readFileSync(fullPath, 'utf-8');
      }
    } catch {
      // unreadable
    }

    const needsDiskFix = contentOnDisk !== POINTER_TARGET;

    if (needsIndexFix || needsDiskFix) {
      try {
        writeFileSync(fullPath, POINTER_TARGET, { encoding: 'ascii' });
        execSync(`git update-index --cacheinfo 120000 ${POINTER_HASH} "${entry.path}"`, {
          cwd: root,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        repairs.push(entry.path);
      } catch (err) {
        console.warn(`[warn] Could not repair symlink for ${entry.path}: ${err.message}`);
      }
    }
  }
  return repairs;
}

/**
 * Collect candidate files to process.
 */
function collectFiles(root, mode, explicitFiles = []) {
  if (explicitFiles.length > 0) {
    return explicitFiles
      .map((f) => relative(root, join(root, f)).replace(/\\/g, '/'))
      .filter((f) => existsSync(join(root, f)));
  }

  if (mode === 'staged') {
    try {
      const output = execSync('git diff --name-only --cached', { cwd: root, encoding: 'utf-8' });
      return output.split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  if (mode === 'changed') {
    try {
      const output = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf-8' });
      return output.split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  // Walk all candidate files in repository
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = relative(root, full).replace(/\\/g, '/');
        const ext = '.' + rel.split('.').pop();
        if (EXCLUDE_EXTENSIONS.has(ext)) continue;
        if (SKILL_PATHS.has(rel)) continue;
        files.push(rel);
      }
    }
  };

  walk(root);
  return files.sort();
}

/**
 * Main CLI entrypoint.
 */
export function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const isAll = args.includes('--all');
  const isStaged = args.includes('--staged');
  const isChanged = args.includes('--changed');
  const explicit = args.filter((a) => !a.startsWith('--'));

  const mode = isStaged ? 'staged' : isChanged ? 'changed' : isAll ? 'all' : (explicit.length > 0 ? 'explicit' : 'all');

  const files = collectFiles(ROOT, mode, explicit);
  let changedFiles = 0;

  for (const rel of files) {
    const full = join(ROOT, rel);
    let original = null;
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      original = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }

    const transformed = bunifyText(rel, original);
    if (transformed !== original) {
      changedFiles++;
      if (isCheck) {
        console.log(`Needs bunify: ${rel}`);
      } else {
        writeFileSync(full, transformed, 'utf-8');
        console.log(`Bunified: ${rel}`);
      }
    }
  }

  // Check and repair symlinks
  if (!isCheck) {
    const repaired = repairSkillSymlinks(ROOT);
    if (repaired.length > 0) {
      console.log(`Repaired ${repaired.length} skill symlink entrypoints in git index.`);
    }
  }

  if (isCheck && changedFiles > 0) {
    console.error(`\n${changedFiles} file(s) require bunification.`);
    process.exit(1);
  }

  console.log(`\n✓ Bunify complete (${changedFiles} file(s) updated).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
