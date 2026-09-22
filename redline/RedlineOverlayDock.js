/**
 * Where a RedlineOverlay's toolbar strip sits: in its usual place, pinned
 * full-width to the top, or dragged by its grip to another height. The left
 * edge is fixed; only the vertical position moves. The state is saved with the
 * overlay's preferences.
 */

const GUTTER = 8;

export class RedlineOverlayDock {
  constructor(overlay) {
    this.overlay = overlay;
    this.pinned = false;
    /** { left, top } in CSS pixels once dragged, else null for the usual place. */
    this.position = null;
    this._drag = null;
  }

  /** Listen to the toolbar's grip. */
  attach(grip) {
    this.grip = grip;
    grip.addEventListener('pointerdown', event => this._onPointerDown(event));
    grip.addEventListener('pointermove', event => this._onPointerMove(event));
    grip.addEventListener('pointerup', event => this._onPointerUp(event));
    grip.addEventListener('pointercancel', event => this._onPointerUp(event, true));
  }

  /** Put the strip where the state says, then re-place what hangs off it. */
  apply() {
    const toolbar = this.overlay.toolbarUI;
    const dock = toolbar.dock;
    dock.toggleAttribute('data-pinned', this.pinned);
    if (!this.position) {
      dock.removeAttribute('data-positioned');
      dock.style.removeProperty('left');
      dock.style.removeProperty('top');
    } else {
      dock.dataset.positioned = '';
      dock.style.left = `${this.position.left}px`;
      dock.style.top = `${this.position.top}px`;
      this._clamp();
    }
    toolbar.positionContext();
    toolbar.menus.forEach(menu => menu.position());
    this.overlay._render();
  }

  togglePin() {
    this.pinned = !this.pinned;
    if (this.pinned) this.position = null;
    this.overlay._savePreferences();
    this.apply();
    this.overlay.options.setStatus(this.pinned ? 'Full-width strip pinned to the top.' : 'Strip unpinned. Drag the grip to move it vertically.');
  }

  /** Keep a dragged strip inside the window. */
  _clamp() {
    const toolbar = this.overlay.toolbarUI;
    const dock = toolbar.dock;
    if (!this.position || !dock.isConnected) return;
    const rect = toolbar.bar.getBoundingClientRect();
    const left = GUTTER;
    const top = Math.min(Math.max(GUTTER, this.position.top), Math.max(GUTTER, window.innerHeight - rect.height - GUTTER));
    this.position = { left, top };
    dock.style.left = `${left}px`;
    dock.style.top = `${top}px`;
  }

  _onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = this.overlay.toolbarUI.dock.getBoundingClientRect();
    this._drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    this.grip.setPointerCapture?.(event.pointerId);
  }

  _onPointerMove(event) {
    if (this._drag?.pointerId !== event.pointerId) return;
    this.pinned = false;
    this.position = {
      left: GUTTER,
      top: this._drag.top + event.clientY - this._drag.startY,
    };
    this.apply();
  }

  _onPointerUp(event, cancelled = false) {
    if (this._drag?.pointerId !== event.pointerId) return;
    this.grip.releasePointerCapture?.(event.pointerId);
    if (cancelled) this.position = null;
    else this._clamp();
    this._drag = null;
    this.overlay._savePreferences();
    this.apply();
  }
}
