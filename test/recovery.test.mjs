import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { RedlineDocument } from '../redline/RedlineDocument.js';
import {
  DRAFT_SCHEMA, DraftAutosaver, buildDraft, describeDraft, draftHasContent, readDraft,
} from '../redline/RedlineRecovery.js';
import { DRAFT_KEY_PREFIX, DRAFT_SECRET_KEY, MAX_DRAFTS, MAX_DRAFTS_PER_TAB, createDraftStore } from '../background/draft-store.js';
import { createCaptureGuard } from '../background/capture-guard.js';

const viewport = { width: 1200, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 340 };
const line = id => ({ id, type: 'line', color: '#000000', width: 2, start: { x: 10, y: 20 }, end: { x: 200, y: 100 } });
const documentWith = (...annotations) => ({ width: 1200, height: 800, annotations });

// ---------------------------------------------------------------------------
// Draft envelope

test('drafts carry the document and viewport context, never page identity or pixels', () => {
  const draft = buildDraft({ sessionId: 's1', createdAt: '2026-09-13T10:00:00.000Z', document: documentWith(line('a')), viewport, ui: { cursorFollow: true }, savedAt: '2026-09-13T10:05:00.000Z' });
  assert.equal(draft.schema, DRAFT_SCHEMA);
  assert.deepEqual(Object.keys(draft).sort(), ['createdAt', 'document', 'savedAt', 'schema', 'sessionId', 'ui', 'viewport']);
  assert.deepEqual(draft.viewport, viewport);
  assert.equal(JSON.stringify(draft).includes('http'), false);
  assert.deepEqual(readDraft(JSON.parse(JSON.stringify(draft))), draft);
});

test('malformed draft envelopes are rejected', () => {
  const good = buildDraft({ sessionId: 's1', document: documentWith(), viewport });
  for (const [name, change] of [
    ['schema', { schema: 2 }], ['session', { sessionId: '' }], ['savedAt', { savedAt: 'yesterday' }],
    ['viewport', { viewport: { ...viewport, width: 0 } }], ['scroll', { viewport: { ...viewport, scrollY: '4' } }],
    ['document', { document: [] }], ['ui', { ui: 'follow' }],
  ]) {
    assert.throws(() => readDraft({ ...good, ...change }), TypeError, name);
  }
  assert.throws(() => readDraft(null), TypeError);
});

test('only documents with something to recover count as content', () => {
  assert.equal(draftHasContent(documentWith()), false);
  assert.equal(draftHasContent({ ...documentWith(), legend: { visible: true } }), false, 'an empty legend alone is not work');
  assert.equal(draftHasContent({ ...documentWith(), cursor: { visible: false, x: 1, y: 1 } }), false);
  assert.equal(draftHasContent(documentWith(line('a'))), true);
  assert.equal(draftHasContent({ ...documentWith(), crop: { x: 0, y: 0, width: 5, height: 5 } }), true);
  assert.equal(draftHasContent({ ...documentWith(), outputScale: 2 }), true);
  assert.equal(draftHasContent({ ...documentWith(), cursor: { visible: true, x: 1, y: 1 } }), true);
});

test('the restore prompt describes contents and the original viewport', () => {
  const doc = new RedlineDocument({ width: 1200, height: 800 });
  doc.load({
    width: 1200, height: 800,
    annotations: [
      { id: 'b1', type: 'bullet', label: '1', color: '#1D4ED8', point: { x: 5, y: 5 }, text: 'Explained' },
      { id: 'b2', type: 'bullet', label: 'A', color: '#1D4ED8', point: { x: 9, y: 9 } },
      { id: 'n', type: 'note', color: '#B65D66', point: { x: 5, y: 5 }, text: 'Legacy', number: 1 },
      line('l'),
    ],
    legend: { visible: true }, cursor: { visible: true, x: 10, y: 10 }, crop: { x: 0, y: 0, width: 600, height: 400 }, outputScale: 2,
  });
  const draft = buildDraft({ sessionId: 's', document: doc.toJSON(), viewport, savedAt: '2026-09-13T14:02:05.000Z' });
  const words = describeDraft(draft, doc, { width: 1000, height: 650, scrollX: 0, scrollY: 0 }, { locale: 'en-US', timeZone: 'UTC' });
  assert.equal(words.contents, '4 marks, 2 bullets (1 explained), 1 note, legend shown, pointer included, crop 600 × 400, 200% output.');
  assert.equal(words.saved, 'Saved at 2:02:05 PM from this tab and page, before it reloaded.');
  assert.equal(words.context, 'Drawn in a 1200 × 800 window scrolled to 0, 340; this window is 1000 × 650 scrolled to 0, 0.');
  assert.deepEqual(words.scroll, { x: 0, y: 340 });
  const same = describeDraft(draft, doc, { width: 1200, height: 800, scrollX: 0, scrollY: 340 });
  assert.equal(same.context, 'Drawn in a 1200 × 800 window scrolled to 0, 340, the same as this window.');
  assert.equal(same.scroll, null);
});

