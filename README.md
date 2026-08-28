# Redline — Chrome extension

Annotate any web page with pen, arrow, rectangle, numbered note, and text-box
marks, then hand an annotated PNG or a portable JSON file to an LLM.

This packages the framework-free Redline overlay from the `add-redline` skill as
a Manifest V3 extension, so the feature is available everywhere instead of being
installed per application.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this directory.

Open the overlay with the toolbar button or **Ctrl+Shift+R**.

Chrome also uses Ctrl+Shift+R for hard reload. If the shortcut does not take,
rebind it at `chrome://extensions/shortcuts` — that page is the authority, and
the extension does not fight the browser for the key.

## What it does

| | |
| --- | --- |
| Tools | select, pen, arrow, rectangle, numbered note, multiline text box |
| Shortcuts | `V P A R N T` pick a tool, `Ctrl+Z` / `Ctrl+Y` undo and redo, `Esc` closes |
| Export | annotated PNG (download or clipboard) and `open-redline` v1 JSON |
| Import | round-trips its own JSON; malformed files are rejected without losing marks |
| Session | marks survive closing and reopening within the same page load |

Marks live in screen space over a screenshot. Nothing is written to the page,
and the page's own undo history is never touched.

## How it is put together

```
manifest.json       MV3: activeTab, scripting, clipboardWrite; Ctrl+Shift+R command
service-worker.js   injects the bootstrap; answers capture requests
content.js          classic bootstrap; dynamically imports main.js
main.js             host integration — shadow root, adapters, one overlay
host-dialogs.js     native <dialog> note entry and clear confirmation
color-picker.js     plain-element colour control (see "custom elements" below)
redline/            the runtime, owned by this extension
test/               real-browser acceptance suite
```

### Isolation

The overlay mounts inside a **shadow root** on a zero-size host `<div>`.
Page CSS cannot reach the toolbar, and the extension does not restyle the page.
`redline.css` is fetched from the extension and adopted as a constructed
stylesheet, which also sidesteps any page Content-Security-Policy.

Exactly one rule has to live in the page, because it targets `<body>`:
`body[data-redline-active] { overflow: hidden; }`. It is adopted onto the
document and removed again by `destroyRedline()`.

Everything runs in the content script's **isolated world**, so page scripts
cannot read or tamper with the overlay, and a strict page CSP cannot block it.

### Capture

`chrome.tabs.captureVisibleTab()` runs in the service worker and returns a PNG
data URL of the visible tab. This is supplied as the overlay's `capturePage`
adapter, which short-circuits its `getDisplayMedia` path — so **there is no
share-screen picker**, unlike an in-page install. The overlay hides itself
before capture; `capturePage` waits two animation frames so the hide has
actually painted.

Captured images come back at the device pixel ratio, and the overlay scales the
annotations to match.

### Permissions

`activeTab` is granted by the toolbar click or the keyboard command, and covers
both `executeScript` and `captureVisibleTab` for that tab. There is no broad
host permission: the extension can only see a page you explicitly invoke it on.

### Privacy

Exports are files you hand to someone else, so the address is trimmed:
`page.url` records **origin and path only**. Query strings and fragments carry
session tokens, password-reset tokens, and search terms, and are dropped. When
something was dropped, `context.urlRedacted` is `true` so a reader knows the
address is not the whole address.

Nothing else about the page is read — no DOM text, no storage, no cookies. The
screenshot, of course, contains whatever is on screen; look before you send.

## Changes to the bundled runtime

`redline/` is the canonical package from the `add-redline` skill with seven
marked changes. Each is searchable as `[extension patch]`, and the package still
passes the skill's verifier. Five are shadow-DOM or content-script corrections;
two add host seams rather than changing behaviour.

| # | File | Change | Why |
| --- | --- | --- | --- |
| 1 | `RedlineOverlay.js` | colour dialog appends to `options.mount`, not `document.body` | it was escaping the shadow root and losing its styles |
| 2 | `RedlineOverlay.js` | Tab cycling reads `root.getRootNode().activeElement` | `document.activeElement` is the shadow **host**, so Tab always jumped back to the first button |
| 3 | `vendor/wb/define-element.js` | skip registration when there is no registry | Chrome gives an isolated world a **null** `customElements`; the import threw and the whole overlay failed to load |
| 4 | `RedlineOverlay.js` | new `createColorPicker` option | lets a host without a registry supply its own control |
| 5 | `RedlineOverlay.js` | guard `customElements.whenDefined` | same null registry |
| 6 | `RedlineOverlay.js` | new `describePage` option; the built-in block was hardcoded to `location.href` | a host on arbitrary sites must be able to redact the URL |
| 7 | `RedlineOverlay.js` | key handler uses `composedPath()[0]`, not `event.target` | **the important one** — see below |

### Patch 7

The overlay listens for keys on `window`. Inside a shadow root every event
retargets, so `event.target` is the shadow host and never the textarea being
typed into. Two guards therefore failed open:

- the "is the user editing text?" check, so the letters `v p a r n t` were
  swallowed as tool shortcuts instead of typed — you could not write the word
  "print" into a text box; and
- the `editable` check, so `Backspace` deleted the selected mark rather than a
  character.

`event.composedPath()[0]` is the element actually typed in, across shadow
boundaries. Both regressions are covered by the suite.

Patches 1, 2, 3, 5, and 7 are latent bugs in the canonical package that only
appear under shadow DOM or in a content script; they are worth folding back
upstream.

## Tests

```bash
node test/run.mjs      # needs playwright
```

37 checks against a real Chromium with the extension loaded: shadow isolation
against a deliberately hostile stylesheet, every drawing tool, undo/redo, the
host dialogs, Tab cycling, tab capture with a device-pixel-ratio assertion,
JSON round-trip and malformed-import rejection, close/reopen session retention,
proof that no URL secret reaches an export, and a narrow-viewport check.

The suite builds its own copy of the extension in a temp directory and adds a
broad host permission there, because Playwright cannot click a toolbar icon and
so cannot trigger the real `activeTab` grant. The shipped manifest keeps
`activeTab`.

Two things the suite does **not** cover, both needing a human:

- **The Ctrl+Shift+R binding.** Chrome owns that key for hard reload, and a
  headless run cannot tell you which one wins on your machine. Check it after
  installing, and rebind at `chrome://extensions/shortcuts` if it loses.
- **Clipboard copy.** `navigator.clipboard.write` needs a focused document and a
  real user gesture. The PNG **download** path is fully tested and shares all of
  its capture and compositing code with copy; only the final clipboard write is
  unverified.

## Limits

- Browser-internal pages (`chrome://`, the Web Store, other extensions) cannot
  host content scripts. The service worker declines them with a console note.
- `file://` pages need "Allow access to file URLs" enabled for the extension.
- Marks are per page load and live in memory. A reload discards them — export
  the JSON first.
- The overlay is created in the top frame only, not inside iframes.
