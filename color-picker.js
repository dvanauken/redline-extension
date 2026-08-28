/**
 * Colour control for the Redline extension.
 *
 * The bundled runtime normally uses the vendored `<wb-color-picker>` custom
 * element. Chrome gives an isolated-world content script a *null*
 * `customElements` registry, so no custom element can ever be defined or
 * upgraded there. This module supplies a plain-element replacement instead.
 *
 * It honours the same two contracts the overlay already listens for:
 *   - swatch buttons carry `data-color`, which the overlay reads on click;
 *   - a `wb-change` CustomEvent with `detail.color` commits a colour.
 */

/** Office-style rows: greys, then a hue ramp the annotation colours sit in. */
const SWATCHES = [
  ['#000000', '#3f3f46', '#52525b', '#71717a', '#a1a1aa', '#d4d4d8', '#f4f4f5', '#ffffff'],
  ['#7f1d1d', '#b91c1c', '#dc2626', '#b65d66', '#ea580c', '#d97706', '#ca8a04', '#65a30d'],
  ['#14532d', '#16a34a', '#0d9488', '#0891b2', '#0284c7', '#2563eb', '#4f46e5', '#7c3aed'],
  ['#86198f', '#c026d3', '#db2777', '#e11d48', '#9f1239', '#78350f', '#1e293b', '#334155'],
];

export const COLOR_PICKER_CSS = `
[data-redline-picker] {
  display: grid;
  gap: 0.6rem;
  padding: 0.6rem;
  background: #181b22;
  color: #e8eaed;
  font: 400 0.8125rem/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-redline-picker] [data-swatches] {
  display: grid;
  grid-template-columns: repeat(8, 1.5rem);
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-redline-picker] button[data-color] {
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 2px;
  background: var(--swatch);
  cursor: pointer;
}
[data-redline-picker] button[data-color]:hover,
[data-redline-picker] button[data-color]:focus-visible {
  outline: 2px solid #8ab4f8;
  outline-offset: 1px;
}
[data-redline-picker] button[data-color][data-selected] {
  box-shadow: inset 0 0 0 2px #181b22;
  outline: 2px solid #e8eaed;
  outline-offset: 1px;
}
[data-redline-picker] [data-custom] {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding-top: 0.5rem;
  border-top: 1px solid #3a3f4a;
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
[data-redline-picker] output {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  color: #a8adb8;
}
`;

/**
 * Build the colour control.
 *
 * The returned element exposes a `value` property so the overlay can seed and
 * read the current colour exactly as it does with the vendored element.
 *
 * @returns {HTMLElement}
 */
export function createColorPicker() {
  const root = document.createElement('div');
  root.dataset.redlinePicker = '';
  root.setAttribute('role', 'group');

  const swatches = document.createElement('menu');
  swatches.dataset.swatches = '';
  const buttons = [];
  for (const row of SWATCHES) {
    for (const hex of row) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.color = hex;
      button.style.setProperty('--swatch', hex);
      button.title = hex;
      button.setAttribute('aria-label', `Colour ${hex}`);
      swatches.appendChild(button);
      buttons.push(button);
    }
  }

  const custom = document.createElement('div');
  custom.dataset.custom = '';
  const label = document.createElement('label');
  label.textContent = 'Custom';
  const field = document.createElement('input');
  field.type = 'color';
  field.setAttribute('aria-label', 'Custom annotation colour');
  label.appendChild(field);
  const readout = document.createElement('output');
  custom.append(label, readout);

  root.append(swatches, custom);

  let current = '#000000';
  const normalise = value => String(value ?? '').trim().toLowerCase();

  function paint() {
    readout.textContent = current.toUpperCase();
    for (const button of buttons) {
      button.toggleAttribute('data-selected', normalise(button.dataset.color) === normalise(current));
    }
    field.value = current;
  }

  // The native input fires `input` continuously while dragging; only `change`
  // means the user settled on a colour, which is what should close the dialog.
  field.addEventListener('input', () => {
    current = normalise(field.value);
    paint();
  });
  field.addEventListener('change', () => {
    current = normalise(field.value);
    paint();
    root.dispatchEvent(new CustomEvent('wb-change', {
      bubbles: true,
      composed: true,
      detail: { color: current },
    }));
  });

  Object.defineProperty(root, 'value', {
    get: () => current,
    set: value => {
      const next = normalise(value);
      if (!/^#[0-9a-f]{6}$/.test(next)) return;
      current = next;
      paint();
    },
    configurable: true,
  });

  paint();
  return root;
}
