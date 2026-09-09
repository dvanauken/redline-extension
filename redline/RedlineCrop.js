/** Crop coordinates share the annotation document's coordinate system. */
export const OUTPUT_SCALES = [0.5, 1, 2];

export function sanitizeCrop(crop, width, height) {
  if (crop == null) return null;
  if (typeof crop !== 'object' || Array.isArray(crop)
    || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key]))
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > width + 1e-7 || crop.y + crop.height > height + 1e-7) {
    throw new TypeError('Crop must be a positive rectangle inside the document.');
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

export function sanitizeOutputScale(value = 1) {
  if (!OUTPUT_SCALES.includes(value)) throw new TypeError('Output scale must be 0.5, 1, or 2.');
  return value;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function cropFromPoints(start, end, width, height) {
  const x1 = clamp(start.x, 0, width);
  const y1 = clamp(start.y, 0, height);
  const x2 = clamp(end.x, 0, width);
  const y2 = clamp(end.y, 0, height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function moveCrop(crop, dx, dy, width, height) {
  return { ...crop, x: clamp(crop.x + dx, 0, width - crop.width), y: clamp(crop.y + dy, 0, height - crop.height) };
}

export function resizeCrop(crop, handle, dx, dy, width, height, minWidth = 1, minHeight = 1) {
  let { x: left, y: top } = crop;
  let right = left + crop.width;
  let bottom = top + crop.height;
  minWidth = Math.min(minWidth, crop.width);
  minHeight = Math.min(minHeight, crop.height);
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, left + minWidth, width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minHeight, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Use actual capture pixels, rather than assuming the screen's device ratio. */
export function cropExportGeometry(doc, captureWidth, captureHeight) {
  const crop = doc.crop ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  const scale = doc.outputScale ?? 1;
  const source = {
    x: crop.x * captureWidth / doc.width,
    y: crop.y * captureHeight / doc.height,
    width: crop.width * captureWidth / doc.width,
    height: crop.height * captureHeight / doc.height,
  };
  return {
    crop, source,
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}