// ---------------------------------------------------------------------------
// Autosaver

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, ms) => { timers.set(++id, { at: now + ms, callback }); return id; },
    clearTimer: key => timers.delete(key),
    pending: () => timers.size,
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(key)) {
          timers.delete(key);
          timer.callback();
        }
      }
    },
  };
}

/** A storage adapter whose operations can be held open, to create races on purpose. */
function fakeHost() {
  const host = {
    stored: null, log: [], hold: false, releases: [], current: documentWith(line('a')), results: [],
    snapshot: () => buildDraft({ sessionId: 'session', createdAt: '2026-09-13T10:00:00.000Z', document: JSON.parse(JSON.stringify(host.current)), viewport }),
    async save(draft) {
      host.log.push(['save', draft.document.annotations.map(mark => mark.id).join(',')]);
      if (host.hold) await new Promise(resolve => host.releases.push(resolve));
      if (host.failWith) return { ok: false, code: host.failWith };
      host.stored = draft;
      return { ok: true };
    },
    async discard() {
      host.log.push(['discard']);
      if (host.hold) await new Promise(resolve => host.releases.push(resolve));
      host.stored = null;
      return { ok: true };
    },
    release() { host.releases.splice(0).forEach(resolve => resolve()); },
  };
  return host;
}

const autosaver = (host, clock, options = {}) => new DraftAutosaver({
  snapshot: host.snapshot, save: draft => host.save(draft), discard: () => host.discard(), onResult: result => host.results.push(result),
  delay: 400, maxWait: 2000, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, ...options,
});

test('writes are debounced, bounded by a maximum wait, and deduplicated', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock);
  for (let i = 0; i < 10; i++) {
    saver.schedule();
    clock.advance(300);
  }
  await saver.idle();
  assert.equal(host.log.filter(([kind]) => kind === 'save').length, 1, 'continuous edits still save within the maximum wait');
  saver.schedule();
  clock.advance(400);
  await saver.idle();
  assert.equal(host.log.length, 1, 'unchanged content is not written again');
  host.current = documentWith(line('a'), line('b'));
  saver.schedule();
  clock.advance(399);
  await saver.idle();
  assert.equal(host.log.length, 1);
  clock.advance(1);
  await saver.idle();
  assert.deepEqual(host.log.at(-1), ['save', 'a,b']);
});

test('an emptied document removes the stored draft instead of saving it', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock);
  saver.schedule();
  await saver.flush();
  host.current = documentWith();
  saver.schedule();
  await saver.flush();
  assert.deepEqual(host.log.map(([kind]) => kind), ['save', 'discard']);
  assert.equal(host.stored, null);
  saver.schedule();
  await saver.flush();
  assert.equal(host.log.length, 2, 'nothing is re-sent once the draft is known to be gone');
});

test('a discard waits for an in-flight save and drops saves scheduled before it', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock);
  host.hold = true;
  saver.schedule();
  saver.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(host.log, [['save', 'a']], 'the first save is in flight');
  host.current = documentWith(line('a'), line('late'));
  saver.schedule();
  saver.flush(); // queued behind the in-flight save
  const discarded = saver.discard();
  host.release();
  await new Promise(resolve => setImmediate(resolve));
  host.release();
  await discarded;
  await saver.idle();
  assert.deepEqual(host.log.map(([kind]) => kind), ['save', 'discard'], 'the late save never ran');
  assert.equal(host.stored, null, 'no discarded marks are resurrected');
});

test('paused writes wait; resuming saves the latest state', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock, { paused: true });
  saver.schedule();
  clock.advance(5000);
  await saver.flush();
  saver.flushNow();
  assert.equal(host.log.length, 0);
  host.current = documentWith(line('z'));
  saver.resume();
  clock.advance(400);
  await saver.idle();
  assert.deepEqual(host.log, [['save', 'z']]);
});

