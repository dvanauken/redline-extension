/**
 * Reload recovery: the draft envelope, its validation and summary, and a
 * debounced, serialised autosaver.
 *
 * A draft holds what is needed to rebuild the session after an accidental
 * reload: the document (marks, bullet explanations, legend, pointer proxy,
 * crop and output scale), when and in what viewport it was drawn, and the
 * proxy's follow setting. It never holds a screenshot, the page URL or title,
 * or undo history. Where it is stored, and under which tab and page identity,
 * is the host's business (the extension keeps it in `chrome.storage.session`).
 *
 * The autosaver never writes more than one operation at a time. A discard
 * waits for any write already in flight and then removes the stored draft, and
 * every write scheduled before the discard is dropped, so a late save cannot
 * resurrect discarded marks. A document with nothing worth recovering removes
 * the stored draft instead of saving an empty one.
 *
 * Nothing here touches the DOM.
 */

export const DRAFT_SCHEMA = 1;
export const DRAFT_SAVE_DELAY = 400;
export const DRAFT_MAX_WAIT = 2000;
/** Serialised characters; the extension's session storage holds 10 MB in all. */
export const DRAFT_MAX_CHARS = 1_500_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function buildDraft({ sessionId, createdAt, document, viewport, ui = {}, savedAt = new Date().toISOString() }) {
  return {
    schema: DRAFT_SCHEMA,
    sessionId: String(sessionId),
    createdAt: createdAt ?? savedAt,
    savedAt,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: viewport.devicePixelRatio,
      scrollX: Math.round(viewport.scrollX ?? 0),
      scrollY: Math.round(viewport.scrollY ?? 0),
    },
    ui: { cursorFollow: ui.cursorFollow === true },
    document,
  };
}

/**
 * Validate a stored draft's envelope and return a detached copy. The document
 * inside is validated by RedlineDocument#load, atomically, when restored.
 */
export function readDraft(value) {
  if (!isObject(value)) throw new TypeError('A recovery draft must be an object.');
  if (value.schema !== DRAFT_SCHEMA) throw new TypeError(`Unsupported recovery draft schema: ${String(value.schema).slice(0, 12)}`);
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 80) throw new TypeError('A recovery draft needs a session id.');
  for (const key of ['createdAt', 'savedAt']) {
    if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) throw new TypeError(`A recovery draft needs a valid ${key}.`);
  }
  const viewport = value.viewport;
  if (!isObject(viewport) || !['width', 'height', 'devicePixelRatio'].every(key => finite(viewport[key]) && viewport[key] > 0)
    || !['scrollX', 'scrollY'].every(key => finite(viewport[key]))) {
    throw new TypeError('A recovery draft needs its original viewport size, pixel ratio and scroll position.');
  }
  if (value.ui !== undefined && !isObject(value.ui)) throw new TypeError('Recovery draft ui settings must be an object.');
  if (!isObject(value.document)) throw new TypeError('A recovery draft needs a document.');
  return JSON.parse(JSON.stringify(value));
}

/** Whether a document snapshot has anything worth offering back after a reload. */
export function draftHasContent(document) {
  return Boolean(document && (
    (Array.isArray(document.annotations) && document.annotations.length > 0)
    || document.crop
    || (document.outputScale !== undefined && document.outputScale !== 1)
    || document.cursor?.visible
  ));
}

const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * Words for the Restore prompt. `document` is a loaded RedlineDocument (or its
 * JSON); `current` describes this window: { width, height, scrollX, scrollY }.
 */
