/**
 * Helpers shared by the browser suites: overlay access, real-input
 * clicks, imports and downloads, PNG sampling, and tab/capture control through
 * the test build's service worker.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { waitUntil } from './harness.mjs';

export const html = (title, background, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
  + `<body style="margin:0;background:${background};font:16px sans-serif">${body}</body></html>`;

export const bullet = (id, label, x, y, text) => ({ id, type: 'bullet', label, color: '#1D4ED8', width: 1.333, point: { x, y }, ...(text ? { text } : {}) });
export const EXPLANATION = 'Hostile <script>alert("x")</script> & \'quotes\'\n  second line keeps spaces  \n\nafter a blank line';

export function helpers({ page, access, scratch }) {
  const { evaluate, importFile } = access;
  const root = fn => evaluate(fn);
  const idle = () => waitUntil(() => evaluate(() => !globalThis.__redlineTestRoot.querySelector('[data-redline-root]').hasAttribute('data-busy')), 'not busy', 30000);
  const rect = selector => evaluate(value => {
    const node = globalThis.__redlineTestRoot.querySelector(value);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom, visible: node.checkVisibility() };
  }, selector);
  const press = async selector => {
    const box = await rect(selector);
    if (!box?.visible || !box.width) throw new Error(`Not clickable: ${selector}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const click = selector => evaluate(value => globalThis.__redlineTestRoot.querySelector(value).click(), selector);
  const message = () => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent);
  const target = () => evaluate(() => globalThis.__redlineTestRoot.querySelector('[data-redline-target]').textContent);
  const active = () => evaluate(() => {
    const element = globalThis.__redlineTestRoot.activeElement;
    return element ? (element.dataset.redlineAction ?? element.dataset.previewAction ?? element.getAttribute('aria-label') ?? element.tagName) : null;
  });
  const cursorAt = () => evaluate(() => {
    const polygon = globalThis.__redlineTestRoot.querySelector('[data-redline-cursor] polygon:last-of-type');
    if (!polygon) return null;
    const [x, y] = polygon.getAttribute('points').split(' ')[0].split(',').map(Number);
    const screen = new DOMPoint(x, y).matrixTransform(polygon.getScreenCTM());
    return { x, y, screenX: screen.x, screenY: screen.y };
  });
  let loads = 0;
  const load = async (document, name = 'doc') => {
    const file = path.join(scratch, `${name}-${++loads}.json`);
    await fs.writeFile(file, JSON.stringify({ format: 'open-redline', version: 1, document }));
    await evaluate(() => { globalThis.__redlineTestRoot.querySelector('[data-redline-message]').textContent = ''; });
    await importFile(file);
    await waitUntil(async () => /Imported|not supported|must|Unsupported|Invalid|cursor/.test(await message()), `import ${name}`);
    return message();
  };
  let saved = 0;
  const download = async (trigger, timeout = 30000) => {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout }), trigger()])
      .catch(async error => { throw new Error(`${error.message.split(/\r?\n/)[0]} — Redline said: ${await message()}`); });
    const destination = path.join(scratch, `${++saved}-${file.suggestedFilename()}`);
    await file.saveAs(destination);
    await idle();
    return { name: file.suggestedFilename(), buffer: await fs.readFile(destination) };
  };
  const exportJSON = async () => JSON.parse((await download(() => click('[data-redline-action="json"]'))).buffer.toString('utf8'));
  const exportPNG = async () => (await download(() => click('[data-redline-action="download"]'))).buffer;
  /** Activate a command-strip action with the keyboard only. */
  const menuByKeyboard = async action => {
    await evaluate(value => globalThis.__redlineTestRoot.querySelector(`[data-redline-toolbar] [data-redline-action="${value}"]`).focus(), action);
    await page.keyboard.press('Enter');
  };
  const pixels = (buffer, points) => evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, samples: points.map(([x, y]) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data]) };
  }, { base64: buffer.toString('base64'), points });
  const imageDigest = buffer => evaluate(async base64 => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
    return `${image.width}x${image.height}:${hash}`;
  }, buffer.toString('base64'));
  const canvasDigest = selector => evaluate(value => {
    const canvas = globalThis.__redlineTestRoot.querySelector(value);
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
    return `${canvas.width}x${canvas.height}:${hash}`;
  }, selector);
  return { root, idle, rect, press, click, message, target, active, cursorAt, load, download, exportJSON, exportPNG, menuByKeyboard, pixels, imageDigest, canvasDigest };
}

export const dark = pixel => pixel[0] + pixel[1] + pixel[2] < 200;
export const white = pixel => pixel.slice(0, 3).every(value => value > 232);
export const near = (a, b, tolerance = 0.75) => Math.abs(a - b) <= tolerance;

export async function tabIdFor(worker, url) {
  return worker.evaluate(async value => (await chrome.tabs.query({})).find(tab => tab.url === value)?.id, url);
}
export const activate = (worker, tabId) => worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
export async function setCaptureDelay(worker, ms) {
  await worker.evaluate(delay => {
    if (!globalThis.__redlineDelayInstalled) {
      const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      chrome.tabs.captureVisibleTab = async (...args) => {
        const wait = globalThis.__redlineCaptureDelay ?? 0;
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        return original(...args);
      };
      globalThis.__redlineDelayInstalled = true;
    }
    globalThis.__redlineCaptureDelay = delay;
  }, ms);
}
