/**
 * Colour control for the Redline extension.
 *
 * The bundled runtime normally uses the vendored `<wb-color-picker>` custom
 * element. Chrome gives an isolated-world content script a *null*
 * `customElements` registry, so no custom element can ever be defined or
 * upgraded there. This module supplies a plain-element replacement instead.
 *
 * It honours the two contracts the overlay listens for:
 *   - swatch buttons carry `data-color` (and `data-intent` for named presets),
 *     which the overlay reads on click;
 *   - a `wb-change` CustomEvent whose detail carries `{ color, intent }`.
 *     The event is not composed, so nothing about the pick crosses the shadow
 *     boundary into the page.
 *
 * The picker chooses a colour only. Whether it becomes an outline or a fill,
 * and how transparent a fill is, is decided by the style row that opened it,
 * so a lighter tint is never confused with a see-through fill.
 *
 * Keyboard: the tabs use arrow keys, Home and End (activation follows focus);
 * each swatch grid is one Tab stop navigated with arrow keys, Home and End;
 * Enter or Space picks.
 */

/**
 * Named presets that mean something, rather than a wall of hues. In the JSON a
 * mark is otherwise just `color: "#DC2626"`; the intent makes the file
 * self-describing.
 */
export const PALETTE = [
  { name: 'Issue', intent: 'issue', hex: '#DC2626' },
  { name: 'Question', intent: 'question', hex: '#D97706' },
  { name: 'Suggestion', intent: 'suggestion', hex: '#7C3AED' },
  { name: 'Approved', intent: 'approved', hex: '#16A34A' },
  { name: 'Note', intent: 'note', hex: '#2563EB' },
  { name: 'Neutral', intent: 'neutral', hex: '#475569' },
  { name: 'Ink', intent: 'ink', hex: '#111827' },
  { name: 'Paper', intent: 'paper', hex: '#FFFFFF' },
];

/** PowerPoint's own standard row, matching the vendored picker. */
const STANDARD_COLORS = [
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050',
  '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0',
];

/** The panel the swatches sit on. The border rule below is derived from it. */
export const PANEL = '#FFFFFF';

/** Below this contrast ratio a swatch cannot be told from the panel. */
const EDGE_THRESHOLD = 1.6;

