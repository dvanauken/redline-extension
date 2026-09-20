/**
 * Redline toolbar: one full-width strip containing commands and context controls.
 *
 * The command strip keeps every tool and action visible in fixed groups. It is
 * intentionally sized for a 1200px-or-wider viewport; narrower windows may
 * scroll the strip horizontally, but never hide commands in another menu.
 *
 * The contextual section in the strip always names its target: the selected mark, or the
 * defaults for marks the active tool will create. It never edits both.
 *
 * The toolbar owns no document state. It reports user intent through
 * `onCommand(name, detail)` and is brought up to date with `sync(state)`.
 */

import { appendIcon, iconElement } from './icons.js';
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

const DRAWING_TOOLS = [
  'pen', 'brush', 'line', 'arrow', 'rectangle', 'ellipse',
  'polyline', 'polygon', 'note', 'bullet', 'textbox',
];

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

    this.grip = button({ label: 'Move strip vertically', title: 'Drag to move the full-width strip vertically', icon: 'grip' });
    this.grip.dataset.redlineGrip = '';

    this.modeButton = button({
      label: 'Switch to Browse mode (F2)',
      title: 'Switch to Browse mode — click, type and scroll normally (F2)',
      icon: 'browse',
    });
    this.modeButton.dataset.redlineMode = 'browse';
    this.modeButton.dataset.redlineModeToggle = '';
    this.modeButton.addEventListener('click', () => this._emit('mode', this.modeButton.dataset.redlineMode));

    const stripGroup = (name, label) => {
      const group = document.createElement('div');
      group.dataset.redlineGroup = name;
      group.dataset.redlineStripSection = name;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      return group;
    };
    const stripTool = (tool, container) => {
      const item = button({
        label: `${TOOL_INFO[tool].label}${TOOL_INFO[tool].key ? ` (${TOOL_INFO[tool].key})` : ''}`,
        title: toolTitle(tool), icon: tool, tool,
      });
      container.appendChild(item);
      return item;
    };
    const stripAction = (action, label, icon, container, title = label) => {
      const item = button({ label, title, icon, action });
      container.appendChild(item);
      return item;
    };

    const tools = stripGroup('drawing', 'Drawing tools');
    this.selectButton = button({ label: 'Select (V)', title: toolTitle('select'), icon: 'select', tool: 'select' });
    this.eraserButton = button({ label: 'Eraser (E)', title: toolTitle('eraser'), icon: 'eraser', tool: 'eraser' });
    tools.append(this.selectButton, this.eraserButton);
    for (const tool of DRAWING_TOOLS) stripTool(tool, tools);

    const history = stripGroup('history', 'History and reset');
    this.undoButton = button({ label: 'Undo (Ctrl+Z)', title: 'Undo mark change (Ctrl+Z)', icon: 'undo', action: 'undo' });
    this.redoButton = button({ label: 'Redo (Ctrl+Y)', title: 'Redo mark change (Ctrl+Y)', icon: 'redo', action: 'redo' });
    this.clearButton = button({
      label: 'Clear all marks',
      title: 'Clear all marks… — removes every mark after confirmation; Undo restores them',
      icon: 'clear',
      action: 'clear',
    });
    history.append(this.undoButton, this.redoButton, this.clearButton);

    const capture = stripGroup('capture', 'Capture');
    this.cropButton = stripTool('crop', capture);
    this.fullPageButton = stripAction('fullPage', 'Full page', 'fullpage', capture, 'Full page — copy the entire scrollable page at native capture resolution');
    this.copyButton = stripAction('copy', 'Copy image', 'copy', capture, 'Copy image — visible area or crop');
    this.reportButton = stripAction('report', 'Copy report', 'report', capture, REPORT_TITLE);
    this.reportButton.title = REPORT_TITLE;
    this.previewButton = stripAction('preview', 'Export preview', 'preview', capture);
    this.downloadButton = stripAction('download', 'Download PNG', 'download', capture);

    const files = stripGroup('files', 'Files and fallback');
    this.reportFallbackButton = stripAction('reportFallback', 'Report text and PNG', 'report', files, 'Report text + PNG — fallback for limited paste targets');
    this.jsonButton = stripAction('json', 'Download JSON', 'json', files);
    this.importButton = stripAction('import', 'Import annotations', 'import', files);

    const pointer = stripGroup('pointer', 'Pointer');
    this.cursorToggle = stripAction('cursorToggle', 'Include cursor', 'cursor', pointer, 'Include cursor — off');
    this.cursorToggle.setAttribute('aria-pressed', 'false');
    this.cursorToggle.dataset.redlineCursorToggle = '';
    this.cursorPlaceButton = stripAction('cursorPlace', 'Place cursor', 'cursor', pointer, 'Place cursor — click, or use arrow keys and Enter');

    const recovery = stripGroup('recovery', 'Recovery');
    this.restoreDraftButton = stripAction('restoreDraft', 'Restore draft', 'restore', recovery);
    this.discardDraftButton = stripAction('discardDraft', 'Discard draft', 'clear', recovery);
    this.resumeRecoveryButton = stripAction('resumeRecovery', 'Resume reload recovery', 'restore', recovery);
    this.recoverySection = recovery;

    const frame = document.createElement('div');
    frame.dataset.redlineGroup = 'frame';
    this.pinButton = button({ label: 'Pin strip to the top', title: 'Pin strip to the top', icon: 'pin', action: 'pin' });
    this.pinButton.dataset.redlinePin = '';
    this.closeButton = button({ label: 'Close Redline (Esc)', title: 'Close Redline — marks are kept (Esc)', icon: 'close', action: 'close' });
    this.closeButton.dataset.redlineClose = '';
    frame.append(this.pinButton, this.closeButton);

    this.frameSeparator = separator();
    this.frameGroup = frame;
    bar.append(
      this.grip, this.modeButton, separator(), tools, separator(), history, separator(),
      capture, separator(), files, separator(), pointer, recovery, this.frameSeparator, frame,
    );
    bar.addEventListener('click', event => {
      const tool = event.target.closest('[data-redline-tool]')?.dataset.redlineTool;
      if (tool) return this._emit('tool', tool);
      const action = event.target.closest('[data-redline-action]')?.dataset.redlineAction;
      if (action) this._emit('action', action);
    });
    this.dock.appendChild(bar);
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

    context.addEventListener('wheel', event => {
      if (context.scrollWidth <= context.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      context.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });

    this.controls = controls;
    this.contextSeparator = separator();
    this.bar.insertBefore(this.contextSeparator, this.frameSeparator);
    this.bar.insertBefore(context, this.frameSeparator);
  }

  closeMenus(options = {}) {
    return false;
  }

  openMenu() {
    return null;
  }

  menuContaining(node) {
    return null;
  }

  setMessage(text) {
    this.message.textContent = text;
  }

  /** Control that represents a tool for focus, whether on the bar or collapsed. */
  toolFocusTarget(tool) {
    return [...this.bar.querySelectorAll(`[data-redline-tool="${tool}"]`)].find(node => !node.hidden) ?? this.selectButton;
  }

  /**
   * Collapse lower-priority bar items until the bar fits the viewport. Runs on
   * open and resize only; it is independent of the tool or selection, so the
   * essential actions never move while the user works.
   */
  layout() {
    if (window.innerWidth < 2400) this.bar.dataset.density = 'compact';
    else this.bar.removeAttribute('data-density');
  }

  /** Context controls share the strip, so normal flex layout positions them. */
  positionContext() {
    // Context controls now live in the same strip; flex layout positions them.
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

    const nextMode = pageMode ? 'annotate' : 'browse';
    const nextLabel = pageMode ? 'Annotate' : 'Browse';
    const nextHint = pageMode ? 'draw over the page' : 'click, type and scroll normally';
    this.modeButton.dataset.redlineMode = nextMode;
    this.modeButton.setAttribute('aria-pressed', String(pageMode));
    this.modeButton.toggleAttribute('data-active', pageMode);
    this.modeButton.title = `Switch to ${nextLabel} mode — ${nextHint} (F2)`;
    this.modeButton.setAttribute('aria-label', `Switch to ${nextLabel} mode (F2)`);
    const modeIcon = this.modeButton.querySelector('svg');
    if (modeIcon?.dataset.icon !== nextMode) {
      const replacement = iconElement(nextMode);
      replacement.dataset.icon = nextMode;
      modeIcon.replaceWith(replacement);
    }
    this.dock.toggleAttribute('data-browse', pageMode);
    this.bar.setAttribute('aria-label', pageMode ? 'Redline tools — Browse mode, F2 resumes annotating' : 'Redline tools — Annotate mode');

    this.pinButton.toggleAttribute('data-active', state.pinned);
    this.pinButton.setAttribute('aria-pressed', String(state.pinned));
    this.pinButton.title = state.pinned ? 'Unpin strip from the top' : 'Pin strip to the top';
    this.pinButton.setAttribute('aria-label', this.pinButton.title);
    this.dock.toggleAttribute('data-pinned', state.pinned);

    const always = new Set([this.grip, this.modeButton, this.pinButton, this.closeButton]);
    for (const control of this.dock.querySelectorAll('button, select, input')) {
      control.disabled = state.busy || (pageMode && !always.has(control));
    }
    if (!state.busy && !pageMode) {
      this.undoButton.disabled = !state.canUndo;
      this.redoButton.disabled = !state.canRedo;
    }
    this.clearButton.disabled = state.busy || state.count === 0;
    this._syncMenuState(state);
    if (pageMode || state.busy) this.closeMenus({ force: true });

    this._syncContext(state);
  }

  _syncMenuState(state) {
    const cursor = state.cursor ?? {};
    this.cursorToggle.setAttribute('aria-pressed', String(Boolean(cursor.included)));
    this.cursorToggle.toggleAttribute('data-active', Boolean(cursor.included));
    this.cursorToggle.title = cursor.included
      ? 'Include cursor — on; the pointer is drawn in exports'
      : 'Include cursor — off; adds a pointer to exports';
    this.cursorToggle.setAttribute('aria-label', this.cursorToggle.title);
    this.cursorToggle.disabled = state.busy;
    this.cursorPlaceButton.disabled = state.busy;
    const recovery = state.recovery ?? {};
    this.restoreDraftButton.hidden = !recovery.pending;
    this.restoreDraftButton.disabled = state.busy;
    if (recovery.pending) {
      this.restoreDraftButton.title = `Restore draft — ${recovery.pending.contents} Saved ${recovery.pending.savedTime}.`;
      this.restoreDraftButton.setAttribute('aria-label', this.restoreDraftButton.title);
    }
    this.discardDraftButton.hidden = !recovery.available || recovery.paused || (!recovery.pending && !recovery.stored);
    this.discardDraftButton.disabled = state.busy;
    this.discardDraftButton.title = recovery.pending
      ? 'Discard waiting draft — delete the marks saved before reload'
      : 'Discard draft — delete the reload-recovery copy and pause saving';
    this.discardDraftButton.setAttribute('aria-label', this.discardDraftButton.title);
    this.resumeRecoveryButton.hidden = !recovery.paused;
    this.resumeRecoveryButton.disabled = state.busy;
    this.recoverySection.hidden = ![this.restoreDraftButton, this.discardDraftButton, this.resumeRecoveryButton]
      .some(item => !item.hidden);
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
    this.contextSeparator.hidden = hidden;
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
        if (type === 'rectangle' && style.text) show.add('fontSize');
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
      if (type === 'textbox' || (type === 'rectangle' && style.text)) {
        setSelectValue(this.fontSizeSelect, style.fontSize ?? 16, value => `${value} px`);
      }
      if (type === 'textbox') {
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
