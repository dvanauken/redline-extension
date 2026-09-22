/**
 * Export actions of a RedlineOverlay: portable JSON, the annotated PNG (tab or
 * full page) to the clipboard or a download, Copy report, and the export
 * preview.
 *
 * It keeps no document state of its own. It reads the overlay's document and
 * uses the overlay's busy state, messages and child-dialog handling; the
 * overlay's public export methods delegate here.
 */

import { RedlineDocument } from './RedlineDocument.js';
import { cursorInsideCrop } from './RedlineCursor.js';
import {
  blobToDataUrl, canvasToBlob, captureBaseImage, clipboardSupport, composeAnnotatedCanvas,
  composeFullPageAnnotatedCanvas, downloadBlob, timestampName,
} from './RedlineExport.js';
import { layoutLegend, legendClipping } from './RedlineLegend.js';
import { RedlinePreview } from './RedlinePreview.js';
import { buildReport, reportCounts } from './RedlineReport.js';

/** The useful part of a clipboard error, without the API boilerplate or a help link. */
const clipboardReason = error => String(error?.message ?? error)
  .replace(/^Failed to execute '\w+' on 'Clipboard':\s*/, '')
  .replace(/\s*See https?:\/\/\S+.*$/, '')
  .replace(/\.$/, '') || 'refused';

export class RedlineOverlayExport {
  constructor(overlay) {
    this.overlay = overlay;
    /** The preview dialog, built on first use. */
    this.preview = null;
    /** The capture the open preview shows, reused by its export actions. */
    this._previewState = null;
  }

  async getExportData() {
    const overlay = this.overlay;
    const context = await Promise.resolve(overlay.options.getContext());
    return {
      format: 'open-redline',
      version: 1,
      createdAt: overlay.sessionStartedAt ?? new Date().toISOString(),
      exportedAt: new Date().toISOString(),
      page: await Promise.resolve(overlay.options.describePage()),
      context: context ?? {},
      document: overlay.document?.toJSON() ?? new RedlineDocument().toJSON(),
    };
  }

