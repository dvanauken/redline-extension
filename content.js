/**
 * Classic content-script bootstrap.
 *
 * Content scripts cannot be ES modules, so this file dynamically imports the
 * real module. The import is cached per frame, so repeated injections reuse the
 * same module scope — and therefore the same overlay instance.
 */
(() => {
  import(chrome.runtime.getURL('main.js'))
    .then(module => module.toggleRedline())
    .catch(error => console.error('[Redline] Failed to load the overlay.', error));
})();
