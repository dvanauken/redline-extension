/**
 * Shared browser harness for the Redline acceptance suites.
 *
 * Builds a temporary copy of the extension, serves the fixture over http, and
 * launches Chromium with an isolated temporary profile. The copy adds a broad
 * host permission because Playwright cannot click a toolbar icon to trigger
 * the real activeTab grant; the shipped manifest keeps activeTab only.
 * The user's ordinary browser and profile are never touched.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { createOverlayAccess } from './browser-access.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE = path.dirname(HERE);
const EXCLUDED = ['test', '.git', '.chrome-redline-profile', 'node_modules', '.codestring', 'test-artifacts'];

export async function loadPlaywright() {
  try {
    const module = await import('playwright');
    return module.default ?? module;
  } catch {
    console.error('This suite needs Playwright. Run: npm install && npm run setup:browser');
    process.exit(2);
  }
}

export async function buildExtensionCopy(scratch) {
  const ext = path.join(scratch, 'ext-test');
  await fs.cp(SOURCE, ext, {
    recursive: true,
    filter: src => !EXCLUDED.some(name => path.relative(SOURCE, src).split(path.sep).includes(name)),
  });
  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.name = 'Redline (test build)';
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return ext;
}

/**
 * Serve the fixture (and any extra routes) on 127.0.0.1. A route is an HTML
 * string or Buffer, or `{ body, headers }` for a page that needs response
 * headers such as a Permissions-Policy.
 */
export async function startServer(routes = {}) {
  const fixtureHtml = await fs.readFile(path.join(HERE, 'fixture.html'));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const route = routes[pathname] ?? fixtureHtml;
    const { body, headers = {} } = typeof route === 'string' || Buffer.isBuffer(route) ? { body: route } : route;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function launch({ viewport = { width: 1200, height: 800 }, deviceScaleFactor = 1, showScrollbars = false, headed = process.argv.includes('--headed') } = {}) {
  const { chromium } = await loadPlaywright();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-test-'));
  const ext = await buildExtensionCopy(scratch);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !headed,
    ignoreDefaultArgs: showScrollbars ? ['--hide-scrollbars'] : undefined,
    acceptDownloads: true,
    viewport,
    deviceScaleFactor,
    args: [
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--force-device-scale-factor=${deviceScaleFactor}`,
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  return { context, worker, scratch };
}

export async function waitUntil(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out: ' + message);
}

export function createChecker() {
  const results = [];
  const check = (name, condition, detail = '') => {
    results.push({ name, pass: !!condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -- ' + detail : ''}`);
  };
  return { results, check };
}

/**
 * Inject the bootstrap into a page's tab and attach test-world access to the
 * closed root. Pass `tabId` when several tabs show the same address.
 */
export async function openRedline({ context, worker, page, tabId: knownTab = null }) {
  const tabId = knownTab ?? await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === url)?.id;
  }, page.url());
  const inject = () => worker.evaluate(async id => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
  }, tabId);
  await inject();
  await waitUntil(() => page.evaluate(() => Boolean(document.querySelector('[data-redline-extension]'))), 'overlay host mounted', 10000);
  const access = await createOverlayAccess(context, page);
  await waitUntil(() => access.evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-root]')?.open), 'overlay opened', 10000);
  return { ...access, inject, tabId };
}

/** Decode a PNG in the page and sample pixels at CSS-pixel coordinates. */
export async function samplePng(evaluate, buffer, points) {
  return evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const sx = image.width / innerWidth;
    const sy = image.height / innerHeight;
    return points.map(([x, y]) => [...ctx.getImageData(Math.round(x * sx), Math.round(y * sy), 1, 1).data]);
  }, { base64: buffer.toString('base64'), points });
}
