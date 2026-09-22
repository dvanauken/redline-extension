/**
 * The colour dialog of a RedlineOverlay: stroke, fill and text colours for the
 * current style subject (the selected mark or the active tool's defaults), an
 * opacity slider that applies as it moves, No Fill / No Outline, and the page
 * eyedropper.
 *
 * A request resolves as soon as a colour is picked, rather than on the
 * dialog's close event, which arrives a task later. Every edit goes through
 * the overlay's _applyStyle, so it reaches exactly one target.
 */

import { RedlineEyedropper } from './RedlineEyedropper.js';
import { appendIcon } from './icons.js';
import { CLOSED_TYPES, STROKE_OPACITY_TYPES, isHexColor, redlineMarkFill, redlineMarkStroked } from './RedlineStyles.js';
import { MARK_NAMES } from './RedlineToolDefaults.js';

/** A picked colour, with its intent when the pick carried one. */
function styleFromPick(source) {
  if (!isHexColor(source.color)) return null;
  const style = { color: String(source.color) };
  if ('intent' in source) style.intent = source.intent ? String(source.intent) : null;
  return style;
}

export class RedlineOverlayColor {
  constructor(overlay) {
    this.overlay = overlay;
    this.eyedropper = null;
    this._resolve = null;
    this._target = null;
    this._anchor = null;
    this._opacityMergeKey = null;
    this._opacityDefaultsDirty = false;
    this._build();
  }

  get open() { return this.dialog.open; }

  /**
   * Ask for a colour for `target` ('stroke', 'fill' or 'text') of the current
   * subject, positioned by `anchor`, and apply it. Resolves whether anything changed.
   */
  async choose(target = 'stroke', anchor = null) {
    const overlay = this.overlay;
    if (this.dialog.open) return false;
    // A cancelled native dialog may still have a queued close event. Settle
    // that request now so a quick reopen cannot lose the user's click.
    if (this._resolve) this._settle(null);
    const subject = overlay._subject();
    if (subject.kind === 'none') return false;
    const style = subject.style;
    const closed = CLOSED_TYPES.has(style.type);
    const fill = redlineMarkFill(style);
    const initial = target === 'text' ? (style.textColor ?? '#292D32')
      : target === 'fill' ? (fill?.color ?? style.fill ?? style.color) : style.color;
    const name = MARK_NAMES[subject.type] ?? 'mark';
    const role = target === 'text' ? 'Text' : target === 'fill' ? 'Fill' : closed ? 'Outline' : style.type === 'textbox' ? 'Border' : 'Color';
    this.heading.textContent = `${role}${role === 'Color' ? '' : ' color'} · ${subject.kind === 'selection' ? `selected ${name}` : `new ${name}s`}`;
    this._anchor = anchor;
    // [extension patch] no registry means no upgrade to wait for.
    if (globalThis.customElements) await customElements.whenDefined('wb-color-picker');
    this.picker.value = initial;
    if ('annotationStyle' in this.picker) this.picker.annotationStyle = { color: initial, intent: style.intent ?? null };
    const supportsOpacity = target === 'text' ? false : target === 'fill' ? closed : STROKE_OPACITY_TYPES.has(style.type);
    const opacity = target === 'fill'
      ? (fill?.opacity ?? style.savedFill?.opacity ?? overlay.defaults.lastFillOpacity)
      : (style.opacity ?? (style.type === 'brush' ? overlay.defaults.brushOpacity : 1));
    const opacityMergeKey = Symbol(`color-opacity:${target}`);
    this._target = target;
    this._opacityMergeKey = opacityMergeKey;
    this._opacityDefaultsDirty = false;
    this.options.hidden = target === 'text' || (!closed && !supportsOpacity);
    this.noPaintButton.hidden = target === 'text' || !closed;
    this.noPaintButton.textContent = target === 'fill' ? 'No Fill' : 'No Outline';
    this.noPaintButton.title = target === 'fill'
      ? 'Remove the shape fill'
      : 'Remove the shape outline';
    for (const element of [this.opacityLabel, this.opacity, this.opacityOutput]) {
      element.hidden = !supportsOpacity;
    }
    this.opacity.value = String(Math.max(1, Math.round(opacity * 100)));
    this.opacityOutput.value = `${this.opacity.value}%`;
    this.opacity.setAttribute('aria-valuetext', `${this.opacity.value}% opacity`);
    this.dialog.returnValue = 'cancel';

    const picked = await overlay._withChildDialog(() => new Promise(resolve => {
      this._resolve = resolve;
      this.dialog.showModal();
      this.position();
      this.picker.initialFocus?.focus();
    }));
    this._anchor?.focus?.({ preventScroll: true });
    if (!picked || !overlay.active) return false;
    if (picked.none && closed) {
      return overlay._applyStyle(
        { property: 'treatment', value: target === 'fill' ? 'outline' : 'fill' },
        { mergeKey: opacityMergeKey },
      );
    }
    if (!picked.color) return false;
    if (target === 'text') return overlay._applyStyle({ property: 'textColor', value: picked.color });
    // The pick names the mark's meaning only when it sets the colour people see
    // first: the outline, or the fill of a fill-only shape.
    const primary = target === 'fill' ? closed && !redlineMarkStroked(style) : !closed || redlineMarkStroked(style);
    const value = {
      color: picked.color,
      opacity: picked.opacity,
      fillOpacity: picked.opacity,
      enable: closed,
    };
    if (primary && 'intent' in picked) value.intent = picked.intent;
    else if (primary) value.intent = null;
    return overlay._applyStyle(
      { property: target === 'fill' ? 'fillColor' : 'strokeColor', value },
      { mergeKey: opacityMergeKey },
    );
  }

