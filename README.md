# Redline — Chrome extension

Annotate any web page with pen, highlighter, line and arrow, rectangle and
ellipse, polyline and polygon, 1–9 or A–Z bullets with an optional editable
legend, legacy numbered notes, and text-box marks, optionally with a pointer in
the picture, then hand an annotated PNG, a copied report (screenshot plus
explanations) or a portable JSON file to an LLM. An accidental reload offers the
marks back.

This packages the framework-free Redline overlay from the `add-redline` skill as
a Manifest V3 extension, so the feature is available everywhere instead of being
installed per application.

## Install in Chrome

1. Open Chrome and navigate to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the project folder: `c:\dbva\code\redline-extension`
5. Chrome loads the extension and shows it in the extension list.

Once installed, open any webpage and click the Redline toolbar icon, or use the keyboard shortcut **Ctrl+Shift+R**.

> If the shortcut does not work, check the extension shortcut settings at `chrome://extensions/shortcuts` and rebind it there.

Open the overlay with the toolbar button or **Ctrl+Shift+R**.

Chrome also uses Ctrl+Shift+R for hard reload. If the shortcut does not take,
rebind it at `chrome://extensions/shortcuts` — that page is the authority, and
the extension does not fight the browser for the key.

## What it does

| | |
| --- | --- |
| Tools | **Select**, **Eraser**, pen, highlighter, line, arrow, rectangle, ellipse, polyline, polygon, note, bullet and text are all direct controls on one strip |
| Bullets | circles labelled 1–9 or A–Z, each with an optional multiline explanation; an optional, movable and resizable **Legend** lists them on the image |
| Styles | contextual controls in the same toolbar strip edit either the selected mark or the defaults for new marks, never both, and say which |
| Shapes | rectangles, ellipses and polygons take **Outline**, **Outline + fill** or **Fill only**, with fill opacity 10, 25, 50, 75 or 100% and independent outline and fill colours |
| Line ends | lines, arrows and polylines take **None**, **Arrowhead**, **Open circle** or **Filled circle** at each end, with pictorial presets |
| Colours | named presets (Issue, Question, Suggestion, Approved, Note, Neutral, Ink, Paper) record an intent in the export; **More colors** holds solid tints and shades; **Custom** accepts any hex value |
| Markers | **Note labels** switches new note circles between `1, 2, 3` and `A, B, C`; the two run as separate sequences |
| Export | the strip’s **Capture** group keeps **Crop**, **Full page**, **Copy image**, **Copy report**, Export preview and Download PNG together |
| Pointer | optional **Include cursor** draws a movable arrow with an exact hotspot into exports; off by default |
| Report | **Copy report** puts the annotated screenshot and every bullet explanation and legacy note (as text) on the clipboard, or copies the text and downloads the PNG when that is all the clipboard allows |
| Preview | **Export preview** shows the exact PNG — crop, output size, legend and pointer — before you copy or download it |
| Import | round-trips its own JSON; malformed files are rejected without losing marks, and fields this version cannot keep are named |
| Session | marks survive closing and reopening, and an accidental reload of the same tab and page in the same browser session (**Restore** or **Discard**) |

### Toolbar

The main bar is one icon-first strip across the viewport. It contains the
compact **Annotate / Browse** toggle, every drawing tool, history and Clear,
Capture, file, pointer and recovery commands, toolbar **Pin**, and **Close**.
There is no overflow menu. At 1200px and wider every command fits on one row;
narrower windows keep the same strip and allow horizontal scrolling.

Chrome does not let an extension insert arbitrary controls into the browser's
own toolbar. Redline's extension icon remains its launcher; the in-page strip is
the nearest available integration surface.

The contextual section in that same strip shows only what applies:

| Target | Controls |
| --- | --- |
| Pen | Color, Thickness |
| Highlighter | Color, Width, Opacity |
| Line, Arrow, Polyline | Color, Thickness, end presets, Start and End |
| Rectangle, Ellipse, Polygon | Treatment, Outline colour, Fill colour, Fill opacity, Thickness |
| Note | Color, Note labels (new notes only) |
| Bullet | Color, Labels (1–9 or A–Z, new bullets only), next free label, Legend, Legend options |
| Selected bullet | Color, Edit explanation, Legend, Duplicate, Delete |
| Legend | Legend (hide), Size, Font, Width, Height (Fit text or Fixed), Place |
| An explanation being edited | Legend, Size, Font, Width, Height, Place, Save, Cancel |
| Text box | Border colour, Font size, Background |
| A selected mark | its type's controls, plus Duplicate and Delete |
| Pointer (selected, or being placed) | Follow / Following, Place…, Remove from export |
| A reload-recovery draft is waiting | Draft from *time* (*n* marks), Restore…, Discard — shown beside any of the above |

With a drawing tool active the row reads **New rectangles** (for example) and
changes only what the next marks look like. With **Select** active it reads
**Selected rectangle** and changes only that mark, as one undo step. Drawing a
mark does not leave it selected, so adjusting a preset never restyles the mark
just drawn. Fill opacity swatches show real transparency over a checkerboard;
tints under **More colors** are solid colours, not see-through fills. A shape
can never lose both its outline and its fill. Switching to **Outline** remembers
the shape's fill colour and exact opacity; switching back restores them, even
after saving and importing JSON. Editing a selected shape leaves future drawing
defaults alone.

### Pick a color from the page

Open **Color**, **Outline**, **Border** or **Fill** in the contextual section, then choose
**Pick from page**. The eyedropper shows a clean snapshot of the visible page,
with Redline's marks and controls removed. Move over a color to see its magnified
pixels and hex value; click to use it. Arrow keys move one captured pixel,
Shift+arrows move ten, and Enter picks. Escape or Cancel returns to the palette
without changing anything.

