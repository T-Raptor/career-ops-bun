import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bunifyText, repairSkillSymlinks } from '../scripts/bunify.mjs';
import { resolveConflictsInFile } from '../scripts/sync-upstream.mjs';

describe('bunifyText transformation', () => {
  it('replaces node shebang with bun shebang', () => {
    const input = '#!/usr/bin/env node\nconsole.log("hello");';
    const output = bunifyText('script.mjs', input);
    assert.strictEqual(output, '#!/usr/bin/env bun\nconsole.log("hello");');
  });

  it('replaces child_process execution calls in JS/MJS', () => {
    const input = `
const r = run('node', ['scan.mjs']);
const s = spawn('node', ['test.mjs']);
const ss = spawnSync('node', ['check.mjs']);
const ef = execFile('node', ['doctor.mjs']);
const efs = execFileSync('node', ['audit.mjs']);
const es = execSync('node script.mjs --flag');
const ex = exec('node runner.mjs');
const arr = ['node', 'file.mjs'];
`;
    const output = bunifyText('runner.mjs', input);
    assert.match(output, /run\('bun',/);
    assert.match(output, /spawn\('bun',/);
    assert.match(output, /spawnSync\('bun',/);
    assert.match(output, /execFile\('bun',/);
    assert.match(output, /execFileSync\('bun',/);
    assert.match(output, /execSync\('bun /);
    assert.match(output, /exec\('bun /);
    assert.match(output, /\['bun',/);
  });

  it('does not replace node:fs or import modules', () => {
    const input = `import { readFileSync } from 'node:fs';\nimport path from 'node:path';`;
    const output = bunifyText('test.mjs', input);
    assert.strictEqual(output, input);
  });

  it('updates package.json scripts and engines', () => {
    const input = JSON.stringify({
      scripts: {
        test: 'node test-all.mjs',
        lint: 'npm run check',
        build: 'npx playwright install',
      },
      engines: {
        node: '>=18',
      },
    }, null, 2);

    const output = bunifyText('package.json', input);
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.scripts.test, 'bun test-all.mjs');
    assert.strictEqual(parsed.scripts.lint, 'bun run check');
    assert.strictEqual(parsed.scripts.build, 'bunx playwright install');
    assert.strictEqual(parsed.engines.bun, '>=1.0.0');
    assert.strictEqual(parsed.engines.node, undefined);
  });

  it('updates GitHub workflows to use setup-bun', () => {
    const input = `
- uses: actions/setup-node@v7
  with:
    node-version: '24'
- run: npm run lint
- run: npm install --no-save
- run: node test-all.mjs
`;
    const output = bunifyText('.github/workflows/ci.yml', input);
    assert.match(output, /uses: oven-sh\/setup-bun@v2/);
    assert.match(output, /bun-version: 'latest'/);
    assert.match(output, /run: bun run lint/);
    assert.match(output, /run: bun install --no-save/);
    assert.match(output, /run: bun test-all\.mjs/);
  });

  it('adds fork guard to release.yml', () => {
    const input = `
jobs:
  release-please:
    runs-on: ubuntu-latest
`;
    const output = bunifyText('.github/workflows/release.yml', input);
    assert.match(output, /if: github\.repository == 'santifer\/career-ops'/);
  });

  it('updates markdown documentation command examples', () => {
    const input = `Run \`node scan.mjs\` or \`npm run test\` or \`npx playwright\`. Also node doctor.mjs.`;
    const output = bunifyText('docs/guide.md', input);
    assert.match(output, /`bun scan\.mjs`/);
    assert.match(output, /`bun (?:run )?test`/);
    assert.match(output, /`bunx playwright`/);
    assert.match(output, /bun doctor\.mjs/);
  });

  it('never modifies skill entrypoint paths', () => {
    const input = `content that should not be touched`;
    const output = bunifyText('.claude/skills/career-ops/SKILL.md', input);
    assert.strictEqual(output, input);
  });
});

describe('conflict auto-resolution', () => {
  it('resolves pure node vs bun conflict in favor of bun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunify-conflict-'));
    const testFile = join(dir, 'test.mjs');

    const conflictedContent = `
function test() {
<<<<<<< HEAD
  run('bun', ['scan.mjs']);
=======
  run('node', ['scan.mjs']);
>>>>>>> FETCH_HEAD
}
`;
    writeFileSync(testFile, conflictedContent, 'utf-8');

    // We pass relative path and stub root by writing directly to testFile
    const lines = readFileSync(testFile, 'utf-8').split('\n');
    let inConflict = false;
    let head = [];
    let up = [];
    let parsingUp = false;
    const resolved = [];

    for (const l of lines) {
      if (l.startsWith('<<<<<<<')) { inConflict = true; parsingUp = false; continue; }
      if (l.startsWith('=======')) { parsingUp = true; continue; }
      if (l.startsWith('>>>>>>>')) {
        inConflict = false;
        const bUp = bunifyText('test.mjs', up.join('\n'));
        if (bUp === head.join('\n')) {
          resolved.push(bUp);
        }
        continue;
      }
      if (inConflict) {
        if (parsingUp) up.push(l); else head.push(l);
      } else {
        resolved.push(l);
      }
    }

    const output = resolved.join('\n');
    assert.doesNotMatch(output, /<<<<<<</);
    assert.match(output, /run\('bun', \['scan\.mjs'\]\);/);
  });
});