test('quota and size failures are reported, keep the change pending, and retry on the next change', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  host.failWith = 'quota';
  const saver = autosaver(host, clock);
  saver.schedule();
  await saver.flush();
  assert.equal(host.results.at(-1).code, 'quota');
  assert.equal(saver.dirty, true);
  host.failWith = null;
  saver.schedule();
  await saver.flush();
  assert.equal(host.results.at(-1).ok, true);

  const tiny = autosaver(host, clock, { maxChars: 50 });
  tiny.schedule();
  await tiny.flush();
  assert.equal(host.results.at(-1).code, 'too-large');
});

test('oversized drafts are reported without sending an invalid unload save', () => {
  const host = fakeHost();
  const saver = autosaver(host, fakeClock(), { maxChars: 50 });
  saver.schedule();
  saver.flushNow();
  assert.equal(host.log.length, 0);
  assert.equal(host.results.at(-1)?.code, 'too-large');
  assert.equal(saver.dirty, true, 'a later reduction in size can still be saved');
});

test('a failed removal of an empty document stays pending for retry', async () => {
  const host = fakeHost();
  const saver = autosaver(host, fakeClock());
  saver.schedule();
  await saver.flush();
  host.current = documentWith();
  const discard = host.discard;
  host.discard = async () => ({ ok: false, code: 'unavailable' });
  saver.schedule();
  await saver.flush();
  assert.equal(saver.dirty, true);
  assert.ok(host.stored);
  host.discard = discard;
  await saver.flush();
  assert.equal(host.stored, null);
});

test('flushNow sends the freshest state immediately for page unload', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock);
  host.hold = true;
  saver.schedule();
  saver.flush();
  await new Promise(resolve => setImmediate(resolve));
  host.current = documentWith(line('a'), line('unload'));
  saver.schedule();
  saver.flushNow();
  assert.deepEqual(host.log.map(entry => entry.join(':')), ['save:a', 'save:a,unload'], 'not queued behind the slow write');
  host.hold = false;
  host.release();
});

// ---------------------------------------------------------------------------
// Service-worker draft store

function fakeSessionStorage({ quota = 10 * 1024 * 1024 } = {}) {
  const data = new Map();
  const size = map => [...map].reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0);
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries([...data].map(([key, value]) => [key, structuredClone(value)]));
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))]));
    },
    async set(items) {
      const next = new Map(data);
      for (const [key, value] of Object.entries(items)) next.set(key, structuredClone(value));
      if (size(next) > quota) throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

const store = (storage, clock = { value: 0 }) => createDraftStore({
  storage, subtle: webcrypto.subtle, getRandomValues: bytes => webcrypto.getRandomValues(bytes), now: () => ++clock.value,
});
const draftFor = (sessionId, ...ids) => buildDraft({ sessionId, document: documentWith(...ids.map(line)), viewport });

test('drafts are isolated by tab and by page, and keys never contain the URL', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  const secret = 'https://example.test/orders?token=sk-live-secret#section';
  await drafts.save(1, secret, draftFor('s1', 'tab-one'));
  await drafts.save(2, secret, draftFor('s2', 'tab-two'));
  await drafts.save(1, 'https://example.test/orders?token=other', draftFor('s3', 'other-page'));
  assert.deepEqual((await drafts.load(1, secret)).document.annotations.map(mark => mark.id), ['tab-one']);
  assert.deepEqual((await drafts.load(2, secret)).document.annotations.map(mark => mark.id), ['tab-two']);
  assert.deepEqual((await drafts.load(1, 'https://example.test/orders?token=other')).document.annotations.map(mark => mark.id), ['other-page']);
  assert.equal(await drafts.load(3, secret), null);
  assert.equal(await drafts.load(1, 'https://example.test/orders'), null);
  const serialised = JSON.stringify([...storage.data]);
  assert.equal(serialised.includes('sk-live-secret') || serialised.includes('example.test'), false);
  assert.ok(storage.data.has(DRAFT_SECRET_KEY));
  assert.equal(await drafts.pageKey(secret), await drafts.pageKey(secret));
  assert.notEqual(await store(fakeSessionStorage()).pageKey(secret), await drafts.pageKey(secret), 'keys differ per browser session');
});

test('discard, closed tabs and a session that changed address remove their drafts', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  await drafts.save(1, 'https://a.test/one', draftFor('moving', 'x'));
  await drafts.save(1, 'https://a.test/two', draftFor('moving', 'x', 'y'));
  assert.equal(await drafts.load(1, 'https://a.test/one'), null, 'the session followed its same-document navigation');
  await drafts.save(2, 'https://a.test/one', draftFor('other', 'z'));
  await drafts.discard(1, 'https://a.test/two');
  assert.equal(await drafts.load(1, 'https://a.test/two'), null);
  assert.ok(await drafts.load(2, 'https://a.test/one'));
  await drafts.removeTab(2);
  assert.equal([...storage.data.keys()].filter(key => key.startsWith(DRAFT_KEY_PREFIX)).length, 0);
});

