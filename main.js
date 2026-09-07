/**
 * Redline extension host integration.
 *
 * Runs in the content script's isolated world. It owns exactly one
 * RedlineOverlay per frame and supplies the adapters the overlay expects from a
 * host application. There is no host application here, so this module plays
 * that role: shadow-DOM isolation instead of an app shell, extension capture
 * instead of an app renderer, and native <dialog> instead of an app dialog
 * service.
 */

import { RedlineOverlay } from './redline/index.js';
import { HostDialogs, HOST_DIALOG_CSS } from './host-dialogs.js';
import { createColorPicker, COLOR_PICKER_CSS } from './color-picker.js';

const CAPTURE_MESSAGE = 'redline:capture';
const PREFERENCES_KEY = 'redline.preferences';

/**
 * Base styles for the shadow root.
 *
 * The shadow host is `all: initial`, which stops every inheritable page style
 * at the boundary but also leaves the overlay with initial fonts and colors.
 * These rules restore a sane baseline; redline.css is adopted afterwards and
 * therefore still wins every rule it declares.
 */
const BASE_CSS = `
:host { all: initial; }
[data-redline-root],
dialog[data-dialog="redline-color"],
dialog[data-redline-host-dialog] {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #e8eaed;
  text-align: start;
  box-sizing: border-box;
}
[data-redline-root] *, [data-redline-root] *::before, [data-redline-root] *::after { box-sizing: border-box; }
[data-redline-toast] {
  position: fixed;
  inset-block-end: 1rem;
  inset-inline-start: 50%;
  translate: -50% 0;
  z-index: 2147483647;
  max-width: min(32rem, calc(100vw - 2rem));
  padding: 0.5rem 0.9rem;
  border-radius: 0.375rem;
  background: rgba(17, 20, 26, 0.94);
  color: #e8eaed;
  font: 400 0.8125rem/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.35);
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
}
[data-redline-toast][data-visible] { opacity: 1; }
`;

/** The page keeps its own scrollbar rules; this only applies while active. */
const PAGE_CSS = 'body[data-redline-active] { overflow: hidden; }';

/** @type {{overlay: RedlineOverlay, host: HTMLElement, pageSheet: CSSStyleSheet}|null} */
let installation = null;
/** In-flight install, so a fast double-toggle cannot build two overlays. */
let installing = null;

/** Wait for the browser to actually paint the hidden overlay before capturing. */
function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function loadStyleSheet(cssText) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  return sheet;
}

async function fetchExtensionCss(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.text();
}

/**
 * Screenshot of the visible tab, taken by the service worker.
 *
 * This replaces the overlay's getDisplayMedia fallback, so the user never sees
 * a share picker. `activeTab` is already granted by the click or shortcut that
 * opened Redline.
 */
async function capturePage() {
  await nextPaint();
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: CAPTURE_MESSAGE });
  } catch (error) {
    throw new Error(`The extension could not reach its background worker: ${error?.message ?? error}`);
  }
  if (!response?.ok) {
    throw new Error(response?.error ?? 'The browser refused to capture this tab.');
  }
  return { dataUrl: response.dataUrl, scope: 'browser-tab' };
}

/**
 * Page metadata attached to every export.
 *
 * The query string and fragment are deliberately dropped. This extension runs
 * on arbitrary sites, and those parts of a URL routinely carry session tokens,
 * password-reset tokens, and search terms that must never travel inside an
 * annotation file the user is about to hand to someone else.
 */
function describePage() {
  return {
    url: location.origin + location.pathname,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  };
}

/** Small, non-secret context so a reader knows where the marks came from. */
function getContext() {
  return {
    application: 'Redline browser extension',
    // Say so rather than silently hiding it, so a reader knows the address
    // in the export is not the whole address.
    urlRedacted: Boolean(location.search || location.hash),
  };
}

function createToast(shadow) {
  const toast = document.createElement('div');
  toast.dataset.redlineToast = '';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  shadow.appendChild(toast);

  let timer = null;
  return message => {
    if (!message) return;
    toast.textContent = message;
    toast.toggleAttribute('data-visible', true);
    clearTimeout(timer);
    timer = setTimeout(() => toast.removeAttribute('data-visible'), 2600);
  };
}

async function install() {
  const host = document.createElement('div');
  host.dataset.redlineExtension = '';
  const shadow = host.attachShadow({ mode: 'closed' });

  const [baseSheet, redlineSheet, dialogSheet] = await Promise.all([
    loadStyleSheet(BASE_CSS),
    fetchExtensionCss('redline/redline.css').then(loadStyleSheet),
    loadStyleSheet(HOST_DIALOG_CSS + COLOR_PICKER_CSS),
  ]);
  // Order matters: redline.css must override the base, and both are scoped to
  // the shadow root so no page rule can reach them.
  shadow.adoptedStyleSheets = [baseSheet, redlineSheet, dialogSheet];

  // The one rule that must live in the page: it targets <body>.
  const pageSheet = await loadStyleSheet(PAGE_CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];

  document.body.appendChild(host);

  const dialogs = new HostDialogs(shadow);
  const setStatus = createToast(shadow);
  let preferences = {};
  try {
    preferences = (await chrome.storage.local.get(PREFERENCES_KEY))[PREFERENCES_KEY] ?? {};
  } catch (error) {
    console.warn('[Redline] Could not load preferences.', error);
  }

  const overlay = new RedlineOverlay({
    mount: shadow,
    getContext,
    describePage,
    setStatus,
    capturePage,
    createColorPicker,
    preferences,
    savePreferences: value => chrome.storage.local.set({ [PREFERENCES_KEY]: value }),
    requestText: (text, context) => dialogs.requestText(text, context),
    confirmClear: count => dialogs.confirm({
      title: 'Clear redline marks?',
      message: `Remove ${count} mark${count === 1 ? '' : 's'} from this page?`,
      confirmLabel: 'Clear',
    }),
  });

  installation = { overlay, host, pageSheet };
  return installation;
}

/** Open the overlay if closed, close it if open. Safe to call repeatedly. */
export async function toggleRedline() {
  if (!installation) {
    installing ??= install().finally(() => { installing = null; });
    await installing;
  }
  installation.overlay.toggle();
}

/** Tear the overlay out of the page entirely. Exposed for manual cleanup. */
export function destroyRedline() {
  if (!installation) return;
  const { overlay, host, pageSheet } = installation;
  overlay.destroy();
  host.remove();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== pageSheet);
  document.body.removeAttribute('data-redline-active');
  installation = null;
}
