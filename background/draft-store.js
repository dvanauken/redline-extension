/**
 * Reload-recovery drafts in extension-owned session storage.
 *
 * Only the service worker uses this store. Content scripts ask for their own
 * draft over runtime messaging, and the worker keys every operation by the
 * browser's tab id for the sender plus an opaque page identity, so one tab or
 * page can neither read nor overwrite another's draft. `chrome.storage.session`
 * keeps its default trusted-contexts access level: it is held in memory,
 * cleared when the browser session ends, and never exposed to content scripts
 * or pages.
 *
 * The page identity is HMAC-SHA-256 of the full page URL with a random key
 * created once per browser session. Query strings and fragments distinguish
 * pages without being stored, and the digest cannot be matched against a
 * guessed URL without that key.
 *
 * Bounds: one draft per tab and page, at most MAX_DRAFTS_PER_TAB pages per tab
 * and MAX_DRAFTS overall (oldest removed first), each under MAX_DRAFT_CHARS.
 * Drafts of a closed tab are removed. A quota failure is reported, never
 * resolved by deleting another tab's draft.
 */

export const DRAFT_KEY_PREFIX = 'redline.draft:';
export const DRAFT_SECRET_KEY = 'redline.draftKey';
export const MAX_DRAFT_CHARS = 1_500_000;
export const MAX_DRAFTS = 20;
export const MAX_DRAFTS_PER_TAB = 4;

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quotaError = error => /quota/i.test(String(error?.message ?? error));

export function createDraftStore({ storage, subtle, getRandomValues, now = () => Date.now() }) {
  let queue = Promise.resolve();
  let hmacKey = null;
  /**
   * Storage key → { tabId, sessionId, savedAt } of every stored draft. Read
   * from storage once, then kept in step with each write this store makes (it
   * is the only writer of draft keys), so a save need not read every draft.
   */
  let index = null;

  /**
   * Run storage operations one at a time, so a discard can never interleave
   * with a write. After a failure the index may be out of step with storage,
   * so it is read again next time.
   */
  const serial = task => {
    const run = queue.then(task).catch(error => {
      index = null;
      throw error;
    });
    queue = run.catch(() => {});
    return run;
  };

  const summary = ({ tabId, sessionId, savedAt }) => ({ tabId, sessionId, savedAt });

  async function removeNames(names) {
    if (!names.length) return;
    await storage.remove(names);
    for (const name of names) index?.delete(name);
  }

  async function key() {
    if (hmacKey) return hmacKey;
    let secret = (await storage.get(DRAFT_SECRET_KEY))[DRAFT_SECRET_KEY];
    if (typeof secret !== 'string') {
      secret = toBase64Url(getRandomValues(new Uint8Array(32)));
      await storage.set({ [DRAFT_SECRET_KEY]: secret });
    }
    hmacKey = await subtle.importKey('raw', fromBase64Url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hmacKey;
  }

  async function pageKey(url) {
    const signature = await subtle.sign('HMAC', await key(), new TextEncoder().encode(String(url)));
    return toBase64Url(new Uint8Array(signature));
  }

  const storageKey = (tabId, page) => `${DRAFT_KEY_PREFIX}${tabId}:${page}`;

  /** Every stored draft as { name, value: { tabId, sessionId, savedAt } }. */
  async function records() {
    if (!index) {
      const all = await storage.get(null);
      index = new Map(Object.entries(all)
        .filter(([name, value]) => name.startsWith(DRAFT_KEY_PREFIX) && isObject(value))
        .map(([name, value]) => [name, summary(value)]));
    }
    return [...index].map(([name, value]) => ({ name, value }));
  }

  function checkRequest(tabId, url) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError('Drafts need the sender tab.');
    if (typeof url !== 'string' || !url) throw new TypeError('Drafts need the sender page.');
  }

  return {
    pageKey,

    load(tabId, url) {
      return serial(async () => {
        checkRequest(tabId, url);
        const name = storageKey(tabId, await pageKey(url));
        const record = (await storage.get(name))[name];
        return isObject(record) && isObject(record.draft) ? record.draft : null;
      });
    },

    save(tabId, url, draft) {
      return serial(async () => {
        checkRequest(tabId, url);
        if (!isObject(draft) || typeof draft.sessionId !== 'string' || !isObject(draft.document)) {
          return { ok: false, code: 'invalid', error: 'The draft is not a Redline recovery draft.' };
        }
        const chars = JSON.stringify(draft).length;
        if (chars > MAX_DRAFT_CHARS) return { ok: false, code: 'too-large', chars };
        const name = storageKey(tabId, await pageKey(url));
        const existing = await records();
        // The same session moved to another address in this tab (a same-document
        // navigation): its draft follows it rather than lingering under the old page.
        const moved = existing.filter(item => item.name !== name && item.value.tabId === tabId && item.value.sessionId === draft.sessionId);
        const others = existing.filter(item => item.name !== name && !moved.includes(item));
        const byAge = list => [...list].sort((a, b) => (a.value.savedAt ?? 0) - (b.value.savedAt ?? 0));
        const sameTab = byAge(others.filter(item => item.value.tabId === tabId));
        const evicted = sameTab.slice(0, Math.max(0, sameTab.length + 1 - MAX_DRAFTS_PER_TAB));
        const remaining = byAge(others.filter(item => !evicted.includes(item)));
        evicted.push(...remaining.slice(0, Math.max(0, remaining.length + 1 - MAX_DRAFTS)));
        const removals = [...moved, ...evicted].map(item => item.name);
        // Keep every last good draft until the replacement is durably stored.
        // At quota, report failure rather than deleting drafts to make room.
        const record = { tabId, sessionId: draft.sessionId, savedAt: now(), chars, draft };
        try {
          await storage.set({ [name]: record });
        } catch (error) {
          if (quotaError(error)) return { ok: false, code: 'quota', error: String(error?.message ?? error) };
          throw error;
        }
        index?.set(name, summary(record));
        await removeNames(removals);
        return { ok: true, evicted: evicted.length };
      });
    },

    /** Remove this page's draft, and `sessionId`'s draft if it is still stored under an earlier address. */
    discard(tabId, url, sessionId = null) {
      return serial(async () => {
        checkRequest(tabId, url);
        const names = [storageKey(tabId, await pageKey(url))];
        if (typeof sessionId === 'string' && sessionId) {
          for (const item of await records()) {
            if (item.value.tabId === tabId && item.value.sessionId === sessionId && !names.includes(item.name)) names.push(item.name);
          }
        }
        await removeNames(names);
        return { ok: true };
      });
    },

    removeTab(tabId) {
      return serial(async () => {
        const names = (await records()).filter(item => item.value.tabId === tabId).map(item => item.name);
        await removeNames(names);
        return { ok: true, removed: names.length };
      });
    },
  };
}
