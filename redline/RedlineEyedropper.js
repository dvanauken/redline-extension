/**
 * Page-only eyedropper using the host's clean viewport capture.
 * The screenshot stays inside the closed mount and is discarded on exit.
 * Pixel coordinates use the captured image dimensions, not devicePixelRatio,
 * so browser zoom and DPR cannot offset the chosen colour. Crop/output settings
 * and annotations never enter this capture. No EyeDropper API or extra grant.
 */
export class RedlineEyedropper {
  constructor({ mount, capture }) {
    this.capture = capture;
    this.session = null;
    const dialog = document.createElement('dialog');
    dialog.dataset.redlineEyedropper = '';
    dialog.setAttribute('aria-label', 'Pick a color from the page');
    this.dialog = dialog;
    this.frame = document.createElement('div');
    this.frame.dataset.eyedropperFrame = '';
    const instruction = document.createElement('div');
    instruction.dataset.eyedropperInstruction = '';
    this.hint = document.createElement('span');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    instruction.append(this.hint, cancel);

    this.loupe = document.createElement('div');
    this.loupe.dataset.eyedropperLoupe = '';
    this.zoom = document.createElement('canvas');
    this.zoom.width = this.zoom.height = 117;
    this.zoom.setAttribute('aria-hidden', 'true');
    this.readout = document.createElement('output');
    this.readout.setAttribute('aria-label', 'Sampled color');
    this.loupe.append(this.zoom, this.readout);
    this.crosshair = document.createElement('div');
    this.crosshair.dataset.eyedropperCrosshair = '';
    dialog.append(this.frame, instruction, this.loupe, this.crosshair);
    mount.appendChild(dialog);

    dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancel(); });
    dialog.addEventListener('close', () => { if (!dialog.open) this.cancel(); });
    dialog.addEventListener('pointermove', event => {
      if (event.target.closest('button') || !this.session?.image) return;
      this._pointAt(event.clientX, event.clientY);
    });
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      if (event.button !== 0 || event.target.closest('button') || !this.session?.image) return;
      this._pointAt(event.clientX, event.clientY);
      this._finish(this.session.color);
    });
    dialog.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
    dialog.addEventListener('contextmenu', event => event.preventDefault());
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancel();
        return;
      }
      const state = this.session;
      if (!state?.image || event.target.closest('button') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this._finish(state.color);
        return;
      }
      const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!move) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      state.x = Math.max(0, Math.min(state.image.width - 1, state.x + move[0] * step));
      state.y = Math.max(0, Math.min(state.image.height - 1, state.y + move[1] * step));
      this._paint();
    });
  }

  get active() { return Boolean(this.session); }

  pick() {
    if (this.session) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const state = {
        resolve, reject, focus: this.dialog.getRootNode().activeElement,
        width: innerWidth, height: innerHeight, scrollX, scrollY, address: location.href,
      };
      this.session = state;
      this.frame.replaceChildren();
      this.hint.textContent = 'Preparing page colors…';
      this.loupe.hidden = this.crosshair.hidden = true;
      state.interrupted = () => this._finish(null, new Error('The page changed while picking a color. Try again.'));
      state.hidden = () => { if (document.visibilityState === 'hidden') this.cancel(); };
      window.addEventListener('resize', state.interrupted);
      window.addEventListener('scroll', state.interrupted);
      window.addEventListener('pagehide', state.hidden);
      document.addEventListener('visibilitychange', state.hidden);
      try {
        this.dialog.showModal();
        this._load(state).catch(error => {
          if (this.session === state) this._finish(null, error);
        });
      } catch (error) {
        this._finish(null, error);
      }
    });
  }

  async _load(state) {
    const { canvas: source } = await this.capture();
    if (this.session !== state) return;
    if (state.width !== innerWidth || state.height !== innerHeight || state.scrollX !== scrollX
      || state.scrollY !== scrollY || state.address !== location.href) {
      throw new Error('The page changed while picking a color. Try again.');
    }
    // Own the displayed snapshot: a reusable host may return its live canvas.
    // Sampling must not reparent or restyle the application's renderer.
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    state.context = canvas.getContext('2d', { willReadFrequently: true });
    state.context.drawImage(source, 0, 0);
    state.image = canvas;
    state.x = Math.floor(canvas.width / 2);
    state.y = Math.floor(canvas.height / 2);
    canvas.dataset.eyedropperImage = '';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Page colors. Arrow keys move one pixel, Shift moves ten, Enter picks, Escape cancels.');
    this.frame.replaceChildren(canvas);
    this.hint.textContent = 'Pick a page color · Click or Enter · Arrows fine-tune · Esc cancels';
    this.loupe.hidden = this.crosshair.hidden = false;
    canvas.focus({ preventScroll: true });
    this._paint();
  }

  _pointAt(clientX, clientY) {
    const state = this.session;
    if (!state?.image) return;
    const rect = state.image.getBoundingClientRect();
    state.x = Math.max(0, Math.min(state.image.width - 1, Math.floor((clientX - rect.left) * state.image.width / rect.width)));
    state.y = Math.max(0, Math.min(state.image.height - 1, Math.floor((clientY - rect.top) * state.image.height / rect.height)));
    this._paint();
  }

  _paint() {
    const state = this.session;
    const { image, x, y } = state;
    const rgb = state.context.getImageData(x, y, 1, 1).data;
    state.color = '#' + [...rgb].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    this.readout.value = state.color;
    this.readout.style.setProperty('--sample', state.color);
    // Announce once per keyboard/pointer-selected pixel through the focused canvas.
    image.setAttribute('aria-label', 'Page color ' + state.color + '. Arrows move, Enter picks, Escape cancels.');
    const ctx = this.zoom.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 117, 117);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, x - 4, y - 4, 9, 9, 0, 0, 117, 117);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.strokeRect(52, 52, 13, 13);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1;
    ctx.strokeRect(52, 52, 13, 13);
    const rect = image.getBoundingClientRect();
    const sx = rect.left + (x + 0.5) * rect.width / image.width;
    const sy = rect.top + (y + 0.5) * rect.height / image.height;
    this.crosshair.style.left = sx + 'px';
    this.crosshair.style.top = sy + 'px';
    const box = this.loupe.getBoundingClientRect();
    const left = sx + box.width + 26 < innerWidth ? sx + 24 : sx - box.width - 24;
    const top = sy + box.height + 26 < innerHeight ? sy + 24 : sy - box.height - 24;
    this.loupe.style.left = Math.max(4, Math.min(innerWidth - box.width - 4, left)) + 'px';
    this.loupe.style.top = Math.max(4, Math.min(innerHeight - box.height - 4, top)) + 'px';
  }

  _finish(color = null, error = null) {
    const state = this.session;
    if (!state) return;
    this.session = null;
    window.removeEventListener('resize', state.interrupted);
    window.removeEventListener('scroll', state.interrupted);
    window.removeEventListener('pagehide', state.hidden);
    document.removeEventListener('visibilitychange', state.hidden);
    if (this.dialog.open) this.dialog.close();
    this.frame.replaceChildren();
    this.zoom.getContext('2d').clearRect(0, 0, 117, 117);
    this.readout.value = '';
    this.readout.style.removeProperty('--sample');
    this.loupe.hidden = this.crosshair.hidden = true;
    if (state.focus?.isConnected && state.focus.checkVisibility?.()) state.focus.focus({ preventScroll: true });
    if (error) state.reject(error);
    else state.resolve(color);
  }

  cancel() { this._finish(); }
  destroy() { this.cancel(); this.dialog.remove(); }
}
