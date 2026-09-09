import { cropFromPoints, moveCrop, resizeCrop, cropExportGeometry, OUTPUT_SCALES } from './RedlineCrop.js';

const HANDLES = [
  ['nw', 'top left', 0, 0], ['n', 'top', 50, 0], ['ne', 'top right', 100, 0],
  ['e', 'right', 100, 50], ['se', 'bottom right', 100, 100], ['s', 'bottom', 50, 100],
  ['sw', 'bottom left', 0, 100], ['w', 'left', 0, 50],
];

/** Screen-sized controls around a crop stored in annotation coordinates. */
export class RedlineCropView {
  constructor(root, { onChange, onScale, onDone, onEdit }) {
    this.root = root;
    this.callbacks = { onChange, onScale, onDone, onEdit };
    this.editing = false;
    this.layer = document.createElement('div');
    this.layer.dataset.redlineCropLayer = '';
    this.layer.hidden = true;
    this.frame = document.createElement('div');
    this.frame.dataset.redlineCropFrame = '';
    this.frame.setAttribute('role', 'group');
    this.frame.setAttribute('aria-label', 'Crop region. Arrow keys move; Shift moves ten pixels.');
    this.label = document.createElement('span');
    this.label.dataset.redlineCropDimensions = '';
    this.frame.appendChild(this.label);
    this.handles = HANDLES.map(([id, label, x, y]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.redlineCropHandle = id;
      button.setAttribute('aria-label', 'Resize crop ' + label + ' with arrow keys');
      button.title = 'Resize ' + label;
      button.style.left = x + '%';
      button.style.top = y + '%';
      this.frame.appendChild(button);
      return button;
    });
    this.layer.appendChild(this.frame);
    root.appendChild(this.layer);

    this.panel = document.createElement('div');
    this.panel.dataset.redlineCropPanel = '';
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', 'Crop and output size');
    this.panel.hidden = true;
    this.panel.innerHTML = '<span data-redline-crop-summary role="status" aria-live="polite"></span>'
      + '<label>Output <select aria-label="Image output scale"></select></label>'
      + '<button type="button" data-crop-action="all">Select all</button>'
      + '<button type="button" data-crop-action="reset">Reset crop</button>'
      + '<button type="button" data-crop-action="edit">Edit crop</button>'
      + '<button type="button" data-crop-action="done">Done</button>'
      + '<small data-redline-crop-help>Drag to crop · Drag inside to move · Handles resize · Enter / Esc: done</small>';
    this.summary = this.panel.querySelector('[data-redline-crop-summary]');
    this.scale = this.panel.querySelector('select');
    for (const value of OUTPUT_SCALES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = value * 100 + '%';
      this.scale.appendChild(option);
    }
    this.scale.title = '100% uses the original screenshot pixels';
    this.scale.addEventListener('change', () => onScale(Number(this.scale.value)));
    this.panel.addEventListener('click', event => {
      const action = event.target.closest('[data-crop-action]')?.dataset.cropAction;
      if (!action || !this.doc) return;
      if (action === 'done') onDone();
      if (action === 'edit') onEdit();
      if (action === 'reset') {
        this.cancel();
        onChange(null);
        (this.editing ? this.panel.querySelector('[data-crop-action="all"]') : null)?.focus();
      }
      if (action === 'all') {
        onChange({ x: 0, y: 0, width: this.doc.width, height: this.doc.height });
        this.frame.focus({ preventScroll: true });
      }
    });
    root.appendChild(this.panel);
    this.layer.addEventListener('pointerdown', event => this._down(event));
    this.layer.addEventListener('pointermove', event => this._move(event));
    this.layer.addEventListener('pointerup', event => this._up(event));
    this.layer.addEventListener('pointercancel', () => this.cancel());
    this.layer.addEventListener('lostpointercapture', () => {
      if (this.gesture) this.cancel();
    });
  }

  sync(doc, editing) {
    if (this.doc !== doc || this.editing !== editing) this.cancel();
    this.doc = doc;
    this.editing = editing;
    this.render();
  }

  cancel() {
    const gesture = this.gesture;
    this.gesture = null;
    this.preview = null;
    if (gesture && this.layer.hasPointerCapture(gesture.pointerId)) {
      this.layer.releasePointerCapture(gesture.pointerId);
    }
    this.render();
  }

