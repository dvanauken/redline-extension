/**
 * Keyboard routing for an open RedlineOverlay (Annotate mode).
 *
 * KEY_RULES is tried in order and the first rule that decides wins, so the
 * order is the behavior: an open menu or editor sees a key before a shortcut
 * does, Escape unwinds the innermost unfinished thing first, and single-letter
 * tool keys come last. A rule returns HANDLED (the key is consumed), PASS (stop
 * here and leave the key to its target or the browser) or nothing (keep
 * looking). F2, which also works in Browse mode, is handled by the overlay.
 */

import { DIRECT_SELECTION_TYPES } from './RedlineTransform.js';
import { TEXT_CONTAINER_TYPES } from './RedlineShapeText.js';

const HANDLED = 'handled';
const PASS = 'pass';

export const TOOL_KEYS = {
  v: 'select', p: 'pen', b: 'brush', e: 'eraser', l: 'line', a: 'arrow', r: 'rectangle', o: 'ellipse',
  n: 'note', u: 'bullet', t: 'textbox', c: 'crop',
};
const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** No modifier that turns a letter into a shortcut of some other kind. */
const plain = ({ ctrl, event }) => !ctrl && !event.altKey && !event.shiftKey;
const onControl = (target, selector = 'button, select, input, textarea, summary') => target?.matches?.(selector);

