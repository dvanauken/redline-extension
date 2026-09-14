/**
 * Redline toolbar: a compact main bar plus a contextual style row.
 *
 * The main bar keeps its controls in fixed positions whatever the tool or
 * selection. When the viewport is too narrow, lower-priority tools move into
 * the More tools menu and labels compact, in a fixed order, until the bar fits.
 *
 * The style row below it always names its target: the selected mark, or the
 * defaults for marks the active tool will create. It never edits both.
 *
 * The toolbar owns no document state. It reports user intent through
 * `onCommand(name, detail)` and is brought up to date with `sync(state)`.
 */

import { appendIcon, iconElement } from './icons.js';
import { RedlineMenu } from './RedlineMenu.js';
import {
  BULLET_SCHEMES, LEGEND_FONT_OPTIONS, LEGEND_FONT_SIZES, LEGEND_WIDTHS,
} from './RedlineLegend.js';
import {
  BULLET_SCHEME_OPTIONS, CLOSED_TYPES, DECORATIONS, DECORATION_LABELS, END_PRESETS, FILL_OPACITIES, FONT_SIZES,
  HIGHLIGHTER_OPACITIES, HIGHLIGHTER_WIDTHS, LINE_TYPES, LINE_WEIGHTS, NOTE_MARKERS, TEXT_BACKGROUNDS,
  TREATMENTS, markDecorations, redlineMarkFill, treatmentOf,
} from './RedlineStyles.js';

export const TOOL_INFO = {
  select: { label: 'Select', key: 'V', hint: 'select, move and style marks' },
  pen: { label: 'Pen', key: 'P', hint: 'freehand' },
  brush: { label: 'Highlighter', key: 'B', hint: 'wide translucent stroke' },
  line: { label: 'Line', key: 'L', hint: 'Shift snaps to 45°' },
  arrow: { label: 'Arrow', key: 'A', hint: 'Shift snaps to 45°' },
  rectangle: { label: 'Rectangle', key: 'R', hint: 'Shift draws a square' },
  ellipse: { label: 'Ellipse', key: 'O', hint: 'Shift draws a circle' },
  note: { label: 'Note', key: 'N', hint: 'numbered note with an adjacent label' },
  bullet: { label: 'Bullet', key: 'U', hint: '1–9 or A–Z marker with an optional legend' },
  textbox: { label: 'Text', key: 'T', hint: 'click and type; grows with your text' },
  polyline: { label: 'Polyline', key: null, hint: 'click points; Enter or double-click finishes' },
  polygon: { label: 'Polygon', key: null, hint: 'click 3+ points; Enter or double-click closes' },
  eraser: { label: 'Eraser', key: 'E', hint: 'click or drag across marks' },
  crop: { label: 'Crop', key: 'C', hint: 'crop and scale the exported image' },
};

const TYPE_NAMES = {
  pen: ['pen stroke', 'pen strokes'],
  brush: ['highlight', 'highlights'],
  line: ['line', 'lines'],
  arrow: ['arrow', 'arrows'],
  polyline: ['polyline', 'polylines'],
  polygon: ['polygon', 'polygons'],
  rectangle: ['rectangle', 'rectangles'],
  ellipse: ['ellipse', 'ellipses'],
  note: ['note', 'notes'],
  bullet: ['bullet', 'bullets'],
  textbox: ['text box', 'text boxes'],
};

/** Tools on the main bar, with the order in which they collapse (first = earliest). */
const BAR_TOOLS = [
  ['select', 12], ['pen', 11], ['brush', 6], ['line', 3], ['arrow', 10],
  ['rectangle', 9], ['ellipse', 4], ['note', 5], ['bullet', 6.5], ['textbox', 7],
];
const MENU_ONLY_TOOLS = ['polyline', 'polygon', 'eraser'];
const LABEL_COLLAPSES = [['copy-label', 2], ['mode-labels', 8], ['density', 8.5]];

export const REPORT_TITLE = 'Copy report — the annotated screenshot plus bullet explanations and notes as text. '
  + 'Explanations are listed even when the legend is hidden on the image.';

function toolTitle(tool) {
  const info = TOOL_INFO[tool];
  return `${info.label}${info.key ? ` (${info.key})` : ''} — ${info.hint}`;
}

function button({ label = '', title, icon = null, action = null, tool = null, text = null }) {
  const element = document.createElement('button');
  element.type = 'button';
  if (title) element.title = title;
  if (label) element.setAttribute('aria-label', label);
  if (action) element.dataset.redlineAction = action;
  if (tool) element.dataset.redlineTool = tool;
  if (text !== null) {
    const span = document.createElement('span');
    span.dataset.redlineLabel = '';
    span.textContent = text;
    element.appendChild(span);
  }
  if (icon) appendIcon(element, icon);
  return element;
}

function separator() {
  const node = document.createElement('span');
  node.dataset.redlineSeparator = '';
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function select(label, options, { title = label } = {}) {
  const wrapper = document.createElement('label');
  wrapper.dataset.redlineField = '';
  wrapper.title = title;
  const caption = document.createElement('span');
  caption.textContent = label;
  const control = document.createElement('select');
  control.setAttribute('aria-label', label);
  for (const [text, value] of options) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = text;
    control.appendChild(option);
  }
  wrapper.append(caption, control);
  return { wrapper, control, caption };
}

/**
 * Show a value in a select even when it is not one of the listed options, so a
 * mark imported with an unusual value is displayed exactly rather than rounded.
 */
function setSelectValue(control, value, format) {
  const text = String(value);
  control.querySelectorAll('option[data-custom]').forEach(option => option.remove());
  if (![...control.options].some(option => option.value === text)) {
    const option = document.createElement('option');
    option.value = text;
    option.dataset.custom = '';
    option.textContent = format(value);
    control.appendChild(option);
  }
  control.value = text;
}

const percent = value => `${Math.round(value * 1000) / 10}%`;