export function describeDraft(draft, document, current, { locale = undefined, timeZone = undefined } = {}) {
  const json = typeof document?.toJSON === 'function' ? document.toJSON() : document;
  const marks = json.annotations ?? [];
  const bullets = marks.filter(mark => mark.type === 'bullet');
  const explained = bullets.filter(mark => mark.text).length;
  const notes = marks.filter(mark => mark.type === 'note').length;
  const parts = [plural(marks.length, 'mark')];
  if (bullets.length) parts.push(`${plural(bullets.length, 'bullet')} (${explained} explained)`);
  if (notes) parts.push(plural(notes, 'note'));
  if (bullets.length) parts.push(json.legend?.visible ? 'legend shown' : 'legend hidden');
  if (json.cursor?.visible) parts.push('pointer included');
  if (json.crop) parts.push(`crop ${Math.round(json.crop.width)} × ${Math.round(json.crop.height)}`);
  if (json.outputScale && json.outputScale !== 1) parts.push(`${json.outputScale * 100}% output`);

  const saved = new Date(draft.savedAt);
  const time = saved.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone });
  const v = draft.viewport;
  const sameSize = Math.round(v.width) === Math.round(current.width) && Math.round(v.height) === Math.round(current.height);
  const scrollDiffers = Math.abs(v.scrollX - Math.round(current.scrollX ?? 0)) > 1 || Math.abs(v.scrollY - Math.round(current.scrollY ?? 0)) > 1;
  const original = `${Math.round(v.width)} × ${Math.round(v.height)} window scrolled to ${v.scrollX}, ${v.scrollY}`;
  const now = `${Math.round(current.width)} × ${Math.round(current.height)} scrolled to ${Math.round(current.scrollX ?? 0)}, ${Math.round(current.scrollY ?? 0)}`;
  const context = sameSize && !scrollDiffers
    ? `Drawn in a ${original}, the same as this window.`
    : `Drawn in a ${original}; this window is ${now}.`;
  return {
    title: 'Restore unsaved redline?',
    contents: `${parts.join(', ')}.`,
    saved: `Saved at ${time} from this tab and page, before it reloaded.`,
    context,
    advice: 'Marks keep their screen positions. If the page content has moved, adjust them after restoring.',
    savedTime: time,
    markCount: marks.length,
    scroll: scrollDiffers ? { x: v.scrollX, y: v.scrollY } : null,
  };
}

/**
 * Debounced, serialised draft writes.
 *
 *   snapshot()       → a draft built from the current session (called when a write runs)
 *   save(draft)      → Promise<{ ok, code?, error? }>
 *   discard()        → Promise<{ ok }>: remove the stored draft
 *   onResult(result) → every save or discard outcome
 *
 * Writes start paused when `paused: true`, which the host uses until it knows
 * whether an earlier draft is waiting.
 */
