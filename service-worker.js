/**
 * Redline background service worker.
 *
 * Two jobs only:
 *   1. Inject the content-script bootstrap when the user asks for Redline.
 *   2. Answer capture requests with a screenshot of the visible tab.
 *
 * `activeTab` is granted by the toolbar click and by the keyboard command, so
 * no broad host permission is needed and capture raises no share picker.
 */

const CAPTURE_MESSAGE = 'redline:capture';
const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== CAPTURE_MESSAGE) return undefined;
  const windowId = sender.tab?.windowId;
  if (windowId === undefined) {
    sendResponse({ ok: false, error: 'The capture request did not come from a tab.' });
    return undefined;
  }
  chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    .then(dataUrl => sendResponse({ ok: true, dataUrl }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true; // keep the message channel open for the async response
});