test('discarding a session also removes its draft left under an earlier address', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  await drafts.save(1, 'https://a.test/page#one', draftFor('s', 'x'));
  await drafts.save(1, 'https://a.test/other', draftFor('unrelated', 'y'));
  await drafts.discard(1, 'https://a.test/page#two', 's');
  assert.equal(await drafts.load(1, 'https://a.test/page#one'), null);
  assert.ok(await drafts.load(1, 'https://a.test/other'), 'another session in the tab is kept');
});

test('an address change re-saves unchanged content, immediately on unload', async () => {
  const clock = fakeClock();
  const host = fakeHost();
  const saver = autosaver(host, clock);
  saver.schedule();
  await saver.flush();
  saver.schedule();
  await saver.flush();
  assert.equal(host.log.length, 1, 'deduplicated at one address');
  saver.addressChanged();
  clock.advance(400);
  await saver.idle();
  assert.equal(host.log.length, 2, 'saved again under the new address');
  saver.addressChanged({ now: true });
  assert.equal(host.log.length, 3, 'sent at once while unloading');
  const paused = autosaver(fakeHost(), fakeClock(), { paused: true });
  paused.addressChanged({ now: true });
  assert.equal(paused.dirty, true);
});

test('storage is bounded per tab and overall, oldest first', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  for (let page = 0; page < MAX_DRAFTS_PER_TAB + 2; page++) await drafts.save(7, `https://a.test/${page}`, draftFor(`s${page}`, 'm'));
  const tabSeven = [...storage.data.values()].filter(value => value.tabId === 7);
  assert.equal(tabSeven.length, MAX_DRAFTS_PER_TAB);
  assert.equal(await drafts.load(7, 'https://a.test/0'), null);
  assert.ok(await drafts.load(7, `https://a.test/${MAX_DRAFTS_PER_TAB + 1}`));
  for (let tab = 100; tab < 100 + MAX_DRAFTS + 3; tab++) await drafts.save(tab, 'https://b.test/', draftFor(`t${tab}`, 'm'));
  assert.equal([...storage.data.keys()].filter(key => key.startsWith(DRAFT_KEY_PREFIX)).length, MAX_DRAFTS);
});

test('quota failures are reported without deleting another tab’s draft', async () => {
  const storage = fakeSessionStorage({ quota: 6000 });
  const drafts = store(storage);
  assert.equal((await drafts.save(1, 'https://a.test/', draftFor('small', 'a'))).ok, true);
  const big = buildDraft({ sessionId: 'big', document: documentWith(...Array.from({ length: 60 }, (_, i) => line(`m${i}`))), viewport });
  const result = await drafts.save(2, 'https://a.test/', big);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quota');
  assert.ok(await drafts.load(1, 'https://a.test/'), 'the other tab keeps its draft');
  const huge = buildDraft({ sessionId: 'huge', document: { ...documentWith(), note: 'x'.repeat(1_600_000) }, viewport });
  assert.equal((await drafts.save(3, 'https://a.test/', huge)).code, 'too-large');
  assert.equal((await drafts.save(3, 'https://a.test/', { nope: true })).code, 'invalid');
});

test('a failed save at the draft-count limit preserves every existing draft', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  for (let tab = 1; tab <= MAX_DRAFTS; tab++) await drafts.save(tab, 'https://a.test/', draftFor('s' + tab, 'm' + tab));
  const before = await storage.get(null);
  storage.set = async () => { throw new Error('Session storage quota exceeded'); };
  assert.equal((await drafts.save(MAX_DRAFTS + 1, 'https://a.test/', draftFor('new', 'new'))).code, 'quota');
  assert.deepEqual(await storage.get(null), before, 'oldest draft must survive a rejected replacement');
});

test('a failed save after navigation keeps the last recoverable version at its previous address', async () => {
  const storage = fakeSessionStorage();
  const drafts = store(storage);
  await drafts.save(1, 'https://a.test/old', draftFor('moving', 'old'));
  const before = await storage.get(null);
  storage.set = async () => { throw new Error('Session storage quota exceeded'); };
  assert.equal((await drafts.save(1, 'https://a.test/new', draftFor('moving', 'latest'))).code, 'quota');
  assert.deepEqual(await storage.get(null), before, 'navigation must not delete the last good draft before saving the new one');
});