/** A small line icon showing a pair of end decorations. */
function endsIcon(start, end) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.redlineEndsIcon = '';
  const parts = [];
  const lineStart = start === 'open-circle' ? 9 : 5;
  const lineEnd = end === 'open-circle' ? 31 : 35;
  parts.push(`<path d="M${lineStart} 8H${lineEnd}"/>`);
  const cap = (x, direction, kind) => {
    if (kind === 'arrow') return `<path d="M${x - direction * 7} 3.5 ${x} 8 ${x - direction * 7} 12.5"/>`;
    if (kind === 'open-circle') return `<circle cx="${x}" cy="8" r="3.5"/>`;
    if (kind === 'filled-circle') return `<circle cx="${x}" cy="8" r="3.5" data-filled="" />`;
    return '';
  };
  parts.push(cap(5, -1, start), cap(35, 1, end));
  svg.innerHTML = parts.join('');
  return svg;
}

function treatmentIcon(treatment) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.redlineTreatmentIcon = treatment;
  svg.innerHTML = '<rect x="4" y="5" width="16" height="14" rx="1.5"/>';
  return svg;
}

export class RedlineToolbar {
  constructor({ root, onCommand }) {
    this.root = root;
    this.onCommand = onCommand;
    this.menus = [];
    this.dock = document.createElement('div');
    this.dock.dataset.redlineDock = '';
    // The dock precedes the menus in document order, as it does visually.
    this.root.appendChild(this.dock);
    this._buildBar();
    this._buildContext();
  }

  _emit(name, detail) {
    this.onCommand(name, detail);
  }

  _buildBar() {
    const bar = document.createElement('div');
    bar.dataset.redlineToolbar = '';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Redline tools');
    this.bar = bar;

    this.grip = button({ label: 'Move toolbar', title: 'Drag to move the toolbar', icon: 'grip' });
    this.grip.dataset.redlineGrip = '';

    const mode = document.createElement('div');
    mode.dataset.redlineModeSwitch = '';
    mode.setAttribute('role', 'group');
    mode.setAttribute('aria-label', 'Interaction mode, F2 switches');
    this.modeIndicator = document.createElement('span');
    this.modeIndicator.dataset.redlineModeIndicator = '';
    this.modeIndicator.setAttribute('aria-hidden', 'true');
    this.annotateButton = button({ title: 'Annotate — draw over the page (F2)', icon: 'annotate', text: 'Annotate' });
    this.annotateButton.dataset.redlineMode = 'annotate';
    this.browseButton = button({ title: 'Browse — click, type and scroll the page (F2)', icon: 'browse', text: 'Browse' });
    this.browseButton.dataset.redlineMode = 'browse';
    mode.append(this.modeIndicator, this.annotateButton, this.browseButton);
    this.modeSwitch = mode;
    mode.addEventListener('click', event => {
      const target = event.target.closest('[data-redline-mode]');
      if (target) this._emit('mode', target.dataset.redlineMode);
    });

    const tools = document.createElement('div');
    tools.dataset.redlineGroup = 'tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', 'Drawing tools');
    this.collapsibles = [];
    for (const [tool, order] of BAR_TOOLS) {
      const element = button({ label: `${TOOL_INFO[tool].label}${TOOL_INFO[tool].key ? ` (${TOOL_INFO[tool].key})` : ''}`, title: toolTitle(tool), icon: tool, tool });
      element.dataset.collapseOrder = String(order);
      tools.appendChild(element);
      this.collapsibles.push({ order, element, kind: 'tool', tool });
    }

    this.toolsButton = button({ label: 'More tools', title: 'More tools — polyline, polygon, eraser', icon: 'tools' });
    this.toolsButton.dataset.redlineMoreTools = '';
    this.toolsButton.appendChild(iconElement('chevron')).dataset.redlineChevron = '';
    tools.appendChild(this.toolsButton);
    this.toolsMenu = this._menu(this.toolsButton, 'More tools');
    for (const [tool] of BAR_TOOLS) this._menuTool(tool, { twin: true });
    this.toolsMenu.addSeparator().dataset.redlineTwinSeparator = '';
    for (const tool of MENU_ONLY_TOOLS) this._menuTool(tool);

    const history = document.createElement('div');
    history.dataset.redlineGroup = 'history';
    this.undoButton = button({ label: 'Undo (Ctrl+Z)', title: 'Undo mark change (Ctrl+Z)', icon: 'undo', action: 'undo' });
    this.redoButton = button({ label: 'Redo (Ctrl+Y)', title: 'Redo mark change (Ctrl+Y)', icon: 'redo', action: 'redo' });
    history.append(this.undoButton, this.redoButton);

    const output = document.createElement('div');
    output.dataset.redlineGroup = 'output';
    this.cropButton = button({ label: 'Crop (C)', title: toolTitle('crop'), icon: 'crop', tool: 'crop' });
    this.cropButton.dataset.collapseOrder = '1';
    this.collapsibles.push({ order: 1, element: this.cropButton, kind: 'tool', tool: 'crop' });
    this.copyButton = button({ title: 'Copy image — annotated screenshot to the clipboard', icon: 'copy', action: 'copy', text: 'Copy image' });
    this.copyButton.setAttribute('aria-label', 'Copy image');
    this.reportButton = button({ title: REPORT_TITLE, icon: 'report', action: 'report', text: 'Copy report' });
    this.reportButton.setAttribute('aria-label', 'Copy report');
    this.reportButton.dataset.collapseOrder = '1.5';
    this.moreButton = button({ label: 'More actions', title: 'More actions — preview, download, pointer, recovery, import, clear', icon: 'more' });
    this.moreButton.dataset.redlineMoreActions = '';
    this.moreMenu = this._menu(this.moreButton, 'More actions');
    this._menuTool('crop', { twin: true });
    const reportTwin = this._menuAction('report', 'Copy report', 'report', { hint: 'screenshot + explanations as text' });
    reportTwin.dataset.redlineTwin = 'report';
    reportTwin.hidden = true;
    reportTwin.title = REPORT_TITLE;
    this.collapsibles.push({ order: 1.5, element: this.reportButton, kind: 'action', twin: reportTwin });
    this.previewButton = this._menuAction('preview', 'Export preview…', 'preview', { hint: 'see the exact PNG before copying' });
    this.downloadButton = this._menuAction('download', 'Download PNG', 'download');
    this.reportFallbackButton = this._menuAction('reportFallback', 'Copy report text + download PNG', 'report', {
      hint: 'for apps that paste only text or only images',
    });
    this.jsonButton = this._menuAction('json', 'Download JSON', 'json');
    this.importButton = this._menuAction('import', 'Import annotations…', 'import');
    this.moreMenu.addSeparator();
    this.cursorToggle = this._menuAction('cursorToggle', 'Include cursor', 'cursor', { hint: 'Off — adds a pointer to exports', role: 'menuitemcheckbox' });
    this.cursorToggle.setAttribute('aria-checked', 'false');
    this.cursorToggle.dataset.redlineCursorToggle = '';
    this.cursorPlaceButton = this._menuAction('cursorPlace', 'Place cursor…', 'cursor', { hint: 'click, or arrow keys and Enter' });
    this.moreMenu.addSeparator();
    this.restoreDraftButton = this._menuAction('restoreDraft', 'Restore draft…', 'restore', { hint: 'marks saved before this page reloaded' });
    this.discardDraftButton = this._menuAction('discardDraft', 'Discard draft…', 'clear', { hint: 'delete the reload-recovery copy' });
    this.resumeRecoveryButton = this._menuAction('resumeRecovery', 'Resume reload recovery', 'restore');
    this.clearButton = this._menuAction('clear', 'Clear all marks…', 'clear');
    output.append(this.cropButton, this.copyButton, this.reportButton, this.moreButton);