This works with page backgrounds, images and canvas-rendered content. Sampling
changes the current tool's color, or just the selected mark's outline/fill.
Existing fill strength and the other color stay intact; selected-mark changes
are undoable. The snapshot stays inside Redline's closed shadow root, is dropped
when sampling ends, and is never stored in a recovery draft or sent elsewhere.
It uses the existing page-capture permission. A resize or interrupted capture
cancels sampling so the chosen pixel cannot be taken from a misaligned image.

### Keyboard and pointer

| Input | Effect |
| --- | --- |
| `V P B L A R O N U T E C` | Select, Pen, Highlighter, Line, Arrow, Rectangle, Ellipse, Note, Bullet, Text box, Eraser, Crop |
| `Enter` on a selected bullet | edit its explanation |
| Start typing on a selected rectangle | create or replace its attached label directly on the canvas |
| `Enter` or double-click a selected rectangle | edit its attached label |
| Arrow keys / Shift+arrows with the pointer selected or being placed | move the pointer 1 / 10 screen pixels |
| `Enter` or `Esc` while placing the pointer | finish placing |
| `Delete` with the pointer selected | leave the pointer out of exports (its position is kept) |
| Arrow keys with the legend selected | nudge the legend 1 / 10 screen pixels |
| Shift while drawing | squares and circles; lines and path segments snap to 45° |
| Shift while dragging a mark | move along one axis |
| Drag a handle of a selected mark | resize it; the opposite handle stays put, at any rotation |
| Shift while dragging a corner handle | keep the proportions |
| Ctrl while dragging a handle | resize about the centre |
| Drag the round knob above a selected mark | rotate it about its centre; Shift snaps to 15° steps |
| Drag an end handle of a selected line or arrow | move that end; Shift snaps the line to 45° |
| Arrow keys / Shift+arrows | nudge the selected mark 1 / 10 screen pixels; a quick run is one undo step |
| `Ctrl+D` | duplicate the selected mark (left to the browser when nothing is selected) |
| `Delete` / `Backspace` | delete the selected mark |
| `Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z` | undo and redo marks |
| `Enter` or double-click | finish a polyline or polygon |
| `Backspace` while drawing a path | remove its last point |
| `Esc` | cancel an unfinished mark or explanation edit; else finish placing or deselect the pointer; else leave crop editing; else close Redline |
| `F2` | switch between Annotate and Browse |
| Tab / Shift+Tab | every command and contextual control in the strip; palette grids use arrow keys |

Unfinished work has one rule: switching tools, entering Browse, closing,
importing, clearing, undoing and exporting discard an in-progress stroke or path
and keep every completed mark. Losing window focus or opening a dialog cancels
a drag in progress. A new polygon needs three separate points that enclose an
area; older files with two-point polygons still load.

Selecting a rectangle, ellipse, text box, pen or highlighter stroke, polyline
or polygon shows a frame with a round handle on every corner and at the middle
of every edge, plus a rotate knob on a short stem above the top edge, as in
PowerPoint. The frame, handles and knob turn with the mark, and each handle
shows a resize pointer for the direction it faces on screen. When a shape sits
at the top of the page, the knob moves below it. A stroke's frame surrounds
its ink; a perfectly straight stroke has no height to stretch, so it omits the
two handles that would only do that. Straight lines and arrows show a handle on
each end instead, and bullets and notes stay fixed-size markers that move but
do not resize or rotate. A rotated text box is edited in place, turned, and
grows from its own top-left corner. Each resize or rotation is one undo step.

The visible **Eraser** button removes what it touches: an outline-only shape is erased on its
outline, not by clicking empty space inside it. Dragging the eraser across
several marks is one undo step.

To label an existing rectangle, select it and start typing. **Enter** or
double-click also opens its in-place editor. The label is centred and clipped
inside the rectangle, moves/resizes/rotates with it, and remains part of that
same annotation in PNG and JSON exports. `Ctrl+Enter` or clicking away saves;
`Esc` cancels. Saving an empty label removes only the label. Once labelled, its
font size is available in the rectangle's contextual controls.

Choose **Text** (or press **T**), click anywhere, and start typing. Text uses
dark lettering on a 75%-opaque white background. The background expands as you
type, then wraps and grows downward for longer text. You can still drag out an
initial size if useful. Double-click saved text to edit it later. `Ctrl+Enter`
or clicking away saves; `Esc` cancels the edit without closing Redline. The
Background control adjusts the white backing's opacity.

### Bullets and the legend

Choose **Bullet** (or press **U**) and click to place a circle labelled with the
lowest free label: `1`–`9`, or `A`–`Z` after switching **Labels**. The two
ranges are independent and can be mixed. Changing **Labels** affects only new
bullets; existing bullets never renumber, including when one is moved or a
lower label is freed by deleting its bullet. When a range is full, clicking
places nothing and explains why, with a **Use A–Z** (or **Use 1–9**) button
when the other range still has room. Redline never switches ranges by itself
and never creates `10` or `AA`. Older files whose notes use `10` or `AA` load
and export unchanged; the Note tool and its adjacent labels still work.

Each bullet owns an optional multiline explanation. Explanations are linked to
the bullet's id, not its label or position, and the legend lists rows in label
order (1–9, then A–Z).

- **Legend hidden** (the default for a new session): clicks just place bullets.
  Double-click a bullet, select it and press **Enter**, or choose **Edit
  explanation** to type its explanation in a card beside it. The card is for
  editing only and never appears in exports.
- **Legend shown** (the **Legend** button): placing a bullet opens its row for
  typing at once. **Ctrl+Enter** (or clicking elsewhere) saves and returns to
  placing, so click, explain, click, explain needs no extra steps. **Esc**
  cancels the text edit without closing Redline. Click a legend row to edit it
  later, with the caret where you clicked.

