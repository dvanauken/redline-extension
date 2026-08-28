/** Register a custom element exactly once and return its constructor. */
export function defineElement(tagName, ElementClass) {
  // [extension patch] Chrome gives an isolated-world content script a null
  // custom-element registry, so registration is impossible there. Skip it
  // instead of throwing; hosts without a registry supply their own controls.
  if (!globalThis.customElements) return ElementClass;
  if (!customElements.get(tagName)) customElements.define(tagName, ElementClass);
  return ElementClass;
}

/** Register a list of [tagName, constructor] pairs. */
export function defineElements(definitions) {
  for (const [tagName, ElementClass] of definitions) defineElement(tagName, ElementClass);
  return definitions.map(([, ElementClass]) => ElementClass);
}
