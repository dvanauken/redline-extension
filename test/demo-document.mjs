/**
 * A synthetic document exercising independent fill/outline paint, graduated fill opacity,
 * independent outline and fill colours, and every end decoration.
 * Coordinates are laid out for a 1200 × 800 document.
 */
export const DEMO_OPACITIES = [0.1, 0.25, 0.5, 0.75, 1];

export const DEMO_ENDS = [
  ['none', 'none'],
  ['none', 'arrow'],
  ['arrow', 'none'],
  ['arrow', 'arrow'],
  ['filled-circle', 'arrow'],
  ['open-circle', 'open-circle'],
  ['open-circle', 'filled-circle'],
];

export function demoDocument({ width = 1200, height = 800 } = {}) {
  // Marks are laid out for 1200 × 800; other sizes scale them non-uniformly.
  const annotations = [];
  DEMO_OPACITIES.forEach((fillOpacity, index) => {
    const x = 60 + index * 150;
    annotations.push({
      id: `rect-${index}`, type: 'rectangle', color: '#1D4ED8', fill: '#DC2626', fillOpacity, width: 2.667,
      start: { x, y: 170 }, end: { x: x + 120, y: 260 },
    });
  });
  annotations.push(
    { id: 'rect-outline', type: 'rectangle', color: '#16A34A', width: 2, start: { x: 810, y: 170 }, end: { x: 930, y: 260 } },
    { id: 'ellipse-fill-only', type: 'ellipse', color: '#7C3AED', fillOpacity: 0.5, outline: false, width: 2, start: { x: 960, y: 170 }, end: { x: 1140, y: 260 } },
    {
      id: 'polygon-outline-fill', type: 'polygon', color: '#D97706', fill: '#FDE68A', fillOpacity: 0.75, width: 2,
      points: [{ x: 960, y: 300 }, { x: 1130, y: 320 }, { x: 1080, y: 420 }, { x: 990, y: 400 }],
    },
  );
  DEMO_ENDS.forEach(([startDecoration, endDecoration], index) => {
    const y = 320 + index * 42;
    annotations.push({
      id: `line-${index}`, type: 'line', color: '#111827', width: 2.667,
      start: { x: 80, y }, end: { x: 360, y }, startDecoration, endDecoration,
    });
  });
  annotations.push(
    {
      id: 'polyline-ends', type: 'polyline', color: '#DC2626', width: 2.667, startDecoration: 'filled-circle', endDecoration: 'arrow',
      points: [{ x: 460, y: 330 }, { x: 560, y: 420 }, { x: 560, y: 420 }, { x: 680, y: 340 }, { x: 800, y: 450 }],
    },
    { id: 'legacy-arrow', type: 'arrow', color: '#2563EB', width: 4, start: { x: 460, y: 520 }, end: { x: 800, y: 520 } },
    {
      id: 'text', type: 'textbox', color: '#B65D66', width: 1.333, fontSize: 16, backgroundOpacity: 1,
      start: { x: 460, y: 570 }, end: { x: 760, y: 650 }, text: 'Graduated fills 10–100%\nand every line end',
    },
    { id: 'note', type: 'note', color: '#B65D66', width: 1.333, point: { x: 880, y: 600 }, text: 'Legacy note', number: 1 },
  );
  return { format: 'open-redline', version: 1, document: { width, height, annotations } };
}
