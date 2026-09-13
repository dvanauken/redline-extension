# Redline: three prompts for Claude

Prepared from the complete conversation on 2026-09-13. This is an implementation brief, not a record of completed feature work. Proposed defaults below resolve details the user has not specified.

Use exactly three implementation prompts, sequentially. Prompt 1 includes the blanket introduction. Prompts 2 and 3 reread it from this file. The team lead reviews each handoff, corrects defects directly, and reruns meaningful checks before sending the next prompt. Corrections do not require a fourth implementation prompt to Claude.

## Prompt 1 — Shared introduction, light workspace, and consistent drawing

You are Claude, implementing Redline in `C:\dbva\code\redline-extension`. The coordinating agent is team lead. Implement this phase, validate it, and return a concrete handoff for independent review. Do not begin the next phase yourself.

### Blanket introduction: applies to all three phases

Redline is a framework-free Chrome Manifest V3 extension for annotating pages and handing PNG and editable JSON to an LLM. Preserve its small runtime, closed shadow root, isolated content-script world, host adapters, and DOM-independent document model. Follow applicable repository instructions discovered when execution starts.

The user's full direction: light approachable toolbar; better hierarchy and contextual controls; independent outlines and graduated shading; rectangles/circles/ovals and polylines/polygons; independent line endpoints; single-character numbered/lettered bullets with an optional editable legend; optional cursor inclusion; and the earlier productivity, recovery, and report improvements. Nothing from the earlier review is to be silently dropped.

Repository facts:

- `main.js` owns the shadow host, extension storage, metadata, capture adapter, and dialogs. `service-worker.js` injects and captures; `content.js` bootstraps.
- `redline/RedlineDocument.js` owns validation/import/history. `RedlineOverlay.js` currently combines toolbar, interaction, editing, SVG, and capture in about 1,900 lines. `RedlineCanvas.js` renders exports; `RedlineCrop.js` and `RedlineCropView.js` handle cropping.
- `color-picker.js` supplies the extension's plain-element picker; preserve this host seam. Do not assume a custom-element registry exists in the content script. Do not introduce an app framework.
- Existing tools: Select, Pen, Highlighter, Line, Arrow, Rectangle, Note, Text Box, Crop, plus Polyline, Polygon, and Eraser in Paths. Extend these rather than implementing competing versions.
- Existing notes have adjacent labels and modal editing. Existing separate numeric/alpha sequences do not yet constitute the requested bullet-and-legend feature.
- Per-annotation `fillOpacity`, optional distinct `fill`, and `outline` already exist. Gallery values are currently 0%, 25%, 50%, and 100%. Investigate the reported UI behavior; existing fields do not prove each opacity applies and restores correctly.
- Current glyph helpers accept 10/AA. Preserve old documents containing those notes. New bullet placement is 1–9/A–Z as described in Phase 2.
- User changes were already present in README, color-picker, overlay, document, canvas, and tests, including untracked `test/style.test.mjs`. Inspect current status/diff and preserve them. Do not reset/stash away/overwrite unrelated work.

Four reproduced review bugs must be fixed:

- Export privacy: `downloadBlob()` appends a blob link to `document.body`. An ordinary page-world MutationObserver observed and fetched the downloaded JSON and PNG. Keep export URLs/bytes out of page DOM and composed event payloads; test that downloads still work. Shadow DOM does not protect a link appended outside it.
- Text mismatch: SVG estimates wrapping by character count while Canvas measures text with another font. A 100×48 textbox with `WWW WWW` displayed both words but exported only `WWW`. Unify font, metrics, wrapping, baselines, and clipping. Cover realistic multiline text and long words.
- Palette keyboard: inactive tabs have `tabIndex=-1` but no arrow-key navigation, leaving Standard/Custom unreachable by keyboard. Implement coherent navigation, focus, and activation.
- Gesture cleanup: place two polyline points, switch to Select, move the pointer; the unfinished path still follows it. Define finish/cancel behavior for all tool transitions and interruptions, not just Crop.

Preserve established behavior:

