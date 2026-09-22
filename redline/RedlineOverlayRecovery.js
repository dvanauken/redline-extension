/**
 * Reload recovery for a RedlineOverlay, when the host supplies loadDraft,
 * saveDraft and discardDraft (see RedlineRecovery.js for the draft envelope and
 * the autosaver).
 *
 * The first open after a page load checks for a draft before any write, and
 * offers Restore or Discard when one is waiting. While that decision is
 * pending, writes stay paused so the waiting draft is never overwritten.
 * Otherwise changes are saved after a short pause, and immediately when the
 * page is hidden or unloaded.
 *
 * States: 'unavailable' (no storage adapters, or loading failed), 'unchecked'
 * (not opened yet), 'checking', 'pending' (a draft waits for a decision) and
 * 'idle' (saving normally, unless `paused` by a discard).
 */

import { RedlineDocument } from './RedlineDocument.js';
import { DraftAutosaver, buildDraft, describeDraft, draftHasContent, readDraft } from './RedlineRecovery.js';

export class RedlineOverlayRecovery {
  constructor(overlay, { loadDraft, saveDraft, discardDraft, requestRecovery }) {
    this.overlay = overlay;
    this.options = { loadDraft, saveDraft, discardDraft, requestRecovery };
    const recoverable = Boolean(loadDraft && saveDraft && discardDraft);
    this.state = recoverable ? 'unchecked' : 'unavailable';
    /** The waiting draft: { draft, doc, summary }. */
    this.pending = null;
    /** Saving was switched off by discarding the current session's draft. */
    this.paused = false;
    /** A draft of this session is stored. */
    this.stored = false;
    /** The last reported failure, so a repeated one is not announced again. */
    this.failure = null;
    this.prompting = false;
    this.autosave = recoverable ? new DraftAutosaver({
      snapshot: () => this._snapshot(),
      save: draft => saveDraft(draft),
      discard: () => discardDraft({ sessionId: overlay.sessionId }),
      onResult: result => this._onResult(result),
      paused: true,
    }) : null;
  }

  // Autosave passthroughs; all are no-ops without storage adapters.
  schedule() { this.autosave?.schedule(); }
  flush() { this.autosave?.flush(); }
  flushNow() { this.autosave?.flushNow(); }

  /** Save what is pending and stop, for a destroyed overlay. */
  stop() {
    this.autosave?.flushNow();
    this.autosave?.pause();
  }

  /** The overlay opened: check once per page load, else offer a waiting draft. */
  onOpen() {
    if (this.state === 'unchecked') this._check();
    else if (this._canPrompt()) this._prompt();
  }

  /** Changes whenever the toolbar's recovery strip could change. */
  renderKey() {
    return [this.state, this.paused, this.stored, Boolean(this.pending)].join('|');
  }

  /** What the toolbar shows about recovery. */
  toolbarState() {
    const pending = this.pending;
    return {
      available: Boolean(this.autosave) && this.state !== 'unavailable',
      state: this.state,
      paused: this.paused,
      stored: this.stored,
      // The prompt itself describes the draft; the notice appears once it is dismissed.
      pending: pending && !this.prompting
        ? { savedTime: pending.summary.savedTime, markCount: pending.summary.markCount, contents: pending.summary.contents } : null,
    };
  }

  /**
   * The host reports that the page changed address within the same document.
   * Drafts are keyed by address, so the session is saved again under the new
   * one (immediately when `now`, as the page unloads).
   */
  noteAddressChanged({ now = false } = {}) {
    if (!this.autosave || this.state !== 'idle' || this.paused) return;
    this.autosave.addressChanged({ now });
  }