Hiding and showing the legend keeps every explanation, including one being
edited, which moves between its row and the card; a hidden legend exports
markers only. The legend sits above other marks, so pressing on it edits or
moves it whichever tool is active. Drag the legend (or its blue grip) to move it; once selected its
handles resize it and arrow keys nudge it. **Legend options** sets its text size,
font (installed Sans-serif, Serif or Monospace faces; nothing is fetched), width,
height and corner. **Fit text** grows the legend with its explanations; a
**Fixed** height clips whole lines and shows a "+N more lines" badge, in the
preview and the PNG, while JSON keeps the full text. While you edit a clipped
legend, the hidden lines show below a red line marking where the export stops.
A legend extending past the window edge or outside the crop is outlined with a
warning in the preview; the export clips it rather than moving it or enlarging
the image. Explanations are limited to 10,000 characters; input past that is
refused with a message rather than truncated.

When an explanation grows beyond the available screen space, a temporary
Canvas editing view keeps the caret visible. Scroll inside it to reach other
lines; typing or keyboard navigation brings the caret back into view. This also
works when editing beside a bullet with the legend hidden. The view avoids the
toolbar and leaves the saved legend position, size, and exported layout alone.
Its footer identifies the editing view and any export clipping. Save and JSON
preserve intentional trailing spaces and blank lines.

The legend and everything about editing it (text, caret, selection, IME
composition underline, placeholders, handles) are drawn on a canvas with the
same layout code the PNG export uses. A transparent 1 px textarea inside the
closed shadow root receives keyboard, IME and clipboard input and gives screen
readers an "Explanation for bullet N" field; it never shows and never takes the
pointer. While editing: Enter adds a line; arrows, Home/End (for the drawn line)
and Shift extend a selection; drag or double-click selects; Ctrl+C/X/V, Ctrl+A
and the text field's own Ctrl+Z work; Tab saves. Typing never triggers drawing
shortcuts, and key and input events stop at the hidden field, so the page's
ordinary (bubbling) key handlers do not react to them. Page code listening in
the capture phase can still observe key events, as it can for the text box
editor; the closed root is encapsulation, not a trust boundary.

Placing a bullet and typing its first explanation is one undo step. A later
edit, a legend move, resize or style change, and hiding or showing the legend
are each one step. Deleting a bullet removes its explanation too; undo restores
the identical bullet. **Duplicate** gives the copy a new id and the next free
label in its range, keeps the explanation, and refuses (with a reason) when the
range is full.

### Pointer in exports

Browsers never include the operating-system cursor in `captureVisibleTab`
images, and Redline does not ask for screen sharing to get one. Instead,
**Include cursor** (on the Pointer section of the strip, or in the export preview) draws a
dark arrow with a white edge whose tip is the exact hotspot. It is off by
default.

When you turn it on, the pointer appears where your mouse last pressed or
paused (for half a second) over the page or the drawing surface — including a
hover in Browse mode followed by F2. Pressing or resting on Redline's toolbar,
contextual controls, colour picker, dialogs, crop controls, text box editor or the
legend never counts, and crossing the page to reach a button is not a pause, so
moving the mouse to **Copy image** does not move the pointer. If no such
position is known yet, Redline enters placement: click where the pointer should
point (and drag to fine-tune), or move it with the arrow keys and press Enter.

The pointer stays **frozen** where it is. **Follow** (in its contextual controls) makes it
move to each new press or pause over the page until you freeze it again;
dragging it, nudging it or choosing **Place…** freezes it. With **Select**
active, drag the arrow to move it; click it to select it, then use the arrow
keys (Shift for 10 pixels) or **Delete** to leave it out of exports. Its frame
and placement mode are never exported.

The pointer is stored in the document (`document.cursor`) like the crop: it is
kept by close/reopen, reload recovery and JSON, and moving it does not use
annotation undo history. It is drawn in document units, so crop, output scale,
device pixel ratio and window resizing move and scale it exactly as they do the
marks; a pointer outside the crop does not appear, and the preview says so. If a
future capture adapter supplies real cursor pixels (`includesCursor: true`), the
proxy is not drawn a second time.

### Copy report

**Copy report** captures the tab and builds a report from the same document
snapshot as the image:

- the page title and the already-redacted URL (origin and path; it says when a
  query string or fragment was removed), creation time, and the image size,
  crop, output scale, legend and pointer state;
- every bullet explanation in label order (1–9, then A–Z) with its full text,
  and every legacy note that has text; entries outside the crop are marked.

Explanations are listed **whether or not the legend is shown on the image**:
hide the legend for an uncluttered picture and the report still carries the
words, and says so. The HTML version escapes every page and annotation value and
keeps line breaks and spaces; the plain-text version indents continuation lines.

Redline checks what the clipboard accepts (`ClipboardItem.supports` where
available) and then tries one clipboard item holding the PNG, HTML (with the
image embedded) and plain text. Pages and apps differ in which of those a paste
uses — some keep only the text or only the image — so the status message says
so. When the combined copy is not accepted, or when you choose **Copy report
text + download PNG**, the report text is copied and names the PNG file that is
downloaded beside it. If even text cannot be copied (for example a page whose
`Permissions-Policy` blocks the clipboard, or a document without focus), both
the PNG and a `-report.txt` file are downloaded. The message always states
exactly what was copied and what was downloaded; a download is never reported as
a clipboard success. **Download JSON** remains the editable export.

### Export preview

**Export preview** on the Capture section captures the tab once and composes it exactly
as an export does, then shows that image with its pixel size, crop, output
scale, screenshot pixel ratio, legend and pointer, plus warnings: a legend
clipped by the crop, window edge or a fixed height, a hidden legend whose
explanations only the report carries, or a pointer outside the crop. Carets,
selections, handles, the temporary long-text editing view and every other
control are never in it, because nothing but the saved document is drawn. An
open explanation or text edit is saved first, as for any export.

**Copy image**, **Copy report** and **Download PNG** inside the preview use the
previewed image itself, and **Include cursor** there recomposes the same capture
with or without the pointer. Escape or × closes it and returns focus to where it
was. If the capture is refused, nothing opens, the reason is shown, and the
overlay and focus are restored. The preview never moves or unpins the toolbar.
Closing Redline also closes Preview; a capture still running cannot reopen it.

### Reload recovery

