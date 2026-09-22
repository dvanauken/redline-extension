/**
 * In-place rich-text editor for text boxes and closed shapes.
 *
 * A native textarea remains the input/IME/clipboard/assistive-technology
 * endpoint, but the shared shape layout paints the visible text, selection and
 * caret. That lets a real selection range flow through a polygon or ellipse
 * instead of being constrained to the textarea's rectangle.
 */

import {
  TEXT_CONTAINER_TYPES, applyTextRangeStyle, baseTextStyle, layoutShapeText, remapTextRuns,
  textIndexAtPoint, textStyleAt,
} from './RedlineShapeText.js';
import { fitTextBoxContent } from './RedlineTextLayout.js';
import { boxCenter, boxFromPoints, markRotation, rotatePoint } from './RedlineGeometry.js';
import { keepCornerInPlace } from './RedlineTransform.js';

const FORMAT_FIELDS = {
  bold: 'bold', italic: 'italic', underline: 'underline', textColor: 'textColor',
  fontFamily: 'fontFamily', fontSize: 'fontSize',
};

function runStyleFields(style, mark) {
  const base = baseTextStyle({ ...mark, textRuns: [] });
  return {
    ...(style.bold !== base.bold ? { bold: style.bold } : {}),
    ...(style.italic !== base.italic ? { italic: style.italic } : {}),
    ...(style.underline !== base.underline ? { underline: style.underline } : {}),
    ...(style.color !== base.color ? { textColor: style.color } : {}),
    ...(style.family !== base.family ? { fontFamily: style.family } : {}),
    ...(style.size !== base.size ? { fontSize: style.size } : {}),
  };
}

export class RedlineTextEditor {
  constructor({ root, svg, measurer, getDocument, onFinish, onInput = () => {}, onChange = () => {}, keepsEditing = () => false }) {
    this.root = root;
    this.svg = svg;
    this.measurer = measurer;
    this.getDocument = getDocument;
    this.onFinish = onFinish;
    this.onInput = onInput;
    this.onChange = onChange;
    this.keepsEditing = keepsEditing;
    this.session = null;
  }

  get active() { return Boolean(this.session); }
  get mark() { return this.session?.preview ?? this.session?.mark ?? null; }
  get creating() { return Boolean(this.session?.creating); }
  get element() { return this.session?.element ?? null; }
  get selectionStart() { return this.session?.element.selectionStart ?? 0; }
  get selectionEnd() { return this.session?.element.selectionEnd ?? 0; }

  contains(node) {
    return Boolean(this.session && (this.session.element === node || this.session.controls.contains(node)));
  }

  owns(node) { return this.contains(node); }