const KEY_RULES = [
  ['inactive', ({ overlay }) => (!overlay.active || overlay.pageMode || overlay._dialogDepth > 0 ? PASS : undefined)],
  // Swallow everything while an export or discard is running.
  ['busy', ({ overlay }) => (overlay._busy ? HANDLED : undefined)],
  ['text editors', ({ overlay, target }) => (
    target === overlay.textEditor.element || overlay.legendEditor.owns(target) ? PASS : undefined)],
  ['open menu', ({ overlay, event, target }) => {
    const menu = overlay.toolbarUI.menuContaining(target);
    if (!menu) return undefined;
    if (event.key !== 'Tab') return PASS;
    // Tab leaves the menu; the Tab rule below then moves focus on from its trigger.
    menu.close({ focusTrigger: false });
    menu.trigger.focus({ preventScroll: true });
    return undefined;
  }],
  ['shift constrains a gesture', ({ overlay, event }) => {
    if (event.key !== 'Shift') return undefined;
    overlay.gestures.modifiersChanged(true);
    return PASS;
  }],
  ['crop editing', ({ overlay, event, target }) => (overlay.cropView.handleKey(event, target) ? HANDLED : undefined)],
  ['escape', ({ overlay, event }) => {
    if (event.key !== 'Escape') return undefined;
    if (overlay.toolbarUI.closeMenus()) return HANDLED;
    if (overlay.gestures.cancel()) {
      overlay._setMessage('Unfinished mark cancelled');
      return HANDLED;
    }
    // An explanation edit whose focus moved to one of its own controls.
    if (overlay.legendEditor.cancel()) return HANDLED;
    if (overlay.cursorPlacing) {
      overlay.endCursorPlacement({ restoreFocus: true });
      return HANDLED;
    }
    if (overlay.cursorSelected) {
      overlay.cursorSelected = false;
      overlay._render({ force: true });
      return HANDLED;
    }
    // Otherwise let the native modal dialog dispatch its cancel event.
    return PASS;
  }],
  ['enter ends pointer placement', ({ overlay, event, target }) => {
    if (event.key !== 'Enter' || !overlay.cursorPlacing || onControl(target)) return undefined;
    overlay.endCursorPlacement({ restoreFocus: true });
    return HANDLED;
  }],
  ['enter finishes a path', ({ overlay, event, target }) => {
    if (event.key !== 'Enter' || !overlay.gestures.hasPathDraft || onControl(target, 'button, select, input, textarea')) return undefined;
    overlay.gestures.finishPath();
    return HANDLED;
  }],
  // Chromium may move reverse-Tab from the first control into browser chrome
  // even for a modal dialog. Keep the toolbar's keyboard loop deterministic.
  ['tab cycles the toolbar', ({ overlay, event }) => {
    if (event.key !== 'Tab') return undefined;
    const focusable = [...overlay.root.querySelectorAll('button, input, select, summary, textarea, [tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
        && !element.closest('[hidden], [inert]')
        && element.checkVisibility({ visibilityProperty: true }));
    if (!focusable.length) return PASS;
    // [extension patch] shadow-aware: document.activeElement is the host, not the button.
    const index = focusable.indexOf(overlay.root.getRootNode().activeElement);
    const next = event.shiftKey
      ? (index <= 0 ? focusable.at(-1) : focusable[index - 1])
      : (index < 0 || index === focusable.length - 1 ? focusable[0] : focusable[index + 1]);
    next.focus();
    return HANDLED;
  }],
  ['undo and redo', ({ overlay, event, ctrl, key }) => {
    if (!ctrl) return undefined;
    if (key === 'z' && event.shiftKey) return (overlay.redo(), HANDLED);
    if (key === 'z') return (overlay.undo(), HANDLED);
    if (key === 'y') return (overlay.redo(), HANDLED);
    return undefined;
  }],
  ['ctrl+d duplicates', ({ overlay, ctrl, key, editable }) => {
    if (!ctrl || key !== 'd' || editable || overlay.tool !== 'select' || !overlay.selectedId) return undefined;
    overlay.duplicateSelected();
    return HANDLED;
  }],
  // Everything below is a single-key shortcut, which a form field keeps for itself.
  ['form fields', ({ editable }) => (editable ? PASS : undefined)],
  // V is the selection-mode toggle while a point path is selected. Once a
  // text edit is active the native editor owns V like any other character.
  ['v toggles direct selection', context => {
    const { overlay, key, selectedMark } = context;
    if (!plain(context) || key !== 'v' || !DIRECT_SELECTION_TYPES.has(selectedMark?.type)) return undefined;
    overlay.setSelectionMode(overlay.selectionMode === 'direct' ? 'object' : 'direct');
    return HANDLED;
  }],
  ['enter explains a bullet', ({ overlay, event, ctrl, target, selectedMark }) => {
    if (event.key !== 'Enter' || ctrl || selectedMark?.type !== 'bullet' || onControl(target)) return undefined;
    overlay.editExplanation(selectedMark.id);
    return HANDLED;
  }],
  ['enter edits text', ({ overlay, event, ctrl, target, selectedMark }) => {
    if (event.key !== 'Enter' || ctrl || !TEXT_CONTAINER_TYPES.has(selectedMark?.type) || target !== overlay.svg) return undefined;
    overlay._startDirectTextEdit(selectedMark);
    return HANDLED;
  }],
  ['typing starts a text edit', ({ overlay, event, ctrl, target, selectedMark }) => {
    if (ctrl || event.altKey || event.metaKey || event.isComposing || event.key?.length !== 1
      || !TEXT_CONTAINER_TYPES.has(selectedMark?.type) || target !== overlay.svg) return undefined;
    overlay._startDirectTextEdit(selectedMark, { initialText: event.key });
    return HANDLED;
  }],
  ['delete', ({ overlay, event, ctrl }) => {
    if (ctrl || (event.key !== 'Delete' && event.key !== 'Backspace')) return undefined;
    if (overlay.gestures.hasPathDraft) overlay.gestures.removeLastPathPoint();
    else if (overlay.selectionMode === 'direct' && overlay.selectedVertex !== null) overlay.removeSelectedVertex();
    else if (overlay.cursorSelected && overlay.document?.cursor?.visible) overlay.setCursorIncluded(false);
    else overlay.removeSelected();
    return HANDLED;
  }],
  ['arrows nudge the pointer', ({ overlay, event, ctrl, direction, inControls }) => {
    const movable = (overlay.cursorSelected || overlay.cursorPlacing) && overlay.document?.cursor?.visible;
    if (!direction || ctrl || event.altKey || !movable || inControls) return undefined;
    const step = event.shiftKey ? 10 : 1;
    overlay.nudgeCursor(direction[0] * step, direction[1] * step);
    return HANDLED;
  }],
  ['arrows nudge the selection', ({ overlay, event, ctrl, direction, inControls }) => {
    const legendMovable = overlay.legendSelected && overlay.document?.legend?.visible && !overlay.selectedId;
    const markMovable = overlay.tool === 'select' && overlay.selectedId;
    if (!direction || ctrl || event.altKey || !(markMovable || legendMovable) || inControls) return undefined;
    const step = event.shiftKey ? 10 : 1;
    overlay.nudgeSelected(direction[0] * step, direction[1] * step);
    return HANDLED;
  }],
  ['v selects', context => {
    const { overlay, key } = context;
    if (!plain(context) || key !== 'v') return undefined;
    overlay.setTool('select');
    overlay.selectionMode = 'object';
    overlay.selectedVertex = null;
    return HANDLED;
  }],
  ['tool letters', context => {
    const { overlay, key, target } = context;
    if (!plain(context) || !TOOL_KEYS[key]) return undefined;
    const focusedTool = target?.closest?.('[data-redline-tool]');
    overlay.setTool(TOOL_KEYS[key]);
    // Keep the focus ring on the tool that is now active, not the previous one.
    if (focusedTool) overlay.toolbarUI.toolFocusTarget(overlay.tool)?.focus({ preventScroll: true });
    return HANDLED;
  }],
];

/** Route one keydown through KEY_RULES. */
export function handleOverlayKeyDown(overlay, event) {
  // [extension patch] Listen inside the root and inspect the original target,
  // including when that root is closed to the surrounding page.
  const target = event.composedPath?.()[0] ?? event.target;
  const ctrl = event.ctrlKey || event.metaKey;
  const context = {
    overlay, event, target, ctrl,
    key: String(event.key ?? '').toLowerCase(),
    editable: Boolean(target?.matches?.('input, textarea, select, [contenteditable="true"]')),
    direction: NUDGE_KEYS[event.key],
    inControls: target?.closest?.('[data-redline-context], [data-redline-crop-panel], [data-redline-text-controls]'),
    get selectedMark() {
      return overlay.tool === 'select' && overlay.selectedId ? overlay.document?.find(overlay.selectedId) : null;
    },
  };
  for (const [, rule] of KEY_RULES) {
    const outcome = rule(context);
    if (outcome === HANDLED) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (outcome) return;
  }
}
