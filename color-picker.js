/**
 * Colour and style control for the Redline extension.
 *
 * The bundled runtime normally uses the vendored `<wb-color-picker>` custom
 * element. Chrome gives an isolated-world content script a *null*
 * `customElements` registry, so no custom element can ever be defined or
 * upgraded there. This module supplies a plain-element replacement instead.
 *
 * It honours the same two contracts the overlay already listens for, extended
 * so one click can set a whole style rather than only a stroke colour:
 *   - swatch buttons carry `data-color`, which the overlay reads on click, plus
 *     `data-fill` / `data-fill-opacity` / `data-intent` where they apply;
 *   - a `wb-change` CustomEvent whose detail carries the same fields.
 *
 * A swatch that omits `data-fill-opacity` leaves the current fill treatment
 * alone, so the tint ramp and the custom picker change colour without
 * disturbing a style chosen from the gallery.
 */

/**
 * Eight entries that mean something, rather than a wall of hues.
 *
 * The export is read downstream as a PNG plus JSON, and in the JSON a mark is
 * just `color: "#ea580c"` with no meaning attached. Pairing each colour with an
 * intent makes the annotation file self-describing.
 */
const PALETTE = [
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

/**
 * Fill treatments, one gallery row each.
 *
 * `strokeShade` indexes the tint/shade ramp below: the solid row darkens its
 * own outline, which is how PowerPoint keeps an intense fill from reading as a
 * flat blob.
 */
const STYLES = [
  { key: 'outline', label: 'Outline', fillOpacity: 0, strokeShade: null },
  { key: 'tint-25', label: '25% fill', fillOpacity: 0.25, strokeShade: null },
  { key: 'tint-50', label: '50% fill', fillOpacity: 0.5, strokeShade: null },
  { key: 'solid', label: 'Solid', fillOpacity: 1, strokeShade: 4 },
];

/** The panel the swatches sit on. The border rule below is derived from it. */
const PANEL = '#181b22';

/** The inset ground a gallery cell draws its preview on. */
const CELL_GROUND = '#11141a';

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

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The border a swatch needs, or null when it needs none.
 *
 * A uniform border is the wrong default: it leaves a near-black swatch reading
 * as a hole in the panel while adding a line to colours that were already
 * distinct. Draw an edge only when the swatch cannot be told from the panel,
 * and push it away from the swatch's own luminance so the edge itself shows.
 */
export function edgeFor(hex, panel = PANEL) {
  if (contrastRatio(hex, panel) >= EDGE_THRESHOLD) return null;
  return relativeLuminance(hex) < relativeLuminance(panel)
    ? 'rgba(255, 255, 255, 0.38)'
    : 'rgba(0, 0, 0, 0.45)';
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex).map(value => Math.round(value * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const isHex = value => /^#[0-9a-f]{6}$/i.test(String(value ?? '').trim());

export const COLOR_PICKER_CSS = `
[data-redline-picker] {
  inline-size: 15.5rem;
  background: #181b22;
  color: #e8eaed;
  font: 400 0.8125rem/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-redline-picker] [data-tabs] {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  background: #11141a;
}
[data-redline-picker] [data-tabs] button {
  appearance: none;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: #9aa2b0;
  cursor: pointer;
  font: 500 0.75rem/1 inherit;
  min-height: 2.25rem;
  padding: 0;
}
[data-redline-picker] [data-tabs] button:hover {
  color: #e8eaed;
}
[data-redline-picker] [data-tabs] button[aria-selected="true"] {
  background: #181b22;
  border-bottom-color: #8ab4f8;
  color: #e8eaed;
}
[data-redline-picker] [data-body] {
  display: grid;
  gap: 0.6rem;
  padding: 0.6rem;
}
[data-redline-picker] [data-group] {
  display: grid;
  gap: 0.3rem;
}
[data-redline-picker] [data-group] > h4 {
  align-items: center;
  color: #6c7382;
  display: grid;
  font: 500 0.625rem/1 inherit;
  gap: 0.4rem;
  grid-template-columns: auto minmax(0, 1fr);
  letter-spacing: 0.09em;
  margin: 0;
  text-transform: uppercase;
}
[data-redline-picker] [data-group] > h4::after {
  background: #23272f;
  content: "";
  height: 1px;
}
[data-redline-picker] [data-grid] {
  display: grid;
  gap: 0.2rem;
  grid-template-columns: repeat(var(--cols, 8), minmax(0, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
}
[data-redline-picker] button[data-color] {
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: var(--swatch);
  cursor: pointer;
}
/* Only the swatches that need separating from the panel get an edge. */
[data-redline-picker] button[data-color][data-edge] {
  box-shadow: inset 0 0 0 1px var(--edge);
}
[data-redline-picker] [data-outline-toggle] {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.2rem;
}
[data-redline-picker] [data-outline-toggle] button {
  appearance: none;
  background: #11141a;
  border: 1px solid #2c313b;
  border-radius: 2px;
  color: #9aa2b0;
  cursor: pointer;
  font: 500 0.6875rem/1 inherit;
  padding: 0.35rem 0;
}
[data-redline-picker] [data-outline-toggle] button:hover {
  border-color: #4a5160;
  color: #e8eaed;
}
[data-redline-picker] [data-outline-toggle] button[aria-pressed="true"] {
  background: #2b3547;
  border-color: #8ab4f8;
  color: #e8eaed;
}
[data-redline-picker] button[data-style-cell] {
  aspect-ratio: 1;
  background: #11141a;
  border: 1px solid #23272f;
  border-radius: 2px;
  cursor: pointer;
  display: grid;
  min-width: 0;
  padding: 3px;
}
/* With no outline and no fill a cell would paint nothing, so it is not offered. */
[data-redline-picker] button[data-style-cell]:disabled {
  cursor: default;
  opacity: 0.25;
}
[data-redline-picker] button[data-style-cell] > span {
  background: var(--cell-fill, transparent);
  border: 2px solid var(--cell-stroke);
  border-radius: 1px;
  /* Same contrast rule as the swatches: a near-black stroke would otherwise
     vanish into the cell's own dark ground. */
  box-shadow: 0 0 0 1px var(--cell-edge, transparent);
}
[data-redline-picker] button[data-style-cell][data-no-outline] > span {
  border-color: transparent;
  box-shadow: none;
}
[data-redline-picker] button[data-color]:hover,
[data-redline-picker] button[data-color]:focus-visible {
  outline: 2px solid #8ab4f8;
  outline-offset: 1px;
  position: relative;
  z-index: 1;
}
[data-redline-picker] button[data-color][data-selected] {
  outline: 2px solid #e8eaed;
  outline-offset: 1px;
  position: relative;
  z-index: 1;
}
[data-redline-picker] button[data-color]:not([data-style-cell])[data-selected] {
  box-shadow: inset 0 0 0 2px #181b22;
}
[data-redline-picker] [data-custom] {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
[data-redline-picker] input[type="color"] {
  width: 2.5rem;
  height: 1.75rem;
  padding: 0;
  border: 1px solid #4a4f5a;
  border-radius: 2px;
  background: #11141a;
  cursor: pointer;
}
[data-redline-picker] [data-note] {
  color: #6c7382;
  font-size: 0.6875rem;
  line-height: 1.45;
  margin: 0;
}
[data-redline-picker] [data-foot] {
  align-items: center;
  background: #11141a;
  border-top: 1px solid #23272f;
  display: grid;
  gap: 0.5rem;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 2.25rem;
  padding: 0 0.6rem;
}
[data-redline-picker] output {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.6875rem;
  color: #9aa2b0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-redline-picker] [data-chip] {
  background: #21252e;
  border: 1px solid #2c313b;
  border-radius: 999px;
  color: #e8eaed;
  font: 500 0.625rem/1 inherit;
  padding: 0.25rem 0.5rem;
}
`;

/**
 * Build the colour and style control.
 *
 * The returned element exposes `value` for the stroke colour and
 * `annotationStyle` for the whole treatment, so the overlay can seed and read
 * either. `annotationStyle` avoids the name `style`, which would shadow the
 * element's own CSS declaration.
 *
 * @returns {HTMLElement}
 */
export function createColorPicker() {
  const root = document.createElement('div');
  root.dataset.redlinePicker = '';
  root.setAttribute('role', 'group');

  const tabStrip = document.createElement('div');
  tabStrip.dataset.tabs = '';
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'Colour picker modes');

  const body = document.createElement('div');
  body.dataset.body = '';

  const foot = document.createElement('div');
  foot.dataset.foot = '';
  const readout = document.createElement('output');
  const chip = document.createElement('span');
  chip.dataset.chip = '';
  foot.append(readout, chip);

  root.append(tabStrip, body, foot);

  const current = {
    color: PALETTE[0].hex,
    fill: null,
    fillOpacity: 0,
    outline: true,
    intent: PALETTE[0].intent,
  };
  let activeTab = 'theme';

  const sameColor = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

  function commit(next, { close = true } = {}) {
    Object.assign(current, next);
    paint();
    if (!close) return;
    root.dispatchEvent(new CustomEvent('wb-change', {
      bubbles: true,
      composed: true,
      detail: { ...current },
    }));
  }

  function group(title) {
    const wrapper = document.createElement('div');
    wrapper.dataset.group = '';
    const heading = document.createElement('h4');
    heading.textContent = title;
    wrapper.appendChild(heading);
    return wrapper;
  }

  function grid(columns) {
    const node = document.createElement('menu');
    node.dataset.grid = '';
    node.style.setProperty('--cols', String(columns));
    return node;
  }

  /**
   * A plain colour swatch. It carries no `data-fill-opacity`, so picking one
   * changes the colour and leaves the fill treatment as it was.
   */
  function swatch(hex, { name, intent } = {}) {
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
    button.addEventListener('click', () => {
      commit({ color: hex, intent: intent ?? null });
    });
    return button;
  }

  /**
   * One gallery cell, previewing the treatment it applies.
   *
   * The preview is the point: an outlined cell, two translucent ones and a
   * solid one say what the click will do without a legend.
   */
  function styleCell(entry, style) {
    const stroke = style.strokeShade === null ? entry.hex : variantFor(entry.hex, style.strokeShade);
    const fillOpacity = style.fillOpacity;
    // The outline toggle is a modifier on the whole gallery, so each cell shows
    // the treatment it would actually apply right now.
    const outline = current.outline;
    const paintsNothing = !outline && fillOpacity === 0;

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.styleCell = style.key;
    button.dataset.color = stroke;
    button.dataset.intent = entry.intent;
    button.dataset.fillOpacity = String(fillOpacity);
    button.dataset.outline = String(outline);
    if (fillOpacity > 0) button.dataset.fill = entry.hex;
    if (!outline) button.dataset.noOutline = '';
    button.disabled = paintsNothing;
    button.style.setProperty('--cell-stroke', stroke);
    if (fillOpacity > 0) button.style.setProperty('--cell-fill', rgba(entry.hex, fillOpacity));
    const cellEdge = edgeFor(stroke, CELL_GROUND);
    if (cellEdge) button.style.setProperty('--cell-edge', cellEdge);
    const treatment = outline ? style.label : `${style.label}, no outline`;
    button.title = paintsNothing ? 'Nothing to paint' : `${entry.name} · ${treatment}`;
    button.setAttribute('aria-label', button.title);
    button.appendChild(document.createElement('span'));

    button.addEventListener('click', () => {
      commit({
        color: stroke,
        fill: fillOpacity > 0 ? entry.hex : null,
        fillOpacity,
        outline,
        intent: entry.intent,
      });
    });
    return button;
  }

  /**
   * Fill strength and outline are independent axes, the way PowerPoint splits
   * Shape Fill from Shape Outline. This toggle does not commit on its own: the
   * gallery stays the one place a style is applied, so the cells repaint to
   * show what the next click will do.
   */
  function outlineToggle() {
    const wrapper = document.createElement('div');
    wrapper.dataset.outlineToggle = '';
    for (const [label, value] of [['Outline', true], ['No outline', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(current.outline === value));
      button.addEventListener('click', () => {
        if (current.outline === value) return;
        // Dropping the outline with no fill set would leave nothing to paint,
        // so a fill comes along with it rather than offering a dead state.
        const patch = { outline: value };
        if (!value && !current.fillOpacity) {
          patch.fillOpacity = 0.5;
          patch.fill = null;
        }
        commit(patch, { close: false });
      });
      wrapper.appendChild(button);
    }
    return wrapper;
  }

  function buildTheme() {
    const gallery = group('Shape styles');
    gallery.appendChild(outlineToggle());
    for (const style of STYLES) {
      const row = grid(PALETTE.length);
      for (const entry of PALETTE) row.appendChild(styleCell(entry, style));
      gallery.appendChild(row);
    }
    body.appendChild(gallery);

    const ramp = group('Tints and shades');
    const rampGrid = grid(PALETTE.length);
    for (let row = 0; row < 5; row += 1) {
      for (const entry of PALETTE) {
        rampGrid.appendChild(swatch(variantFor(entry.hex, row), {
          name: `${entry.name} ${row < 3 ? 'tint' : 'shade'}`,
          intent: entry.intent,
        }));
      }
    }
    ramp.appendChild(rampGrid);
    body.appendChild(ramp);
  }

  function buildStandard() {
    const standard = group('Standard colours');
    const standardGrid = grid(STANDARD_COLORS.length);
    for (const hex of STANDARD_COLORS) standardGrid.appendChild(swatch(hex));
    standard.appendChild(standardGrid);
    body.appendChild(standard);

    const ramp = group('Tints and shades');
    const rampGrid = grid(STANDARD_COLORS.length);
    for (let row = 0; row < 5; row += 1) {
      for (const hex of STANDARD_COLORS) rampGrid.appendChild(swatch(variantFor(hex, row)));
    }
    ramp.appendChild(rampGrid);
    body.appendChild(ramp);
  }

  function buildCustom() {
    const wrapper = group('Custom');
    const row = document.createElement('div');
    row.dataset.custom = '';

    const field = document.createElement('input');
    field.type = 'color';
    field.value = current.color.toLowerCase();
    field.setAttribute('aria-label', 'Custom annotation colour');

    const hex = document.createElement('output');
    hex.textContent = current.color.toUpperCase();

    // The native input fires `input` continuously while dragging; only `change`
    // means the user settled on a colour, which is what should commit.
    field.addEventListener('input', () => {
      hex.textContent = field.value.toUpperCase();
    });
    field.addEventListener('change', () => {
      commit({ color: field.value.toUpperCase(), intent: null });
    });

    row.append(field, hex);
    wrapper.appendChild(row);

    const note = document.createElement('p');
    note.dataset.note = '';
    note.textContent = 'Keeps the current fill treatment. Pick a gallery cell to change it.';
    wrapper.appendChild(note);

    body.appendChild(wrapper);
  }

  const TABS = [
    ['theme', 'Theme', buildTheme],
    ['standard', 'Standard', buildStandard],
    ['custom', 'Custom', buildCustom],
  ];

  const tabButtons = TABS.map(([key, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.tab = key;
    button.textContent = label;
    button.addEventListener('click', () => {
      activeTab = key;
      paint();
    });
    tabStrip.appendChild(button);
    return button;
  });

  function paint() {
    const build = TABS.find(([key]) => key === activeTab)?.[2] ?? buildTheme;
    body.replaceChildren();
    build();

    for (const button of tabButtons) {
      button.setAttribute('aria-selected', String(button.dataset.tab === activeTab));
      button.tabIndex = button.dataset.tab === activeTab ? 0 : -1;
    }

    for (const node of body.querySelectorAll('button[data-color]')) {
      const isCell = 'styleCell' in node.dataset;
      const matches = isCell
        ? sameColor(node.dataset.color, current.color)
          && Number(node.dataset.fillOpacity) === current.fillOpacity
          && (node.dataset.outline === 'true') === current.outline
        : sameColor(node.dataset.color, current.color) && !current.fillOpacity;
      node.toggleAttribute('data-selected', matches);
    }

    const treatment = STYLES.find(style => style.fillOpacity === current.fillOpacity);
    const parts = [current.color.toUpperCase()];
    if (current.fillOpacity) parts.push(treatment?.label ?? `${current.fillOpacity * 100}% fill`);
    if (!current.outline) parts.push('no outline');
    readout.textContent = parts.join(' · ');
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
      if (Number.isFinite(Number(next.fillOpacity))) patch.fillOpacity = clamp01(Number(next.fillOpacity));
      if (isHex(next.fill)) patch.fill = String(next.fill).trim().toUpperCase();
      else if (next.fill === null) patch.fill = null;
      if (typeof next.outline === 'boolean') patch.outline = next.outline;
      if (typeof next.intent === 'string' || next.intent === null) patch.intent = next.intent;
      commit(patch, { close: false });
    },
    configurable: true,
  });

  paint();
  return root;
}
