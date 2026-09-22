/**
 * Run every Redline suite in sequence and summarise.
 *
 *   npm test            (or: node test/all.mjs [--headed] [--skip-watcher])
 *
 * Suites: model tests (node:test), the original real-browser acceptance suite,
 * the Phase 1, Phase 2 and Phase 3 real-browser suites, and the mocked
 * reload-watcher tests (PowerShell 7). Browser suites need `npm install` and
 * `npm run setup:browser`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.includes('--headed') ? ['--headed'] : [];
const modelTests = fs.readdirSync(HERE).filter(name => name.endsWith('.test.mjs')).map(name => path.join(HERE, name));

const suites = [
  ['model', process.execPath, ['--test', ...modelTests]],
  ['browser acceptance', process.execPath, [path.join(HERE, 'run.mjs'), ...passthrough]],
  ['phase 1 browser', process.execPath, [path.join(HERE, 'phase1-browser.mjs'), ...passthrough]],
  ['phase 1 lead review', process.execPath, [path.join(HERE, 'phase1-review-browser.mjs'), ...passthrough]],
  ['click-to-type browser', process.execPath, [path.join(HERE, 'text-browser.mjs'), ...passthrough]],
  ['rectangle direct-label browser', process.execPath, [path.join(HERE, 'rectangle-label-browser.mjs'), ...passthrough]],
  ['shape text and direct selection browser', process.execPath, [path.join(HERE, 'shape-edit-browser.mjs'), ...passthrough]],
  ['phase 2 bullets and legend browser', process.execPath, [path.join(HERE, 'phase2-browser.mjs'), ...passthrough]],
  ['phase 2 lead review', process.execPath, [path.join(HERE, 'phase2-review-browser.mjs'), ...passthrough]],
  ['phase 3 pointer, report, preview and capture browser', process.execPath, [path.join(HERE, 'phase3-browser.mjs'), ...passthrough]],
  ['phase 3 reload recovery browser', process.execPath, [path.join(HERE, 'phase3-recovery-browser.mjs'), ...passthrough]],
  ['phase 3 lead review', process.execPath, [path.join(HERE, 'phase3-review-browser.mjs'), ...passthrough]],
  ['page eyedropper browser', process.execPath, [path.join(HERE, 'eyedropper-browser.mjs'), ...passthrough]],
  ['mode layout preservation', process.execPath, [path.join(HERE, 'mode-layout-browser.mjs'), ...passthrough]],
  ['selection handles and rotation browser', process.execPath, [path.join(HERE, 'transform-browser.mjs'), ...passthrough]],
  ['full-page capture and consolidated menu', process.execPath, [path.join(HERE, 'fullpage-browser.mjs'), ...passthrough]],
];
if (!process.argv.includes('--skip-watcher')) {
  suites.push(['reload watcher (mocked)', 'pwsh', ['-NoProfile', '-File', path.join(HERE, 'watch-reload.ps1')]]);
}

const summary = [];
for (const [name, command, args] of suites) {
  console.log(`\n=== ${name} ===`);
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: path.dirname(HERE) });
  const ok = result.status === 0;
  summary.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000), error: result.error?.message });
}

console.log('\n=== summary ===');
for (const { name, ok, seconds, error } of summary) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${seconds}s)${error ? ` — ${error}` : ''}`);
}
process.exit(summary.every(item => item.ok) ? 0 : 1);
