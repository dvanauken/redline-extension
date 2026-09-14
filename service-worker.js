/**
 * Redline background service worker (an ES module).
 *
 * Three jobs:
 *   1. Inject the content-script bootstrap when the user asks for Redline.
 *   2. Answer capture requests with a screenshot of the sender's own tab,
 *      verified before and after capture (background/capture-guard.js).
 *   3. Keep reload-recovery drafts for the sender's tab and page in
 *      extension-owned session storage (background/draft-store.js).
 *
 * `activeTab` is granted by the toolbar click and by the keyboard command, so
 * no broad host permission is needed and capture raises no share picker.
 */

import { CaptureRejected, createCaptureGuard } from './background/capture-guard.js';
import { createDraftStore } from './background/draft-store.js';

const CAPTURE_MESSAGE = 'redline:capture';
const DRAFT_MESSAGE = /^redline:draft:(load|save|discard)$/;
const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

const captureGuard = createCaptureGuard({ tabs: chrome.tabs });
const drafts = createDraftStore({
  storage: chrome.storage.session,
  subtle: crypto.subtle,
  getRandomValues: bytes => crypto.getRandomValues(bytes),
});

async function activate(tab) {
  if (!tab?.id) return;
  if (RESTRICTED.test(tab.url ?? '')) {
    console.warn('[Redline] Browser-internal pages cannot host the overlay:', tab.url);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (error) {
    console.warn('[Redline] Could not inject into this page.', error);
  }
}

chrome.action.onClicked.addListener(activate);

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-redline') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await activate(tab);
});

chrome.tabs.onActivated.addListener(info => captureGuard.noteActivated(info));
chrome.tabs.onUpdated.addListener((tabId, change) => captureGuard.noteUpdated(tabId, change));
chrome.tabs.onDetached.addListener(tabId => captureGuard.noteMoved(tabId));
chrome.tabs.onRemoved.addListener(tabId => {
  captureGuard.noteRemoved(tabId);
  drafts.removeTab(tabId).catch(error => console.warn('[Redline] Could not remove drafts of a closed tab.', error));
});

/**
 * The page's current address, as its content script reports it. Chrome keeps
 * `sender.url` at the address the document loaded with after history
 * navigation, so that cannot identify the page a reload will show. The report
 * is accepted only for the sender's own origin (history navigation cannot
 * change origin); the tab itself always comes from `sender.tab.id`.
 */
function senderAddress(message, sender) {
  const fallback = sender.url ?? sender.tab?.url ?? null;
  if (typeof message?.address !== 'string') return fallback;
  try {
    const origin = sender.origin ?? new URL(fallback).origin;
    return new URL(message.address).origin === origin ? message.address : null;
  } catch {
    return null;
  }
}

async function answerDraft(action, message, sender) {
  const tabId = sender.tab.id;
  const url = senderAddress(message, sender);
  if (!url) return { ok: false, code: 'no-identity', error: 'This page did not identify itself, so reload recovery is unavailable.' };
  if (action === 'load') return { ok: true, draft: await drafts.load(tabId, url) };
  if (action === 'save') return drafts.save(tabId, url, message.draft);
  return drafts.discard(tabId, url, typeof message.sessionId === 'string' ? message.sessionId : null);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own content scripts, running in a tab.
  if (sender.id !== chrome.runtime.id || !sender.tab) return undefined;
  if (message?.type === CAPTURE_MESSAGE) {
    captureGuard.capture(sender, { address: senderAddress(message, sender), options: { format: 'png' } })
      .then(({ dataUrl }) => sendResponse({ ok: true, dataUrl }))
      .catch(error => sendResponse({
        ok: false,
        code: error instanceof CaptureRejected ? error.code : 'failed',
        error: String(error?.message ?? error),
      }));
    return true; // keep the message channel open for the async response
  }
  const draft = DRAFT_MESSAGE.exec(message?.type ?? '');
  if (draft) {
    answerDraft(draft[1], message, sender)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, code: 'unavailable', error: String(error?.message ?? error) }));
    return true;
  }
  return undefined;
});
