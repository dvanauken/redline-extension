/**
 * Copy report: the annotated screenshot plus readable text.
 *
 * The report lists every bullet explanation in label order (1–9, then A–Z) and
 * every legacy note with text, verbatim. It is built from the same document
 * snapshot as the image, so labels match what the picture shows. The text
 * version is plain; the HTML version escapes every value it did not write
 * itself and keeps explanation whitespace with `white-space: pre-wrap`.
 *
 * Explanations are listed whether or not the legend is drawn on the image: a
 * hidden legend keeps the picture uncluttered while the report still carries
 * the words, and the report says so.
 *
 * Nothing here touches the DOM.
 */

import { legendBullets } from './RedlineLegend.js';
import { redlineNoteGlyph } from './RedlineStyles.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

const insideCrop = (point, crop) => !crop || (point.x >= crop.x && point.x <= crop.x + crop.width
  && point.y >= crop.y && point.y <= crop.y + crop.height);

const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

/** Bullets and notes the report lists, with their visible labels. */
export function reportEntries(snapshot) {
  const annotations = snapshot?.annotations ?? [];
  const crop = snapshot?.crop ?? null;
  const bullets = legendBullets(annotations).map(bullet => ({
    id: bullet.id, label: bullet.label, text: bullet.text ?? '', outsideCrop: !insideCrop(bullet.point, crop),
  }));
  const notes = annotations
    .filter(mark => mark.type === 'note' && String(mark.text ?? '').length)
    .map(note => ({
      id: note.id, label: redlineNoteGlyph(note.number, note.marker), text: note.text, outsideCrop: !insideCrop(note.point, crop),
    }));
  return { bullets, notes };
}

/** One sentence describing the exported image. */
export function describeImage(snapshot, image) {
  const parts = [`${image.width} × ${image.height} PNG`];
  const crop = snapshot.crop;
  const scale = snapshot.outputScale ?? 1;
  if (crop) parts.push(`cropped to ${Math.round(crop.width)} × ${Math.round(crop.height)} CSS px`);
  if (scale !== 1) parts.push(`${scale * 100}% output`);
  const bullets = (snapshot.annotations ?? []).filter(mark => mark.type === 'bullet').length;
  if (bullets) parts.push(snapshot.legend?.visible ? 'legend shown on the image' : 'legend hidden on the image');
  parts.push(snapshot.cursor?.visible ? 'pointer included' : 'no pointer');
  return parts.join(', ');
}

/**
 * Build the report.
 *
 *   snapshot       RedlineDocument#toJSON() used for the image
 *   page           { url, title } — url is already redacted by the host
 *   context        { urlRedacted }
 *   image          { width, height } of the exported PNG
 *   createdAt      ISO timestamp
 *   imageDataUrl   embed the PNG in the HTML (clipboard report)
 *   imageFileName  name of a separately downloaded PNG (fallback report)
 *
 * Returns { text, html, bullets, notes }.
 */
export function buildReport({ snapshot, page = {}, context = {}, image, createdAt = new Date().toISOString(), imageDataUrl = null, imageFileName = null }) {
  const { bullets, notes } = reportEntries(snapshot);
  const title = String(page.title ?? '').trim() || '(untitled page)';
  const url = String(page.url ?? '');
  const legendHidden = bullets.length > 0 && !snapshot.legend?.visible;
  const imageLine = describeImage(snapshot, image);

  const text = [];
  text.push('Redline report', '');
  text.push(`Page: ${title}`);
  if (url) text.push(`URL: ${url}${context.urlRedacted ? ' (query string and fragment removed)' : ''}`);
  text.push(`Created: ${createdAt}`);
  text.push(`Screenshot: ${imageLine}${imageFileName ? ` — saved separately as ${imageFileName}` : ''}`);
  if (legendHidden) text.push('The legend is hidden on the image; the explanations below are included as text only.');
  const listText = (heading, entries, labelFor) => {
    if (!entries.length) return;
    text.push('', heading);
    for (const entry of entries) {
      const label = labelFor(entry);
      const indent = ' '.repeat(label.length + 2);
      const lines = entry.text ? entry.text.split('\n') : ['(no explanation)'];
      text.push(`${label}  ${lines[0]}`, ...lines.slice(1).map(line => `${indent}${line}`));
      if (entry.outsideCrop) text.push(`${indent}(outside the cropped image)`);
    }
  };
  listText('Bullet explanations', bullets, entry => entry.label);
  listText('Notes', notes, entry => `Note ${entry.label}:`);

  const html = [];
  html.push('<meta charset="utf-8">');
  html.push('<div data-redline-report="">');
  html.push('<h2>Redline report</h2>');
  const facts = [`<strong>Page:</strong> ${escapeHtml(title)}`];
  if (url) facts.push(`<strong>URL:</strong> ${escapeHtml(url)}${context.urlRedacted ? ' <em>(query string and fragment removed)</em>' : ''}`);
  facts.push(`<strong>Created:</strong> ${escapeHtml(createdAt)}`);
  facts.push(`<strong>Screenshot:</strong> ${escapeHtml(imageLine)}${imageFileName ? ` — saved separately as ${escapeHtml(imageFileName)}` : ''}`);
  html.push(`<p>${facts.join('<br>')}</p>`);
  if (imageDataUrl) {
    html.push(`<p><img src="${escapeHtml(imageDataUrl)}" width="${Math.round(image.width)}" height="${Math.round(image.height)}" style="max-width:100%;height:auto" alt="${escapeHtml(`Annotated screenshot of ${title}`)}"></p>`);
  }
  if (legendHidden) html.push('<p><em>The legend is hidden on the image; the explanations below are included as text only.</em></p>');
  const listHtml = (heading, entries, labelFor) => {
    if (!entries.length) return;
    html.push(`<h3>${escapeHtml(heading)}</h3>`);
    for (const entry of entries) {
      const body = entry.text
        ? `<span style="white-space:pre-wrap">${escapeHtml(entry.text)}</span>`
        : '<em>(no explanation)</em>';
      const note = entry.outsideCrop ? ' <em>(outside the cropped image)</em>' : '';
      html.push(`<p><strong>${escapeHtml(labelFor(entry))}</strong>&nbsp; ${body}${note}</p>`);
    }
  };
  listHtml('Bullet explanations', bullets, entry => entry.label);
  listHtml('Notes', notes, entry => `Note ${entry.label}:`);
  html.push('</div>');

  return { text: text.join('\n') + '\n', html: html.join('\n'), bullets, notes };
}

/** Short counts for status messages. */
export function reportCounts({ bullets, notes }) {
  const parts = [];
  if (bullets.length) parts.push(plural(bullets.length, 'explanation'));
  if (notes.length) parts.push(plural(notes.length, 'note'));
  return parts.length ? parts.join(' and ') : 'no explanations';
}