  async downloadJSON() {
    this.overlay.gestures.cancel();
    const data = await this.getExportData();
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), timestampName('redline.json'));
    this.overlay._setMessage('Redline data downloaded');
    return data;
  }

  async captureAnnotatedImage({ fullPage = false } = {}) {
    const overlay = this.overlay;
    if (!overlay.document) throw new Error('Open redline mode before capturing.');
    overlay.textEditor.finish({ commit: true });
    overlay.legendEditor.commit({ focus: false });
    overlay.gestures.cancel();
    const snapshot = overlay.document.toJSON();
    const capture = await this.captureBase({ fullPage });
    const canvas = fullPage
      ? composeFullPageAnnotatedCanvas(snapshot, capture.canvas, {
        page: capture.page, measurer: overlay.measurer, includesCursor: capture.includesCursor,
      })
      : composeAnnotatedCanvas(snapshot, capture.canvas, { measurer: overlay.measurer, includesCursor: capture.includesCursor });
    return { canvas, scope: capture.scope, snapshot, capture };
  }

  async copyImage() {
    return this._busy('Capturing this tab…', async () => {
      const { canvas, scope } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      const result = await this._copyImageBlob(blob, scope);
      this.overlay._setMessage(result.message);
      return { blob, scope, copied: result.copied };
    });
  }

  async copyFullPageImage() {
    return this._busy('Capturing the full page…', async () => {
      const { canvas, scope } = await this.captureAnnotatedImage({ fullPage: true });
      const blob = await canvasToBlob(canvas);
      const result = await this._copyImageBlob(blob, scope);
      this.overlay._setMessage(`${result.message} at ${canvas.width} × ${canvas.height} native pixels`);
      return { blob, scope, copied: result.copied };
    });
  }

  async downloadImage() {
    return this._busy('Capturing this tab…', async () => {
      const { canvas, scope } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, timestampName('png'));
      this.overlay._setMessage(scope === 'browser-tab' ? 'Annotated screenshot downloaded' : 'Annotated viewport fallback downloaded');
      return { blob, scope };
    });
  }

  /**
   * Copy report: the annotated screenshot plus bullet explanations and notes as
   * text. `combined` first tries one clipboard item holding the PNG, HTML (with
   * the image embedded) and plain text. When the browser does not accept those
   * formats or refuses the write, or when `combined` is false, the report text
   * goes to the clipboard and the PNG is downloaded; if even text cannot be
   * copied, the text is downloaded too. The message says exactly what happened.
   */
  async copyReport({ combined = true } = {}) {
    return this._busy('Capturing this tab…', async () => {
      const { canvas, snapshot } = await this.captureAnnotatedImage();
      const blob = await canvasToBlob(canvas);
      const result = await this._deliverReport({ canvas, blob, snapshot, combined });
      this.overlay._setMessage(result.message);
      this.overlay.options.setStatus(result.message);
      return result;
    });
  }

  /**
   * Export preview: capture once, compose exactly as an export does, and show
   * the result with its dimensions, legend and pointer. Exports from the
   * preview reuse that image. Focus returns to where it was when it closes,
   * and the overlay is visible again whether or not the capture succeeded.
   */
  async showExportPreview() {
    const overlay = this.overlay;
    if (!overlay.document || overlay._busy || !overlay.active || overlay.pageMode) return false;
    const lifecycle = overlay._lifecycleToken;
    overlay._setBusy(true, 'Capturing an export preview…');
    let result;
    try {
      result = await this.captureAnnotatedImage();
    } catch (error) {
      overlay._setBusy(false);
      overlay._reportError(error, 'Could not preview the export');
      return false;
    }
    overlay._setBusy(false);
    if (!overlay.active || lifecycle !== overlay._lifecycleToken) return false;
    const returnFocus = overlay.root.getRootNode().activeElement;
    this.preview ??= new RedlinePreview({
      mount: overlay.options.mount,
      onAction: (name, detail) => this._onPreviewAction(name, detail).catch(error => {
        console.error('[Redline]', error);
        this.preview.setBusy(false);
        this.preview.setMessage(`Could not ${name}: ${error.message}`);
      }),
    });
    this._previewState = { capture: result.capture, canvas: result.canvas, snapshot: result.snapshot };
    await overlay._withChildDialog(() => this.preview.show(this._previewContent(this._previewState)));
    this._previewState = null;
    if (overlay.active) {
      const target = returnFocus?.isConnected && !returnFocus.disabled && returnFocus.checkVisibility?.()
        ? returnFocus : overlay.toolbarUI.toolFocusTarget(overlay.tool);
      target?.focus({ preventScroll: true });
    }
    overlay._render({ force: true });
    return true;
  }

  /** A screenshot of the page with Redline hidden, from the host or the fallback. */
  captureBase(captureOptions = {}) {
    return captureBaseImage({
      capturePage: this.overlay.options.capturePage,
      captureFallback: this.overlay.options.captureFallback,
      whileHidden: callback => this._whileHidden(callback),
      captureOptions,
    });
  }

  closePreview() { this.preview?.close(); }

  destroy() { this.preview?.destroy(); }

  /** Run an export with the overlay busy, and always release it. */
  async _busy(message, task) {
    this.overlay._setBusy(true, message);
    try {
      return await task();
    } finally {
      this.overlay._setBusy(false);
    }
  }

  /** Put a PNG on the clipboard, or download it and say exactly why. */
  async _copyImageBlob(blob, scope = 'browser-tab') {
    const support = clipboardSupport();
    if (!support.api || !support.png) {
      downloadBlob(blob, timestampName('png'));
      return { copied: false, message: 'Clipboard images are unavailable in this browser; downloaded PNG instead.' };
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      const message = scope === 'full-page'
        ? 'Annotated full page copied'
        : (scope === 'browser-tab' ? 'Annotated screenshot copied' : 'Annotated viewport fallback copied');
      return { copied: true, message };
    } catch (error) {
      console.warn('[Redline] Clipboard write was refused; downloading instead.', error);
      downloadBlob(blob, timestampName('png'));
      return { copied: false, message: `The clipboard refused the image (${clipboardReason(error)}); downloaded PNG instead.` };
    }
  }

  async _deliverReport({ canvas, blob, snapshot, combined }) {
    const options = this.overlay.options;
    const page = (await Promise.resolve(options.describePage())) ?? {};
    const context = (await Promise.resolve(options.getContext())) ?? {};
    const createdAt = new Date().toISOString();
    const image = { width: canvas.width, height: canvas.height };
    const support = clipboardSupport();
    let refusal = null;
    if (combined) {
      const missing = [['image/png', support.png], ['text/html', support.html], ['text/plain', support.text]]
        .filter(([, ok]) => !ok).map(([type]) => type);
      if (!support.api) refusal = 'this browser has no clipboard write API';
      else if (missing.length) refusal = `the clipboard does not accept ${missing.join(' or ')} here`;
      else {
        const report = buildReport({ snapshot, page, context, image, createdAt, imageDataUrl: await blobToDataUrl(blob) });
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'image/png': blob,
            'text/html': new Blob([report.html], { type: 'text/html' }),
            'text/plain': new Blob([report.text], { type: 'text/plain' }),
          })]);
          const contents = report.bullets.length || report.notes.length ? reportCounts(report) : 'page details';
          return {
            image: 'clipboard', text: 'clipboard', combined: true, report,
            message: `Report copied: the screenshot and ${contents} together. If the app you paste into keeps only the text or only the image, use Copy report text + download PNG.`,
          };
        } catch (error) {
          console.warn('[Redline] The combined report copy was refused.', error);
          refusal = `the clipboard refused it: ${clipboardReason(error)}`;
        }
      }
    }
    const fileName = timestampName('png');
    const report = buildReport({ snapshot, page, context, image, createdAt, imageFileName: fileName });
    let text = 'none';
    let textError = null;
    if (support.api && support.text) {
      try {
        const item = { 'text/plain': new Blob([report.text], { type: 'text/plain' }) };
        if (support.html) item['text/html'] = new Blob([report.html], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem(item)]);
        text = 'clipboard';
      } catch (error) {
        textError = clipboardReason(error);
      }
    } else {
      textError = 'this browser cannot put text on the clipboard';
    }
    downloadBlob(blob, fileName);
    let textFile = null;
    if (text !== 'clipboard') {
      textFile = fileName.replace(/\.png$/, '-report.txt');
      downloadBlob(new Blob([report.text], { type: 'text/plain' }), textFile);
      text = 'download';
    }
    const message = text === 'clipboard'
      ? `Report text copied; screenshot downloaded as ${fileName}.${refusal ? ` (Image and text together were not copied: ${refusal}.)` : ''}`
      : `Clipboard unavailable (${textError}): downloaded the screenshot as ${fileName} and the report text as ${textFile}. Nothing was copied.`;
    return { image: 'download', text, combined: false, refusal, report, fileName, textFile, message };
  }

  _previewContent({ capture, canvas, snapshot }) {
    const doc = this.overlay.document;
    const measurer = this.overlay.measurer;
    const parts = [`${canvas.width} × ${canvas.height} PNG`];
    parts.push(snapshot.crop ? `crop ${Math.round(snapshot.crop.width)} × ${Math.round(snapshot.crop.height)} CSS px` : 'full window');
    parts.push(`${(snapshot.outputScale ?? 1) * 100}% output`);
    parts.push(`${Math.round(capture.canvas.width / snapshot.width * 100) / 100}× screenshot pixels`);
    const bullets = snapshot.annotations.filter(mark => mark.type === 'bullet');
    const warnings = [];
    if (bullets.length && snapshot.legend?.visible) {
      parts.push(`legend with ${bullets.length} explanation${bullets.length === 1 ? '' : 's'}`);
      const layout = layoutLegend(snapshot.legend, snapshot.annotations, measurer);
      const clipping = legendClipping(layout.box, snapshot.width, snapshot.height, snapshot.crop ?? null);
      if (clipping.crop) warnings.push('Part of the legend lies outside the crop and is clipped in this image.');
      else if (clipping.viewport) warnings.push('Part of the legend lies past the window edge and is clipped in this image.');
      if (layout.overflows) warnings.push(`The legend’s fixed height hides ${layout.hiddenLines} line${layout.hiddenLines === 1 ? '' : 's'}; Copy report and JSON keep the full text.`);
    } else if (bullets.length) {
      parts.push('legend hidden');
      warnings.push(`The legend is hidden on the image; Copy report still lists the ${bullets.length} explanation${bullets.length === 1 ? '' : 's'} as text.`);
    }
    if (snapshot.cursor?.visible) {
      parts.push(capture.includesCursor ? 'real pointer in screenshot' : 'pointer included');
      if (!cursorInsideCrop(snapshot.cursor, snapshot.crop)) warnings.push('The pointer is outside the crop, so it does not appear in this image.');
    } else {
      parts.push('no pointer');
    }
    return {
      canvas,
      summary: parts.join(' · '),
      warnings,
      cursor: { included: Boolean(doc?.cursor?.visible) },
    };
  }

  async _onPreviewAction(name, detail) {
    const overlay = this.overlay;
    const state = this._previewState;
    if (!state || !this.preview) return;
    if (name === 'cursor') {
      const included = overlay.pointerProxy.setVisibility(Boolean(detail), { select: false });
      const snapshot = overlay.document.toJSON();
      state.snapshot = snapshot;
      state.canvas = composeAnnotatedCanvas(snapshot, state.capture.canvas, { measurer: overlay.measurer, includesCursor: state.capture.includesCursor });
      this.preview.update(this._previewContent(state));
      this.preview.setMessage(included.message);
      return;
    }
    this.preview.setBusy(true);
    try {
      const blob = await canvasToBlob(state.canvas);
      if (name === 'download') {
        const fileName = timestampName('png');
        downloadBlob(blob, fileName);
        this.preview.setMessage(`Downloaded this image as ${fileName}`);
      } else if (name === 'copy') {
        this.preview.setMessage((await this._copyImageBlob(blob)).message);
      } else if (name === 'report') {
        const result = await this._deliverReport({ canvas: state.canvas, blob, snapshot: state.snapshot, combined: true });
        this.preview.setMessage(result.message);
      }
    } finally {
      this.preview.setBusy(false);
    }
  }

  async _whileHidden(callback) {
    // Top-layer dialogs have their own visible style; hiding the shadow host
    // alone does not hide their painted surfaces.
    const nodes = [this.overlay.root, ...this.overlay.options.mount.querySelectorAll(
      'dialog[data-dialog="redline-color"][open], dialog[data-redline-preview][open], dialog[data-redline-eyedropper][open]',
    )];
    const prior = nodes.map(node => [node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
    for (const node of nodes) node.style.setProperty('visibility', 'hidden', 'important');
    try { return await callback(); }
    finally {
      for (const [node, value, priority] of prior) {
        if (value) node.style.setProperty('visibility', value, priority);
        else node.style.removeProperty('visibility');
      }
    }
  }
}
