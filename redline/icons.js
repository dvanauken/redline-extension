const ICON_SVG = {
  select: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>',
  brush: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
  rectangle: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/></svg>',
  textbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 3v4l-3 3-1-6-6-1 3-3h4z"/><path d="m9 15-5 5"/></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="7" r="1.4"/><circle cx="16" cy="7" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="8" cy="17" r="1.4"/><circle cx="16" cy="17" r="1.4"/></svg>',
  line: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5"/></svg>',
  polyline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 5-10 5 6 6-8"/></svg>',
  polygon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 6-3 10H7L4 9z"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 8.5-8.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L11 19H6l-3-3 4-4z"/><path d="M14 12 9 17"/></svg>',
};

export function appendIcon(button, name) {
  const template = document.createElement('template');
  template.innerHTML = ICON_SVG[name] ?? '';
  const icon = template.content.firstElementChild;
  if (icon) button.prepend(icon);
  return button;
}
