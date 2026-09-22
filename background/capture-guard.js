/**
 * Capture only the tab that asked, and only if it stayed put.
 *
 * `chrome.tabs.captureVisibleTab(windowId)` photographs whatever tab is active
 * in that window when the capture happens, which need not be the tab whose
 * annotations will be drawn on top. The guard checks the sender's tab before
 * capturing, then checks again afterwards and rejects the image if, at any
 * point in between, that window activated another tab (even one that was then
 * switched back) or the tab started navigating, moved window or closed. The
 * content script separately rejects the result if its own document was hidden
 * or changed address meanwhile.
 *
 * Events arrive asynchronously, so each check lets pending tab events run
 * before comparing counters.
 *
 * `address` is the content script's current `location.href`. The message
 * sender's own URL is not used: Chrome keeps reporting the address a document
 * loaded with after `history.pushState`, while the tab's URL follows it, so
 * comparing those would refuse every capture after an in-app route change.
 */

export class CaptureRejected extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaptureRejected';
    this.code = code;
  }
}

const MESSAGES = {
  'no-tab': 'The capture request did not come from a tab.',
  inactive: 'Redline’s tab is not the active tab in its window, so nothing was captured. Switch back to it and try again.',
  switched: 'Another tab became active while capturing, so the screenshot was discarded. Nothing was exported; try again.',
  navigated: 'The page started navigating while capturing, so the screenshot was discarded. Nothing was exported; try again.',
  closed: 'The tab closed while capturing.',
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const RATE_LIMITED = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/;
const RATE_RETRIES = 3;
const RATE_WAIT_MS = 550;

export function createCaptureGuard({ tabs }) {
  const activations = new Map();
  const navigations = new Map();
  const bump = (map, id) => map.set(id, (map.get(id) ?? 0) + 1);

  return {
    noteActivated({ windowId }) { bump(activations, windowId); },
    noteUpdated(tabId, change) {
      if (change?.url !== undefined || change?.status === 'loading' || change?.discarded) bump(navigations, tabId);
    },
    noteRemoved(tabId) { bump(navigations, tabId); },
    noteMoved(tabId) { bump(navigations, tabId); },

    /** Resolve { dataUrl, tabId, windowId } or reject with CaptureRejected. */
    async capture(sender, { address = null, options = { format: 'png' } } = {}) {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) throw new CaptureRejected('no-tab', MESSAGES['no-tab']);
      await settle();
      let before;
      try {
        before = await tabs.get(tabId);
      } catch {
        throw new CaptureRejected('closed', MESSAGES.closed);
      }
      if (!before.active) throw new CaptureRejected('inactive', MESSAGES.inactive);
      if (before.pendingUrl || (address && before.url && before.url !== address)) {
        throw new CaptureRejected('navigated', MESSAGES.navigated);
      }
      const windowId = before.windowId;
      const activationEpoch = activations.get(windowId) ?? 0;
      const navigationEpoch = navigations.get(tabId) ?? 0;

      // Chrome allows two captures per second; a quick second export waits its turn.
      let dataUrl;
      for (let attempt = 0; ; attempt++) {
        try {
          dataUrl = await tabs.captureVisibleTab(windowId, options);
          break;
        } catch (error) {
          if (attempt >= RATE_RETRIES || !RATE_LIMITED.test(String(error?.message ?? error))) throw error;
          await new Promise(resolve => setTimeout(resolve, RATE_WAIT_MS));
        }
      }

      await settle();
      let after;
      try {
        after = await tabs.get(tabId);
      } catch {
        throw new CaptureRejected('closed', MESSAGES.closed);
      }
      const [active] = await tabs.query({ active: true, windowId });
      await settle();
      if (after.windowId !== windowId || !after.active || active?.id !== tabId
        || (activations.get(windowId) ?? 0) !== activationEpoch) {
        throw new CaptureRejected('switched', MESSAGES.switched);
      }
      if ((navigations.get(tabId) ?? 0) !== navigationEpoch || after.pendingUrl
        || (before.url && after.url && before.url !== after.url)) {
        throw new CaptureRejected('navigated', MESSAGES.navigated);
      }
      return { dataUrl, tabId, windowId };
    },
  };
}