- Toolbar/keyboard invocation; one overlay; same-page close/reopen retention; Pin and drag; Browse mode releases input/scroll; F2 resumes annotations.
- Annotation undo/redo independent of page editing; editable text and legacy notes; crop creation/move/eight handles/keyboard controls; 50%/100%/200% output; native screenshot DPR including DPR 2; consistent geometry after nonuniform viewport resize.
- PNG download, clipboard fallback, editable JSON, atomic rejection of malformed imports/duplicate IDs without losing existing state/history.
- URL query/fragment redaction. No website storage for preferences or drafts. No broad host permissions in the shipped manifest, remote annotation service, or exported secrets introduced by new features.
- No production test hooks/open shadow root. The page still controls its surrounding document: encapsulation is not a complete trust boundary.
- Crop/output settings remain separate from annotation history. Validate/detach new fields and import atomically. Old open-redline v1 remains readable. If a schema version change is needed, keep the legacy reader and document migration; do not silently discard unsupported types/fields.
- Screen-space semantics remain: scrolling/layout changes can move underlying page content. Recovery does not make annotations DOM-anchored.

Architecture, validation, and working agreement:

- Extract cohesive toolbar, gesture, text layout/editor, and export responsibilities where needed. Share preview/export geometry and text layout. Avoid both a growing monolith and a wholesale rewrite.
- Keep expensive cloning/rendering away from every caret blink/keystroke; keep larger documents usable and history/recovery storage bounded.
- Use meaningful tests and real UI interaction. Do not weaken coverage to pass. Update palette/layout assertions only for intentional changes while retaining behavior checks.
- Prior baseline: 38 model/style tests, 123 real-browser checks, and mocked watcher checks passed. Reestablish the current baseline; old counts are not proof of new correctness.
- Existing commands: `node --test test/document.test.mjs test/crop.test.mjs test/style.test.mjs`; `node test/run.mjs`; `pwsh -NoProfile -File test/watch-reload.ps1`. Add relevant tests and a discoverable aggregate command. Record development dependencies/browser setup reproducibly; the reviewed repo had no package manifest or lockfile.
- Browser tests use a temporary extension copy and isolated temporary Chromium profile. Its broad host permission simulates user activation; keep it out of the real manifest. Do not manipulate the user's ordinary browser.
- Visually inspect 1920, 1200, 800, and 420 CSS-pixel widths, including menus, palette, selected objects, Browse mode, pin/drag. The old bar was about 1,732px at 1920 and hid Undo/Copy/PNG/Close behind scrolling at 1200.
- Report true OS clipboard, IME, and extension-shortcut checks honestly. A mocked fallback test is not a successful real clipboard/IME test.
- No committing/pushing/publishing/deploying. Use normal permissions; report actual blockers. The lead reviews and fixes each phase directly before the next Claude prompt.

### Implement Phase 1

