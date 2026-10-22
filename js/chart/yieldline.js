/**
 * 国债收益率走势图
 *
 * 国债收益率是**日频单值**，没有开盘/最高/最低，画不出真正的 K 线。
 * 所以这里画的是「收益率连着走 + 每日 bp 变化柱」——
 * 信息量够看趋势和节奏，但不伪造一个不存在的开盘价。
 *
 * 不叠均线：国债收益率的日内/日间波动常只有个位数 bp，
 * MA5/MA20 与主线基本贴在一起，画上去只会糊成三条难分的线，
 * 既看不清真实走势，也容易把「均线交叉」误读成信号。
 *
 * 布局：上 68% 主图（收益率线），下 24% 副图（每日 bp 柱），
 * 底部留一行日期刻度。Y 轴标签放右边，左边留给折线起势。
 *
 * 交互（v1.26）：十字光标。指针在主图上移动时吸附到最近的交易日，
 * 画一条竖虚线 + 高亮点，底部日期换成该日，右侧刻度换成该日收益率。
 * 上方的收益率大数字由调用方在 onHover 里同步——图只负责画，不碰 DOM。
 */

import { setupCanvas, niceTicks } from './base.js';
import { readPalette, withAlpha } from '../util/format.js';

/** 圆角矩形（roundRect 在老 Safari 上没有，自己画一段） */
function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{date:string, v:number}>} points 已按日期升序
 * @param {{digits?:number, hover?:number|null, onHover?:(i:number|null)=>void}} [opt]
 * @returns {{hover:number|null}|undefined} 当前吸附的索引
 */