  start(mark, { creating = false, initialText = null } = {}) {
    if (!TEXT_CONTAINER_TYPES.has(mark?.type)) return false;
    const editor = document.createElement('textarea');
    editor.dataset.redlineTextEditor = '';
    editor.dataset.redlineShapeTextEditor = mark.type;
    if (mark.type === 'rectangle') editor.dataset.redlineRectangleLabelEditor = '';
    editor.setAttribute('aria-label', mark.type === 'textbox' ? 'Text box content' : `${mark.type} text`);
    editor.spellcheck = true;
    editor.autocapitalize = 'sentences';
    editor.value = initialText ?? mark.text ?? '';

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

    const preview = initialText === null ? { ...mark } : remapTextRuns(mark, editor.value, runStyleFields(baseTextStyle(mark)));
    this.session = {
      element: editor, controls, mark, preview, creating,
      typingStyle: runStyleFields(textStyleAt(preview, Math.max(0, editor.value.length - 1)), preview),
      pointerAnchor: null,
    };
    this.root.append(editor, controls);
    this.position();

    editor.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.finish({ commit: false, restoreFocus: true });
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.finish({ commit: true, restoreFocus: true });
      } else if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        const property = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
        const current = this.currentStyle();
        this.applyFormat(property, !current[property]);
      }
    });
    editor.addEventListener('input', () => {
      const session = this.session;
      if (!session) return;
      session.preview = remapTextRuns(session.preview, editor.value, session.typingStyle);
      this._fitPreview();
      this.position();
      this.onInput();
      this.onChange();
    });
    for (const type of ['select', 'keyup', 'click']) editor.addEventListener(type, () => {
      this._syncTypingStyle();
      this.position();
      this.onChange();
    });
    editor.addEventListener('blur', () => {
      queueMicrotask(() => {
        if (this.session?.element === editor && !this.keepsEditing()
          && !this.root.getRootNode().activeElement?.closest?.('[data-redline-context]')) {
          this.finish({ commit: true });
        }
      });
    });
    save.addEventListener('click', () => this.finish({ commit: true, restoreFocus: true }));
    cancel.addEventListener('click', () => this.finish({ commit: false, restoreFocus: true }));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    this._syncTypingStyle();
    this.position();
    this.onChange();
    return true;
  }

  _fitPreview() {
    const session = this.session;
    const doc = this.getDocument();
    if (!session || !doc || session.preview.type !== 'textbox') return;
    const original = boxFromPoints(session.mark.start, session.mark.end);
    // Refit from the session's original upright box on every keystroke. Using
    // the already translated rotated preview as the next input compounds its
    // anchoring translation and makes the corner walk across the page.
    const upright = { ...session.preview, start: session.mark.start, end: session.mark.end };
    session.preview = keepCornerInPlace(session.mark, fitTextBoxContent(upright, this.measurer, {
      maxWidth: Math.min(600, doc.width - original.x),
    }));
  }

  _localPoint(point) {
    const mark = this.mark;
    if (!mark) return point;
    const rotation = markRotation(mark);
    if (!rotation) return point;
    const box = mark.type === 'polygon'
      ? (() => {
        const xs = mark.points.map(item => item.x);
        const ys = mark.points.map(item => item.y);
        return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      })()
      : boxFromPoints(mark.start, mark.end);
    return rotatePoint(point, boxCenter(box), -rotation);
  }

  indexAtPoint(point) {
    const mark = this.mark;
    if (!mark) return 0;
    return textIndexAtPoint(layoutShapeText(mark, this.measurer), mark, this._localPoint(point), this.measurer);
  }

  pointerDown(point, { shiftKey = false } = {}) {
    const session = this.session;
    if (!session) return false;
    const index = this.indexAtPoint(point);
    const anchor = shiftKey ? session.element.selectionStart : index;
    session.pointerAnchor = anchor;
    session.element.setSelectionRange(Math.min(anchor, index), Math.max(anchor, index));
    session.element.focus({ preventScroll: true });
    this._syncTypingStyle();
    this.onChange();
    return true;
  }

  pointerDrag(point) {
    const session = this.session;
    if (!session || session.pointerAnchor === null) return false;
    const index = this.indexAtPoint(point);
    session.element.setSelectionRange(Math.min(session.pointerAnchor, index), Math.max(session.pointerAnchor, index),
      index < session.pointerAnchor ? 'backward' : 'forward');
    this._syncTypingStyle();
    this.onChange();
    return true;
  }

  pointerUp() {
    if (!this.session) return false;
    this.session.pointerAnchor = null;
    return true;
  }

  _syncTypingStyle() {
    const session = this.session;
    if (!session) return;
    const index = Math.max(0, Math.min(session.preview.text.length - 1,
      session.element.selectionStart > 0 ? session.element.selectionStart - 1 : session.element.selectionStart));
    session.typingStyle = runStyleFields(textStyleAt(session.preview, index), session.preview);
  }

  /** Formatting state at the caret or start of the selected range. */
  currentStyle() {
    if (!this.session) return null;
    const index = Math.max(0, Math.min(this.mark.text.length - 1, this.selectionStart));
    const style = textStyleAt(this.mark, index);
    const current = {
      bold: style.bold, italic: style.italic, underline: style.underline,
      textColor: style.color, fontFamily: style.family, fontSize: style.size,
      textAlign: this.mark.textAlign ?? (this.mark.type === 'textbox' ? 'left' : 'center'),
      verticalAlign: this.mark.verticalAlign ?? (this.mark.type === 'textbox' ? 'top' : 'middle'),
    };
    if (this.selectionStart === this.selectionEnd) Object.assign(current, this.session.typingStyle);
    return current;
  }

  applyFormat(property, value) {
    const session = this.session;
    if (!session) return false;
    if (property === 'textAlign' || property === 'verticalAlign') {
      session.preview = { ...session.preview, [property]: value };
    } else if (FORMAT_FIELDS[property]) {
      if (this.selectionStart !== this.selectionEnd) {
        session.preview = applyTextRangeStyle(session.preview, property, value, this.selectionStart, this.selectionEnd);
      } else {
        session.typingStyle = { ...session.typingStyle, [FORMAT_FIELDS[property]]: value };
      }
    } else {
      return false;
    }
    this.position();
    this.onInput();
    this.onChange();
    session.element.focus({ preventScroll: true });
    return true;
  }

  position() {
    const session = this.session;
    const doc = this.getDocument();
    if (!session || !doc || !this.svg.isConnected) return;
    const layout = layoutShapeText(session.preview, this.measurer);
    const index = session.element.selectionEnd;
    const line = layout.lines.find(item => index >= item.start && index <= item.end) ?? layout.lines.at(-1);
    const anchor = line ? { x: line.x, y: line.top, height: line.height } : { x: layout.box.x, y: layout.box.y, height: 20 };
    const rotation = markRotation(session.preview);
    const turned = rotation ? rotatePoint(anchor, boxCenter(layout.box), rotation) : anchor;
    const svgRect = this.svg.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const scaleX = svgRect.width / Math.max(1, doc.width);
    const scaleY = svgRect.height / Math.max(1, doc.height);
    Object.assign(session.element.style, {
      left: `${svgRect.left - rootRect.left + turned.x * scaleX}px`,
      top: `${svgRect.top - rootRect.top + turned.y * scaleY}px`,
      width: '2px',
      height: `${Math.max(2, anchor.height * scaleY)}px`,
    });

    const box = layout.box;
    const corners = [
      { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height },
    ].map(point => rotation ? rotatePoint(point, boxCenter(box), rotation) : point);
    const left = svgRect.left - rootRect.left + Math.min(...corners.map(point => point.x)) * scaleX;
    const top = svgRect.top - rootRect.top + Math.min(...corners.map(point => point.y)) * scaleY;
    const width = (Math.max(...corners.map(point => point.x)) - Math.min(...corners.map(point => point.x))) * scaleX;
    const height = (Math.max(...corners.map(point => point.y)) - Math.min(...corners.map(point => point.y))) * scaleY;
    const controlsRect = session.controls.getBoundingClientRect();
    const gutter = 8;
    session.controls.style.left = `${Math.min(Math.max(gutter, left + width - controlsRect.width), Math.max(gutter, rootRect.width - controlsRect.width - gutter))}px`;
    const below = top + height + 6;
    session.controls.style.top = `${below + controlsRect.height <= rootRect.height - gutter ? below : Math.max(gutter, top - controlsRect.height - 6)}px`;
  }

  /** End the edit. Returns false when nothing was being edited. */
  finish({ commit, restoreFocus = false } = {}) {
    const session = this.session;
    if (!session) return false;
    const cleanText = session.element.value.trim();
    const preview = cleanText === session.preview.text ? session.preview : remapTextRuns(session.preview, cleanText, session.typingStyle);
    this.session = null;
    session.element.remove();
    session.controls.remove();
    this.onFinish({
      mark: session.mark,
      preview,
      geometry: preview.start && preview.end ? { start: preview.start, end: preview.end } : null,
      creating: session.creating,
      commit,
      text: cleanText,
    });
    this.onChange();
    if (restoreFocus) this.svg.focus({ preventScroll: true });
    return true;
  }
}