Redline saves the current session a moment after each change — marks, bullet
explanations (including one still being typed), legend, pointer, crop and output
scale — and immediately when the page is hidden or unloads. After an accidental
reload, opening Redline on the **same tab and page** in the **same browser
session** offers the draft:

> **Restore unsaved redline?** 4 marks, 3 bullets (3 explained), legend shown,
> pointer included, crop 1200 × 800, 200% output. Saved at 2:04:31 PM from this
> tab and page, before it reloaded. Drawn in a 1200 × 800 window scrolled to 0,
> 340; this window is 1000 × 650 scrolled to 0, 0.

**Restore** (the default button) replaces the empty session with the draft;
**Discard draft** deletes it. When the saved scroll position differs, a checkbox
scrolls the page back to it. Marks keep their screen positions — recovery does
not anchor them to page content — so adjust them if the page moved. Undo history
is not recovered.

Escape decides later: the draft stays, a notice in the strip and its
**Restore draft** control keep it reachable, and **nothing new is saved for
recovery until you restore or discard it**, so the waiting draft is never
overwritten. Restoring over marks drawn meanwhile asks first. Reopening Redline
on a still-empty page offers the draft again. Closing Redline dismisses the
Restore dialog and keeps the waiting draft, just like deciding later.

Clearing every mark removes the stored draft rather than saving an empty one, so
nothing comes back. **Discard draft** on the strip deletes the copy of the
current session and pauses saving until **Resume reload recovery**. If the
extension's session storage is full, or a session exceeds 1.5 MB, Redline says
so and keeps your marks open; the next change retries. Close and reopen still
keep the in-memory session without asking. Older drafts are removed only after
the replacement saves successfully. If Discard fails, the error is shown and
the waiting draft stays available to restore or discard again.

Recovery is not browser-restart recovery: drafts live in
`chrome.storage.session`, which the browser clears when it closes. Another tab —
even on the same address — and another page in the same tab never see or
overwrite each other's drafts; closing a tab deletes its drafts.

### Use the page while Redline is open

Use the compact mode button or press **F2** to switch to Browse mode. The page
then receives clicks, typing, and scrolling; drawing tools are disabled and the
bar shows a dashed border. Use the same button or press **F2** again to return to
Annotate mode. The button's icon and accessible label always describe the mode
it will enter next.

Switching modes preserves the space occupied by an existing vertical scrollbar,
so entering Annotate does not widen the page and reset responsive 3D canvases.
The underlying page stays live; this does not pause its scripts or animations.

**Pin** returns the full-width strip to the top and highlights while engaged. It
works in both modes. Click it again to unpin, then drag the grip to move the
strip vertically; its horizontal edges remain aligned with the viewport.

Marks, the pointer and the crop are hidden in Browse mode and retained when you return.
They stay at their screen positions; if scrolling or page layout changes move
the underlying content, reposition the marks to match.

### Crop and resize an export

Choose **Crop** in the strip's Capture section (or press **C**), then drag a rectangle around the
area to include. Drag inside to move it, or use its eight handles to resize it.
Arrow keys move the crop one screen pixel; hold Shift for ten pixels. Focus a
handle with Tab to resize it with those keys. **Select all** provides a
keyboard-accessible starting rectangle.

Choose **Done**, Enter, or Escape to resume annotation with the crop retained.
Escape during a drag cancels that gesture. **Reset crop** restores the whole
viewport. The shaded area, crop outline, handles, and toolbar are excluded from
both Copy and PNG exports.

The crop panel's **Output** control scales the PNG to 50%, 100%, or 200%.
100% uses the screenshot's native pixels, including high-DPI resolution.
The frame label shows screen dimensions, while the panel shows expected PNG
dimensions. Enlarging the image increases its size, not the screenshot detail.

Cropping does not delete marks or change annotation undo/redo. JSON preserves
all marks, with optional `document.crop` (`x, y, width, height` in document
coordinates) and `document.outputScale` fields in the existing version 1
format. Older files without these fields export the full screen at 100%.
Crop settings belong to the current session and do not carry to other sites.

Marks use the session's viewport coordinates over the live page. The drawing
surface and exported PNG use the same scaling when the window changes size.
Annotation history is separate from the page's undo history.

### Capture the full page

Choose **Full page** in the strip's **Capture** group beside Crop and Copy image.
Redline temporarily hides itself, scrolls through the
document, stitches the visible tiles into one PNG, restores the original scroll
position, and copies the result. Current annotations are placed at the page
position occupied by the viewport when capture began.

Full Page preserves at least the screenshot's native pixel dimensions, even if
the regular crop output is set to 50%; settings above 100% remain an explicit
upscale. The completion message reports the actual PNG width × height. Image
viewers often scale a very tall PNG down to fit, which can look soft until it is
opened or viewed at 100%.

Full-page capture uses the existing active-tab permission and adds no debugger
or all-sites permission. It is intentionally bounded to 60 screen tiles and a
64-megapixel PNG. Pages with fixed or sticky chrome, animations, lazy loading or
infinite scrolling can produce repeated or changing content; visible-area
capture remains available for those pages.

## Annotation schema