  /** Place the dialog under its trigger (or above it when there is no room). */
  position() {
    if (!this.dialog?.open) return;
    const trigger = this._anchor?.isConnected ? this._anchor : this.overlay.toolbarUI.bar;
    const gutter = 8;
    const gap = 6;
    const triggerRect = trigger.getBoundingClientRect();
    this.dialog.style.left = '0px';
    this.dialog.style.top = '0px';
    const dialogRect = this.dialog.getBoundingClientRect();
    const maxLeft = Math.max(gutter, window.innerWidth - dialogRect.width - gutter);
    const maxTop = Math.max(gutter, window.innerHeight - dialogRect.height - gutter);
    let left = triggerRect.left;
    let top = triggerRect.bottom + gap;
    let placement = 'bottom-start';
    if (top + dialogRect.height > window.innerHeight - gutter) {
      top = triggerRect.top - dialogRect.height - gap;
      placement = 'top-start';
    }
    left = Math.min(Math.max(gutter, left), maxLeft);
    top = Math.min(Math.max(gutter, top), maxTop);
    this.dialog.style.left = `${Math.round(left)}px`;
    this.dialog.style.top = `${Math.round(top)}px`;
    this.dialog.dataset.placement = placement;
  }

  cancelEyedropper() { this.eyedropper?.cancel(); }

  /** Close an open request without a pick. */
  close() {
    if (this.dialog.open) this.dialog.close('cancel');
  }

  destroy() {
    this.eyedropper?.destroy();
    this.close();
    this.dialog.remove();
  }