    const frame = document.createElement('div');
    frame.dataset.redlineGroup = 'frame';
    this.pinButton = button({ label: 'Pin toolbar to the top-left', title: 'Pin toolbar to the top-left', icon: 'pin', action: 'pin' });
    this.pinButton.dataset.redlinePin = '';
    this.closeButton = button({ label: 'Close Redline (Esc)', title: 'Close Redline — marks are kept (Esc)', icon: 'close', action: 'close' });
    this.closeButton.dataset.redlineClose = '';
    frame.append(this.pinButton, this.closeButton);

    for (const [name, order] of LABEL_COLLAPSES) this.collapsibles.push({ order, kind: 'flag', name });
    this.collapsibles.sort((a, b) => a.order - b.order);

    bar.append(this.grip, mode, separator(), tools, separator(), history, separator(), output, separator(), frame);
    bar.addEventListener('click', event => {
      const tool = event.target.closest('[data-redline-tool]')?.dataset.redlineTool;
      if (tool) return this._emit('tool', tool);
      const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
      if (action) this._emit('action', action);
    });
    this.dock.appendChild(bar);
  }

  _menu(trigger, label) {
    const menu = new RedlineMenu({
      trigger,
      container: this.root,
      label,
      onOpen: opening => this.menus.forEach(other => other !== opening && other.close({ focusTrigger: false })),
    });
    menu.menu.addEventListener('click', event => {
      const tool = event.target.closest('[data-redline-tool]')?.dataset.redlineTool;
      if (tool) return this._emit('tool', tool);
      const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
      if (action) this._emit('action', action);
    });
    this.menus.push(menu);
    return menu;
  }

  _menuTool(tool, { twin = false } = {}) {
    const menu = tool === 'crop' ? this.moreMenu : this.toolsMenu;
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.dataset.redlineTool = tool;
    item.title = toolTitle(tool);
    appendIcon(item, tool);
    const label = document.createElement('span');
    label.textContent = TOOL_INFO[tool].label;
    const hint = document.createElement('small');
    hint.textContent = TOOL_INFO[tool].key ? `${TOOL_INFO[tool].key} · ${TOOL_INFO[tool].hint}` : TOOL_INFO[tool].hint;
    item.append(label, hint);
    if (twin) {
      item.dataset.redlineTwin = tool;
      item.hidden = true;
    }
    return menu.add(item);
  }

  _menuAction(action, text, icon, { hint = null, role = 'menuitem' } = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', role);
    item.dataset.redlineAction = action;
    appendIcon(item, icon);
    const label = document.createElement('span');
    label.textContent = text;
    item.appendChild(label);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      item.appendChild(small);
    }
    return this.moreMenu.add(item);
  }

  _buildContext() {
    const context = document.createElement('div');
    context.dataset.redlineContext = '';
    context.setAttribute('role', 'group');
    this.context = context;

    this.targetLabel = document.createElement('span');
    this.targetLabel.dataset.redlineTarget = '';
    context.appendChild(this.targetLabel);

    const controls = {};
    const group = name => {
      const node = document.createElement('div');
      node.dataset.redlineControl = name;
      context.appendChild(node);
      controls[name] = node;
      return node;
    };

    const treatment = group('treatment');
    treatment.setAttribute('role', 'group');
    treatment.setAttribute('aria-label', 'Shape treatment');
    this.treatmentButtons = TREATMENTS.map(([key, text]) => {
      const element = button({ title: text });
      element.dataset.treatment = key;
      element.appendChild(treatmentIcon(key));
      const span = document.createElement('span');
      span.dataset.redlineLabel = '';
      span.textContent = text;
      element.appendChild(span);
      element.setAttribute('aria-label', text);
      element.addEventListener('click', () => this._emit('style', { property: 'treatment', value: key }));
      treatment.appendChild(element);
      return element;
    });

    const colorButton = (name, text) => {
      const element = button({ title: text });
      element.dataset.redlineColor = name;
      const swatch = document.createElement('span');
      swatch.dataset.redlineSwatch = name;
      swatch.setAttribute('aria-hidden', 'true');
      const paint = document.createElement('span');
      swatch.appendChild(paint);
      const caption = document.createElement('span');
      caption.dataset.redlineLabel = '';
      caption.textContent = text;
      element.append(swatch, caption);
      element.addEventListener('click', () => this._emit('color', { target: name, anchor: element }));
      return { element, swatch, paint, caption };
    };
    this.strokeColor = colorButton('stroke', 'Color');
    group('stroke').appendChild(this.strokeColor.element);
    this.fillColor = colorButton('fill', 'Fill');
    group('fill').appendChild(this.fillColor.element);

    const opacity = group('fillOpacity');
    opacity.setAttribute('role', 'group');
    opacity.setAttribute('aria-label', 'Fill opacity');
    const opacityCaption = document.createElement('span');
    opacityCaption.dataset.redlineCaption = '';
    opacityCaption.textContent = 'Fill opacity';
    opacity.appendChild(opacityCaption);
    this.opacityButtons = [...FILL_OPACITIES, 'custom'].map(value => {
      const element = button({ title: value === 'custom' ? 'Imported fill opacity' : `${percent(value)} fill` });
      element.dataset.fillOpacity = String(value);
      const swatch = document.createElement('span');
      swatch.dataset.redlineOpacitySwatch = '';
      swatch.setAttribute('aria-hidden', 'true');
      const paint = document.createElement('span');
      if (value !== 'custom') paint.style.opacity = String(value);
      swatch.appendChild(paint);
      const caption = document.createElement('span');
      caption.textContent = value === 'custom' ? '' : percent(value);
      element.append(swatch, caption);
      element.setAttribute('aria-label', value === 'custom' ? 'Imported fill opacity' : `${percent(value)} fill opacity`);
      if (value !== 'custom') {
        element.addEventListener('click', () => this._emit('style', { property: 'fillOpacity', value }));
      }
      opacity.appendChild(element);
      return element;
    });

    const widthField = select('Thickness', LINE_WEIGHTS, { title: 'Line thickness in points' });
    widthField.control.setAttribute('aria-label', 'Line weight');
    group('width').appendChild(widthField.wrapper);
    this.widthSelect = widthField.control;
    this.widthSelect.addEventListener('change', () => this._emit('style', { property: 'width', value: Number(this.widthSelect.value) }));

    const brushWidth = select('Width', HIGHLIGHTER_WIDTHS, { title: 'Highlighter width' });
    brushWidth.control.setAttribute('aria-label', 'Highlighter width');
    group('brushWidth').appendChild(brushWidth.wrapper);
    this.brushWidthSelect = brushWidth.control;
    this.brushWidthSelect.addEventListener('change', () => this._emit('style', { property: 'width', value: Number(this.brushWidthSelect.value) }));

    const brushOpacity = select('Opacity', HIGHLIGHTER_OPACITIES, { title: 'Highlighter opacity' });
    brushOpacity.control.setAttribute('aria-label', 'Highlighter opacity');
    group('brushOpacity').appendChild(brushOpacity.wrapper);
    this.brushOpacitySelect = brushOpacity.control;
    this.brushOpacitySelect.addEventListener('change', () => this._emit('style', { property: 'opacity', value: Number(this.brushOpacitySelect.value) }));

    const ends = group('ends');
    ends.setAttribute('role', 'group');
    ends.setAttribute('aria-label', 'Line ends');
    const presets = document.createElement('div');
    presets.dataset.redlineEndPresets = '';
    this.endPresetButtons = END_PRESETS.map(preset => {
      const element = button({ label: preset.label, title: preset.label });
      element.dataset.endPreset = preset.key;
      element.appendChild(endsIcon(preset.start, preset.end));
      element.addEventListener('click', () => this._emit('style', { property: 'ends', value: { start: preset.start, end: preset.end } }));
      presets.appendChild(element);
      return element;
    });
    const decorationOptions = DECORATIONS.map(key => [DECORATION_LABELS[key], key]);
    const startField = select('Start', decorationOptions, { title: 'Decoration at the start of the line' });
    startField.control.setAttribute('aria-label', 'Start decoration');
    const endField = select('End', decorationOptions, { title: 'Decoration at the end of the line' });
    endField.control.setAttribute('aria-label', 'End decoration');
    this.startSelect = startField.control;
    this.endSelect = endField.control;
    this.startSelect.addEventListener('change', () => this._emit('style', { property: 'ends', value: { start: this.startSelect.value, end: this.endSelect.value } }));
    this.endSelect.addEventListener('change', () => this._emit('style', { property: 'ends', value: { start: this.startSelect.value, end: this.endSelect.value } }));
    ends.append(presets, startField.wrapper, endField.wrapper);

    const marker = select('Note labels', NOTE_MARKERS, { title: 'Numbers or letters for new notes; existing notes keep theirs' });
    marker.control.setAttribute('aria-label', 'Note marker style');
    group('noteMarker').appendChild(marker.wrapper);
    this.noteMarkerSelect = marker.control;
    this.noteMarkerSelect.addEventListener('change', () => this._emit('noteMarker', this.noteMarkerSelect.value));

    // ---- Bullets and legend
    const scheme = select('Labels', BULLET_SCHEME_OPTIONS, { title: 'Numbers or letters for new bullets; existing bullets keep theirs' });
    scheme.control.setAttribute('aria-label', 'Bullet labels');
    group('bulletScheme').appendChild(scheme.wrapper);
    this.bulletSchemeSelect = scheme.control;
    this.bulletSchemeSelect.addEventListener('change', () => this._emit('bulletScheme', this.bulletSchemeSelect.value));

    this.bulletNext = document.createElement('span');
    this.bulletNext.dataset.redlineBulletNext = '';
    group('bulletNext').appendChild(this.bulletNext);

    const limit = group('bulletLimit');
    limit.setAttribute('role', 'alert');
    this.bulletLimitText = document.createElement('span');
    this.bulletLimitText.dataset.redlineBulletLimitText = '';
    this.bulletLimitSwitch = button({ title: 'Use the other label range for new bullets', text: 'Use A–Z' });
    this.bulletLimitSwitch.dataset.redlineBulletSwitch = '';
    this.bulletLimitSwitch.addEventListener('click', () => this._emit('bulletScheme', this.bulletLimitSwitch.dataset.scheme));
    limit.append(this.bulletLimitText, this.bulletLimitSwitch);

    const explain = group('explain');
    this.explainButton = button({ title: 'Edit the explanation of the selected bullet (Enter)', icon: 'explain', text: 'Edit explanation' });
    this.explainButton.dataset.redlineExplain = '';
    this.explainButton.addEventListener('click', () => this._emit('action', 'explain'));
    explain.appendChild(this.explainButton);

    const legendToggle = group('legendToggle');
    this.legendToggle = button({ title: 'Show or hide the legend of bullet explanations', icon: 'legend', text: 'Legend' });
    this.legendToggle.dataset.redlineLegendToggle = '';
    this.legendToggle.setAttribute('aria-pressed', 'false');
    // A mouse press keeps focus where it was, so hiding or showing the legend
    // mid-edit moves the open explanation between row and card without saving.
    this.legendToggle.addEventListener('pointerdown', event => event.preventDefault());
    this.legendToggle.addEventListener('click', () => this._emit('legend', {
      property: 'visible', value: this.legendToggle.getAttribute('aria-pressed') !== 'true',
    }));
    this.legendOptions = button({ title: 'Legend font, size and position', text: 'Legend options' });
    this.legendOptions.dataset.redlineLegendOptions = '';
    this.legendOptions.addEventListener('click', () => this._emit('legendSelect'));
    legendToggle.append(this.legendToggle, this.legendOptions);

    const legendStyle = group('legendStyle');
    legendStyle.setAttribute('role', 'group');
    legendStyle.setAttribute('aria-label', 'Legend layout');
    const legendField = (label, options, property, aria, title, parse = value => value) => {
      const field = select(label, options, { title });
      field.control.setAttribute('aria-label', aria);
      field.control.dataset.legendProperty = property;
      field.control.addEventListener('change', () => this._emit('legend', { property, value: parse(field.control.value) }));
      legendStyle.appendChild(field.wrapper);
      return field.control;
    };
    this.legendFontSizeSelect = legendField('Size', LEGEND_FONT_SIZES.map(size => [`${size} px`, size]), 'fontSize', 'Legend font size', 'Legend text size', Number);
    this.legendFontSelect = legendField('Font', LEGEND_FONT_OPTIONS, 'fontFamily', 'Legend font', 'Legend typeface (installed fonts only)');
    this.legendWidthSelect = legendField('Width', LEGEND_WIDTHS.map(width => [`${width} px`, width]), 'width', 'Legend width', 'Legend width; drag its side handles for any width', Number);
    this.legendHeightSelect = legendField('Height', [['Fit text', 'auto'], ['Fixed', 'fixed']], 'height', 'Legend height',
      'Fit text grows with explanations; Fixed keeps a height and marks clipped text');
    this.legendPositionSelect = legendField('Place', [['Move to…', ''], ['Top left', 'top-left'], ['Top right', 'top-right'], ['Bottom left', 'bottom-left'], ['Bottom right', 'bottom-right']],
      'position', 'Move legend to a corner', 'Move the legend to a corner; drag it for any position');

    const explanationActions = group('explanationActions');
    this.explanationSave = button({ title: 'Save the explanation (Ctrl+Enter)', text: 'Save' });
    this.explanationSave.dataset.redlineExplanationSave = '';
    this.explanationCancel = button({ title: 'Discard this edit (Esc)', text: 'Cancel' });
    this.explanationCancel.dataset.redlineExplanationCancel = '';
    for (const [element, action] of [[this.explanationSave, 'explainCommit'], [this.explanationCancel, 'explainCancel']]) {
      // Keep focus in the editor, so pressing the button does not save first.
      element.addEventListener('pointerdown', event => event.preventDefault());
      element.addEventListener('click', () => this._emit('action', action));
    }
    explanationActions.append(this.explanationSave, this.explanationCancel);

    // ---- Pointer proxy
    const cursor = group('cursor');
    cursor.setAttribute('role', 'group');
    cursor.setAttribute('aria-label', 'Pointer in exports');
    this.cursorFollowButton = button({ title: 'Follow: move the pointer to where you next click or pause over the page', icon: 'cursor', text: 'Follow' });
    this.cursorFollowButton.dataset.redlineCursorFollow = '';
    this.cursorFollowButton.setAttribute('aria-pressed', 'false');
    this.cursorPlaceContext = button({ title: 'Place the pointer: click where it should point, or use arrow keys and Enter', text: 'Place…' });
    this.cursorPlaceContext.dataset.redlineCursorPlace = '';
    this.cursorHideButton = button({ title: 'Leave the pointer out of exports (Delete)', text: 'Remove from export' });
    this.cursorHideButton.dataset.redlineCursorHide = '';
    for (const [element, action] of [[this.cursorFollowButton, 'cursorFollow'], [this.cursorPlaceContext, 'cursorPlace'], [this.cursorHideButton, 'cursorToggle']]) {
      element.addEventListener('click', () => this._emit('action', action));
    }
    cursor.append(this.cursorFollowButton, this.cursorPlaceContext, this.cursorHideButton);

    const fontSize = select('Font size', FONT_SIZES.map(size => [`${size} px`, size]));
    group('fontSize').appendChild(fontSize.wrapper);
    this.fontSizeSelect = fontSize.control;
    this.fontSizeSelect.addEventListener('change', () => this._emit('style', { property: 'fontSize', value: Number(this.fontSizeSelect.value) }));

    const background = select('Background', TEXT_BACKGROUNDS, { title: 'Text box background opacity' });
    background.control.setAttribute('aria-label', 'Text box background');
    group('background').appendChild(background.wrapper);
    this.backgroundSelect = background.control;
    this.backgroundSelect.addEventListener('change', () => this._emit('style', { property: 'backgroundOpacity', value: Number(this.backgroundSelect.value) }));

    this.hint = document.createElement('span');
    this.hint.dataset.redlineHint = '';
    context.appendChild(this.hint);

    const selection = group('selection');
    this.duplicateButton = button({ label: 'Duplicate (Ctrl+D)', title: 'Duplicate the selected mark (Ctrl+D)', icon: 'duplicate', action: 'duplicate', text: 'Duplicate' });
    this.deleteButton = button({ label: 'Delete (Delete)', title: 'Delete the selected mark (Delete)', icon: 'delete', action: 'delete', text: 'Delete' });
    selection.append(this.duplicateButton, this.deleteButton);
    selection.addEventListener('click', event => {
      const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
      if (action) this._emit('action', action);
    });

    // ---- A reload-recovery draft waiting for a decision
    const recovery = group('recovery');
    recovery.setAttribute('role', 'group');
    recovery.setAttribute('aria-label', 'Reload recovery draft');
    this.recoveryText = document.createElement('span');
    this.recoveryText.dataset.redlineRecoveryText = '';
    this.recoveryRestore = button({ title: 'Restore the marks saved before this page reloaded', icon: 'restore', text: 'Restore…' });
    this.recoveryRestore.dataset.redlineRecoveryRestore = '';
    this.recoveryDiscard = button({ title: 'Delete the saved draft', text: 'Discard' });
    this.recoveryDiscard.dataset.redlineRecoveryDiscard = '';
    this.recoveryRestore.addEventListener('click', () => this._emit('action', 'restoreDraft'));
    this.recoveryDiscard.addEventListener('click', () => this._emit('action', 'discardDraft'));
    recovery.append(this.recoveryText, this.recoveryRestore, this.recoveryDiscard);

    this.message = document.createElement('span');
    this.message.dataset.redlineMessage = '';
    this.message.setAttribute('role', 'status');
    this.message.setAttribute('aria-live', 'polite');
    context.appendChild(this.message);

    this.controls = controls;
    this.dock.appendChild(context);
  }

  closeMenus() {
    return this.menus.map(menu => menu.close({ focusTrigger: false })).some(Boolean);
  }

  openMenu() {
    return this.menus.find(menu => menu.isOpen) ?? null;
  }

  menuContaining(node) {
    return this.menus.find(menu => menu.menu.contains(node)) ?? null;
  }

  setMessage(text) {
    this.message.textContent = text;
  }

  /** Control that represents a tool for focus, whether on the bar or collapsed. */
  toolFocusTarget(tool) {
    const onBar = [...this.bar.querySelectorAll(`[data-redline-tool="${tool}"]`)].find(node => !node.hidden);
    if (onBar) return onBar;
    return tool === 'crop' ? this.moreButton : this.toolsButton;
  }

  /**
   * Collapse lower-priority bar items until the bar fits the viewport. Runs on
   * open and resize only; it is independent of the tool or selection, so the
   * essential actions never move while the user works.
   */
  layout() {
    const available = window.innerWidth - 16;
    this.bar.removeAttribute('data-compact-copy');
    this.bar.removeAttribute('data-compact-mode');
    this.bar.removeAttribute('data-density');
    for (const item of this.collapsibles) {
      if (item.kind === 'tool' || item.kind === 'action') {
        item.element.hidden = false;
        (item.twin ?? this._twin(item.tool)).hidden = true;
      }
    }
    for (const item of this.collapsibles) {
      if (this.bar.scrollWidth <= available) break;
      if (item.kind === 'tool' || item.kind === 'action') {
        item.element.hidden = true;
        (item.twin ?? this._twin(item.tool)).hidden = false;
      } else if (item.name === 'copy-label') {
        this.bar.dataset.compactCopy = '';
      } else if (item.name === 'mode-labels') {
        this.bar.dataset.compactMode = '';
      } else if (item.name === 'density') {
        this.bar.dataset.density = 'compact';
      }
    }
    const twins = [...this.toolsMenu.menu.querySelectorAll('[data-redline-twin]')];
    this.toolsMenu.menu.querySelector('[data-redline-twin-separator]').hidden = twins.every(node => node.hidden);
    this.positionContext();
    this.menus.forEach(menu => menu.position());
  }

  _twin(tool) {
    return (tool === 'crop' ? this.moreMenu : this.toolsMenu).menu.querySelector(`[data-redline-twin="${tool}"]`);
  }

  /** Keep the style row on screen when the toolbar sits near an edge. */
  positionContext() {
    if (this.context.hidden) return;
    this.context.style.left = '0px';
    const rect = this.context.getBoundingClientRect();
    const gutter = 8;
    let shift = 0;
    if (rect.right > window.innerWidth - gutter) shift = window.innerWidth - gutter - rect.right;
    if (rect.left + shift < gutter) shift = gutter - rect.left;
    this.context.style.left = `${Math.round(shift)}px`;
  }

  /**
   * state: {
   *   tool, pageMode, busy, pinned, canUndo, canRedo, count, hasSelection,
   *   subject: { kind: 'selection' | 'defaults' | 'none', type, style, noteMarker, hint }
   * }
   */
  sync(state) {
    const { tool, pageMode } = state;
    for (const element of this.dock.querySelectorAll('[data-redline-tool]')) this._syncToolElement(element, tool);
    for (const element of this.root.querySelectorAll('[data-redline-menu] [data-redline-tool]')) this._syncToolElement(element, tool);
    const menuTool = [...this.toolsMenu.menu.querySelectorAll('[data-redline-tool]')]
      .find(item => item.dataset.redlineTool === tool && !item.hidden);
    this.toolsButton.toggleAttribute('data-active', Boolean(menuTool));
    const toolIcon = this.toolsButton.querySelector('svg:not([data-redline-chevron])');
    const iconName = menuTool ? tool : 'tools';
    if (toolIcon?.dataset.icon !== iconName) {
      const replacement = iconElement(iconName);
      replacement.dataset.icon = iconName;
      toolIcon.replaceWith(replacement);
    }
    this.toolsButton.setAttribute('aria-label', menuTool ? `More tools, ${TOOL_INFO[tool].label} active` : 'More tools');

    this.annotateButton.setAttribute('aria-pressed', String(!pageMode));
    this.browseButton.setAttribute('aria-pressed', String(pageMode));
    this.annotateButton.toggleAttribute('data-active', !pageMode);
    this.browseButton.toggleAttribute('data-active', pageMode);
    this.dock.toggleAttribute('data-browse', pageMode);
    this.bar.setAttribute('aria-label', pageMode ? 'Redline tools — Browse mode, F2 resumes annotating' : 'Redline tools — Annotate mode');

    this.pinButton.toggleAttribute('data-active', state.pinned);
    this.pinButton.setAttribute('aria-pressed', String(state.pinned));
    this.pinButton.title = state.pinned ? 'Unpin toolbar from the top-left' : 'Pin toolbar to the top-left';
    this.pinButton.setAttribute('aria-label', this.pinButton.title);
    this.dock.toggleAttribute('data-pinned', state.pinned);

    const always = new Set([this.grip, this.annotateButton, this.browseButton, this.pinButton, this.closeButton]);
    for (const control of this.dock.querySelectorAll('button, select, input')) {
      control.disabled = state.busy || (pageMode && !always.has(control));
    }
    this.toolsButton.disabled = state.busy || pageMode;
    this.moreButton.disabled = state.busy || pageMode;
    if (!state.busy && !pageMode) {
      this.undoButton.disabled = !state.canUndo;
      this.redoButton.disabled = !state.canRedo;
    }
    this.clearButton.disabled = state.busy || state.count === 0;
    for (const item of [this.downloadButton, this.jsonButton, this.importButton, this.previewButton, this.reportFallbackButton,
      this.moreMenu.menu.querySelector('[data-redline-twin="report"]')]) item.disabled = state.busy;
    this._syncMenuState(state);
    if (pageMode || state.busy) this.closeMenus();

    this._syncContext(state);
  }

  _syncMenuState(state) {
    const cursor = state.cursor ?? {};
    this.cursorToggle.setAttribute('aria-checked', String(Boolean(cursor.included)));
    this.cursorToggle.querySelector('small').textContent = cursor.included
      ? 'On — the pointer is drawn in exports'
      : 'Off — adds a pointer to exports';
    this.cursorToggle.disabled = state.busy;
    this.cursorPlaceButton.disabled = state.busy;
    const recovery = state.recovery ?? {};
    this.restoreDraftButton.hidden = !recovery.pending;
    this.restoreDraftButton.disabled = state.busy;
    if (recovery.pending) this.restoreDraftButton.querySelector('small').textContent = `${recovery.pending.contents} Saved ${recovery.pending.savedTime}.`;
    this.discardDraftButton.hidden = !recovery.available || recovery.paused || (!recovery.pending && !recovery.stored);
    this.discardDraftButton.disabled = state.busy;
    this.discardDraftButton.querySelector('span').textContent = recovery.pending ? 'Discard waiting draft…' : 'Discard draft…';
    this.discardDraftButton.querySelector('small').textContent = recovery.pending
      ? 'delete the marks saved before reload'
      : 'delete the reload-recovery copy and pause saving';
    this.resumeRecoveryButton.hidden = !recovery.paused;
    this.resumeRecoveryButton.disabled = state.busy;
  }

  _syncToolElement(element, tool) {
    const selected = element.dataset.redlineTool === tool;
    element.toggleAttribute('data-active', selected);
    if (element.getAttribute('role') === 'menuitemradio') element.setAttribute('aria-checked', String(selected));
    else element.setAttribute('aria-pressed', String(selected));
  }

  _syncContext(state) {
    const { subject } = state;
    const hidden = state.pageMode || state.tool === 'crop';
    this.context.hidden = hidden;
    if (hidden) return;
    const show = new Set();
    const type = subject.type;
    const style = subject.style ?? {};
    const [singular, plural] = TYPE_NAMES[type] ?? ['mark', 'marks'];
    if (subject.kind === 'selection') {
      this.targetLabel.textContent = type === 'bullet' ? `Selected bullet ${style.label}` : `Selected ${singular}`;
      this.context.setAttribute('aria-label', `Style of the selected ${singular}`);
      this.context.dataset.target = 'selection';
      show.add('selection');
    } else if (subject.kind === 'legend') {
      this.targetLabel.textContent = 'Legend';
      this.context.setAttribute('aria-label', 'Legend layout');
      this.context.dataset.target = 'selection';
    } else if (subject.kind === 'cursor') {
      this.targetLabel.textContent = subject.placing ? 'Placing pointer' : 'Pointer';
      this.context.setAttribute('aria-label', subject.placing ? 'Placing the pointer for exports' : 'Pointer in exports');
      this.context.dataset.target = 'selection';
    } else if (subject.kind === 'explanation') {
      this.targetLabel.textContent = `Bullet ${subject.label} explanation`;
      this.context.setAttribute('aria-label', `Editing the explanation for bullet ${subject.label}`);
      this.context.dataset.target = 'selection';
    } else if (subject.kind === 'defaults') {
      this.targetLabel.textContent = `New ${plural}`;
      this.context.setAttribute('aria-label', `Style for new ${plural}`);
      this.context.dataset.target = 'defaults';
    } else {
      this.targetLabel.textContent = TOOL_INFO[state.tool]?.label ?? '';
      this.context.setAttribute('aria-label', `${TOOL_INFO[state.tool]?.label ?? 'Redline'} options`);
      this.context.dataset.target = 'none';
    }
    this.hint.textContent = subject.hint ?? '';
    this.hint.hidden = !subject.hint;

    if (subject.kind === 'cursor') {
      show.add('cursor');
      this.cursorFollowButton.setAttribute('aria-pressed', String(Boolean(subject.follow)));
      this.cursorFollowButton.toggleAttribute('data-active', Boolean(subject.follow));
      this.cursorFollowButton.querySelector('[data-redline-label]').textContent = subject.follow ? 'Following' : 'Follow';
      this.cursorFollowButton.title = subject.follow
        ? 'Following: the pointer moves to where you next click or pause over the page. Press to freeze it.'
        : 'Frozen: the pointer stays put. Press to follow where you next click or pause over the page.';
      this.cursorPlaceContext.setAttribute('aria-pressed', String(Boolean(subject.placing)));
      this.cursorPlaceContext.toggleAttribute('data-active', Boolean(subject.placing));
    } else if (subject.kind === 'legend' || subject.kind === 'explanation') {
      show.add('legendToggle');
      if (subject.legend?.visible) show.add('legendStyle');
      if (subject.kind === 'explanation') show.add('explanationActions');
    } else if (subject.kind !== 'none') {
      const closed = CLOSED_TYPES.has(type);
      const treatment = closed ? treatmentOf(style) : 'outline';
      if (closed) {
        show.add('treatment').add('stroke').add('fill').add('fillOpacity').add('width');
        this.treatmentButtons.forEach(element => {
          const pressed = element.dataset.treatment === treatment;
          element.setAttribute('aria-pressed', String(pressed));
          element.toggleAttribute('data-active', pressed);
        });
      } else if (type === 'brush') {
        show.add('stroke').add('brushWidth').add('brushOpacity');
      } else if (type === 'textbox') {
        show.add('stroke').add('fontSize').add('background');
      } else if (type === 'note') {
        show.add('stroke');
        if (subject.kind === 'defaults') show.add('noteMarker');
      } else if (type === 'bullet') {
        show.add('stroke').add('legendToggle');
        if (subject.kind === 'defaults') {
          show.add('bulletScheme').add('bulletNext');
          if (subject.limit) show.add('bulletLimit');
        } else {
          show.add('explain');
        }
      } else {
        show.add('stroke').add('width');
        if (LINE_TYPES.has(type)) show.add('ends');
      }

      this._paintColorButton(this.strokeColor, style.color, 1, closed ? 'Outline' : type === 'textbox' ? 'Border' : 'Color');
      this.strokeColor.element.disabled = this.strokeColor.element.disabled || treatment === 'fill';
      const fill = redlineMarkFill(style);
      this._paintColorButton(this.fillColor, fill?.color ?? style.fill ?? style.color, fill?.opacity ?? 1, 'Fill');
      this.fillColor.element.disabled = this.fillColor.element.disabled || treatment === 'outline';
      const describe = subject.kind === 'selection' ? `the selected ${singular}` : `new ${plural}`;
      const strokeRole = this.strokeColor.caption.textContent === 'Color' ? 'Color' : `${this.strokeColor.caption.textContent} color`;
      this.strokeColor.element.title = `${strokeRole} for ${describe}: ${style.color}`;
      this.fillColor.element.title = `Fill color for ${describe}${fill ? `: ${fill.color}` : ''}`;
      this.strokeColor.element.setAttribute('aria-label', `${strokeRole}, ${style.color}`);
      this.fillColor.element.setAttribute('aria-label', `Fill color${fill ? `, ${fill.color}` : ''}`);

      const fillOpacity = fill?.opacity ?? 0;
      const standard = FILL_OPACITIES.includes(fillOpacity);
      this.opacityButtons.forEach(element => {
        const value = element.dataset.fillOpacity;
        const custom = value === 'custom';
        const pressed = custom ? fillOpacity > 0 && !standard : Number(value) === fillOpacity;
        element.hidden = custom && (fillOpacity === 0 || standard);
        if (custom && !element.hidden) {
          element.lastElementChild.textContent = percent(fillOpacity);
          element.querySelector('[data-redline-opacity-swatch] > span').style.opacity = String(fillOpacity);
        }
        element.setAttribute('aria-pressed', String(pressed));
        element.toggleAttribute('data-active', pressed);
        element.disabled = element.disabled || treatment === 'outline';
        element.querySelector('[data-redline-opacity-swatch] > span').style.backgroundColor = fill?.color ?? style.fill ?? style.color ?? '#000000';
      });

      if (type === 'brush') {
        setSelectValue(this.brushWidthSelect, style.width, value => `${Math.round(Math.max(value * 4, 6))} px`);
        setSelectValue(this.brushOpacitySelect, style.opacity ?? 0.35, percent);
      } else if (style.width !== undefined) {
        setSelectValue(this.widthSelect, style.width, value => `${Math.round(value * 100) / 100} px`);
      }
      this.widthSelect.disabled = this.widthSelect.disabled || treatment === 'fill';
      if (type === 'textbox') {
        setSelectValue(this.fontSizeSelect, style.fontSize ?? 16, value => `${value} px`);
        setSelectValue(this.backgroundSelect, style.backgroundOpacity ?? 1, percent);
      }
      if (LINE_TYPES.has(type)) {
        const ends = markDecorations(style);
        this.startSelect.value = ends.start;
        this.endSelect.value = ends.end;
        this.endPresetButtons.forEach(element => {
          const preset = END_PRESETS.find(item => item.key === element.dataset.endPreset);
          const pressed = preset.start === ends.start && preset.end === ends.end;
          element.setAttribute('aria-pressed', String(pressed));
          element.toggleAttribute('data-active', pressed);
        });
      }
      if (subject.noteMarker) this.noteMarkerSelect.value = subject.noteMarker;
    }
    this._syncBulletControls(subject, show);
    const pending = state.recovery?.pending;
    if (pending) {
      show.add('recovery');
      this.recoveryText.textContent = `Draft from ${pending.savedTime} (${pending.markCount} mark${pending.markCount === 1 ? '' : 's'}) is waiting`
        + ' — new marks are not saved for recovery until you choose';
    }

    for (const [name, node] of Object.entries(this.controls)) node.hidden = !show.has(name);
    this.duplicateButton.disabled = this.duplicateButton.disabled || !state.hasSelection;
    this.deleteButton.disabled = this.deleteButton.disabled || !state.hasSelection;
    this.positionContext();
  }

  _syncBulletControls(subject, show) {
    const legend = subject.legend ?? null;
    if (show.has('legendToggle')) {
      const visible = Boolean(legend?.visible);
      this.legendToggle.setAttribute('aria-pressed', String(visible));
      this.legendToggle.toggleAttribute('data-active', visible);
      this.legendToggle.title = visible
        ? 'Hide the legend; every explanation is kept (exports then show markers only)'
        : 'Show the legend of bullet explanations';
      this.legendOptions.hidden = !visible || subject.kind === 'legend' || subject.kind === 'explanation';
    }
    if (show.has('legendStyle') && legend) {
      setSelectValue(this.legendFontSizeSelect, legend.fontSize, value => `${value} px`);
      this.legendFontSelect.value = legend.fontFamily;
      setSelectValue(this.legendWidthSelect, Math.round(legend.width), value => `${value} px`);
      this.legendHeightSelect.value = legend.height === null ? 'auto' : 'fixed';
      this.legendPositionSelect.value = '';
    }
    if (show.has('bulletScheme')) {
      this.bulletSchemeSelect.value = subject.scheme;
      const { next, used, total } = subject.status;
      this.bulletNext.textContent = next ? `Next: ${next}` : `${BULLET_SCHEMES[subject.scheme].range} all used`;
      this.bulletNext.title = `${used} of ${total} ${BULLET_SCHEMES[subject.scheme].noun} labels in use`;
    }
    if (show.has('bulletLimit')) {
      const { limit } = subject;
      this.bulletLimitText.textContent = limit.message;
      this.bulletLimitSwitch.hidden = !limit.otherAvailable;
      this.bulletLimitSwitch.dataset.scheme = limit.other;
      this.bulletLimitSwitch.querySelector('[data-redline-label]').textContent = `Use ${BULLET_SCHEMES[limit.other].range}`;
    }
  }

  _paintColorButton(control, color, opacity, caption) {
    control.caption.textContent = caption;
    control.paint.style.backgroundColor = color ?? 'transparent';
    control.paint.style.opacity = String(opacity);
  }
}