Exports stay `open-redline` version 1. Every addition is optional and defaults
to the earlier behaviour, so every earlier file loads unchanged and unchanged
marks serialise exactly as before:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type: "ellipse"` | new type | `start`/`end` bounding box, like `rectangle` |
| `fillOpacity` | rectangle, ellipse, polygon | 0 (omitted) is Outline; any value in (0, 1] is kept exactly |
| `fill` | rectangle, ellipse, polygon | fill colour; omitted when it equals `color` |
| `outline: false` | rectangle, ellipse, polygon | Fill only; ignored unless there is a fill |
| `savedFill` | rectangle, ellipse, polygon | Optional `{color, opacity}` retained while Outline hides a previously chosen fill; restored when fill is enabled |
| `text`, `fontSize` | rectangle | optional attached, centred label and its size; both are omitted when the label is empty |
| `rotation` | rectangle, ellipse, textbox, pen, brush, polyline, polygon | clockwise degrees in [0, 360) about the centre of the mark's upright box (its `start`/`end` box, or the extent of its `points`); geometry stays upright and the rotation is applied when drawing; omitted when 0 |
| `startDecoration`, `endDecoration` | line, arrow, polyline | `none`, `arrow`, `open-circle` or `filled-circle`; omitted when the type's default |
| `type: "bullet"` | new type | `point` (finite `x`, `y`), `label` (one character, `1`–`9` or `A`–`Z`), optional `text` (multiline explanation, at most 10,000 characters; omitted when empty), plus the usual `id`, `color`, `width`, `intent` |
| `document.legend` | document | optional `{visible, x, y, width, height?, fontSize, fontFamily}` in document coordinates; `height` omitted means Fit text; `fontFamily` is `sans-serif`, `serif` or `monospace`; missing geometry defaults from the document size |
| `document.cursor` | document | optional pointer proxy `{visible, x, y}`: `visible` must be a boolean and the hotspot `x`, `y` finite numbers inside the document (0…`width`, 0…`height`); omitted until a pointer is first placed; a hidden pointer keeps its position; an export setting outside undo history, like `crop` |

A bullet's explanation lives on the bullet, so the legend has no separate list of
entries to fall out of step: rows are the document's bullets in label order.
Bullet labels must be unique within a document; a duplicate label, a label such
as `10`, `AA` or `a`, a non-text or over-long explanation, or a malformed legend
field (for example `visible: "yes"`) rejects the whole import and leaves the
current marks, legend and undo history untouched. Imports are also laid out and
measured before they replace anything. Unknown legend fields are reported like
unknown mark fields (`legend.title`). Legacy notes keep `number`/`marker` and may
still use `10` or `AA`. Builds from before this change reject files that contain
bullets, as they reject ellipses.

A `rotation` that is not a finite number (for example `"45"`) rejects the whole
import; any other value is normalised into [0, 360). On marks that cannot
rotate, such as lines and bullets, it is reported as an unsupported field
(`line.rotation`). Builds from before this change report `rectangle.rotation`
and similar as unsupported and draw those marks upright.

A malformed `cursor` (for example `visible: "yes"` or a hotspot outside the
document) rejects the whole import; unknown cursor fields are reported as
`cursor.<name>`. Builds from before this change report `document.cursor` as an
unsupported field and export without a pointer.

A straight line with exactly one arrowhead at its end is written as `arrow`,
which earlier readers already draw; any other combination is a `line` with
explicit decorations. An unknown decoration value rejects the import. Fields
this version does not understand cannot be kept, so the import status names
them (for example `rectangle.shadow`) instead of dropping them silently.

### Reload-recovery storage

Drafts are written only by the service worker, in `chrome.storage.session` with
its default trusted-contexts access (content scripts and pages cannot read it).
The content script asks for its own draft over runtime messaging. The worker
takes the tab id from the message *sender*, which the browser supplies. The page
address is the document's current `location.href` as reported by Redline's
content script, accepted only when its origin matches the sender's origin: after
`history.pushState` Chrome keeps reporting the sender at its load-time address,
which is not the address a reload shows. Pages cannot message the extension.
Each draft is stored as:

| Key / field | Meaning |
| --- | --- |
| `redline.draftKey` | a random 256-bit HMAC key, created once per browser session |
| `redline.draft:<tabId>:<pageKey>` | one draft; `pageKey` is base64url HMAC-SHA-256 of the full page URL, so query strings and fragments distinguish pages without being stored and cannot be guessed back without the key |
| `.tabId`, `.sessionId`, `.savedAt`, `.chars` | bookkeeping for isolation, bounds and eviction |
| `.draft.schema` | `1` |
| `.draft.sessionId`, `.createdAt`, `.savedAt` | the overlay session and its timestamps |
| `.draft.viewport` | `{width, height, devicePixelRatio, scrollX, scrollY}` when saved |
| `.draft.ui` | `{cursorFollow}` |
| `.draft.document` | the same object as JSON `document` (marks, legend, cursor, crop, outputScale) |

No screenshot, URL, title, user agent or undo history is stored. A draft is at
most 1.5 MB; each tab keeps at most 4 pages' drafts and the store at most 20,
oldest first. A quota failure is reported to the page's session and never
resolved by deleting another tab's draft. When a session moves to another
address in the same document (a fragment link or an app route change), its
draft is saved again under the new address — at the latest as the page
unloads — and the entry under the old address is removed, so a reload at either
address finds the right draft.
Restored drafts are validated like an import — envelope first, then the whole
document atomically — and an unreadable draft is discarded with a message.
Preferences remain separate, in `chrome.storage.local`.

## How it is put together

```
manifest.json         MV3: activeTab, scripting, clipboardWrite, storage; Ctrl+Shift+R; module service worker
service-worker.js     injects the bootstrap; answers capture and draft requests
background/
  capture-guard.js    captures only the sender's active tab, verified before and after
  draft-store.js      reload-recovery drafts in session storage, keyed by tab and HMAC page identity
content.js            classic bootstrap; dynamically imports main.js
main.js               host integration — shadow root, adapters, one overlay
host-dialogs.js       native <dialog> note entry, confirmations and the Restore/Discard prompt
color-picker.js       plain-element colour control (see "custom elements" below)
redline/
  RedlineOverlay.js     orchestration: lifecycle, selection, defaults, keyboard, pointer, recovery, export
  RedlineToolbar.js     one full-width strip with commands and contextual controls
  RedlineGestures.js    drawing, moving, resizing, rotating, erasing, path drafts
  RedlineTransform.js   selection handles, rotate knob, rotation-aware resize
  RedlineTextEditor.js  in-place text-box and rectangle-label editing
  RedlineLegend.js      bullet labels, legend validation, layout, caret geometry, drawing
  RedlineLegendEditor.js  live legend canvas and its hidden-input explanation editor
  RedlineDocument.js    validation, import, bounded undo/redo of marks and legend
  RedlineStyles.js      style vocabulary and the single style-edit function
  RedlineGeometry.js    drawing primitives, rotation, bounds, hit testing, constraints
  RedlineTextLayout.js  shared font, measurement, wrapping and baselines
  RedlineSvg.js         live preview, cached per mark
  RedlineCanvas.js      PNG renderer drawing the same primitives
  RedlineExport.js      capture, composition, clipboard probing, private downloads
  RedlineCursor.js      pointer proxy validation, geometry and the meaningful-position tracker
  RedlineReport.js      Copy report text and escaped HTML
  RedlineRecovery.js    draft envelope, validation, prompt wording and the serialised autosaver
  RedlinePreview.js     export preview dialog
  RedlineCrop*.js       crop model and controls