  _build() {
    const overlay = this.overlay;
    this.dialog = document.createElement('dialog');
    this.dialog.dataset.dialog = 'redline-color';
    this.dialog.setAttribute('aria-labelledby', 'redline-color-heading');

    this.heading = document.createElement('h2');
    this.heading.id = 'redline-color-heading';
    this.heading.dataset.redlineColorHeading = '';
    this.dialog.appendChild(this.heading);

    this.options = document.createElement('div');
    this.options.dataset.redlineColorOptions = '';
    this.noPaintButton = document.createElement('button');
    this.noPaintButton.type = 'button';
    this.noPaintButton.dataset.redlineNoPaint = '';
    this.noPaintButton.addEventListener('click', () => this._settle({ none: true }));
    this.opacityLabel = document.createElement('label');
    this.opacityLabel.textContent = 'Opacity';
    this.opacityLabel.htmlFor = 'redline-color-opacity';
    this.opacity = document.createElement('input');
    this.opacity.id = 'redline-color-opacity';
    this.opacity.type = 'range';
    this.opacity.min = '1';
    this.opacity.max = '100';
    this.opacity.step = '1';
    this.opacity.setAttribute('aria-label', 'Opacity');
    this.opacityOutput = document.createElement('output');
    this.opacityOutput.htmlFor = this.opacity.id;
    this.opacityOutput.dataset.redlineColorOpacityOutput = '';
    this.opacity.addEventListener('input', () => {
      this.opacityOutput.value = `${this.opacity.value}%`;
      this.opacity.setAttribute('aria-valuetext', `${this.opacity.value}% opacity`);
      if (this.dialog.open) this._applyOpacity();
    });
    this.options.append(this.noPaintButton, this.opacityLabel, this.opacity, this.opacityOutput);
    this.dialog.appendChild(this.options);

    this.eyedropperButton = document.createElement('button');
    this.eyedropperButton.type = 'button';
    this.eyedropperButton.dataset.redlineEyedropperButton = '';
    this.eyedropperButton.textContent = 'Pick from page';
    this.eyedropperButton.title = 'Eyedropper — sample a color from the page';
    this.eyedropperButton.hidden = !overlay.options.capturePage && !overlay.options.captureFallback;
    appendIcon(this.eyedropperButton, 'eyedropper');
    this.eyedropperButton.addEventListener('click', () => this._samplePage());
    this.dialog.appendChild(this.eyedropperButton);

    this.picker = overlay.options.createColorPicker();
    this.picker.setAttribute('value', overlay.defaults.color);
    this.picker.setAttribute('aria-label', 'Annotation color picker');
    this.picker.addEventListener('wb-change', event => {
      if (!event.detail?.color || !this.dialog.open) return;
      this._settle({ ...styleFromPick(event.detail), opacity: Number(this.opacity.value) / 100 });
    });
    this.picker.addEventListener('click', event => {
      if (!this.dialog.open) return;
      const swatch = event.composedPath().find(node => node instanceof Element && node.matches?.('[data-color]'));
      if (!swatch?.dataset.color) return;
      this._settle({ ...styleFromPick(swatch.dataset), opacity: Number(this.opacity.value) / 100 });
    });
    this.dialog.appendChild(this.picker);
    // [extension patch] keep the color dialog inside the same (shadow) mount as the root.
    overlay.options.mount.appendChild(this.dialog);

    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this._settle(null);
    });
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) this._settle(null);
    });
    // Escape or a click outside: nothing was picked. The close event arrives a
    // task later, so ignore one that lands after a new request reopened the dialog.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this._settle(null);
    });
  }

  /** Resolve the open request with `style` (null when nothing was picked) and close. */
  _settle(style) {
    this.eyedropper?.cancel();
    if (this._opacityDefaultsDirty) this.overlay._savePreferences();
    this._opacityDefaultsDirty = false;
    const resolve = this._resolve;
    this._resolve = null;
    if (this.dialog.open) this.dialog.close(style ? 'apply' : 'cancel');
    resolve?.(style);
  }

  async _samplePage() {
    const overlay = this.overlay;
    if (!overlay.active || !this.dialog.open || this.eyedropper?.active) return;
    const request = this._resolve;
    const lifecycle = overlay._lifecycleToken;
    this.eyedropper ??= new RedlineEyedropper({
      mount: overlay.options.mount,
      capture: () => overlay.exporter.captureBase(),
    });
    this.eyedropperButton.disabled = true;
    try {
      const color = await overlay._withChildDialog(() => this.eyedropper.pick());
      if (!overlay.active || lifecycle !== overlay._lifecycleToken || request !== this._resolve) return;
      if (color) {
        this._settle({ color, intent: null, opacity: Number(this.opacity.value) / 100 });
        overlay._setMessage('Picked ' + color + ' from the page');
      }
    } catch (error) {
      if (overlay.active && lifecycle === overlay._lifecycleToken && request === this._resolve) {
        overlay._reportError(error, 'Could not pick a page color');
      }
    } finally {
      this.eyedropperButton.disabled = false;
      if (overlay.active && this.dialog.open && request === this._resolve) {
        this.eyedropperButton.focus({ preventScroll: true });
      }
    }
  }

  /** Apply range input immediately, without requiring a colour pick or closing the dialog. */
  _applyOpacity() {
    const overlay = this.overlay;
    const target = this._target;
    const subject = overlay._subject();
    if (!target || subject.kind === 'none') return false;
    const style = subject.style;
    const closed = CLOSED_TYPES.has(style.type);
    if (target === 'fill' && !closed) return false;
    if (target === 'stroke' && !STROKE_OPACITY_TYPES.has(style.type)) return false;
    const fill = redlineMarkFill(style);
    const color = target === 'fill'
      ? (fill?.color ?? style.savedFill?.color ?? style.fill ?? style.color)
      : style.color;
    const opacity = Number(this.opacity.value) / 100;
    const value = target === 'fill'
      ? { color, fillOpacity: opacity }
      : { color, opacity, enable: closed };
    const changed = overlay._applyStyle(
      { property: target === 'fill' ? 'fillColor' : 'strokeColor', value },
      { mergeKey: this._opacityMergeKey, savePreferences: false },
    );
    if (changed) {
      this._opacityDefaultsDirty ||= subject.kind === 'defaults';
    }
    return changed;
  }
}