// ---------------------------------------------------------------------------
// Capture guard

function fakeTabs() {
  const state = { tabs: new Map([[1, { id: 1, windowId: 9, active: true, url: 'https://a.test/' }], [2, { id: 2, windowId: 9, active: false, url: 'https://b.test/' }]]) };
  const guard = { value: null };
  const activate = id => {
    for (const tab of state.tabs.values()) if (tab.windowId === 9) tab.active = tab.id === id;
    guard.value.noteActivated({ tabId: id, windowId: 9 });
  };
  const tabs = {
    async get(id) {
      const tab = state.tabs.get(id);
      if (!tab) throw new Error('No tab');
      return { ...tab };
    },
    async query({ active, windowId }) {
      return [...state.tabs.values()].filter(tab => tab.windowId === windowId && tab.active === active).map(tab => ({ ...tab }));
    },
    async captureVisibleTab(windowId) {
      await state.during?.();
      const shown = [...state.tabs.values()].find(tab => tab.windowId === windowId && tab.active);
      return `data:image/png;base64,${shown.id}`;
    },
  };
  guard.value = createCaptureGuard({ tabs });
  return { state, tabs, guard: guard.value, activate };
}

const sender = { tab: { id: 1, windowId: 9 }, url: 'https://a.test/' };
const request = { address: 'https://a.test/' };

test('capture succeeds for the active sender tab', async () => {
  const { guard } = fakeTabs();
  assert.deepEqual(await guard.capture(sender, request), { dataUrl: 'data:image/png;base64,1', tabId: 1, windowId: 9 });
});

test('a capture over Chrome’s per-second quota waits and retries, still checking the tab afterwards', async () => {
  let fake = fakeTabs();
  let calls = 0;
  const original = fake.tabs.captureVisibleTab;
  fake.tabs.captureVisibleTab = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    return original(...args);
  };
  assert.equal((await fake.guard.capture(sender, request)).dataUrl, 'data:image/png;base64,1');
  assert.equal(calls, 2);

  fake = fakeTabs();
  calls = 0;
  const first = fake.tabs.captureVisibleTab;
  fake.tabs.captureVisibleTab = async (...args) => {
    calls += 1;
    if (calls === 1) {
      fake.activate(2);
      throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    }
    return first(...args);
  };
  await assert.rejects(fake.guard.capture(sender, request), { code: 'switched' }, 'a switch during the wait is still caught');

  fake = fakeTabs();
  fake.tabs.captureVisibleTab = async () => { throw new Error('Cannot access contents of the page.'); };
  await assert.rejects(fake.guard.capture(sender, request), /Cannot access/);
});

test('capture refuses a background sender, a tab switch, a switch back, and navigation', async () => {
  let fake = fakeTabs();
  fake.activate(2);
  await assert.rejects(fake.guard.capture(sender, request), { code: 'inactive' });

  fake = fakeTabs();
  fake.state.during = async () => fake.activate(2);
  await assert.rejects(fake.guard.capture(sender, request), { code: 'switched' }, 'page B was captured under page A');

  fake = fakeTabs();
  fake.state.during = async () => { fake.activate(2); fake.activate(1); };
  await assert.rejects(fake.guard.capture(sender, request), { code: 'switched' }, 'A → B → A during capture is still rejected');

  fake = fakeTabs();
  fake.state.during = async () => {
    fake.state.tabs.get(1).url = 'https://a.test/next';
    fake.guard.noteUpdated(1, { url: 'https://a.test/next' });
  };
  await assert.rejects(fake.guard.capture(sender, request), { code: 'navigated' });

  fake = fakeTabs();
  fake.state.tabs.get(1).pendingUrl = 'https://a.test/loading';
  await assert.rejects(fake.guard.capture(sender, request), { code: 'navigated' });

  fake = fakeTabs();
  fake.state.tabs.get(1).url = 'https://a.test/other-document';
  await assert.rejects(fake.guard.capture(sender, request), { code: 'navigated' }, 'the tab shows another address than the page that asked');

  fake = fakeTabs();
  fake.state.tabs.get(1).url = 'https://a.test/route#two';
  assert.ok(await fake.guard.capture({ ...sender, url: 'https://a.test/' }, { address: 'https://a.test/route#two' }),
    'after history.pushState the sender URL is stale but the page address matches the tab');

  fake = fakeTabs();
  await assert.rejects(fake.guard.capture({ tab: { id: 5, windowId: 9 } }), { code: 'closed' });
  await assert.rejects(fake.guard.capture({}), { code: 'no-tab' });
});
