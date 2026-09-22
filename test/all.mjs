/**
 * Run every Redline suite in sequence and summarise.
 *
 *   npm test            (or: node test/all.mjs [--headed] [--skip-watcher])
 *
 * Suites: model tests (node:test), the real-browser acceptance suite and the
 * feature suites beside it, and the mocked reload-watcher tests (PowerShell 7). Browser suites need `npm install` and
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
  ['workspace and drawing browser', process.execPath, [path.join(HERE, 'workspace-browser.mjs'), ...passthrough]],
  ['fill retention and clean capture browser', process.execPath, [path.join(HERE, 'fill-capture-browser.mjs'), ...passthrough]],
  ['click-to-type browser', process.execPath, [path.join(HERE, 'text-browser.mjs'), ...passthrough]],
  ['rectangle direct-label browser', process.execPath, [path.join(HERE, 'rectangle-label-browser.mjs'), ...passthrough]],
  ['shape text and direct selection browser', process.execPath, [path.join(HERE, 'shape-edit-browser.mjs'), ...passthrough]],
  ['bullets and legend browser', process.execPath, [path.join(HERE, 'legend-browser.mjs'), ...passthrough]],
  ['long legend text browser', process.execPath, [path.join(HERE, 'legend-long-text-browser.mjs'), ...passthrough]],
  ['pointer, report, preview and capture browser', process.execPath, [path.join(HERE, 'export-browser.mjs'), ...passthrough]],
  ['reload recovery browser', process.execPath, [path.join(HERE, 'recovery-browser.mjs'), ...passthrough]],
  ['closing and recovery failure browser', process.execPath, [path.join(HERE, 'recovery-failures-browser.mjs'), ...passthrough]],
  ['page eyedropper browser', process.execPath, [path.join(HERE, 'eyedropper-browser.mjs'), ...passthrough]],
  ['mode layout preservation', process.execPath, [path.join(HERE, 'mode-layout-browser.mjs'), ...passthrough]],
  ['selection handles and rotation browser', process.execPath, [path.join(HERE, 'transform-browser.mjs'), ...passthrough]],
  ['full-page capture and consolidated menu', process.execPath, [path.join(HERE, 'fullpage-browser.mjs'), ...passthrough]],
];
if (!process.argv.includes('--skip-watcher')) {
  suites.push(['reload watcher (mocked)', 'pwsh', ['-NoProfile', '-File', path.join(HERE, 'watch-reload.test.ps1')]]);
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