export class DraftAutosaver {
  constructor({
    snapshot, save, discard, onResult = () => {},
    delay = DRAFT_SAVE_DELAY, maxWait = DRAFT_MAX_WAIT, maxChars = DRAFT_MAX_CHARS, paused = false,
    setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id), now = () => Date.now(),
  }) {
    Object.assign(this, { snapshot, saveFn: save, discardFn: discard, onResult, delay, maxWait, maxChars, setTimer, clearTimer, now });
    this._paused = paused;
    this._dirty = false;
    this._timer = null;
    this._firstDirtyAt = 0;
    this._generation = 0;
    /** The last stored content (without savedAt), or null when unknown or removed. */
    this._lastSaved = null;
    /** true when a draft of ours is stored, false when known absent, null when unknown. */
    this._stored = null;
    this._chain = Promise.resolve();
    this._pendingOps = 0;
  }

  get paused() { return this._paused; }
  get dirty() { return this._dirty || this._timer !== null; }
  get busy() { return this._pendingOps > 0; }

  /** Something that a draft contains has changed. */
  schedule() {
    this._dirty = true;
    if (this._paused) return;
    const now = this.now();
    if (this._timer === null) this._firstDirtyAt = now;
    else this.clearTimer(this._timer);
    const wait = Math.max(0, Math.min(this.delay, this._firstDirtyAt + this.maxWait - now));
    this._timer = this.setTimer(() => {
      this._timer = null;
      this._enqueueWrite();
    }, wait);
  }

  pause() {
    this._paused = true;
    this._cancelTimer();
  }

  /**
   * The page changed address without reloading (a fragment or history
   * navigation). The host keys drafts by address, so the same content must be
   * saved again under the new one; `now` sends it immediately (page unload).
   */
  addressChanged({ now = false } = {}) {
    this._lastSaved = null;
    if (this._stored === true) this._stored = null;
    this._dirty = true;
    if (now) this.flushNow();
    else if (!this._paused) this.schedule();
  }

  /** Tell the saver whether a draft is already stored for this page (after a recovery check). */
  assume({ stored }) {
    this._stored = stored;
    this._lastSaved = null;
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    if (this._dirty) this.schedule();
  }

  /** Write a scheduled change now. Resolves when every queued operation has finished. */
  flush() {
    if (this._timer !== null) {
      this._cancelTimer();
      this._enqueueWrite();
    } else if (this._dirty && !this._paused) {
      this._enqueueWrite();
    }
    return this.idle();
  }

  /**
   * Last chance before the page unloads: send the freshest state immediately,
   * without waiting behind an operation already in flight (its response may
   * never arrive once the page is gone).
   */
  flushNow() {
    if (this._paused || !this.dirty) return;
    this._cancelTimer();
    this._dirty = false;
    const generation = this._generation;
    const plan = this._plan();
    if (!plan || generation !== this._generation) return;
    if (plan.kind === 'too-large') {
      this._dirty = true;
      this.onResult({ ok: false, code: 'too-large', chars: plan.chars, operation: 'save' });
      return;
    }
    if (plan.kind === 'discard') this.discardFn()?.catch?.(() => {});
    else this.saveFn(plan.draft)?.catch?.(() => {});
  }

  /** Remove the stored draft and drop every write scheduled before now. */
  discard() {
    this._generation += 1;
    this._cancelTimer();
    this._dirty = false;
    this._lastSaved = null;
    return this._enqueue(async () => {
      let result;
      try {
        result = await this.discardFn();
      } catch (error) {
        result = { ok: false, code: 'unavailable', error: String(error?.message ?? error) };
      }
      if (result?.ok !== false) this._stored = false;
      this.onResult({ ...result, operation: 'discard' });
      return result;
    });
  }

  /** Resolves once no operation is queued or running. */
  async idle() {
    let chain;
    do {
      chain = this._chain;
      await chain;
    } while (chain !== this._chain);
  }

  _cancelTimer() {
    if (this._timer !== null) this.clearTimer(this._timer);
    this._timer = null;
  }

  _enqueue(task) {
    this._pendingOps += 1;
    const run = this._chain.then(task).finally(() => { this._pendingOps -= 1; });
    this._chain = run.catch(() => {});
    return run;
  }

  /** What a write would do now: { kind: 'save', draft, key } | { kind: 'discard' } | null. */
  _plan() {
    let draft;
    try {
      draft = this.snapshot();
    } catch (error) {
      this.onResult({ ok: false, code: 'snapshot', error: String(error?.message ?? error), operation: 'save' });
      return null;
    }
    if (!draftHasContent(draft?.document)) return this._stored === false ? null : { kind: 'discard' };
    const { savedAt: _savedAt, ...content } = draft;
    const key = JSON.stringify(content);
    if (key === this._lastSaved) return null;
    if (key.length > this.maxChars) return { kind: 'too-large', chars: key.length };
    return { kind: 'save', draft, key };
  }

  _enqueueWrite() {
    const generation = this._generation;
    return this._enqueue(async () => {
      if (generation !== this._generation || this._paused) return null;
      this._dirty = false;
      const plan = this._plan();
      if (!plan) return null;
      if (plan.kind === 'too-large') {
        this._dirty = true;
        const result = { ok: false, code: 'too-large', chars: plan.chars, operation: 'save' };
        this.onResult(result);
        return result;
      }
      let result;
      try {
        result = plan.kind === 'discard' ? await this.discardFn() : await this.saveFn(plan.draft);
      } catch (error) {
        result = { ok: false, code: 'unavailable', error: String(error?.message ?? error) };
      }
      result = { ok: result?.ok !== false, ...(result ?? {}), operation: plan.kind };
      if (result.ok) {
        this._stored = plan.kind === 'save';
        this._lastSaved = plan.kind === 'save' ? plan.key : null;
      } else {
        // Keep failed saves and removals pending for the next flush or change.
        this._dirty = true;
      }
      this.onResult(result);
      return result;
    });
  }
}
