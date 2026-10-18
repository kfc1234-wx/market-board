/**
 * Canvas 图表公共底座
 * DPR 适配、线性刻度、美化刻度、离屏缓冲、尺寸监听
 */

/** 初始化 canvas 的物理像素尺寸，返回逻辑坐标系 */
export function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

/** 创建一个离屏画布（用于缓存静态层） */
export function makeBuffer(w, h, dpr) {
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(pw, ph);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

/** 线性映射，附带反向求值 */
export function scaleLinear(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  const k = (r1 - r0) / span;
  const f = v => r0 + (v - d0) * k;
  f.invert = p => d0 + (p - r0) / k;
  f.k = k;
  return f;
}

/** 1 / 2 / 2.5 / 5 × 10^k 步长 */
export function niceStep(range, target = 4) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

/** 生成刻度值（含边界） */
export function niceTicks(min, max, target = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const base = Number.isFinite(min) ? min : 0;
    return [base];
  }
  const step = niceStep(max - min, target);
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    // 消除浮点毛刺
    out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toFixed(10));
  }
  return out;
}

/** 圆角矩形路径 */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  if (rr <= 0.5) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

/** 右对齐文字 */
export function textRight(ctx, text, x, y) {
  const prev = ctx.textAlign;
  ctx.textAlign = 'right';
  ctx.fillText(text, x, y);
  ctx.textAlign = prev;
}

/** 左对齐文字 */
export function textLeft(ctx, text, x, y) {
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
  ctx.textAlign = prev;
}

/** 居中文字 */
export function textCenter(ctx, text, x, y) {
  const prev = ctx.textAlign;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.textAlign = prev;
}

/** 虚线 */
export function dashLine(ctx, x1, y1, x2, y2, dash = [4, 4]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 尺寸监听：元素尺寸变化时回调（含首帧）
 * @returns {() => void} 取消监听
 */
export function watchResize(host, cb) {
  let raf = 0;
  const fire = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => cb());
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fire) : null;
  if (ro) ro.observe(host);
  window.addEventListener('orientationchange', fire);
  fire();
  return () => {
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    window.removeEventListener('orientationchange', fire);
  };
}

/** 数字缩写（轴上用，避免过长） */
export function abbr(v, digits = 2) {
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(1) + '万';
  if (abs >= 1000) return v.toFixed(0);
  return v.toFixed(digits);
}