test/                 model tests and real-browser acceptance suites
```

The preview and the PNG draw the same primitives with the same text layout,
measured with one font stack and one Canvas measurer, so wrapping, baselines,
decorations and clipping match. Stored marks are immutable, history shares
unchanged marks and keeps at most 200 undo steps, and the preview reuses each
unchanged mark's SVG node, so drawing over a large document redraws only the
mark in progress.

### Isolation

The overlay mounts inside a **closed shadow root** on a host `<div>`.
Page CSS cannot reach the toolbar, and the extension does not restyle the page.
`redline.css` is fetched from the extension and adopted as a constructed
stylesheet, which also sidesteps any page Content-Security-Policy. Interface
colours are `--rl-*` tokens in that sheet (paper `#F7F5F0`, white controls, text
`#292D32`, dividers `#D9D5CC`, red `#B65D66`); marks never read them, so the
theme cannot restyle imported annotations.

Exactly one rule has to live in the page, because it targets `<body>`:
`body[data-redline-active] { overflow: hidden; }`. It is adopted onto the
document and removed again by `destroyRedline()`.

The content script's **isolated world** keeps extension JavaScript separate
from page JavaScript. The closed root prevents ordinary page DOM traversal
from reading annotation text through `host.shadowRoot`. Keyboard handling runs
inside that root so text editing and shortcuts still see their actual targets.

The surrounding document remains controlled by the website: page code can
remove the host or observe composed events. Shadow DOM provides encapsulation;
it does not make the whole page a trusted environment.

Downloads never touch the page's DOM. An earlier version appended a temporary
blob link to `document.body`, where an ordinary page `MutationObserver` could
read its URL and fetch the JSON or PNG. The link is now created detached and
clicked without ever being inserted, and the colour picker's change event is not
composed, so neither export bytes nor annotation details reach page listeners.

### Capture

`chrome.tabs.captureVisibleTab()` runs in the service worker and returns a PNG
data URL of the visible tab. This is supplied as the overlay's `capturePage`
adapter, which short-circuits its `getDisplayMedia` path — so **there is no
share-screen picker**, unlike an in-page install. The overlay hides itself
before capture; `capturePage` waits two animation frames so the hide has
actually painted.

`captureVisibleTab(windowId)` photographs whichever tab is active in that
window, which need not be the tab that asked. The worker therefore captures only
for the sender's tab, only while it is the active tab and showing the address
the content script reports (so an earlier in-app route change is fine); afterwards it checks
again and discards the image if that window activated any other tab in the
meantime (even if it then switched back), or if the tab started navigating,
changed address, moved window or closed. The content script also rejects the
result if its own document was hidden or changed address during capture. A
rejected capture exports nothing, shows the reason, and restores the overlay
and focus; one page's marks are never drawn on another page's screenshot.
Chrome allows two captures per second, so a quick second export waits briefly
and retries, still under the same checks.

The capture image dimensions determine export resolution, and the overlay scales
annotations to match. The browser suite checks native device scale factor 2 as
well as resized viewport geometry.

### Permissions

`activeTab` is granted by the toolbar click or the keyboard command, and covers
both `executeScript` and `captureVisibleTab` for that tab. There is no broad
host permission: the extension can only see a page you explicitly invoke it on.
The `storage` permission saves tool preferences locally in the extension and
reload-recovery drafts in its session storage. Phase 3 added no permission:
tab events used by the capture checks and draft cleanup need none, and no
screen sharing is requested for the pointer.

### Privacy

Exports are files you hand to someone else, so the address is trimmed:
`page.url` records **origin and path only**. Query strings and fragments carry
session tokens, password-reset tokens, and search terms, and are dropped. When
something was dropped, `context.urlRedacted` is `true` so a reader knows the
address is not the whole address.