- Apply a warm paper theme to toolbar, popovers, palette, dialogs, and editor controls. Starting tokens: chrome `#F7F5F0`, white controls, text `#292D32`, dividers `#D9D5CC`, restrained red `#B65D66`. Verify readable contrast. Interface colors must not silently restyle imported annotations.
- Reduce individual borders, add comfortable targets and group spacing/separators, use consistent icons, visible focus and selected state. Replace the full green border with a small explicit mode indicator.
- Compact the main bar. Keep Undo, Redo, Copy image, and Close visible; use reachable overflow for lower-frequency actions/tools, including PNG/JSON/import/Clear. Preserve Pin/drag. Menus must not expand the bar sideways or be clipped by overflow.
- Put active-tool/selected-object settings in a secondary row or anchored panel. Pen: color/thickness; Highlighter: width/opacity; closed shapes: outline/fill; Line: endpoints; Notes: scheme; Text: font size/background. Keep essential action positions stable as context changes.
- Use Annotate/Browse with F2 and explicit state. Labels: Thickness, Note labels, Import annotations, More tools. Keep Eraser discoverable. Preserve helpful shortcut tooltips and accessible names.
- Fix and regression-test all four reproduced review bugs before adding new export features.
- Separate styling a selected object from setting future drawing defaults. Controls must identify their target. Select-mode appearance edits affect only the selected mark; drawing presets affect upcoming marks. Do not modify the last-created mark merely because it remained selected. Restore each object's exact style through selection, undo/redo, reopen, and JSON.
- Three explicit treatments for closed shapes: Outline, Outline + fill, Fill only. Graduated fill opacity: 10%, 25%, 50%, 75%, 100%; Outline represents zero fill. Show actual transparency on a neutral/checkered ground, support independent outline/fill colors, prevent invisible no-outline/zero-fill states. Changing color preserves treatment and has explicit stroke/fill targeting.
- Keep named Issue, Question, Approved, Note and existing intents as larger identifiable presets. Put full tints/shades under More colors. Distinguish lighter colors from transparent fills; ensure all palette choices work in the light theme and by keyboard.
- Rectangle plus Ellipse, with Shift for square/circle. Make existing Polyline/Polygon discoverable. Open polylines have no fill; closed polygons support all treatments. Require at least three useful distinct points for newly drawn polygons while keeping supported old files loadable.
- Enter/double-click finishes paths without duplicate trailing vertices. Escape cancels unfinished geometry before closing the overlay. Switching tools cancels unfinished geometry and retains completed marks.
- Generalize Line/Arrow to independent Start/End choices: None, Arrowhead, Open circle, Filled circle. Include none/none, single arrow in either direction, both arrows, and filled-circle-to-arrow. Show pictorial presets and individual end controls. Arrow tool remains a convenient one-ended preset.
- Decorations apply to lines/open polylines using first/last nonzero segment direction; closed polygons have none. Include decoration geometry in bounds, selection, and export. Handle repeated points/zero lengths without NaN/crashes.
- Add Shift angle constraints for line/arrow/path segments, duplicate selected annotation, and arrow-key nudge with a larger Shift step. Respect text editing/browser shortcuts/crop keys. Keep gesture/history units sensible.
- Improve eraser geometry as needed: clicking empty space inside a large outline's bounding box should not erase a distant outline unexpectedly.

### End-of-prompt handoff and lead acceptance gate

Claude: stop after Phase 1. Supply changed files, actual test results, screenshot paths at all widths, schema/design decisions, and real limitations. Show independent shapes at different opacities and all end decorations in preview and PNG.

Team lead: independently inspect diff/UI and run relevant tests. Reproduce all four bugs, verify the fixes, and exercise light-theme contrast, narrow layouts, treatments/endpoints, keyboard, history, and round-trips. Correct defects directly and retest until requirements pass. Do not send Prompt 2 while material Phase 1 defects remain. Record actual acceptance evidence in this file.

## Prompt 2 — Single-character bullets and canvas-rendered legend editing

Reread the blanket introduction and the lead's Phase 1 acceptance evidence. Inspect the current working tree. Implement this phase on the accepted code, reusing its layout, styling, rendering, and validation.

### Implement Phase 2

