/**
 * Redline extension host integration.
 *
 * Runs in the content script's isolated world. It owns exactly one
 * RedlineOverlay per frame and supplies the adapters the overlay expects from a
 * host application. There is no host application here, so this module plays
 * that role: shadow-DOM isolation instead of an app shell, extension capture
 * instead of an app renderer, and native <dialog> instead of an app dialog
 * service.
 *
 * Reload-recovery drafts go to the service worker, which keeps them in
 * extension-owned session storage under this tab and an opaque page identity.
 * Nothing is written to the website's storage.
 */

import { RedlineOverlay } from './redline/index.js';
import { HostDialogs, HOST_DIALOG_CSS } from './host-dialogs.js';
import { createColorPicker, COLOR_PICKER_CSS } from './color-picker.js';

const CAPTURE_MESSAGE = 'redline:capture';
const DRAFT_MESSAGE = 'redline:draft:';
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
dialog[data-redline-preview],
dialog[data-redline-host-dialog] {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #292D32;
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
  border: 1px solid #D9D5CC;
  background: #F7F5F0;
  color: #292D32;
  font: 400 0.8125rem/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 0.5rem 1.5rem rgb(41 45 50 / 0.18);
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
}
[data-redline-toast][data-visible] { opacity: 1; }
`;

/** The page keeps its own scrollbar rules; this only applies while active. */
const PAGE_CSS = 'body[data-redline-active] { overflow: hidden; } html[data-redline-scrollbar] { scrollbar-gutter: stable; }';

/** Keep an existing scrollbar's space while locking input, so canvases do not resize. */
function setPageLocked(locked) {
  const html = document.documentElement;
  if (locked) {
    if (innerWidth > html.clientWidth && !getComputedStyle(html).scrollbarGutter.includes('stable')) {
      html.setAttribute('data-redline-scrollbar', '');
    }
    document.body.setAttribute('data-redline-active', '');
  } else {
    document.body.removeAttribute('data-redline-active');
    html.removeAttribute('data-redline-scrollbar');
  }
}

/** @type {{overlay: RedlineOverlay, host: HTMLElement, pageSheet: CSSStyleSheet}|null} */
let installation = null;
/** The address the last draft was saved under, to notice same-document navigation. */
let draftAddress = null;
/** In-flight install, so a fast double-toggle cannot build two overlays. */
let installing = null;

/**
 * Wait for the browser to actually paint the hidden overlay before capturing.
 * A tab hidden meanwhile gets no animation frames, so give up after a moment
 * and let the visibility check reject the capture.
 */
function nextPaint() {
  return Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, 500)),
  ]);
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
 *
 * The worker only captures this tab while it is active, and rejects the image
 * if another tab was activated or this one navigated during capture. This
 * document adds its own check: if it was hidden or changed address while the
 * worker captured, the image cannot be trusted to show this page.
 */
async function requestVisibleCapture(address) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: CAPTURE_MESSAGE, address });
  } catch (error) {
    throw new Error(`The extension could not reach its background worker: ${error?.message ?? error}`);
  }
  if (!response?.ok) throw new Error(response?.error ?? 'The browser refused to capture this tab.');
  return response.dataUrl;
}

function decodeCapture(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('A full-page capture tile could not be decoded.'));
    image.src = dataUrl;
  });
}

function tilePositions(total, viewport) {
  if (total <= viewport) return [0];
  const last = Math.max(0, total - viewport);
  const values = [];
  for (let value = 0; value < last; value += viewport) values.push(value);
  if (values.at(-1) !== last) values.push(last);
  return values;
}

async function captureFullPage(address, interrupted) {
  const scrolling = document.scrollingElement ?? document.documentElement;
  const width = Math.max(innerWidth, scrolling.scrollWidth, document.body?.scrollWidth ?? 0);
  const height = Math.max(innerHeight, scrolling.scrollHeight, document.body?.scrollHeight ?? 0);
  const original = { x: scrollX, y: scrollY };
  const xs = tilePositions(width, innerWidth);
  const ys = tilePositions(height, innerHeight);
  if (xs.length * ys.length > 60) {
    throw new Error('This page is too large for a safe full-page capture (more than 60 screen tiles).');
  }
  const oldBehavior = scrolling.style.getPropertyValue('scroll-behavior');
  const oldPriority = scrolling.style.getPropertyPriority('scroll-behavior');
  const wasLocked = document.body.hasAttribute('data-redline-active');
  if (wasLocked) document.body.removeAttribute('data-redline-active');
  scrolling.style.setProperty('scroll-behavior', 'auto', 'important');
  let canvas = null;
  let ctx = null;
  let scaleX = 1;
  let scaleY = 1;
  try {
    for (const y of ys) {
      for (const x of xs) {
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
        await nextPaint();
        if (interrupted()) throw new Error('This tab changed while capturing the full page. Nothing was exported.');
        const image = await decodeCapture(await requestVisibleCapture(address));
        if (!canvas) {
          scaleX = image.naturalWidth / innerWidth;
          scaleY = image.naturalHeight / innerHeight;
          const pixelWidth = Math.round(width * scaleX);
          const pixelHeight = Math.round(height * scaleY);
          if (pixelWidth > 32767 || pixelHeight > 32767 || pixelWidth * pixelHeight > 64_000_000) {
            throw new Error('This full page is too large to encode as one PNG.');
          }
          canvas = document.createElement('canvas');
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          ctx = canvas.getContext('2d');
        }
        ctx.drawImage(image, Math.round(scrollX * scaleX), Math.round(scrollY * scaleY));
      }
    }
  } finally {
    window.scrollTo({ left: original.x, top: original.y, behavior: 'instant' });
    if (oldBehavior) scrolling.style.setProperty('scroll-behavior', oldBehavior, oldPriority);
    else scrolling.style.removeProperty('scroll-behavior');
    if (wasLocked) document.body.setAttribute('data-redline-active', '');
    await nextPaint();
  }
  return {
    canvas,
    scope: 'full-page',
    page: { x: 0, y: 0, width, height, scrollX: original.x, scrollY: original.y },
  };
}

async function capturePage(host, { fullPage = false } = {}) {
  if (document.visibilityState !== 'visible') {
    throw new Error('This tab is in the background, so nothing was captured. Switch to it and try again.');
  }
  const address = location.href;
  let interrupted = false;
  const onHidden = () => { if (document.visibilityState !== 'visible') interrupted = true; };
  const onPageHide = () => { interrupted = true; };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  // Toasts and host dialogs live beside the overlay root. Hide the whole host
  // for capture, then restore it even if the worker or screenshot fails.
  const visibility = host.style.getPropertyValue('visibility');
  const priority = host.style.getPropertyPriority('visibility');
  host.style.setProperty('visibility', 'hidden', 'important');
  try {
    await nextPaint();
    if (interrupted || document.visibilityState !== 'visible') {
      throw new Error('This tab was hidden before capture, so nothing was captured. Try again.');
    }
    const result = fullPage
      ? await captureFullPage(address, () => interrupted || document.visibilityState !== 'visible' || location.href !== address)
      : { dataUrl: await requestVisibleCapture(address), scope: 'browser-tab' };
    if (interrupted || document.visibilityState !== 'visible') {
      throw new Error('This tab was switched away from during capture, so the screenshot was discarded. Nothing was exported; try again.');
    }
    if (location.href !== address) {
      throw new Error('This page changed address during capture, so the screenshot was discarded. Nothing was exported; try again.');
    }
    return result;
  } finally {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
    if (visibility) host.style.setProperty('visibility', visibility, priority);
    else host.style.removeProperty('visibility');
  }
}

/**
 * Ask the service worker to load, save or discard this tab and page's draft.
 * The worker takes the tab from the message sender. It keys the page by this
 * document's current address, accepted only for the sender's own origin.
 * Pages cannot message the extension at all (no externally_connectable).
 */
async function draftRequest(action, payload = {}) {
  // The current address (after any history navigation); the worker checks its origin.
  const response = await chrome.runtime.sendMessage({ type: DRAFT_MESSAGE + action, ...payload, address: location.href });
  if (!response) throw new Error('The extension background worker did not answer.');
  return response;
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
    capturePage: options => capturePage(host, options),
    createColorPicker,
    preferences,
    savePreferences: value => chrome.storage.local.set({ [PREFERENCES_KEY]: value }),
    dismissDialogs: () => dialogs.dismissAll(),
    setPageLocked,
    requestText: (text, context) => dialogs.requestText(text, context),
    confirmClear: count => dialogs.confirm({
      title: 'Clear redline marks?',
      message: `Remove ${count} mark${count === 1 ? '' : 's'} from this page?`,
      confirmLabel: 'Clear',
    }),
    confirm: options => dialogs.confirm(options),
    loadDraft: async () => {
      const response = await draftRequest('load');
      if (!response.ok) throw new Error(response.error ?? 'Reload recovery is unavailable.');
      return response.draft ?? null;
    },
    saveDraft: draft => {
      // Recorded when sent, so a navigation while the save is in flight is still noticed.
      draftAddress = location.href;
      return draftRequest('save', { draft });
    },
    discardDraft: ({ sessionId } = {}) => draftRequest('discard', { sessionId }),
    requestRecovery: summary => dialogs.recovery(summary),
  });

  // A fragment or history navigation keeps this document (and the marks) but
  // changes the address a reload will use, so save the draft under it.
  const addressChanged = () => {
    if (draftAddress && draftAddress !== location.href) overlay.noteAddressChanged();
  };
  window.addEventListener('hashchange', addressChanged);
  window.addEventListener('popstate', addressChanged);
  // history.pushState fires no event; check once more as the page unloads.
  window.addEventListener('pagehide', () => {
    if (draftAddress && draftAddress !== location.href) overlay.noteAddressChanged({ now: true });
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
  setPageLocked(false);
  installation = null;
}
