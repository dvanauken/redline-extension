/** Canvas renderer shared by PNG export and tests. */

function line(ctx, points) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

function arrow(ctx, start, end, width) {
  line(ctx, [start, end]);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(12, width * 4);
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - length * Math.cos(angle - Math.PI / 6), end.y - length * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - length * Math.cos(angle + Math.PI / 6), end.y - length * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Match the presentation-style text boxes used by the main canvas. */
export function redlineTextBoxFill(opacity = 1) {
  const alpha = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  return `rgba(24,27,34,${alpha})`;
}

function wrappedLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (!line || ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function drawRedlineAnnotations(ctx, annotations, {
  scaleX = 1,
  scaleY = scaleX,
  fontFamily = 'Arial, sans-serif',
} = {}) {
  ctx.save();
  ctx.scale(scaleX, scaleY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const mark of annotations) {
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineWidth = mark.width;

    if (mark.type === 'pen') {
      line(ctx, mark.points);
    } else if (mark.type === 'arrow') {
      arrow(ctx, mark.start, mark.end, mark.width);
    } else if (mark.type === 'rectangle') {
      const x = Math.min(mark.start.x, mark.end.x);
      const y = Math.min(mark.start.y, mark.end.y);
      ctx.strokeRect(x, y, Math.abs(mark.end.x - mark.start.x), Math.abs(mark.end.y - mark.start.y));
    } else if (mark.type === 'textbox') {
      const x = Math.min(mark.start.x, mark.end.x);
      const y = Math.min(mark.start.y, mark.end.y);
      const boxWidth = Math.abs(mark.end.x - mark.start.x);
      const boxHeight = Math.abs(mark.end.y - mark.start.y);
      const padding = 10;
      const fontSize = mark.fontSize ?? 16;
      roundedRect(ctx, x, y, boxWidth, boxHeight, 4);
      ctx.fillStyle = redlineTextBoxFill(mark.backgroundOpacity);
      ctx.fill();
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = mark.width;
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, y + 1, Math.max(0, boxWidth - 2), Math.max(0, boxHeight - 2));
      ctx.clip();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '400 ' + fontSize + 'px ' + fontFamily;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const lineHeight = fontSize * 1.25;
      let textY = y + padding;
      for (const textLine of wrappedLines(ctx, mark.text, Math.max(1, boxWidth - padding * 2))) {
        if (textY + lineHeight > y + boxHeight) break;
        ctx.fillText(textLine, x + padding, textY);
        textY += lineHeight;
      }
      ctx.restore();
    } else if (mark.type === 'note') {
      const radius = 14;
      ctx.beginPath();
      ctx.arc(mark.point.x, mark.point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 14px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(mark.number), mark.point.x, mark.point.y + 0.5);

      ctx.font = `600 14px ${fontFamily}`;
      ctx.textAlign = 'left';
      const labelX = mark.point.x + 22;
      const labelY = mark.point.y - 16;
      const textWidth = Math.min(420, Math.max(80, ctx.measureText(mark.text).width + 20));
      roundedRect(ctx, labelX, labelY, textWidth, 32, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.fill();
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#111827';
      ctx.fillText(mark.text, labelX + 10, labelY + 17);
    }
  }

  ctx.restore();
}