- Add a Bullet tool that places a circle and glyph only, without a required dialog/text entry. Preserve the existing Note tool and legacy adjacent-label notes.
- New labels are 1–9 or A–Z. Number/letter sequences are independent and may coexist. Changing the default scheme affects future bullets only. Link explanation entries by stable internal bullet IDs, never array positions or labels.
- Allocate an available unused label without silently renumbering existing bullets. At range exhaustion, explain the limit and offer switching schemes when available; never invent 10/AA, duplicate labels, or automatically switch. Legacy imported notes with 10/AA remain intact. Validate duplicate new-bullet labels as well as document IDs.
- Each bullet owns optional multiline explanation text. Legend enabled: placement immediately creates/focuses its row for typing; committing returns to Bullet placement so click/explain/click/explain is smooth. Legend hidden: place the marker without forced editing.
- A movable/resizable optional Legend displays glyphs and explanations on the annotation surface. Hide/show must retain text/markers. Store visibility, geometry, text style, and entries in the editable document.
- The visible legend and editor must be rendered on the drawing surface using Canvas for text/caret/selection. A visually hidden textarea inside the closed shadow root may handle keyboard, IME, clipboard, and accessibility. A visible HTML textarea/contenteditable card/modal/sidebar is not a substitute. Toolbar and popup controls may remain HTML.
- Click a legend row or double-click its bullet to edit later. With the legend hidden, explicit Edit explanation/Show legend makes editing reachable without forcing a legend into a markers-only export. Selection links the row and bullet when shown.
- Support caret placement/selection, multiline text, Enter, deletion, arrow/Home/End navigation, copy/cut/paste, and composition-safe input. Ctrl/Cmd+Enter commits; Escape cancels the current text edit before dismissing the overlay. Typing/selection/composition must never activate drawing shortcuts. Restore meaningful focus.
- Use exactly the shared font, metrics, wrapping, and line layout for live legend and PNG. Exclude caret, selection highlight, edit handles, and placeholders from exports. No external font fetch.
- Grow/resize the legend for long explanations; allow font-size/width/height adjustment and clearly indicate overflow. Never silently lose text. JSON/text reports retain full explanations. Preview must make clipping outside the crop/viewport explicit rather than silently moving the legend or enlarging capture.
- Legend/bullet edits participate in annotation history. Deletion removes its entry in one undoable operation; undo restores identical ID/glyph/text. Moving a bullet never renumbers/reorders rows. Duplicate gets a new ID/unused label, preserves explanation text, and respects exhaustion.
- Scale marker circles, glyphs, editor hit-testing, and legend through viewport/DPR/crop/output transforms. Keep narrow layouts usable and the legend movable away from page content. Browse mode hides annotations and releases page input as before.
- Validate/serialize every new field atomically. Preserve legacy notes and JSON. Invalid imports must not damage previous document/history, including when rendering preparation fails.

### End-of-prompt handoff and lead acceptance gate

Claude: stop after Phase 2. Supply changed files, schema decisions, tests/screenshots, and precise manual-input limitations. Demonstrate immediate typing, later editing, hide/show, delete/undo, duplicate, both schemes, and exhaustion.

Team lead: independently use real pointer/keyboard actions. Verify visible editing is canvas-rendered and hidden input stays isolated. Check caret/selection/multiline/focus, save/cancel, range limits, stable links, legacy import, JSON, DPR 1/2, and resized/cropped PNG. Correct defects directly and retest until satisfactory. Do not send Prompt 3 with a broken editor/legend. Record manual IME/clipboard gaps honestly.

## Prompt 3 — Cursor, recovery, report export, and final integration

Reread the shared introduction and lead acceptance evidence for Phases 1 and 2. Complete the remaining features on the accepted code and validate the full workflow.

### Implement Phase 3

