/**
 * Inline 24px stroke icons in one consistent style (Lucide-derived shapes,
 * ISC licence). Inline markup keeps icons inside the closed shadow root and
 * needs no extra requests.
 */
const ICON_SVG = {
  eyedropper: '<path d="m15 3 6 6M14 4l2-2a2.8 2.8 0 0 1 4 4l-2 2M14 6 3 17v4h4L18 10M5 17l2 2"/>',
  crop: '<path d="M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12"/>',
  select: '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  brush: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  rectangle: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9.5" ry="7"/>',
  note: '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  bullet: '<circle cx="12" cy="12" r="9"/><path d="M10.2 9.3 12.5 7.5v9"/>',
  legend: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="7.5" cy="9" r="1.2"/><circle cx="7.5" cy="15" r="1.2"/><path d="M11 9h6M11 15h6"/>',
  explain: '<path d="M4 6h10M4 11h7M4 16h5"/><path d="M19.4 11.6a1.4 1.4 0 0 0-2-2L12 15v2h2z"/>',
  textbox: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  delete: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/><path d="M14.5 11.5v6M11.5 14.5h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><rect x="7.5" y="11" width="5" height="4" rx=".6"/><path d="M14.5 12h2M14.5 14.5h2M7.5 18h9"/>',
  preview: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  cursor: '<path d="M5 3v15.5l4.2-4.1 2.9 6.6 2.8-1.2-2.9-6.5H18z"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19 3 3v-5.5"/><path d="m17 22 3-3"/><circle cx="9" cy="9" r="2"/>',
  json: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
  import: '<path d="M12 15V3"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  clear: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pin: '<path d="m15 4 5 5-3 3v4l-3 3-1-6-6-1 3-3h4z"/><path d="m9 15-5 5"/>',
  grip: '<path d="M9 3h2v2H9V3m4 0h2v2h-2V3M9 7h2v2H9V7m4 0h2v2h-2V7m-4 4h2v2H9v-2m4 0h2v2h-2v-2m-4 4h2v2H9v-2m4 0h2v2h-2v-2m-4 4h2v2H9v-2m4 0h2v2h-2v-2Z"/>',
  line: '<path d="M5 19 19 5"/>',
  polyline: '<path d="m3 17 5-10 5 6 8-8"/>',
  polygon: '<path d="m12 3 8.5 6-3.2 10H6.7L3.5 9z"/>',
  eraser: '<path d="m7 15 8.5-8.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L11 19H6l-3-3 4-4z"/><path d="M14 12 9 17"/>',
  tools: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  annotate: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  browse: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
};

export const ICON_NAMES = Object.keys(ICON_SVG);

export function iconElement(name) {
  const template = document.createElement('template');
  template.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_SVG[name] ?? ''}</svg>`;
  return template.content.firstElementChild;
}

export function appendIcon(button, name) {
  if (ICON_SVG[name]) button.prepend(iconElement(name));
  return button;
}
