/**
 * WbBaseElement — base class for all wb-components.
 *
 * Resource model (contract §5, spec §3):
 * - Production path: subclasses carry `static template` (HTML string) and
 *   `static styles` (CSS string), generated at build time from the sibling
 *   `.html`/`.css` files (see docs/build-inlining-spec.md). Styles become one
 *   shared constructable CSSStyleSheet per unique CSS string, adopted via
 *   `shadowRoot.adoptedStyleSheets`; templates parse once and clone per
 *   instance. Zero runtime fetches.
 * - Legacy path (dev / not-yet-migrated components): when neither static is
 *   set, resources are fetched relative to `resourcePath`/`_moduleUrl` as
 *   before. This path disappears once all components are migrated (task 004).
 *
 * Set `WbBaseElement.devMode = true` (before elements connect) to force the
 * fetch path even for migrated components — lets you edit .css/.html and
 * refresh without rebuilding, when serving from source.
 */

/** @type {Map<string, CSSStyleSheet>} keyed by CSS text — shared across classes */
const sheetCache = new Map();
/** @type {Map<string, HTMLTemplateElement>} keyed by HTML text */
const templateCache = new Map();
/** @type {Map<string, {html: string, promise: Promise<void>}>} legacy fetch cache */
const fetchCache = new Map();
/** CSS text already injected into `document` (light-DOM elements). */
const documentInjected = new Set();

/**
 * Name of the cascade layer every light-DOM component stylesheet is wrapped in.
 * Page CSS is unlayered, and unlayered rules beat every layer no matter how
 * specific the layered rule is — so `wb-table th { … }` in the page wins over
 * `wb-table thead th { … }` here without `!important` or specificity games.
 * Nothing outside this file needs to know the name exists.
 */
const STYLE_LAYER = 'wb';

/**
 * Inject a light-DOM component's stylesheet into <head>, wrapped in the
 * component layer.
 *
 * `document.adoptedStyleSheets` cannot be used: the spec orders adopted sheets
 * AFTER the document's own stylesheets, and there is no way to layer or reorder
 * them, so component rules would beat page rules of equal specificity.
 *
 * Placement is still first-in-<head> so that, among equals, later wins —
 * relevant only between two layered sheets (i.e. two components).
 */
function injectDocumentStyles(cssText) {
  if (documentInjected.has(cssText)) return;
  documentInjected.add(cssText);
  const style = document.createElement('style');
  style.dataset.wb = '';
  style.textContent = `@layer ${STYLE_LAYER} {\n${cssText}\n}`;
  const head = document.head;
  // After any sheet we already injected, before everything the author wrote.
  const ours = head.querySelectorAll('style[data-wb]');
  head.insertBefore(style, ours.length ? ours[ours.length - 1].nextSibling : head.firstChild);
}

function getSheet(cssText) {
  let sheet = sheetCache.get(cssText);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    sheetCache.set(cssText, sheet);
  }
  return sheet;
}

function getTemplate(htmlText) {
  let tpl = templateCache.get(htmlText);
  if (!tpl) {
    tpl = document.createElement('template');
    tpl.innerHTML = htmlText;
    templateCache.set(htmlText, tpl);
  }
  return tpl;
}

export class WbBaseElement extends HTMLElement {

  /** Global switch: force the runtime-fetch path (dev only). */
  static devMode = false;

  static resourcePath = './';
  static tagName = null;
  /**
   * Base filename (no extension) for this element's HTML/CSS, resolved
   * relative to `resourcePath`. Defaults to the tag name. Set this when a
   * subclass should reuse a sibling's resources instead of forking copies.
   * (Inlined equivalent: import the sibling's `.resources.js` module.)
   */
  static resourceName = null;
  static hasTemplate = true;
  static hasStyles = true;

  /**
   * Baseline stylesheet every light-DOM component gets, scoped to its own tag
   * and injected ahead of the component's own CSS.
   *
   * Text selection is off by default: these are application chrome, and
   * double-clicking a cell or dragging across a toolbar should not smear a blue
   * highlight over the widget. Form controls opt back in, so typing, selecting
   * and copying inside an editor behaves normally.
   *
   * @param {string} tag the component's registered tag name
   */
  static baseStyles(tag) {
    return `${tag} {
  -webkit-user-select: none;
  user-select: none;
}
${tag} :is(input, textarea, [contenteditable]) {
  -webkit-user-select: text;
  user-select: text;
}`;
  }