- Add optional Include cursor with a visible movable cursor proxy. The documented captureVisibleTab image options are format/quality, with no cursor toggle. Use a rendered pointer for deterministic placement; do not add screen-sharing prompts/broad permissions merely for OS cursor capture. References: https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab and https://developer.chrome.com/docs/extensions/reference/api/extensionTypes#type-ImageDetails.
- Default proxy: clear arrow with contrasting edge and accurate tip/hotspot. Initialize from the last meaningful page/drawing position, excluding toolbar/palette/text-editing interactions. Allow explicit placement, dragging, freezing, and nudging. Moving the real mouse to Copy must not move the proxy there. If no useful position exists, have the user place it in the UI.
- Cursor inclusion is off by default; preview matches export. Persist position/visibility, transform crop/resize/scaling correctly, and exclude when disabled. Avoid a duplicate if a future adapter supplies cursor pixels. Cursor is independent of bullet labels/legend.
- Recover previous session after accidental reload. Store document/legend/cursor/crop/output state through host adapters in extension-owned session storage, with bounded/debounced writes and validation. Preferences remain separate. Promise same-browser-session reload recovery, not browser-restart recovery unless separately implemented/tested.
- Scope drafts by tab/page identity; unrelated tabs/pages must not overwrite/restore each other. Do not persist raw query/fragment strings just to key drafts; use opaque identity if needed. Do not store screenshots. Bound saved drafts, expose Discard draft, and handle quota/write failures while preserving in-memory work.
- On reload offer Restore/Discard for a matching draft and indicate original viewport context. Screen-space alignment may need adjustment. Empty/new sessions and explicit clearing/discarding must not resurrect stale marks. Handle pending/late saves and stale async restore/import responses. Preserve close/reopen behavior.
- Add Copy report alongside Copy image: annotated screenshot plus readable bullet explanations/legacy notes as appropriate, title, and already-redacted URL. Keep stable numeric/lettered labels and full text; escape HTML. Report text can include explanations while the on-image legend is hidden; make that behavior clear.
- Probe actual clipboard format support and respect focus/gesture requirements. If combined image/text pasting is unreliable, explicitly copy report text and download PNG as a useful fallback. Keep editable JSON. Do not report clipboard success when only download/fallback worked.
- Add export preview showing crop/output dimensions, legend, and optional cursor as exported. Exclude all editor controls and restore visibility/focus on success/failure. Preserve manual toolbar placement/pinning; avoid surprise automatic toolbar movement under the pointer.
- Harden capture for tab switches: captureVisibleTab(windowId) captures that window's active tab, not necessarily the sender. Check intended tab and reject results if activation/navigation changes during capture. Never combine page A's annotations with page B's screenshot. Add a real multi-tab regression. This was a review concern, not one of the original four reproduced bugs.
- Recheck export privacy for PNG/JSON/report/preview/recovery/hidden inputs/new DOM or custom-event paths. Use local synthetic data; no external upload/messaging.
- Check all earlier improvements remain integrated: Shift constraints, duplicate/nudge, discoverable tools, contextual controls, light dialogs/palette, visible essential actions, mode labels, named styles, independent opacity, marker limits, later editing.
- Update README/test/install/schema instructions and obsolete statements about in-memory-only sessions, labels, note behavior, and coverage. Keep shortcut/OS clipboard limitations accurate.

### End-of-prompt handoff and final lead acceptance gate

Claude: return changed files, aggregate test results, screenshot/export artifacts, coverage of all three prompts, and remaining real limitations. Stop for final lead review; no publishing/deployment.

Team lead: independently inspect diff/UI/exports and run the full model/browser/watcher suites plus new relevant tests. Exercise mixed styles, numbered/lettered bullets, typing/revising legend, cursor, crop/resize, image/report/JSON export, reload/restore, and reimport. Cover keyboard-only use, narrow widths, clipboard fallback, capture failure, two-tab isolation, invalid imports, and exhaustion. Correct defects directly and retest affected behavior until the brief is met. Do not mark complete while required work remains. Return concise evidence and actual limitations to the user.

## Coverage ledger

| Conversation requirement | Phase |
| --- | --- |
| Four reproduced bugs: export privacy, PNG text, picker keyboard, unfinished path | 1; recheck 3 |
| Light theme, contextual settings, anchored actions, grouping, labels, named presets | 1 |
| Split overlay responsibilities, share layout/geometry, reproducible tests | 1; maintained throughout |
| Per-object graduated opacity and three outline/fill treatments | 1 |
| Rectangle/square/ellipse/circle; existing polyline/polygon refinement | 1 |
| Independent ends: none, arrow, open/filled circle | 1 |
| Shift constraints, duplicate, keyboard nudging | 1; bullet integration 2 |
| 1–9/A–Z bullets, optional linked legend, immediate/later editing | 2 |
| Canvas-rendered legend editor with hidden input, preview/PNG parity | 2 |
| Optional cursor/proxy with stable placement | 3 |
| Reload recovery, separate tab/page drafts, discard/lifecycle | 3 |
| Copy report: screenshot plus explanations and useful fallback | 3 |
| Export preview; crop/DPR/resize; legacy JSON; focus/failure recovery | Throughout; final integration 3 |
| Lead review/correction/tests after each handoff; at most three prompts | Every phase |

## Execution status

- Brief prepared; no implementation phase started.
- Claude CLI found at `C:\nvm4w\nodejs\claude.ps1`. Authentication/implementation invocation not tested in this planning turn.
- Phase 1 lead acceptance: pending.
- Phase 2 lead acceptance: pending.
- Phase 3 lead acceptance: pending.
