/**
 * WbColorPicker - tabbed color picker panel.
 *
 * Usage:
 *   <wb-color-picker></wb-color-picker>
 *
 * Events:
 *   - wb-change: detail { color, value, previousValue, source, tab }
 */

import { WbBaseElement } from '../wb-base.js';
import { template, styles } from './wb-color-picker.resources.js';

const THEME_COLORS = [
  '#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4',
  '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'
];

const STANDARD_COLORS = [
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050',
  '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

function rgbToHexStr(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

const srgbToLinear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

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
  const C = Math.sqrt(a * a + bLab * bLab);
  let h = Math.atan2(bLab, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
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
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

function variantFor(hex, row) {
  const targetsL = [0.92, 0.82, 0.70, 0.45, 0.30];
  const targetL = targetsL[row];
  const upper = hex.toUpperCase();

  if (upper === '#FFFFFF' || upper === '#000000' || upper === '#E7E6E6') {
    const grayL = [0.95, 0.82, 0.65, 0.42, 0.18];
    const [r, g, b] = oklchToRgb(grayL[row], 0, 0);
    return rgbToHexStr(r, g, b);
  }

  const [r, g, b] = hexToRgb(hex);
  const [L, C, h] = rgbToOklch(r, g, b);
  let newC;
  if (targetL > L) {
    newC = C * (1 - ((targetL - L) / (1 - L + 0.001)) * 0.4);
  } else {
    newC = C * (1 + ((L - targetL) / (L + 0.001)) * 0.15);
  }
  const [vr, vg, vb] = oklchToRgb(targetL, newC, h);
  return rgbToHexStr(vr, vg, vb);
}

function hsvToHex(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r;
  let g;
  let b;

  if (h < 60) {
    r = c; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = c; b = 0;
  } else if (h < 180) {
    r = 0; g = c; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = c;
  } else if (h < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }

  const t = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${t(r)}${t(g)}${t(b)}`;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function rgbHex(r, g, b) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

function applyBrightness(hex, t) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  let nr;
  let ng;
  let nb;

  if (t < 0.5) {
    const k = 1 - t * 2;
    nr = Math.round(r + (255 - r) * k);
    ng = Math.round(g + (255 - g) * k);
    nb = Math.round(b + (255 - b) * k);
  } else {
    const k = (t - 0.5) * 2;
    nr = Math.round(r * (1 - k));
    ng = Math.round(g * (1 - k));
    nb = Math.round(b * (1 - k));
  }

  return rgbHex(nr, ng, nb);
}

export class WbColorPicker extends WbBaseElement {
  static tagName = 'wb-color-picker';
  static template = template;
  static styles = styles;

  static get observedAttributes() {
    return ['value', 'tab'];
  }

  _value = null;
  _activeTab = 'theme';
  _recentColors = Array(10).fill(null);
  _tabCleanup = [];
  _reflecting = false;

  async onInit() {
    this._content = this.$('#content');
    this._readout = this.$('#readout');
    this._readoutSwatch = this.$('#readout-swatch');
    this._tabButtons = Array.from(this.$$('nav[role="tablist"] > button'));

    this._applyInitialAttributes();
    this._setupEventListeners();
    this._showTab(this._activeTab, { emit: false, reflect: false });
    this._setReadout(this._value);
  }

  onDestroy() {
    this._cleanupTab();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || this._reflecting) return;

    if (name === 'value') {
      this._setValue(newValue, { emit: false, reflect: false, remember: false, source: 'attribute' });
      return;
    }

    if (name === 'tab' && this._content) {
      this._showTab(newValue || 'theme', { emit: false, reflect: false });
    }
  }

  get value() {
    return this._value || '';
  }

  set value(color) {
    this.setColor(color);
  }

  get activeTab() {
    return this._activeTab;
  }

  set activeTab(tab) {
    this.showTab(tab);
  }

  getColor() {
    return this._value;
  }

  setColor(color) {
    this._setValue(color, { emit: false, reflect: true, remember: true, source: 'api' });
  }

  showTab(tab) {
    this._showTab(tab, { emit: true, reflect: true });
  }

  clearRecentColors() {
    this._recentColors = Array(10).fill(null);
    if (this._activeTab === 'theme') {
      this._refreshRecentRow();
    }
  }

  _applyInitialAttributes() {
    this._activeTab = this.getAttribute('tab') || 'theme';
    this._value = this._normalizeHex(this.getAttribute('value'));
  }

  _setupEventListeners() {
    this._tabButtons.forEach((button) => {
      this._listen(button, 'click', () => this._showTab(button.dataset.tab, { emit: true, reflect: true }));
      this._listen(button, 'keydown', (event) => this._onTabKeydown(event));
    });
  }

  _onTabKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();

    const currentIndex = this._tabButtons.findIndex((button) => button.dataset.tab === this._activeTab);
    let nextIndex = currentIndex;

    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = this._tabButtons.length - 1;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + this._tabButtons.length) % this._tabButtons.length;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % this._tabButtons.length;

    const nextButton = this._tabButtons[nextIndex];
    nextButton.focus();
    this._showTab(nextButton.dataset.tab, { emit: true, reflect: true });
  }

  _showTab(tab, options = {}) {
    const { emit = false, reflect = true } = options;
    const builders = {
      theme: () => this._buildThemeTab(),
      standard: () => this._buildStandardTab(),
      custom: () => this._buildCustomTab()
    };

    const nextTab = builders[tab] ? tab : 'theme';
    const previousTab = this._activeTab;
    this._activeTab = nextTab;

    if (reflect && this.getAttribute('tab') !== nextTab) {
      this._reflecting = true;
      this.setAttribute('tab', nextTab);
      this._reflecting = false;
    }

    this._cleanupTab();
    this._content.replaceChildren();
    this._content.setAttribute('aria-labelledby', `tab-${nextTab}`);
    builders[nextTab]();

    this._tabButtons.forEach((button) => {
      const active = button.dataset.tab === nextTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });

    this._updateSelectedVisuals();

    if (emit && previousTab !== nextTab) {
      this._emit('tab-change', { tab: nextTab, previousTab });
    }
  }

  _buildThemeTab() {
    this._content.appendChild(this._makeSectionLabel('Theme Colors'));

    const top = this._makeSwatchRow('row');
    THEME_COLORS.forEach((color) => top.appendChild(this._makeColorSwatch(color)));
    this._content.appendChild(top);

    const grid = this._makeSwatchRow('grid');
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        grid.appendChild(this._makeColorSwatch(variantFor(THEME_COLORS[col], row), { row }));
      }
    }
    this._content.appendChild(grid);

    this._content.appendChild(this._makeSectionLabel('Standard Colors'));

    const standardRow = this._makeSwatchRow('row');
    STANDARD_COLORS.forEach((color) => standardRow.appendChild(this._makeColorSwatch(color)));
    this._content.appendChild(standardRow);

    this._content.appendChild(this._makeSectionLabel('Recent Colors'));

    const recentRow = this._makeSwatchRow('recent');
    recentRow.dataset.recentRow = 'true';
    this._content.appendChild(recentRow);
    this._refreshRecentRow();
  }

  _makeSectionLabel(text) {
    const fragment = this._cloneTemplate('section-label');
    const label = fragment.querySelector('header');
    const labelText = fragment.querySelector('h3');
    labelText.textContent = text;
    return label;
  }

  _makeSwatchRow(layout) {
    const fragment = this._cloneTemplate('swatch-row');
    const row = fragment.querySelector('menu');
    row.dataset.layout = layout;
    return row;
  }

  _makeColorSwatch(color, options = {}) {
    const normalized = this._normalizeHex(color);
    const fragment = this._cloneTemplate('swatch');
    const button = fragment.querySelector('button');
    button.dataset.color = normalized;
    if (options.row !== undefined) button.dataset.row = String(options.row);
    button.style.setProperty('--_swatch-color', normalized);
    button.title = normalized;
    button.setAttribute('aria-label', `Select ${normalized}`);

    this._addTabListener(button, 'mouseenter', () => this._setReadout(normalized));
    this._addTabListener(button, 'focus', () => this._setReadout(normalized));
    this._addTabListener(button, 'mouseleave', () => this._setReadout(this._value));
    this._addTabListener(button, 'blur', () => this._setReadout(this._value));
    this._addTabListener(button, 'click', () => {
      this._setValue(normalized, { emit: true, reflect: true, remember: true, source: this._activeTab });
    });

    return button;
  }

  _makeEmptySlot() {
    const fragment = this._cloneTemplate('empty-swatch');
    return fragment.querySelector('span');
  }

  _refreshRecentRow() {
    const recentRow = this.shadowRoot.querySelector('[data-recent-row="true"]');
    if (!recentRow) return;

    recentRow.replaceChildren();
    this._recentColors.forEach((color) => {
      recentRow.appendChild(color ? this._makeColorSwatch(color) : this._makeEmptySlot());
    });
    this._updateSelectedVisuals();
  }

  _buildStandardTab() {
    const size = 6.5;
    const width = size * Math.sqrt(3);
    const height = size * 2;
    const rowStep = height * 0.75;
    const colStep = width;
    const radius = 6;
    const pad = 4;
    const renderSize = size + 0.4;
    const rows = [];

    for (let i = 0; i <= radius * 2; i += 1) {
      rows.push((radius * 2 + 1) - Math.abs(i - radius));
    }

    const maxCount = Math.max(...rows);
    const totalRows = rows.length;
    const layoutW = pad * 2 + maxCount * colStep + colStep / 2;
    const layoutH = pad * 2 + (totalRows - 1) * rowStep + height;
    const hexes = [];

    rows.forEach((count, rowIndex) => {
      const cy = pad + size + rowIndex * rowStep;
      const rowWidth = (count - 1) * colStep;
      const startX = (layoutW - rowWidth) / 2;
      for (let i = 0; i < count; i += 1) {
        hexes.push({ cx: startX + i * colStep, cy });
      }
    });

    const middleRowIndex = radius;
    const centerCy = pad + size + middleRowIndex * rowStep;
    const centerCx = layoutW / 2;
    let maxDist = 0;

    hexes.forEach((hex) => {
      const dx = hex.cx - centerCx;
      const dy = hex.cy - centerCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxDist) maxDist = dist;
    });

    const lightMap = [
      [0, 240], [45, 280], [90, 320], [135, 350], [180, 380],
      [225, 420], [270, 480], [315, 540], [360, 600]
    ];

    hexes.forEach((hex) => {
      const dx = hex.cx - centerCx;
      const dy = hex.cy - centerCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radial = dist / maxDist;

      if (dist < 0.5) {
        hex.color = '#FFFFFF';
        return;
      }

      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (angle < 0) angle += 360;
      const walk = (angle - 270 + 360) % 360;
      let mappedHue = 0;

      for (let j = 0; j < lightMap.length - 1; j += 1) {
        const [w1, h1] = lightMap[j];
        const [w2, h2] = lightMap[j + 1];
        if (walk >= w1 && walk <= w2) {
          mappedHue = h1 + (h2 - h1) * (walk - w1) / (w2 - w1);
          break;
        }
      }

      const hue = mappedHue % 360;
      let sat;
      let val;

      if (radial < 0.55) {
        sat = radial / 0.55;
        val = 1;
      } else {
        sat = 1;
        val = 1 - ((radial - 0.55) / 0.45) * 0.75;
      }

      hex.color = hsvToHex(hue, sat, val);
    });

    const viewFragment = this._cloneTemplate('standard-view');
    const wrap = viewFragment.querySelector('figure');
    const svg = viewFragment.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${layoutW} ${layoutH}`);
    svg.setAttribute('width', layoutW);
    svg.setAttribute('height', layoutH);

    let selected = null;

    const resetPolygon = (polygon) => {
      polygon.setAttribute('stroke', polygon.getAttribute('fill'));
      polygon.setAttribute('stroke-width', '0.3');
      polygon.removeAttribute('data-selected');
    };

    const markSelected = (polygon) => {
      polygon.setAttribute('stroke', '#1a1a1a');
      polygon.setAttribute('stroke-width', '1.2');
      polygon.dataset.selected = '';
    };

    const points = (cx, cy, pointSize) => {
      const result = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        result.push(`${(cx + pointSize * Math.cos(angle)).toFixed(3)},${(cy + pointSize * Math.sin(angle)).toFixed(3)}`);
      }
      return result.join(' ');
    };

    hexes.forEach((hex) => {
      const hexFragment = this._cloneTemplate('hex');
      const polygon = hexFragment.querySelector('polygon');
      polygon.dataset.color = hex.color;
      polygon.setAttribute('points', points(hex.cx, hex.cy, renderSize));
      polygon.setAttribute('fill', hex.color);
      polygon.setAttribute('stroke', hex.color);
      polygon.setAttribute('aria-label', `Select ${hex.color}`);

      if (this._value === hex.color) {
        selected = polygon;
        markSelected(polygon);
      }

      this._addTabListener(polygon, 'mouseenter', () => {
        svg.querySelectorAll('polygon').forEach((element) => {
          if (element !== selected) resetPolygon(element);
        });
        polygon.setAttribute('stroke', '#ffffff');
        polygon.setAttribute('stroke-width', '1.2');
        svg.appendChild(polygon);
        this._setReadout(hex.color);
      });

      this._addTabListener(polygon, 'focus', () => this._setReadout(hex.color));

      this._addTabListener(polygon, 'click', () => {
        if (selected) resetPolygon(selected);
        selected = polygon;
        markSelected(polygon);
        this._setValue(hex.color, { emit: true, reflect: true, remember: true, source: 'standard' });
      });

      this._addTabListener(polygon, 'keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        polygon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      svg.appendChild(polygon);
    });

    wrap.appendChild(svg);
    this._content.appendChild(wrap);
  }

  _buildCustomTab() {
    const fragment = this._cloneTemplate('custom-view');
    const wrap = fragment.querySelector('section');
    const canvas = wrap.querySelector('[data-control="field"] > canvas');
    const crosshair = wrap.querySelector('[data-indicator="crosshair"]');
    const barCanvas = wrap.querySelector('[data-control="brightness"] > canvas');
    const barArrow = wrap.querySelector('[data-indicator="brightness"]');

    this._content.appendChild(wrap);

    this._raf(() => {
      if (!canvas.isConnected || this._activeTab !== 'custom') return;

      const dpr = (window.devicePixelRatio || 1) * 2;
      let currentBaseHex = '#2178B8';
      let brightnessT = 0.5;
      let pendingColor = null;
      let draggingField = false;
      let draggingBar = false;

      const fieldRect = canvas.getBoundingClientRect();
      canvas.width = Math.round(fieldRect.width * dpr);
      canvas.height = Math.round(fieldRect.height * dpr);

      const ctx = canvas.getContext('2d');
      const numBands = 36;
      const numRows = 24;
      const bandW = canvas.width / numBands;
      const rowH = canvas.height / numRows;

      for (let bx = 0; bx < numBands; bx += 1) {
        const hue = (bx / numBands) * 360;
        for (let by = 0; by < numRows; by += 1) {
          const t = by / (numRows - 1);
          const sat = 100 * (1 - t * 0.85);
          const light = 50 + t * 5;
          const [r, g, b] = hslToRgb(hue, sat, light);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(bx * bandW, by * rowH, Math.ceil(bandW) + 1, Math.ceil(rowH) + 1);
        }
      }

      const barRect = barCanvas.getBoundingClientRect();
      barCanvas.width = Math.round(barRect.width * dpr);
      barCanvas.height = Math.round(barRect.height * dpr);

      const drawBar = (base) => {
        const barContext = barCanvas.getContext('2d');
        const gradient = barContext.createLinearGradient(0, 0, 0, barCanvas.height);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.5, base);
        gradient.addColorStop(1, '#000000');
        barContext.fillStyle = gradient;
        barContext.fillRect(0, 0, barCanvas.width, barCanvas.height);
      };

      const commitCustomColor = (color) => {
        pendingColor = color;
        this._setValue(color, { emit: true, reflect: true, remember: false, source: 'custom' });
      };

      const rememberPendingColor = () => {
        if (!pendingColor) return;
        this._rememberColor(pendingColor);
        pendingColor = null;
      };

      const pickField = (event) => {
        const rect = field.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
        crosshair.style.left = `${x}px`;
        crosshair.style.top = `${y}px`;

        const hue = (x / rect.width) * 360;
        const t = y / rect.height;
        const sat = 100 * (1 - t * 0.85);
        const light = 50 + t * 5;
        const [red, green, blue] = hslToRgb(hue, sat, light);

        currentBaseHex = rgbHex(red, green, blue);
        drawBar(currentBaseHex);
        commitCustomColor(applyBrightness(currentBaseHex, brightnessT));
      };

      const pickBar = (event) => {
        const rect = bar.getBoundingClientRect();
        const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
        barArrow.style.top = `${y}px`;
        brightnessT = y / rect.height;
        commitCustomColor(applyBrightness(currentBaseHex, brightnessT));
      };

      const handleMove = (event) => {
        if (draggingField) pickField(event);
        if (draggingBar) pickBar(event);
      };

      const handleUp = () => {
        draggingField = false;
        draggingBar = false;
        rememberPendingColor();
      };

      drawBar(currentBaseHex);
      this._setReadout(applyBrightness(currentBaseHex, brightnessT));

      this._addTabListener(field, 'pointerdown', (event) => {
        draggingField = true;
        field.setPointerCapture?.(event.pointerId);
        pickField(event);
      });

      this._addTabListener(bar, 'pointerdown', (event) => {
        draggingBar = true;
        bar.setPointerCapture?.(event.pointerId);
        pickBar(event);
      });

      this._addTabListener(document, 'pointermove', handleMove);
      this._addTabListener(document, 'pointerup', handleUp);
      this._addTabListener(document, 'pointercancel', handleUp);
    });
  }

  _setValue(color, options = {}) {
    const {
      emit = false,
      reflect = true,
      remember = true,
      source = 'api'
    } = options;

    const normalized = this._normalizeHex(color);
    if (!normalized) {
      const previousValue = this._value;
      this._value = null;
      this._setReadout(null);
      this._updateSelectedVisuals();

      if (reflect && this.hasAttribute('value')) {
        this._reflecting = true;
        this.removeAttribute('value');
        this._reflecting = false;
      }

      if (emit && previousValue !== null) {
        this._dispatchChange({ color: null, previousValue, source });
      }
      return;
    }

    const previousValue = this._value;
    this._value = normalized;

    if (reflect && this.getAttribute('value') !== normalized) {
      this._reflecting = true;
      this.setAttribute('value', normalized);
      this._reflecting = false;
    }

    this._setReadout(normalized);
    this._updateSelectedVisuals();
    if (remember) this._rememberColor(normalized);

    if (emit && previousValue !== normalized) {
      this._dispatchChange({ color: normalized, previousValue, source });
    }
  }

  _setReadout(color) {
    if (!this._readout || !this._readoutSwatch) return;

    const normalized = this._normalizeHex(color);
    this._readout.textContent = normalized || '-';

    if (normalized) {
      this._readoutSwatch.removeAttribute('data-empty');
      this._readoutSwatch.style.backgroundColor = normalized;
    } else {
      this._readoutSwatch.dataset.empty = '';
      this._readoutSwatch.style.backgroundColor = '';
    }
  }

  _rememberColor(color) {
    const normalized = this._normalizeHex(color);
    if (!normalized) return;

    this._recentColors = [
      normalized,
      ...this._recentColors.filter((recent) => recent !== normalized)
    ].slice(0, 10);

    while (this._recentColors.length < 10) {
      this._recentColors.push(null);
    }

    if (this._activeTab === 'theme') {
      this._refreshRecentRow();
    }
  }

  _updateSelectedVisuals() {
    if (!this.shadowRoot) return;

    const current = this._value;
    this.shadowRoot.querySelectorAll('button[data-color]').forEach((swatch) => {
      swatch.toggleAttribute('data-selected', swatch.dataset.color === current);
    });

    this.shadowRoot.querySelectorAll('polygon[data-color]').forEach((hex) => {
      const selected = hex.dataset.color === current;
      hex.toggleAttribute('data-selected', selected);
      hex.setAttribute('stroke', selected ? '#1a1a1a' : hex.getAttribute('fill'));
      hex.setAttribute('stroke-width', selected ? '1.2' : '0.3');
    });
  }

  _dispatchChange({ color, previousValue, source }) {
    const detail = {
      color,
      value: color,
      previousValue,
      source,
      tab: this._activeTab
    };

    this._emit('change', detail);
  }

  _normalizeHex(color) {
    if (typeof color !== 'string') return null;

    let value = color.trim();
    if (!value) return null;
    if (!value.startsWith('#')) value = `#${value}`;

    if (/^#[0-9a-f]{3}$/i.test(value)) {
      value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }

    if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
    return value.toUpperCase();
  }

  _addTabListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this._tabCleanup.push(() => target.removeEventListener(event, handler, options));
  }

  _cleanupTab() {
    this._tabCleanup.splice(0).forEach((cleanup) => cleanup());
  }
}


export default WbColorPicker;