Page metadata includes the title, redacted URL, viewport, and browser information.
The extension does not read page content text, page storage, or cookies. Tool
preferences use [chrome.storage.local](https://developer.chrome.com/docs/extensions/reference/api/storage),
so they follow you across sites without writing into those sites' `localStorage`.
Existing per-site preferences from older versions are left untouched and are
not imported.

Annotations live in memory, plus a reload-recovery draft of the current session
in the extension's `chrome.storage.session` (see *Reload-recovery storage*): held
by the browser in memory, cleared when the browser session ends, deleted when
the tab closes or you discard or clear it, and never readable by the page. It
contains no screenshot, URL or title. Copy report and its fallback files carry
the page title and redacted URL only, with annotation text escaped in HTML. The
export preview is a canvas inside the closed shadow root; it creates no image
URL and adds nothing to the page's DOM. Pointer tracking reads only coordinates,
passively. The screenshot contains whatever is on screen; look before you send.

## Changes to the bundled runtime

`redline/` started with the package from the `add-redline` skill. The original
extension integration changes are listed below; host-specific seams are marked
`[extension patch]`. This repository owns the runtime and its regression tests.
It also includes atomic import validation, duplicate-ID rejection, complete
keyboard traversal, and matching drawing/export coordinates.

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `RedlineOverlay.js` | colour dialog appends to `options.mount`, not `document.body` | it was escaping the shadow root and losing its styles |
| 2 | `RedlineOverlay.js` | Tab cycling reads `root.getRootNode().activeElement` | `document.activeElement` is the shadow **host**, so Tab always jumped back to the first button |
| 3 | `vendor/wb/define-element.js` | skip registration when there is no registry | Chrome gives an isolated world a **null** `customElements`; the import threw and the whole overlay failed to load |
| 4 | `RedlineOverlay.js` | new `createColorPicker` option | lets a host without a registry supply its own control |
| 5 | `RedlineOverlay.js` | guard `customElements.whenDefined` | same null registry |
| 6 | `RedlineOverlay.js` | new `describePage` option; the built-in block was hardcoded to `location.href` | a host on arbitrary sites must be able to redact the URL |
| 7 | `RedlineOverlay.js` | key handler runs inside the mount root and uses `composedPath()[0]` | preserves text editing across shadow boundaries |
| 8 | `RedlineOverlay.js` | `preferences` and `savePreferences` host adapters | keeps the reusable runtime out of website storage |

### Patch 7

The original overlay listened for keys on `window`. Shadow events retarget
outside the root, so `event.target` was the host instead of the textarea.
Two guards therefore failed open:

- the "is the user editing text?" check, so the letters `v p a r n t` were
  swallowed as tool shortcuts instead of typed — you could not write the word
  "print" into a text box; and
- the `editable` check, so `Backspace` deleted the selected mark rather than a
  character.

The handler now listens inside the mount root, where `event.composedPath()[0]`
identifies the element being edited even when the root is closed. Both
regressions are covered by the suite.

Patches 1, 2, 3, 5, and 7 are latent bugs in the canonical package that only
appear under shadow DOM or in a content script; they are worth folding back
upstream.

## Tests

Development tooling is recorded in `package.json` and `package-lock.json`
(Playwright 1.61.0, Chromium revision 1228). The extension itself has no
runtime dependencies.

```bash
npm install               # Playwright
npm run setup:browser     # Playwright's Chromium, once per machine
npm test                  # every suite below, with a summary
```

Individual suites:

```bash
node --test test/*.test.mjs          # model, layout, geometry, style and contrast tests
node test/run.mjs                    # original real-browser acceptance suite
node test/phase1-browser.mjs         # workspace, drawing and review-bug regressions
node test/phase2-browser.mjs         # bullets, label limits, legend and canvas editor (DPR 2 and 1)
node test/phase3-browser.mjs         # pointer, Copy report, export preview, tab-isolated capture (DPR 2 and 1)
node test/phase3-recovery-browser.mjs  # reload recovery lifecycle, tabs, quota, complete workflow
node test/phase3-review-browser.mjs   # lead regressions for closing dialogs and recovery failures
node test/eyedropper-browser.mjs      # real page-pixel samples, DPR, style ownership and cancellation
node test/mode-layout-browser.mjs     # classic scrollbar layout and camera-reset regressions
node test/transform-browser.mjs       # selection handles, rotate knob, rotated resize/export/text (DPR 2)
node test/fullpage-browser.mjs        # menu-free strip and native-resolution full-page alignment
pwsh -NoProfile -File test/watch-reload.ps1
node test/screenshots.mjs            # review captures at 1920, 1200, 800 and 420 px
```

Browser suites run headless by default; pass `--headed` to watch. Screenshots
go to `test-artifacts/screenshots`, which Git ignores.

The acceptance suite exercises all drawing tools, undo/redo, dialogs,
closed-shadow text editing, full keyboard traversal, native DPR 2 capture, PNG
pixel alignment after resize, crop and output scaling, JSON round-trips,
rejected imports, session retention, URL redaction, website storage isolation,
preference restoration on another origin, and narrow layouts.

The Phase 1 suite runs at DPR 2 and checks, through real pointer and keyboard
input: that a page-world observer sees no export link, bytes or payload; that
text wraps identically in the preview and the PNG (including the `WWW WWW`
case, blank lines and long words); arrow-key tab and swatch navigation in the
palette; that tool switches, Browse, Escape and blur cancel unfinished paths and
strokes; bar fit and visible essential actions at 1920, 1200, 800 and 420 px;
selection versus default styling with exact undo, redo and import; graduated
fill opacity in preview and PNG; Shift constraints; every end decoration;
duplicate and nudge history; eraser geometry; and rendered text contrast.

The lead-review suite also checks that hidden fills survive treatment changes,
JSON, reopen and history; selected shapes cannot change remembered drawing
defaults; status toasts stay out of captured PNGs; and both endpoint selectors
remain visible and operable at 420 px. The text suite checks click-to-type,
translucent white paper, live expansion, later edits, PNG and JSON at DPR 1 and 2.

The Phase 2 suite runs at DPR 2 and again at DPR 1 and checks, through real
pointer and keyboard input: hidden-legend placement without typing; independent
1–9 and A–Z sequences; reuse of freed labels; exhaustion messages and the
offered switch; legacy `10`/`AA` notes; immediate typing with the legend shown;
that no visible HTML editor exists; shortcut letters typed as text and kept
from page key handlers; save, cancel, click-to-continue and merged undo; caret
placement by click, Shift+Home, End, visual ArrowUp/Down, double-click word
selection, drag selection, copy/cut/paste and Delete; synthetic IME
composition; the 10,000-character limit; editing with the legend hidden and
its absence from the PNG; delete/undo identity, duplicate and move; legend
move, nudge, resize, fixed-height clipping badge, Fit text, font, size and
corner placement; row-by-row preview/PNG text parity; placeholders excluded from
PNG; nonuniform resize, crop at 200% output and the past-edge warning; Browse
mode; atomic rejection of bad bullets and legends; legacy JSON; the new controls
at 1920, 1200, 800 and 420 px; close/reopen; and no page-visible editor nodes or
payloads. Its click targets come from importing the extension's own layout
module into the DevTools test world. Screenshots go to `test-artifacts/phase2`.

The Phase 2 lead-review suite adds real caret-pixel checks for long explanations,
wheel scrolling and pointer placement, hidden-legend cards, nonuniform narrow
resizing, exact whitespace retention, and composition shortcut protection at
DPR 1 and 2. It verifies that exporting while the editing view is scrolled
produces the same PNG as exporting the saved document. Its screenshots are in
`test-artifacts/phase2-review`.

The Phase 3 suite runs at DPR 2 and DPR 1 through real pointer and keyboard
input: Include cursor off by default; keyboard-only placement at the centre
with arrows and Enter; hotspot pixels in the PNG; dragging, freezing and
Follow; that moving the mouse to Copy image and resting there leaves the
pointer where it was, in the copied image too; initialising from a pause over
the page in Browse mode but not over the toolbar; crop, 200% output and a
nonuniform resize; atomic rejection of a bad cursor; export preview dimensions,
legend and pointer with pixel-identical preview, preview download and ordinary
PNG, and no legend handles although they were on screen; the preview's Include
cursor; focus, toolbar placement and pinning after closing. At DPR 2 it also
checks Copy report's single clipboard item (PNG, HTML, text) read back in the
page, escaped HTML parsed with DOMParser, full explanations, the hidden-legend
statement and URL redaction; the keyboard fallback copying text that names the
downloaded PNG; a `Permissions-Policy: clipboard-write=()` page downloading PNG
and report text and saying nothing was copied; a real second tab in the same
window with capture refused from a background tab, when another tab is
activated mid-capture, when the tab switches away and back mid-capture, and on
navigation mid-capture (the worker's capture is delayed from the test to make
these deterministic); a refused preview; 1920, 1200, 800 and 420 px layouts of
the command strip, Pointer row and preview at both ratios; page-world
observers, page storage, the stored draft's contents and the shipped manifest.
Screenshots go to `test-artifacts/phase3`.

The recovery suite reloads real pages: no offer for an empty session; a session
built by drawing, typing explanations in both schemes, including the pointer,
cropping and scaling; the stored draft's contents and opaque key; the offer's
contents and viewport context; keyboard Restore to the identical document;
Discard; Escape without overwriting the waiting draft; Restore over new marks
with confirmation; clearing; an edit and an unsaved explanation made just before
reload; Discard draft pausing and Resume; a full session store; two tabs on the
same address; navigating away and back; closing a tab; close/reopen; the 420 px
dialog with scroll restoration; a complete workflow with mixed styles, all 35
labels, a long explanation edited later in the scrolling card editor, report
text, JSON reimport and restore; and a pixel-identical PNG after restoring at
DPR 2.

The Phase 3 lead regressions close Redline with Restore, Preview, the colour
picker and Clear confirmation open; close and reopen while preview capture is
pending; keep a cancelled recovery draft unchanged; and inject repeated failed
discards before retrying successfully. Additional model regressions preserve
older drafts when a save fails at the count limit or after navigation, reject
oversized unload saves cleanly, and retry failed removal of an empty session.

The model tests verify that rejected imports preserve dimensions, marks, and
both history stacks. Phase 3 model tests cover cursor validation, geometry,
hit testing and the pause/press tracker; report text and HTML escaping; the
draft envelope, prompt wording and autosaver (debounce, maximum wait,
deduplication, pause, discard ordering against in-flight writes, unload flush,
quota and size failures); the worker's draft store (tab and page isolation,
HMAC keys, bounds, moved sessions, quota without evicting other tabs); and the
capture guard (background tab, switch, switch back, navigation, rate-limit
retry). The PowerShell tests mock operating-system calls to verify
process isolation and path quoting without closing any real browser.

