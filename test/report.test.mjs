import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, describeImage, escapeHtml, reportCounts, reportEntries } from '../redline/RedlineReport.js';

const bullet = (id, label, text, point = { x: 100, y: 100 }) => ({ id, type: 'bullet', label, color: '#1D4ED8', width: 1.333, point, ...(text ? { text } : {}) });
const snapshot = (extra = {}) => ({
  width: 1200, height: 800,
  annotations: [
    bullet('late-alpha', 'B', 'Second lettered'),
    bullet('two', '2', 'Line one\n  indented line two  \n\nafter a blank line   '),
    bullet('alpha', 'A', ''),
    bullet('one', '1', 'Hostile <script>alert("x")</script> & \'quotes\''),
    { id: 'n1', type: 'note', color: '#B65D66', width: 1.333, point: { x: 50, y: 50 }, text: 'Legacy <note> 10', number: 10 },
    { id: 'n2', type: 'note', color: '#B65D66', width: 1.333, point: { x: 60, y: 60 }, text: 'Lettered', number: 27, marker: 'alpha' },
    { id: 'empty-note', type: 'note', color: '#B65D66', width: 1.333, point: { x: 60, y: 60 }, text: '', number: 3 },
    { id: 'rect', type: 'rectangle', color: '#000000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
  ],
  ...extra,
});
const page = { url: 'https://example.test/orders/42', title: 'Orders <b>&</b> "billing"' };

test('escapeHtml escapes every markup-significant character', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('entries keep stable labels in legend order, full text, and legacy notes with text', () => {
  const { bullets, notes } = reportEntries(snapshot());
  assert.deepEqual(bullets.map(item => item.label), ['1', '2', 'A', 'B']);
  assert.equal(bullets[1].text, 'Line one\n  indented line two  \n\nafter a blank line   ');
  assert.deepEqual(notes.map(item => item.label), ['10', 'AA']);
  assert.equal(reportCounts({ bullets, notes }), '4 explanations and 2 notes');
});

test('plain text lists every explanation verbatim under its label', () => {
  const { text } = buildReport({ snapshot: snapshot(), page, context: { urlRedacted: true }, image: { width: 2400, height: 1600 }, createdAt: '2026-09-13T12:00:00.000Z' });
  assert.match(text, /^Redline report\n/);
  assert.match(text, /Page: Orders <b>&<\/b> "billing"/, 'plain text is not HTML-escaped');
  assert.match(text, /URL: https:\/\/example\.test\/orders\/42 \(query string and fragment removed\)/);
  assert.match(text, /Screenshot: 2400 × 1600 PNG, legend hidden on the image, no pointer/);
  assert.match(text, /The legend is hidden on the image; the explanations below are included as text only\./);
  assert.match(text, /\n1  Hostile <script>alert\("x"\)<\/script> & 'quotes'\n/);
  assert.match(text, /\n2  Line one\n     indented line two  \n   \n   after a blank line   \n/, 'continuation lines keep their own whitespace');
  assert.match(text, /\nA  \(no explanation\)\n/);
  assert.match(text, /\nNotes\nNote 10:  Legacy <note> 10\nNote AA:  Lettered\n/);
  assert.equal(text.includes('empty-note'), false);
});

test('HTML escapes every page and annotation value and preserves whitespace', () => {
  const { html } = buildReport({
    snapshot: snapshot({ legend: { visible: true, x: 0, y: 0, width: 300, fontSize: 14, fontFamily: 'sans-serif' } }),
    page, context: { urlRedacted: false }, image: { width: 1200, height: 800 }, createdAt: '2026-09-13T12:00:00.000Z',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<b>&</b>'), false);
  assert.match(html, /Orders &lt;b&gt;&amp;&lt;\/b&gt; &quot;billing&quot;/);
  assert.match(html, /Hostile &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;quotes&#39;/);
  assert.match(html, /<span style="white-space:pre-wrap">Line one\n  indented line two  \n\nafter a blank line   <\/span>/);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" width="1200" height="800"/);
  assert.equal(html.includes('legend is hidden'), false, 'a shown legend needs no explanation');
  assert.equal(html.includes('query string and fragment removed'), false);
  assert.match(html, /legend shown on the image/);
});

test('fallback report names the separately downloaded PNG and marks entries outside the crop', () => {
  const snap = snapshot({ crop: { x: 0, y: 0, width: 90, height: 90 }, outputScale: 2, cursor: { visible: true, x: 10, y: 10 } });
  const report = buildReport({ snapshot: snap, page, image: { width: 360, height: 360 }, imageFileName: 'redline-x.png' });
  assert.match(report.text, /Screenshot: 360 × 360 PNG, cropped to 90 × 90 CSS px, 200% output, legend hidden on the image, pointer included — saved separately as redline-x\.png/);
  assert.match(report.text, /1  Hostile.*\n   \(outside the cropped image\)/);
  assert.match(report.text, /Note 10:  Legacy <note> 10\nNote AA:  Lettered\n/, 'notes inside the crop carry no outside marker');
  assert.equal(report.html.includes('<img'), false);
  assert.match(report.html, /saved separately as redline-x\.png/);
});

test('describeImage summarises output settings', () => {
  assert.equal(describeImage({ annotations: [] }, { width: 10, height: 20 }), '10 × 20 PNG, no pointer');
});
