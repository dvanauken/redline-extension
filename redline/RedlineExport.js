/**
 * Capture decoding, image composition and file hand-off.
 *
 * Export bytes and their object URLs never enter the page's DOM. A link
 * appended to `document.body`, even for an instant, is visible to any page
 * MutationObserver, which can then fetch the blob. Shadow DOM does not help
 * there: the link was outside it.
 */

import { cropExportGeometry } from './RedlineCrop.js';
import { drawRedlineDocument } from './RedlineCanvas.js';

export const MAX_EXPORT_SIDE = 32767;
export const MAX_EXPORT_PIXELS = 64_000_000;

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('The browser could not encode the redline image.')),
    'image/png',
  ));
}

export async function captureSourceToCanvas(value) {
  const source = value?.canvas ?? value?.image ?? value?.dataUrl ?? value;
  if (source instanceof HTMLCanvasElement) return source;

  let drawable = source;
  let objectURL = null;
  if (source instanceof Blob) {
    objectURL = URL.createObjectURL(source);
    drawable = objectURL;
  }
  try {
    if (typeof drawable === 'string') {
      drawable = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new TypeError('The capture image could not be decoded.'));
        image.src = drawable;
      });
    }
    const width = drawable?.naturalWidth ?? drawable?.videoWidth ?? drawable?.width;
    const height = drawable?.naturalHeight ?? drawable?.videoHeight ?? drawable?.height;
    if (!width || !height) {
      throw new TypeError('A capture callback must return a canvas, image, Blob, or image data URL.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(drawable, 0, 0);
    return canvas;
  } finally {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * What this browser says its asynchronous clipboard accepts. `ClipboardItem.supports`
 * answers where available (Chrome 121+); older browsers are assumed to accept
 * the three standard types, and a refused write is still caught by the caller.
 */
export function clipboardSupport() {
  const api = Boolean(globalThis.navigator?.clipboard?.write && globalThis.ClipboardItem);
  const probed = api && typeof ClipboardItem.supports === 'function';
  const supports = type => {
    if (!api) return false;
    if (!probed) return ['image/png', 'text/plain', 'text/html'].includes(type);
    try { return ClipboardItem.supports(type); } catch { return false; }
  };
  return { api, probed, png: supports('image/png'), text: supports('text/plain'), html: supports('text/html') };
}

export function timestampName(extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `redline-${stamp}.${extension}`;
}

/**
 * Save a Blob as a file without exposing it to the page.
 *
 * The anchor is never attached to any document, so no page observer sees it,
 * and a click on a detached element does not propagate to page listeners.
 */
export function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  // Give the browser time to start reading the blob before it is released.
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/**
 * Draw a document's marks over a captured screenshot, honouring crop and
 * output scale. `snapshot` is a plain document object (RedlineDocument#toJSON).
 * When the capture already shows the real cursor (`includesCursor`), the proxy
 * is not drawn a second time.
 */
export function composeAnnotatedCanvas(snapshot, captureCanvas, { measurer, includesCursor = false }) {
  const { crop, source, width, height } = cropExportGeometry(snapshot, captureCanvas.width, captureCanvas.height);
  if (width > MAX_EXPORT_SIDE || height > MAX_EXPORT_SIDE || width * height > MAX_EXPORT_PIXELS) {
    throw new Error('Output is too large. Choose a smaller crop or output scale.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(captureCanvas, source.x, source.y, source.width, source.height, 0, 0, width, height);
  const scaleX = width / crop.width;
  const scaleY = height / crop.height;
  ctx.save();
  ctx.translate(-crop.x * scaleX, -crop.y * scaleY);
  drawRedlineDocument(ctx, snapshot, { scaleX, scaleY, measurer, cursor: !includesCursor });
  ctx.restore();
  return canvas;
}

/**
 * Capture the page beneath the overlay.
 *
 * A host `capturePage` adapter (the extension's captureVisibleTab) wins. A
 * standalone page falls back to the tab share picker, then to a host-drawn
 * viewport. `whileHidden` hides the overlay for the duration of a capture.
 *
 * An adapter whose image already contains the real pointer returns
 * `includesCursor: true`, so composition does not add the proxy as well.
 */
export async function captureBaseImage({ capturePage, captureFallback, whileHidden }) {
  let nativeError = null;
  if (capturePage) {
    const result = await whileHidden(() => capturePage());
    return {
      canvas: await captureSourceToCanvas(result),
      scope: result?.scope ?? 'host-page',
      includesCursor: result?.includesCursor === true,
    };
  }
  if (navigator.mediaDevices?.getDisplayMedia) {
    try {
      return await whileHidden(() => captureBrowserTab());
    } catch (error) {
      nativeError = error;
      console.warn('[Redline] Browser-tab capture unavailable; using viewport fallback.', error);
    }
  }
  if (captureFallback) {
    const result = await whileHidden(() => captureFallback());
    return {
      canvas: await captureSourceToCanvas(result),
      scope: result?.scope ?? 'viewport-fallback',
      includesCursor: result?.includesCursor === true,
    };
  }
  throw nativeError ?? new Error('No page capture method is available in this browser.');
}

async function captureBrowserTab() {
  let stream;
  try {
    // The picker cannot be bypassed by page code. preferCurrentTab keeps the
    // intended choice prominent while still respecting browser permission.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    });
    const track = stream.getVideoTracks()[0];
    const surface = track?.getSettings?.().displaySurface;
    if (surface && surface !== 'browser') {
      throw new Error('Choose “This Tab” in the share picker so annotations align with the screenshot.');
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return { canvas, scope: 'browser-tab' };
  } finally {
    stream?.getTracks().forEach(track => track.stop());
  }
}
