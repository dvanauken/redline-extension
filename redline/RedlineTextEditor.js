/**
 * In-place editor for text boxes and labels attached to rectangles.
 *
 * A textarea over the box handles typing, IME and the clipboard. It uses the
 * shared font, padding and line height, so committed text reads the way it did
 * while typing; rectangle labels keep their rectangle's existing geometry.
 *
 * Keys: Ctrl/Cmd+Enter saves, Escape cancels the edit without closing Redline,
 * and moving focus away saves.
 *
 * A rotated text box is edited in place, turned with it. As it grows, its
 * upright top-left corner stays where it is on the page.
 */

import {
  RECTANGLE_LABEL_PADDING, REDLINE_FONT_FAMILY, TEXTBOX_LINE_HEIGHT, TEXTBOX_PADDING,
  fitTextBoxContent, layoutRectangleLabel,
} from './RedlineTextLayout.js';
import { rectangleLabelColor, redlineTextBoxFill } from './RedlineStyles.js';
import { boxCenter, boxFromPoints, markRotation, rotatePoint } from './RedlineGeometry.js';
import { keepCornerInPlace } from './RedlineTransform.js';

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

  start(mark, { creating = false, initialText = null } = {}) {
    const rectangleLabel = mark.type === 'rectangle';
    const editor = document.createElement('textarea');
    editor.dataset.redlineTextEditor = '';
    if (rectangleLabel) editor.dataset.redlineRectangleLabelEditor = '';
    editor.setAttribute('aria-label', rectangleLabel ? 'Rectangle label' : 'Text box content');
    editor.setAttribute('placeholder', rectangleLabel ? 'Type a label' : 'Type here');
    editor.spellcheck = true;
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

    this.session = { element: editor, controls, mark, creating, rectangleLabel };
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
    save.addEventListener('click', () => this.finish({ commit: true, restoreFocus: true }));
    cancel.addEventListener('click', () => this.finish({ commit: false, restoreFocus: true }));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  position() {
    const session = this.session;
    const doc = this.getDocument();
    if (!session || !doc || !this.svg.isConnected) return;
    const original = boxFromPoints(session.mark.start, session.mark.end);
    let rectangleLayout = null;
    if (session.rectangleLabel) {
      session.preview = { ...session.mark, text: session.element.value };
      rectangleLayout = layoutRectangleLabel(session.preview, this.measurer);
    } else {
      session.preview = keepCornerInPlace(session.mark, fitTextBoxContent({ ...session.mark, text: session.element.value }, this.measurer, {
        maxWidth: Math.min(600, doc.width - original.x),
      }));
    }
    const box = boxFromPoints(session.preview.start, session.preview.end);
    const rotation = markRotation(session.preview);
    const corner = rotatePoint({ x: box.x, y: box.y }, boxCenter(box), rotation);
    const svgRect = this.svg.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const scaleX = svgRect.width / Math.max(1, doc.width);
    const scaleY = svgRect.height / Math.max(1, doc.height);
    let left = svgRect.left - rootRect.left + corner.x * scaleX;
    let top = svgRect.top - rootRect.top + corner.y * scaleY;
    let width = box.width * scaleX;
    let height = box.height * scaleY;
    Object.assign(session.element.style, {
      left: `${left}px`,
      top: `${top}px`,
      // Scale the entire editor, including glyph widths, exactly like SVG/PNG,
      // turned about its corner as the SVG turns the box about its centre.
      width: `${box.width}px`,
      height: `${box.height}px`,
      transformOrigin: 'top left',
      transform: `scale(${scaleX}, ${scaleY})${rotation ? ` rotate(${rotation}deg)` : ''}`,
      padding: session.rectangleLabel
        ? `${rectangleLayout.paddingTop}px ${RECTANGLE_LABEL_PADDING}px 0`
        : `${TEXTBOX_PADDING}px`,
      fontFamily: REDLINE_FONT_FAMILY,
      fontSize: `${session.mark.fontSize ?? 16}px`,
      lineHeight: String(TEXTBOX_LINE_HEIGHT),
      fontWeight: session.rectangleLabel ? '600' : '400',
      textAlign: session.rectangleLabel ? 'center' : 'left',
      color: session.rectangleLabel ? rectangleLabelColor(session.mark) : '#292D32',
      borderWidth: '0px',
      outline: '1px solid #6EA8FF',
      backgroundColor: session.rectangleLabel ? 'transparent' : redlineTextBoxFill(session.mark.backgroundOpacity),
    });
    if (rotation) {
      // Place the actions against the turned editor's on-screen extent.
      const turned = session.element.getBoundingClientRect();
      ({ width, height } = turned);
      left = turned.left - rootRect.left;
      top = turned.top - rootRect.top;
    }
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
  finish({ commit, restoreFocus = false }) {
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
    if (restoreFocus) this.svg.focus({ preventScroll: true });
    return true;
  }
}