  /**
   * Build-time inlined resources (strings). When either is non-null the
   * component renders synchronously with no fetch. Generated modules assign
   * these; see docs/build-inlining-spec.md.
   * @type {string|null}
   */
  static template = null;
  /** @type {string|null} */
  static styles = null;

  /**
   * Set to `false` in subclasses that render into light DOM (wb-accordion-item,
   * wb-tab, wb-form, wb-table). No shadow root is attached; `styles` (if any)
   * are adopted once into `document.adoptedStyleSheets`, and `template` renders
   * into the element itself.
   *
   * Light-DOM components own their whole subtree — `template` replaces any
   * children the author wrote — so this is only safe for components that take
   * no slotted content. Their CSS must also be written scoped to the tag
   * (`wb-table .toolbar`, not `.toolbar`), since it is now global.
   */
  static shadow = true;

  static getTagName() {
    if (this.tagName) return this.tagName;
    return this.name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }

  static register(name) {
    const tagName = name || this.getTagName();
    if (!customElements.get(tagName)) {
      customElements.define(tagName, this);
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy fetch path (removed when task 004 migrates all components)
  // ---------------------------------------------------------------------------

  static async loadResources() {
    const className = this.name;
    if (fetchCache.has(className)) {
      const cached = fetchCache.get(className);
      await cached.promise;
      return cached.html;
    }
    const entry = { html: '', promise: null };
    entry.promise = this._loadResources(entry);
    fetchCache.set(className, entry);
    await entry.promise;
    return entry.html;
  }

  static async _loadResources(entry) {
    const resourceName = this.resourceName || this.getTagName();
    const moduleUrl = this._moduleUrl;
    const base = new URL(this.resourcePath, moduleUrl || import.meta.url);
    const loadPromises = [];
    let css = '';
    let html = '';

    if (this.hasStyles) {
      loadPromises.push(
        fetch(new URL(`./${resourceName}.css`, base))
          .then(r => { if (!r.ok) throw new Error(`CSS ${r.status}: ${r.url}`); return r.text(); })
          .then(text => { css = text; })
          .catch(err => console.warn(`[${this.name}] CSS:`, err.message))
      );
    }

    if (this.hasTemplate) {
      loadPromises.push(
        fetch(new URL(`./${resourceName}.html`, base))
          .then(r => { if (!r.ok) throw new Error(`HTML ${r.status}: ${r.url}`); return r.text(); })
          .then(text => { html = text; })
          .catch(err => console.warn(`[${this.name}] HTML:`, err.message))
      );
    }

    await Promise.all(loadPromises);
    entry.html = css ? `<style>${css}</style>${html}` : html;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  _initialized = false;
  _abortController = null;

  /**
   * Light-DOM components only: the children the author wrote between the tags,
   * moved aside before `template` rendered over them. Null when there were
   * none, or when the component uses a shadow root (there they stay put).
   * @type {DocumentFragment|null}
   */
  _authorContent = null;

  /** Author-written content, wherever it ended up. Query it like an element. */
  get authorContent() { return this._authorContent ?? this; }

  constructor() {
    super();
    if (this.constructor.shadow) {
      this.attachShadow({ mode: 'open' });
    }
  }

  async connectedCallback() {
    this._abortController = new AbortController();
    // Captured, not re-read: disconnectedCallback nulls the field, and a
    // reconnect creates a fresh controller — this run must keep answering
    // for the connection it started with.
    const signal = this._abortController.signal;
    try {
      const ctor = this.constructor;

      // A light-DOM component renders its template over its own children, so
      // it must not do that until the parser has actually delivered them.
      // connectedCallback fires on the START tag — at that moment
      // `<wb-table><wb-table-column>…` still looks empty.
      if (!this.shadowRoot && ctor.template != null && document.readyState === 'loading') {
        await new Promise(resolve =>
          document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        if (signal.aborted) return;     // removed while waiting
      }

      const inlined = (ctor.template != null || ctor.styles != null);
      if (inlined && !WbBaseElement.devMode) {
        this._renderInlined();          // synchronous — no FOUC, no fetch
      } else {
        await this._renderFetched();    // legacy / dev
        if (signal.aborted) return;     // removed during fetch
      }
      await this.onInit();
      if (signal.aborted) return;       // removed during onInit
      this._initialized = true;
      this._emit('ready', { element: this });
    } catch (err) {
      console.error(`[${this.constructor.name}] Initialization failed:`, err);
      this._emit('error', { error: err });
    }
  }

  _renderInlined() {
    const ctor = this.constructor;
    if (ctor.styles != null) {
      if (this.shadowRoot) {
        this.shadowRoot.adoptedStyleSheets = [getSheet(ctor.styles)];
      } else {
        // Baseline first so the component's own rules win ties. Both are
        // deduped by text, so this costs one <style> per tag, not per instance.
        injectDocumentStyles(WbBaseElement.baseStyles(ctor.getTagName()));
        injectDocumentStyles(ctor.styles);
      }
    }
    if (ctor.template != null) {
      // replaceChildren keeps reconnect idempotent (matches old innerHTML behavior).
      // A light-DOM component renders into itself, so the template would wipe
      // out whatever the author wrote between the tags. Move that aside first
      // and hand it to the subclass as `authorContent` — declarative config
      // like <wb-table><script type="application/json">…</script></wb-table>
      // lives there, and under Shadow DOM it used to survive automatically.
      if (!this.shadowRoot && this.firstChild) {
        const stash = document.createDocumentFragment();
        stash.append(...this.childNodes);
        this._authorContent = stash;
      }
      const root = this.shadowRoot ?? this;
      root.replaceChildren(getTemplate(ctor.template).content.cloneNode(true));
    }
  }

  async _renderFetched() {
    if (!this.shadowRoot) return; // light-DOM elements have no fetch path
    const html = await this.constructor.loadResources();
    this.shadowRoot.innerHTML = html;
  }

  disconnectedCallback() {
    this._abortController?.abort();
    this._abortController = null;
    this.onDestroy();
    this._initialized = false;
  }

  async onInit() {}
  onDestroy() {}

  // ---------------------------------------------------------------------------
  // Events (contract §1/§2)
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a commit/notification event. Non-cancelable per contract §1.
   */
  _emit(eventName, detail = {}, bubbles = true, composed = true) {
    const name = eventName.startsWith('wb-') ? eventName : `wb-${eventName}`;
    return this.dispatchEvent(new CustomEvent(name, {
      bubbles, composed, detail, cancelable: false
    }));
  }

  /**
   * Dispatch a cancelable `wb-request-<name>` event (contract §2).
   * @returns {boolean} false if a listener called preventDefault() — the
   *   caller MUST abort the state change in that case.
   */
  _emitRequest(eventName, detail = {}) {
    return this.dispatchEvent(new CustomEvent(`wb-request-${eventName}`, {
      bubbles: true, composed: true, cancelable: true, detail
    }));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  // Query root: shadow root, or the element itself for light-DOM subclasses.
  // (Deliberately not a `_root` getter — subclasses use that name, e.g. wb-window-builder.)
  $(selector) { return (this.shadowRoot ?? this).querySelector(selector); }
  $$(selector) { return (this.shadowRoot ?? this).querySelectorAll(selector); }

  /** Clone a named inert fragment declared in the component's HTML resource. */
  _cloneTemplate(name) {
    const source = [...this.$$('template[data-template]')]
      .find(template => template.dataset.template === name);
    if (!source) {
      throw new Error(`[${this.constructor.getTagName()}] Missing template: ${name}`);
    }
    return source.content.cloneNode(true);
  }

  _listen(target, event, handler, options = {}) {
    // No live controller means the element is disconnected (onInit can still
    // be mid-await when that happens). Registering would attach a listener
    // with no abort signal — one that teardown can never remove — so skip it,
    // matching what _timeout/_raf already do.
    const signal = this._abortController?.signal;
    if (!signal || signal.aborted) return;
    const listenerOptions = typeof options === 'boolean'
      ? { capture: options }
      : (options || {});
    target.addEventListener(event, handler, {
      ...listenerOptions,
      signal
    });
  }

  /**
   * setTimeout that auto-cancels when the element disconnects (spec R2.3).
   * @returns {number} timer id (0 if already disconnected)
   */
  _timeout(fn, ms) {
    const signal = this._abortController?.signal;
    if (!signal || signal.aborted) return 0;
    const cancel = () => clearTimeout(id);
    const id = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      fn();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    return id;
  }

  /**
   * requestAnimationFrame that auto-cancels on disconnect (spec R2.3).
   * @returns {number} rAF id (0 if already disconnected)
   */
  _raf(fn) {
    const signal = this._abortController?.signal;
    if (!signal || signal.aborted) return 0;
    const cancel = () => cancelAnimationFrame(id);
    const id = requestAnimationFrame(t => {
      signal.removeEventListener('abort', cancel);
      fn(t);
    });
    signal.addEventListener('abort', cancel, { once: true });
    return id;
  }

  get isInitialized() { return this._initialized; }
}

export default WbBaseElement;