export function drawYieldLine(canvas, points, opt = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  // 页面隐藏 / 还没布局时不画，可见后由调用方重绘
  if (rect.width < 8 || rect.height < 8) return;

  // 先剔掉缺值的点再取索引：否则 vals 与 points 会错位，
  // 光标停在第 12 根时读到的日期可能是第 13 根
  const pts = (Array.isArray(points) ? points : [])
    .filter(p => p && Number.isFinite(p.v) && p.v > 0);
  if (pts.length < 2) return;

  const vals = pts.map(p => p.v);
  const { ctx, w, h } = setupCanvas(canvas);
  const pal = readPalette();
  const digits = opt.digits ?? 3;

  const padL = 6;
  const padR = 42;          // 右侧 Y 轴标签
  const padT = 8;
  const padB = 16;          // 底部日期
  const gap = 10;           // 主图与副图间距
  const mainH = Math.max(40, (h - padT - padB - gap) * 0.72);
  const subTop = padT + mainH + gap;
  const subH = Math.max(16, h - padB - subTop);

  const plotW = w - padL - padR;

  // ---- Y 值域 ----
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!(hi > lo)) hi = lo + 0.01;
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;

  const yOf = v => padT + mainH - ((v - lo) / (hi - lo)) * mainH;
  const n = vals.length;
  const xOf = i => padL + (n === 1 ? 0 : (i / (n - 1)) * plotW);

  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) {
    xs.push(xOf(i));
    ys.push(yOf(vals[i]));
  }

  const last = vals[n - 1];
  const first = vals[0];
  const tone = last > first ? pal.up : last < first ? pal.down : pal.flat;

  let hover = Number.isInteger(opt.hover) && opt.hover >= 0 && opt.hover < n
    ? opt.hover
    : null;

  const label = p => String(p?.date || '').slice(5);   // MM-DD
  const mono = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';

  const render = () => {
    ctx.clearRect(0, 0, w, h);

    // ---- 网格 + Y 轴刻度 ----
    ctx.font = mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const ticks = niceTicks(lo, hi, 4);
    for (const t of ticks) {
      if (t < lo || t > hi) continue;
      // 光标停住时，把光标那条刻度让位给浮动数值
      if (hover != null && Math.abs(yOf(t) - ys[hover]) < 7) continue;
      const y = Math.round(yOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = pal.axis;
      ctx.fillText(t.toFixed(digits), padL + plotW + 6, y);
    }

    // ---- 面积渐变 ----
    const grad = ctx.createLinearGradient(0, padT, 0, padT + mainH);
    grad.addColorStop(0, withAlpha(tone, 0.16));
    grad.addColorStop(1, withAlpha(tone, 0));
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.lineTo(xs[n - 1], padT + mainH);
    ctx.lineTo(xs[0], padT + mainH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ---- 主线 ----
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // ---- 副图：每日 bp 变化柱 ----
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push((vals[i] - vals[i - 1]) * 100);
    const midY = subTop + subH / 2;
    const halfH = subH / 2 - 1;
    const maxAbs = Math.max(...diffs.map(Math.abs), 1);

    if (diffs.length) {
      // 零轴
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(midY) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(midY) + 0.5);
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.stroke();

      const bw = Math.max(1, plotW / Math.max(diffs.length, 1) - 0.6);
      for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i];
        const x = xOf(i + 1) - bw / 2;
        const hh = (Math.abs(d) / maxAbs) * halfH;
        ctx.fillStyle = withAlpha(d >= 0 ? pal.up : pal.down, 0.72);
        ctx.fillRect(x, d >= 0 ? midY - hh : midY, bw, Math.max(0.8, hh));
      }
    }

    // ---- 末值圆点（仅在没开光标时画，避免和高亮点重复） ----
    if (hover == null) {
      ctx.beginPath();
      ctx.arc(xs[n - 1], ys[n - 1], 2.6, 0, Math.PI * 2);
      ctx.fillStyle = tone;
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.bg, 0.9);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // ---- 十字光标 ----
    if (hover != null) {
      const hx = Math.round(xOf(hover)) + 0.5;
      const hy = ys[hover];

      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, subTop + subH);
      ctx.strokeStyle = withAlpha(pal.axis, 0.62);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // 高亮点
      ctx.beginPath();
      ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = tone;
      ctx.fill();
      ctx.strokeStyle = withAlpha(pal.bg, 0.95);
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // 右侧刻度位置换成该日数值
      const vt = vals[hover].toFixed(digits);
      ctx.font = mono;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const vw = ctx.measureText(vt).width;
      ctx.fillStyle = withAlpha(pal.bg, 0.92);
      rrect(ctx, padL + plotW + 3, hy - 7, vw + 8, 14, 3);
      ctx.fill();
      ctx.fillStyle = tone;
      ctx.fillText(vt, padL + plotW + 7, hy);
    }

    // ---- X 轴日期 ----
    ctx.font = mono;
    ctx.textBaseline = 'top';
    const labelY = padT + mainH + gap + subH + 2;

    if (hover != null) {
      // 光标在时只显示光标那天：固定刻度会跟它挤在一起，读不清
      const txt = label(pts[hover]);
      ctx.textAlign = 'center';
      const tw = ctx.measureText(txt).width;
      const cx = Math.max(padL + tw / 2 + 2,
        Math.min(padL + plotW - tw / 2 - 2, xOf(hover)));
      ctx.fillStyle = withAlpha(pal.axis, 0.16);
      rrect(ctx, cx - tw / 2 - 4, labelY - 1, tw + 8, 13, 3);
      ctx.fill();
      ctx.fillStyle = pal.axis;
      ctx.fillText(txt, cx, labelY);
    } else {
      // 首 / 中 / 末
      const picks = [0, Math.floor((n - 1) / 2), n - 1];
      const seen = new Set();
      for (const i of picks) {
        if (seen.has(i)) continue;
        seen.add(i);
        const txt = label(pts[i]);
        const x = xOf(i);
        let align = 'center';
        let tx = x;
        if (i === 0) { align = 'left'; tx = padL; }
        else if (i === n - 1) { align = 'right'; tx = padL + plotW; }
        ctx.textAlign = align;
        ctx.fillStyle = pal.axis;
        ctx.fillText(txt, tx, labelY);
      }
    }
  };

  /* ---------------- 指针交互 ---------------- */

  // 画布 CSS 尺寸可能与 setupCanvas 的 w 不同（设备像素比变换后），按比例换算
  const idxAt = clientX => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return null;
    const x = (clientX - r.left) * (w / r.width);
    if (x < padL - 12 || x > padL + plotW + 12) return null;
    const ratio = (x - padL) / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
  };

  const move = i => {
    if (i === hover) return;
    hover = i;
    render();
    // 只回传索引：调用方去改 DOM 文本，不要在这里回调重绘整个图
    opt.onHover?.(i);
  };

  let pressed = false;

  canvas.onpointerdown = ev => {
    pressed = true;
    move(idxAt(ev.clientX));
  };
  canvas.onpointermove = ev => {
    // 手机上手指在图表上竖滑是想滚页面，不该顺手把光标拖出来
    if (ev.pointerType === 'touch' && !pressed) return;
    move(idxAt(ev.clientX));
  };
  canvas.onpointerup = () => { pressed = false; };
  canvas.onpointercancel = () => { pressed = false; };
  canvas.onpointerleave = () => {
    pressed = false;
    move(null);
  };

  render();
  return { hover };
}
