# Redline — Chrome extension

Annotate any web page with pen, arrow, rectangle, numbered note, and text-box
marks, then hand an annotated PNG or a portable JSON file to an LLM.

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
| Tools | select, pen, highlighter, line, arrow, rectangle, numbered note, multiline text box; Paths menu for polyline, polygon, and eraser |
| Shortcuts | `V P B L A R N T E` pick a tool, `Ctrl+Z` / `Ctrl+Y` undo and redo, `Esc` closes; Tab and Shift+Tab reach every toolbar control |
| Export | annotated PNG (download or clipboard) and `open-redline` v1 JSON |
| Import | round-trips its own JSON; malformed files are rejected without losing marks |
| Session | marks survive closing and reopening within the same page load |

### Use the page while Redline is open

Click **Page** or press **F2** to use the webpage normally. The toolbar dims,
and the page receives clicks, typing, and scrolling. Click **Annotate** or
press **F2** again to resume drawing. The green toolbar border indicates that
annotation mode is active.

**Pin** docks the toolbar at the top-left and highlights while engaged. It works
in both modes. Click it again to unpin, or drag the grip to undock and move it.

Marks and the crop are hidden in Page mode and retained when you return.
They stay at their screen positions; if scrolling or page layout changes move
the underlying content, reposition the marks to match.

### Crop and resize an export

Choose the **Crop** icon (or press **C**), then drag a rectangle around the
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

## How it is put together

```
manifest.json       MV3: activeTab, scripting, clipboardWrite, storage; Ctrl+Shift+R
service-worker.js   injects the bootstrap; answers capture requests
content.js          classic bootstrap; dynamically imports main.js
main.js             host integration — shadow root, adapters, one overlay
host-dialogs.js     native <dialog> note entry and clear confirmation
color-picker.js     plain-element colour control (see "custom elements" below)
redline/            the runtime, owned by this extension
test/               real-browser acceptance suite
```

### Isolation

The overlay mounts inside a **closed shadow root** on a host `<div>`.
Page CSS cannot reach the toolbar, and the extension does not restyle the page.
`redline.css` is fetched from the extension and adopted as a constructed
stylesheet, which also sidesteps any page Content-Security-Policy.

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

### Capture

`chrome.tabs.captureVisibleTab()` runs in the service worker and returns a PNG
data URL of the visible tab. This is supplied as the overlay's `capturePage`
adapter, which short-circuits its `getDisplayMedia` path — so **there is no
share-screen picker**, unlike an in-page install. The overlay hides itself
before capture; `capturePage` waits two animation frames so the hide has
actually painted.

The capture image dimensions determine export resolution, and the overlay scales
annotations to match. The browser suite checks native device scale factor 2 as
well as resized viewport geometry.

### Permissions

`activeTab` is granted by the toolbar click or the keyboard command, and covers
both `executeScript` and `captureVisibleTab` for that tab. There is no broad
host permission: the extension can only see a page you explicitly invoke it on.
The `storage` permission saves tool preferences locally in the extension.

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
not imported. Annotations remain in memory until exported or the page reloads.
The screenshot contains whatever is on screen; look before you send.

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

```bash
node --test test/document.test.mjs
node --test test/crop.test.mjs
node test/run.mjs      # needs playwright and its Chromium browser
pwsh -NoProfile -File test/watch-reload.ps1
```

The browser suite runs headless by default; pass `--headed` to see the browser.
It exercises all drawing tools, undo/redo, dialogs, closed-shadow text editing,
full keyboard traversal, native DPR 2 capture, PNG pixel alignment after resize,
JSON round-trips, rejected imports, session retention, URL redaction, website
storage isolation, preference restoration on another origin, and narrow layouts.

The model tests verify that rejected imports preserve dimensions, marks, and
both history stacks. The PowerShell tests mock operating-system calls to verify
process isolation and path quoting without closing any real browser.

The suite builds its own copy of the extension in a temp directory and adds a
broad host permission there, because Playwright cannot click a toolbar icon and
so cannot trigger the real `activeTab` grant. The shipped manifest keeps
`activeTab`. The copy excludes browser profiles, Git metadata, and dependencies.
DevTools inspects the closed shadow root in a separate test world; production
code and the ordinary page world gain no test hooks or exposed shadow root.

Two things the suite does **not** cover, both needing a human:

- **The Ctrl+Shift+R binding.** Chrome owns that key for hard reload, and a
  headless run cannot tell you which one wins on your machine. Check it after
  installing, and rebind at `chrome://extensions/shortcuts` if it loses.
- **Clipboard copy.** `navigator.clipboard.write` needs a focused document and a
  real user gesture. The PNG **download** path is fully tested and shares all of
  its capture and compositing code with copy; only the final clipboard write is
  unverified.

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
- Marks are per page load and live in memory. A reload discards them — export
  the JSON first.
- The overlay is created in the top frame only, not inside iframes.