const clamp01 = value => Math.min(1, Math.max(0, value));

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex(r, g, b) {
  const channel = value => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklch(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bLab = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  let h = Math.atan2(bLab, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.sqrt(a * a + bLab * bLab), h];
}

function oklchToRgb(L, C, h) {
  const hr = h * Math.PI / 180;
  const a = C * Math.cos(hr);
  const bLab = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bLab;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bLab;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bLab;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/**
 * One step of a tint/shade ramp, row 0 lightest and row 4 deepest.
 *
 * Ported from the vendored picker so both pickers produce the same ramp.
 * Near-neutral inputs would ramp to muddy near-greys through the hue path, so
 * they take a straight lightness ramp instead.
 */
export function variantFor(hex, row) {
  const targets = [0.92, 0.82, 0.70, 0.45, 0.30];
  const targetL = targets[row];
  const [r, g, b] = hexToRgb(hex);
  const [L, C, h] = rgbToOklch(r, g, b);
  if (C < 0.02) {
    const greys = [0.95, 0.82, 0.65, 0.42, 0.18];
    return rgbToHex(...oklchToRgb(greys[row], 0, 0));
  }
  const newC = targetL > L
    ? C * (1 - ((targetL - L) / (1 - L + 0.001)) * 0.4)
    : C * (1 + ((L - targetL) / (L + 0.001)) * 0.15);
  return rgbToHex(...oklchToRgb(targetL, newC, h));
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The border a swatch needs, or null when it needs none.
 *
 * A uniform border is the wrong default: it adds a line to colours that were
 * already distinct. Draw an edge only when the swatch cannot be told from the
 * panel, and push it away from the swatch's own luminance so the edge shows.
 */
export function edgeFor(hex, panel = PANEL) {
  if (contrastRatio(hex, panel) >= EDGE_THRESHOLD) return null;
  return relativeLuminance(hex) < relativeLuminance(panel)
    ? 'rgba(255, 255, 255, 0.5)'
    : 'rgba(41, 45, 50, 0.32)';
}

const isHex = value => /^#[0-9a-f]{6}$/i.test(String(value ?? '').trim());

export const COLOR_PICKER_CSS = `
[data-redline-picker] {
  inline-size: 17.5rem;
  max-inline-size: calc(100vw - 1.5rem);
  background: #FFFFFF;
  color: #292D32;
  font: 400 0.8125rem/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-redline-picker] [data-tabs] {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.125rem;
  padding: 0.25rem 0.375rem 0;
  border-bottom: 1px solid #D9D5CC;
  background: #F7F5F0;
}
[data-redline-picker] [data-tabs] button {
  appearance: none;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: #5B5F66;
  cursor: pointer;
  font: 600 0.75rem/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 2.25rem;
  padding: 0 0.25rem;
}
[data-redline-picker] [data-tabs] button:hover { color: #292D32; }
[data-redline-picker] [data-tabs] button[aria-selected="true"] {
  border-bottom-color: #9A4650;
  color: #292D32;
}
[data-redline-picker] [data-body] {
  display: grid;
  gap: 0.75rem;
  max-block-size: min(22rem, calc(100vh - 12rem));
  overflow: auto;
  padding: 0.75rem;
}
[data-redline-picker] [data-group] { display: grid; gap: 0.375rem; }
[data-redline-picker] [data-group] > h4 {
  color: #5B5F66;
  font: 600 0.6875rem/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.02em;
  margin: 0;
}
[data-redline-picker] [data-grid] {
  display: grid;
  gap: 0.25rem;
  grid-template-columns: repeat(var(--cols, 8), minmax(0, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}
[data-redline-picker] [data-grid][data-presets] { gap: 0.375rem; }
[data-redline-picker] button[data-color] {
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: var(--swatch);
  cursor: pointer;
}
[data-redline-picker] button[data-color][data-edge] { box-shadow: inset 0 0 0 1px var(--edge); }
[data-redline-picker] button[data-preset] {
  aspect-ratio: auto;
  display: grid;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  min-height: 2.5rem;
  padding: 0.25rem 0.5rem 0.25rem 0.25rem;
  background: #FFFFFF;
  border: 1px solid #D9D5CC;
  border-radius: 6px;
  color: #292D32;
  text-align: start;
  font: 600 0.8125rem/1.1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-redline-picker] button[data-preset] > span:first-child {
  inline-size: 1.75rem;
  block-size: 1.75rem;
  border-radius: 4px;
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px var(--edge, transparent);
}
[data-redline-picker] button[data-preset] small {
  display: block;
  color: #5B5F66;
  font: 400 0.6875rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
[data-redline-picker] button[data-preset]:hover { border-color: #B9B3A7; background: #FBFAF7; }
[data-redline-picker] button[data-color]:focus-visible,
[data-redline-picker] [data-tabs] button:focus-visible,
[data-redline-picker] input:focus-visible,
[data-redline-picker] [data-apply]:focus-visible {
  outline: 2px solid #2F6DB5;
  outline-offset: 2px;
  position: relative;
  z-index: 1;
}
[data-redline-picker] button[data-color][aria-pressed="true"] {
  outline: 2px solid #292D32;
  outline-offset: 2px;
  position: relative;
}
[data-redline-picker] button[data-preset][aria-pressed="true"] {
  outline: none;
  border-color: #9A4650;
  box-shadow: 0 0 0 1px #9A4650;
}
[data-redline-picker] [data-custom] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}
[data-redline-picker] input[type="color"] {
  width: 2.75rem;
  height: 2rem;
  padding: 0;
  border: 1px solid #D9D5CC;
  border-radius: 4px;
  background: #FFFFFF;
  cursor: pointer;
}
[data-redline-picker] input[data-hex] {
  min-width: 0;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid #D9D5CC;
  border-radius: 4px;
  background: #FFFFFF;
  color: #292D32;
  font: 400 0.8125rem/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
[data-redline-picker] input[data-hex][aria-invalid="true"] { border-color: #B3261E; }
[data-redline-picker] [data-apply] {
  height: 2rem;
  padding: 0 0.75rem;
  border: 1px solid #9A4650;
  border-radius: 4px;
  background: #9A4650;
  color: #FFFFFF;
  font: 600 0.75rem/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
[data-redline-picker] [data-note] {
  color: #5B5F66;
  font-size: 0.6875rem;
  line-height: 1.45;
  margin: 0;
}
[data-redline-picker] [data-foot] {
  align-items: center;
  background: #F7F5F0;
  border-top: 1px solid #D9D5CC;
  display: grid;
  gap: 0.5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 2.25rem;
  padding: 0 0.75rem;
}
[data-redline-picker] [data-foot] > span:first-child {
  inline-size: 1rem;
  block-size: 1rem;
  border-radius: 3px;
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px rgba(41, 45, 50, 0.32);
}
[data-redline-picker] output {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.75rem;
  color: #292D32;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-redline-picker] [data-chip] {
  background: #FFFFFF;
  border: 1px solid #D9D5CC;
  border-radius: 999px;
  color: #292D32;
  font: 600 0.6875rem/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 0.25rem 0.5rem;
}
`;

/** Arrow-key navigation over a grid of buttons with a single Tab stop. */
function rovingGrid(grid, columns) {
  const items = () => [...grid.querySelectorAll('button')];
  const list = items();
  const active = list.find(item => item.getAttribute('aria-pressed') === 'true') ?? list[0];
  list.forEach(item => { item.tabIndex = item === active ? 0 : -1; });
  grid.addEventListener('keydown', event => {
    const all = items();
    const index = all.indexOf(event.target);
    if (index < 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      // Activate on keydown and suppress the key's default activation: picking
      // closes the popover and returns focus to its trigger, which the same
      // keystroke would otherwise activate again.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) event.target.click();
      return;
    }
    const moves = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index + columns,
      ArrowUp: index - columns,
      Home: 0,
      End: all.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = all[Math.min(all.length - 1, Math.max(0, moves[event.key]))];
    all.forEach(item => { item.tabIndex = item === next ? 0 : -1; });
    next.focus();
  });
}

/**
 * Build the colour control.
 *
 * The returned element exposes `value` for the colour and `annotationStyle`
 * for `{ color, intent }`, so the overlay can seed and read either.
 *
 * @returns {HTMLElement}
 */
export function createColorPicker() {
  const root = document.createElement('div');
  root.dataset.redlinePicker = '';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Colour picker');

  const tabStrip = document.createElement('div');
  tabStrip.dataset.tabs = '';
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'Colour sets');

  const body = document.createElement('div');
  body.dataset.body = '';
  body.setAttribute('role', 'tabpanel');
  body.id = `redline-picker-panel-${Math.random().toString(36).slice(2, 10)}`;

  const foot = document.createElement('div');
  foot.dataset.foot = '';
  const footSwatch = document.createElement('span');
  footSwatch.setAttribute('aria-hidden', 'true');
  const readout = document.createElement('output');
  const chip = document.createElement('span');
  chip.dataset.chip = '';
  foot.append(footSwatch, readout, chip);

  root.append(tabStrip, body, foot);

  const current = { color: PALETTE[0].hex, intent: PALETTE[0].intent };
  let activeTab = 'presets';

  const sameColor = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

  function commit(next, { close = true } = {}) {
    Object.assign(current, next);
    if (!close) {
      paint();
      return;
    }
    root.dispatchEvent(new CustomEvent('wb-change', { bubbles: true, composed: false, detail: { ...current } }));
  }

  function group(title) {
    const wrapper = document.createElement('div');
    wrapper.dataset.group = '';
    const heading = document.createElement('h4');
    heading.textContent = title;
    wrapper.appendChild(heading);
    return wrapper;
  }

  function grid(columns, label) {
    const node = document.createElement('div');
    node.dataset.grid = '';
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', label);
    node.style.setProperty('--cols', String(columns));
    return node;
  }

  function swatch(hex, { name, intent = null } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.color = hex;
    if (intent) button.dataset.intent = intent;
    button.style.setProperty('--swatch', hex);
    const edge = edgeFor(hex);
    if (edge) {
      button.dataset.edge = '';
      button.style.setProperty('--edge', edge);
    }
    button.title = name ? `${name} · ${hex}` : hex;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(sameColor(hex, current.color)));
    button.addEventListener('click', () => commit({ color: hex, intent }));
    return button;
  }

  function preset(entry) {
    const button = swatch(entry.hex, { name: entry.name, intent: entry.intent });
    button.dataset.preset = entry.intent;
    button.removeAttribute('data-edge');
    button.setAttribute('aria-pressed', String(sameColor(entry.hex, current.color) && current.intent === entry.intent));
    const chipSwatch = document.createElement('span');
    const edge = edgeFor(entry.hex);
    if (edge) chipSwatch.style.setProperty('--edge', edge);
    const text = document.createElement('span');
    text.textContent = entry.name;
    const hex = document.createElement('small');
    hex.textContent = entry.hex;
    text.appendChild(hex);
    button.append(chipSwatch, text);
    return button;
  }

  function buildPresets() {
    const presets = group('Named styles');
    const presetGrid = grid(2, 'Named styles');
    presetGrid.dataset.presets = '';
    for (const entry of PALETTE) presetGrid.appendChild(preset(entry));
    presets.appendChild(presetGrid);
    body.appendChild(presets);
    rovingGrid(presetGrid, 2);
  }

  function buildMore() {
    const note = document.createElement('p');
    note.dataset.note = '';
    note.textContent = 'Every swatch is a solid colour. Lighter tints are not see-through; set transparency with Fill opacity.';
    body.appendChild(note);

    const themed = group('Tints and shades of the named styles');
    const themedGrid = grid(PALETTE.length, 'Tints and shades of the named styles');
    for (let row = 0; row < 5; row += 1) {
      for (const entry of PALETTE) {
        themedGrid.appendChild(swatch(variantFor(entry.hex, row), {
          name: `${entry.name} ${row < 3 ? 'tint' : 'shade'} ${row + 1}`,
          intent: entry.intent,
        }));
      }
    }
    themed.appendChild(themedGrid);
    body.appendChild(themed);
    rovingGrid(themedGrid, PALETTE.length);

    const standard = group('Standard colours');
    const standardGrid = grid(STANDARD_COLORS.length, 'Standard colours with tints and shades');
    for (const hex of STANDARD_COLORS) standardGrid.appendChild(swatch(hex));
    for (let row = 0; row < 5; row += 1) {
      for (const hex of STANDARD_COLORS) standardGrid.appendChild(swatch(variantFor(hex, row)));
    }
    standard.appendChild(standardGrid);
    body.appendChild(standard);
    rovingGrid(standardGrid, STANDARD_COLORS.length);
  }

  function buildCustom() {
    const wrapper = group('Custom colour');
    const row = document.createElement('div');
    row.dataset.custom = '';

    const field = document.createElement('input');
    field.type = 'color';
    field.value = current.color.toLowerCase();
    field.setAttribute('aria-label', 'Custom colour');

    const hexField = document.createElement('input');
    hexField.type = 'text';
    hexField.dataset.hex = '';
    hexField.value = current.color.toUpperCase();
    hexField.maxLength = 7;
    hexField.spellcheck = false;
    hexField.setAttribute('aria-label', 'Hex colour, for example #1F6FEB');

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.dataset.apply = '';
    apply.textContent = 'Apply';

    const applyHex = () => {
      const value = hexField.value.trim().startsWith('#') ? hexField.value.trim() : `#${hexField.value.trim()}`;
      if (!isHex(value)) {
        hexField.setAttribute('aria-invalid', 'true');
        hexField.focus();
        return;
      }
      commit({ color: value.toUpperCase(), intent: null });
    };
    // The native input fires `input` continuously while dragging; only `change`
    // means the user settled on a colour, which is what should commit.
    field.addEventListener('input', () => {
      hexField.value = field.value.toUpperCase();
      hexField.removeAttribute('aria-invalid');
    });
    field.addEventListener('change', () => commit({ color: field.value.toUpperCase(), intent: null }));
    hexField.addEventListener('input', () => hexField.removeAttribute('aria-invalid'));
    hexField.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyHex();
      }
    });
    apply.addEventListener('click', applyHex);
    apply.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) applyHex();
    });

    row.append(field, hexField, apply);
    wrapper.appendChild(row);
    body.appendChild(wrapper);
  }

  const TABS = [
    ['presets', 'Presets', buildPresets],
    ['more', 'More colors', buildMore],
    ['custom', 'Custom', buildCustom],
  ];

  const tabButtons = TABS.map(([key, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.tab = key;
    button.id = `${body.id}-${key}`;
    button.setAttribute('aria-controls', body.id);
    button.textContent = label;
    button.addEventListener('click', () => activate(key));
    tabStrip.appendChild(button);
    return button;
  });

  function activate(key, { focus = false } = {}) {
    activeTab = key;
    paint();
    if (focus) tabButtons.find(button => button.dataset.tab === key)?.focus();
  }

  tabStrip.addEventListener('keydown', event => {
    const index = tabButtons.indexOf(event.target);
    if (index < 0) return;
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabButtons.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = tabButtons[(moves[event.key] + tabButtons.length) % tabButtons.length];
    activate(next.dataset.tab, { focus: true });
  });

  function paint() {
    const build = TABS.find(([key]) => key === activeTab)?.[2] ?? buildPresets;
    body.replaceChildren();
    build();
    for (const button of tabButtons) {
      const selected = button.dataset.tab === activeTab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) body.setAttribute('aria-labelledby', button.id);
    }
    footSwatch.style.setProperty('--swatch', current.color);
    readout.textContent = current.color.toUpperCase();
    const named = PALETTE.find(entry => entry.intent === current.intent);
    chip.textContent = named?.name ?? 'Custom';
  }

  Object.defineProperty(root, 'value', {
    get: () => current.color,
    set: value => {
      if (!isHex(value)) return;
      commit({ color: String(value).trim().toUpperCase() }, { close: false });
    },
    configurable: true,
  });

  Object.defineProperty(root, 'annotationStyle', {
    get: () => ({ ...current }),
    set: next => {
      if (!next || typeof next !== 'object') return;
      const patch = {};
      if (isHex(next.color)) patch.color = String(next.color).trim().toUpperCase();
      if (typeof next.intent === 'string' || next.intent === null) patch.intent = next.intent;
      commit(patch, { close: false });
    },
    configurable: true,
  });

  /** The control that should take focus when the picker opens. */
  Object.defineProperty(root, 'initialFocus', {
    get: () => body.querySelector('button[tabindex="0"], input') ?? tabButtons.find(button => button.tabIndex === 0),
    configurable: true,
  });

  paint();
  return root;
}