  _point(event) {
    const bounds = this.root.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * this.doc.width / bounds.width,
      y: (event.clientY - bounds.top) * this.doc.height / bounds.height,
    };
  }

  _down(event) {
    if (!this.editing || !this.doc || event.button !== 0 || this.gesture || this.root.hasAttribute('data-busy')) return;
    event.preventDefault();
    const handle = event.target.closest('[data-redline-crop-handle]')?.dataset.redlineCropHandle;
    const inside = !!event.target.closest('[data-redline-crop-frame]');
    this.gesture = {
      pointerId: event.pointerId, start: this._point(event),
      original: this.doc.crop, mode: handle ?? (inside ? 'move' : 'create'),
    };
    this.preview = this.gesture.mode === 'create' ? null : this.doc.crop;
    this.layer.setPointerCapture(event.pointerId);
    this.render();
  }

  _move(event) {
    if (this.gesture?.pointerId !== event.pointerId) return;
    const { mode, start, original } = this.gesture;
    const point = this._point(event);
    const { width, height } = this.doc;
    const bounds = this.root.getBoundingClientRect();
    if (mode === 'create') this.preview = cropFromPoints(start, point, width, height);
    else if (mode === 'move') this.preview = moveCrop(original, point.x - start.x, point.y - start.y, width, height);
    else this.preview = resizeCrop(original, mode, point.x - start.x, point.y - start.y,
      width, height, 8 * width / bounds.width, 8 * height / bounds.height);
    this.render();
  }

  _up(event) {
    if (this.gesture?.pointerId !== event.pointerId) return;
    this._move(event);
    const crop = this.preview;
    const bounds = this.root.getBoundingClientRect();
    const meaningful = crop && crop.width * bounds.width / this.doc.width >= 4
      && crop.height * bounds.height / this.doc.height >= 4;
    this.cancel();
    if (meaningful) this.callbacks.onChange(crop);
    if (!this.frame.hidden) this.frame.focus({ preventScroll: true });
  }

  handleKey(event, target) {
    if (!this.editing) return false;
    if (event.key === 'Escape') {
      if (this.gesture) this.cancel();
      else this.callbacks.onDone();
      return true;
    }
    if (target?.matches('input, select, textarea, [contenteditable="true"]')) return false;
    if (event.key === 'Enter' && (!target?.matches('button, summary')
      || target?.dataset.redlineTool === 'crop' || target?.hasAttribute('data-redline-crop-handle'))) {
      this.callbacks.onDone();
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || this.gesture || !this.doc.crop) return false;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return false;
    const bounds = this.root.getBoundingClientRect();
    const step = event.shiftKey ? 10 : 1;
    const dx = direction[0] * step * this.doc.width / bounds.width;
    const dy = direction[1] * step * this.doc.height / bounds.height;
    const handle = target?.dataset.redlineCropHandle;
    const crop = handle
      ? resizeCrop(this.doc.crop, handle, dx, dy, this.doc.width, this.doc.height,
        8 * this.doc.width / bounds.width, 8 * this.doc.height / bounds.height)
      : moveCrop(this.doc.crop, dx, dy, this.doc.width, this.doc.height);
    this.callbacks.onChange(crop);
    return true;
  }

  render() {
    if (!this.doc) return;
    const crop = this.gesture ? this.preview : this.doc.crop;
    const visible = crop?.width > 0 && crop?.height > 0;
    this.layer.hidden = !this.editing && !visible;
    this.layer.toggleAttribute('data-editing', this.editing);
    this.frame.hidden = !visible;
    this.frame.tabIndex = this.editing && visible ? 0 : -1;
    this.handles.forEach(button => { button.hidden = !this.editing; });
    const bounds = this.root.getBoundingClientRect();
    if (visible) {
      Object.assign(this.frame.style, {
        left: crop.x / this.doc.width * 100 + '%',
        top: crop.y / this.doc.height * 100 + '%',
        width: crop.width / this.doc.width * 100 + '%',
        height: crop.height / this.doc.height * 100 + '%',
      });
      this.label.textContent = Math.round(crop.width * bounds.width / this.doc.width)
        + ' × ' + Math.round(crop.height * bounds.height / this.doc.height) + ' px';
      this.label.toggleAttribute('data-inside', crop.y * bounds.height / this.doc.height < 30);
    }
    this.label.hidden = !this.editing;
    this.panel.hidden = !this.editing && !crop && this.doc.outputScale === 1;
    this.panel.querySelector('[data-crop-action="done"]').hidden = !this.editing;
    this.panel.querySelector('[data-crop-action="edit"]').hidden = this.editing;
    this.panel.querySelector('[data-crop-action="all"]').hidden = !this.editing || !!crop;
    this.panel.querySelector('[data-crop-action="reset"]').hidden = !crop;
    this.panel.querySelector('[data-redline-crop-help]').hidden = !this.editing;
    this.scale.value = String(this.doc.outputScale);
    const output = cropExportGeometry({
      width: this.doc.width, height: this.doc.height, crop, outputScale: this.doc.outputScale,
    }, bounds.width * window.devicePixelRatio, bounds.height * window.devicePixelRatio);
    this.summary.textContent = (crop ? 'Crop' : 'Full screen') + ' → ' + output.width + ' × ' + output.height + ' PNG';
  }
}