  /** Restore the waiting draft, replacing the current document (after confirmation if it has marks). */
  async restore({ scroll = false, confirmed = false } = {}) {
    const overlay = this.overlay;
    const pending = this.state === 'pending' ? this.pending : null;
    if (!pending || overlay._busy) return false;
    const current = overlay.document?.toJSON();
    if (!confirmed && (draftHasContent(current) || overlay.textEditor.active || overlay.legendEditor.active)) {
      const count = current?.annotations.length ?? 0;
      const ok = await overlay._withChildDialog(() => overlay.options.confirm({
        title: 'Replace the current marks?',
        message: `Restoring the draft saved at ${pending.summary.savedTime} replaces the ${count} mark${count === 1 ? '' : 's'} now open. Undo cannot bring them back; download JSON first to keep them.`,
        confirmLabel: 'Replace',
      }));
      if (!ok || this.pending !== pending) return false;
    }
    overlay.cropView.cancel();
    overlay.textEditor.finish({ commit: false });
    overlay.legendEditor.cancel({ focus: false });
    overlay.gestures.cancel();
    if (!overlay.document) overlay.document = new RedlineDocument();
    try {
      overlay.document.load(pending.draft.document, { prepare: snapshot => overlay._prepareRender(snapshot) });
    } catch (error) {
      overlay._reportError(error, 'Could not restore the draft');
      return false;
    }
    overlay.sessionStartedAt = pending.draft.createdAt;
    overlay.cursorFollow = pending.draft.ui?.cursorFollow === true;
    overlay._resetSelection();
    overlay._documentToken += 1;
    this.state = 'idle';
    this.pending = null;
    if (scroll) window.scrollTo(pending.draft.viewport.scrollX, pending.draft.viewport.scrollY);
    this.autosave.resume();
    // Save at once, so this session takes over the restored draft's entry
    // before any navigation could leave the old one behind.
    this.autosave.schedule();
    this.autosave.flush();
    overlay._syncViewport();
    overlay._render({ force: true });
    const count = overlay.document.marks.length;
    const message = `Restored ${count} mark${count === 1 ? '' : 's'} saved at ${pending.summary.savedTime}. Marks keep their screen positions; adjust them if the page moved.`;
    overlay._setMessage(message);
    overlay.options.setStatus(message);
    return true;
  }

  /**
   * Discard the waiting draft, or, with none waiting, the current session's
   * stored draft, which also pauses reload recovery until resumed so the next
   * change does not store it again.
   */
  async discard({ confirmed = false } = {}) {
    const overlay = this.overlay;
    if (!this.autosave || overlay._busy) return false;
    const pending = this.state === 'pending' ? this.pending : null;
    if (!confirmed) {
      const ok = await overlay._withChildDialog(() => overlay.options.confirm(pending ? {
        title: 'Discard the waiting draft?',
        message: `Delete the draft saved at ${pending.summary.savedTime} (${pending.summary.contents}) It cannot be recovered afterwards.`,
        confirmLabel: 'Discard',
      } : {
        title: 'Discard the recovery draft?',
        message: 'Delete the reload-recovery copy of these marks? They stay open now, but reload recovery stays off for this page until you resume it.',
        confirmLabel: 'Discard',
      }));
      if (!ok || (pending && this.pending !== pending)) return false;
    }
    const wasPaused = this.autosave.paused;
    this.autosave.pause();
    overlay._setBusy(true, 'Discarding the recovery draft…');
    try {
      const result = await this.autosave.discard();
      if (result?.ok === false) {
        // A failed deletion must keep Restore available and must not be reported
        // as a successful discard. Resume existing autosaving only if it was on.
        if (!wasPaused) {
          this.autosave.resume();
          this.autosave.schedule();
        }
        return false;
      }
      let message;
      if (pending) {
        this.state = 'idle';
        this.pending = null;
        // Marks drawn while the decision was pending are saved from now on.
        this.autosave.resume();
        this.autosave.schedule();
        message = 'Draft discarded';
      } else {
        this.paused = true;
        message = 'Recovery draft discarded; reload recovery is paused for this page until you resume it';
      }
      this.stored = false;
      overlay._setMessage(message);
      overlay.options.setStatus(message);
      return true;
    } finally {
      overlay._setBusy(false);
    }
  }

  resume() {
    if (!this.autosave || !this.paused) return false;
    this.paused = false;
    if (this.state !== 'pending') {
      this.autosave.resume();
      this.autosave.schedule();
    }
    this.overlay._setMessage('Reload recovery resumed');
    this.overlay._render({ force: true });
    return true;
  }

  _viewport() {
    return {
      width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX, scrollY: window.scrollY,
    };
  }

  /** The draft for the current session, including explanation or text edits not yet saved. */
  _snapshot() {
    const overlay = this.overlay;
    const json = overlay.document.toJSON();
    if (overlay.legendEditor.active) {
      const id = overlay.legendEditor.editingId;
      const text = overlay.legendEditor.input.value;
      json.annotations = json.annotations.map(mark => {
        if (mark.id !== id) return mark;
        const { text: _previous, ...rest } = mark;
        return text ? { ...rest, text } : rest;
      });
    }
    if (overlay.textEditor.active) {
      const editing = overlay.textEditor.mark;
      const text = overlay.textEditor.element.value.trim();
      if (editing && text) {
        const next = { ...JSON.parse(JSON.stringify(editing)), text };
        const index = json.annotations.findIndex(mark => mark.id === editing.id);
        if (index >= 0) json.annotations[index] = next;
        else json.annotations.push(next);
      }
    }
    return buildDraft({
      sessionId: overlay.sessionId, createdAt: overlay.sessionStartedAt, document: json,
      viewport: this._viewport(), ui: { cursorFollow: overlay.cursorFollow },
    });
  }