The suites build their own copy of the extension in a temp directory and add a
broad host permission there, because Playwright cannot click a toolbar icon and
so cannot trigger the real `activeTab` grant. The shipped manifest keeps
`activeTab`. Each run uses a fresh temporary browser profile, never your own.
DevTools inspects the closed shadow root in a separate test world; production
code and the ordinary page world gain no test hooks or exposed shadow root.

Three things the suites do **not** cover, all needing a human:

- **The Ctrl+Shift+R binding.** Chrome owns that key for hard reload, and a
  headless run cannot tell you which one wins on your machine. Check it after
  installing, and rebind at `chrome://extensions/shortcuts` if it loses.
- **Clipboard copy.** `navigator.clipboard.write` needs a focused document, and
  the page's Permissions-Policy can forbid it. The Phase 3 suite reads Copy
  image and Copy report back from headless Chromium's clipboard, and exercises a
  blocked page, but headless Chromium keeps its own clipboard: the
  operating-system clipboard was not written or checked, and nothing was pasted
  into a chat app, document editor or mail client. Which of the PNG, HTML and
  text a real destination uses on paste is unverified. Copy, cut and paste
  inside legend explanations are likewise tested with Chromium's in-browser
  clipboard only.
- **IME composition.** Text boxes use a native textarea and legend explanations
  a hidden one. Typing is tested with synthetic key events, and legend
  composition with DevTools `Input.imeSetComposition`/`insertText`; composing
  with a real input method editor (candidate window placement, reconversion) has
  not been verified.

## Development reload watcher

Run `./watch-reload.ps1` from PowerShell. It watches source changes and restarts
only Chrome processes whose `--user-data-dir` exactly matches this project's
`.chrome-redline-profile` directory. Paths with spaces are quoted, file-change
bursts are debounced, and profile/Git/dependency changes are ignored.

The development profile is ignored by Git and excluded from test copies.

## Limits

- Browser-internal pages (`chrome://`, the Web Store, other extensions) cannot
  host content scripts. The service worker declines them with a console note.
- `file://` pages need "Allow access to file URLs" enabled for the extension.
- Marks live in memory. An accidental reload of the same tab and page in the
  same browser session can restore them; closing the tab, restarting the
  browser, discarding the draft, or a full session store cannot — export the
  JSON to keep work.
- The pointer is a drawn stand-in, not the operating-system cursor or its
  shape (hand, text caret and so on).
- Annotations are screen-space. Scrolling or page layout changes move content
  out from under them.
- The overlay is created in the top frame only, not inside iframes.
