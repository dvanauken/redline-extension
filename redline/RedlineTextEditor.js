/**
 * In-place editor for text box marks.
 *
 * A textarea over the box handles typing, IME and the clipboard. It uses the
 * shared font, padding and line height, so the committed text box reads the
 * way it did while typing; the committed box is drawn from the shared layout.
 *
 * Keys: Ctrl/Cmd+Enter saves, Escape cancels the edit without closing Redline,
 * and moving focus away saves.
 */

import {
  REDLINE_FONT_FAMILY, TEXTBOX_LINE_HEIGHT, TEXTBOX_PADDING, fitTextBoxContent,
} from './RedlineTextLayout.js';
import { redlineTextBoxFill } from './RedlineStyles.js';
import { boxFromPoints } from './RedlineGeometry.js';

export class RedlineTextEditor {
  constructor({ root, svg, measurer, getDocument, onFinish, onInput = () => {} }) {
    this.root = root;
    this.svg = svg;
    this.measurer = measurer;
    this.getDocument = getDocument;
    this.onFinish = onFinish;
    this.onInput = onInput;
    this.session = null;
  }

  get active() { return Boolean(this.session); }
  get mark() { return this.session?.preview ?? this.session?.mark ?? null; }
  get creating() { return Boolean(this.session?.creating); }
  get element() { return this.session?.element ?? null; }

  contains(node) {
    return Boolean(this.session && (this.session.element === node || this.session.controls.contains(node)));
  }

  start(mark, { creating = false } = {}) {
    const editor = document.createElement('textarea');
    editor.dataset.redlineTextEditor = '';
    editor.setAttribute('aria-label', 'Text box content');
    editor.setAttribute('placeholder', 'Type here');
    editor.spellcheck = true;
    editor.value = mark.text ?? '';

    const controls = document.createElement('div');
    controls.dataset.redlineTextControls = '';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Text editing actions');
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.title = 'Save text (Ctrl+Enter)';
    save.dataset.redlineTextCommit = '';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.title = 'Discard this edit (Esc)';
    cancel.dataset.redlineTextCancel = '';
    controls.append(save, cancel);
    controls.addEventListener('pointerdown', event => event.preventDefault());

    this.session = { element: editor, controls, mark, creating };
    this.root.append(editor, controls);
    this.position();

    editor.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.finish({ commit: false });
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.finish({ commit: true });
      }
    });
    editor.addEventListener('input', () => {
      this.position();
      this.onInput();
    });
    editor.addEventListener('blur', () => {
      queueMicrotask(() => {
        if (this.session?.element === editor) this.finish({ commit: true });
      });
    });
    save.addEventListener('click', () => this.finish({ commit: true }));
    cancel.addEventListener('click', () => this.finish({ commit: false }));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  position() {
    const session = this.session;
    const doc = this.getDocument();
    if (!session || !doc || !this.svg.isConnected) return;
    const original = boxFromPoints(session.mark.start, session.mark.end);
    session.preview = fitTextBoxContent({ ...session.mark, text: session.element.value }, this.measurer, {
      maxWidth: Math.min(600, doc.width - original.x),
    });
    const box = boxFromPoints(session.preview.start, session.preview.end);
    const svgRect = this.svg.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const scaleX = svgRect.width / Math.max(1, doc.width);
    const scaleY = svgRect.height / Math.max(1, doc.height);
    const left = svgRect.left - rootRect.left + box.x * scaleX;
    const top = svgRect.top - rootRect.top + box.y * scaleY;
    const width = box.width * scaleX;
    const height = box.height * scaleY;
    Object.assign(session.element.style, {
      left: `${left}px`,
      top: `${top}px`,
      // Scale the entire editor, including glyph widths, exactly like SVG/PNG.
      width: `${box.width}px`,
      height: `${box.height}px`,
      transformOrigin: 'top left',
      transform: `scale(${scaleX}, ${scaleY})`,
      padding: `${TEXTBOX_PADDING}px`,
      fontFamily: REDLINE_FONT_FAMILY,
      fontSize: `${session.mark.fontSize ?? 16}px`,
      lineHeight: String(TEXTBOX_LINE_HEIGHT),
      borderWidth: '0px',
      outline: '1px solid #6EA8FF',
      backgroundColor: redlineTextBoxFill(session.mark.backgroundOpacity),
    });
    const controlsRect = session.controls.getBoundingClientRect();
    const gutter = 8;
    const controlsLeft = Math.min(
      Math.max(gutter, left + width - controlsRect.width),
      Math.max(gutter, rootRect.width - controlsRect.width - gutter),
    );
    const below = top + height + 6;
    const controlsTop = below + controlsRect.height <= rootRect.height - gutter
      ? below
      : Math.max(gutter, top - controlsRect.height - 6);
    session.controls.style.left = `${controlsLeft}px`;
    session.controls.style.top = `${controlsTop}px`;
  }

  /** End the edit. Returns false when nothing was being edited. */
  finish({ commit }) {
    const session = this.session;
    if (!session) return false;
    this.position();
    this.session = null;
    session.element.remove();
    session.controls.remove();
    this.onFinish({
      mark: session.mark,
      geometry: { start: session.preview.start, end: session.preview.end },
      creating: session.creating,
      commit,
      text: session.element.value.trim(),
    });
    return true;
  }
}