  async _check() {
    const overlay = this.overlay;
    this.state = 'checking';
    this.autosave?.pause();
    let stored;
    try {
      stored = await this.options.loadDraft();
    } catch (error) {
      console.warn('[Redline] Reload recovery is unavailable.', error);
      this.state = 'unavailable';
      overlay._setMessage(`Reload recovery is unavailable here: ${error?.message ?? error}`);
      overlay._render({ force: true });
      return;
    }
    let draft = null;
    let doc = null;
    if (stored) {
      try {
        draft = readDraft(stored);
        doc = new RedlineDocument();
        doc.load(draft.document, { prepare: snapshot => overlay._prepareRender(snapshot) });
      } catch (error) {
        console.warn('[Redline] Discarding an unreadable recovery draft.', error);
        draft = null;
        await Promise.resolve(this.options.discardDraft()).catch(() => {});
        overlay._setMessage('An unreadable reload-recovery draft was discarded');
      }
    }
    if (!draft || !draftHasContent(doc.toJSON())) {
      this.state = 'idle';
      this.stored = false;
      this.autosave.assume({ stored: false });
      this.autosave.resume();
      overlay._render({ force: true });
      return;
    }
    this.state = 'pending';
    this.stored = true;
    this.pending = { draft, doc, summary: describeDraft(draft, doc, this._viewport()) };
    this.autosave.assume({ stored: true });
    overlay._render({ force: true });
    if (this._canPrompt()) await this._prompt();
    else overlay._setMessage(`A draft saved at ${this.pending.summary.savedTime} is waiting — Restore or Discard it`);
  }

  _canPrompt() {
    const overlay = this.overlay;
    return this.state === 'pending' && Boolean(this.options.requestRecovery) && !this.prompting
      && overlay.active && !overlay.pageMode && !overlay._busy && overlay._dialogDepth === 0
      && !overlay.textEditor.active && !overlay.legendEditor.active && !overlay.gestures.pointer && !overlay.gestures.draft
      && !draftHasContent(overlay.document?.toJSON());
  }

  async _prompt() {
    const overlay = this.overlay;
    const pending = this.pending;
    if (!pending) return;
    this.prompting = true;
    overlay._render({ force: true });
    let result;
    try {
      const summary = describeDraft(pending.draft, pending.doc, this._viewport());
      result = await overlay._withChildDialog(() => this.options.requestRecovery(summary));
    } finally {
      this.prompting = false;
    }
    if (this.pending !== pending) {
      overlay._render({ force: true });
      return;
    }
    if (result?.choice === 'restore') {
      await this.restore({ scroll: result.scroll, confirmed: true });
    } else if (result?.choice === 'discard') {
      await this.discard({ confirmed: true });
    } else {
      overlay._setMessage('Draft kept — Restore or Discard it from this strip');
      overlay.options.setStatus('Redline draft kept for later. New marks are not saved for reload recovery until you restore or discard it.');
      overlay._render({ force: true });
    }
  }

  _onResult(result) {
    const overlay = this.overlay;
    const before = this.stored;
    if (result.ok) this.stored = result.operation === 'save';
    if (!result.ok) {
      const messages = {
        quota: 'Reload recovery could not save: the extension’s session storage is full. Your marks are still open; download JSON to keep them.',
        'too-large': 'This session is too large for reload recovery. Your marks are still open; download JSON to keep them.',
      };
      const message = result.operation === 'discard'
        ? `Could not discard the recovery draft (${result.error ?? result.code}). It is still kept and may be offered after reload; try again.`
        : messages[result.code]
          ?? `Reload recovery could not save (${result.error ?? result.code}). Your marks are still open; download JSON to keep them.`;
      const failure = `${result.operation}:${result.code}`;
      overlay._setMessage(message);
      if (this.failure !== failure) {
        this.failure = failure;
        overlay.options.setStatus(message);
      }
    } else if (result.ok && this.failure) {
      this.failure = null;
      overlay._setMessage('Reload recovery is saving again');
    }
    if (before !== this.stored && overlay.active) overlay._render({ force: true });
  }
}
