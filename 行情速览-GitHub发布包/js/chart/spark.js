/**
 * 迷你走势（Sparkline）
 *
 * 指数卡片里的小分时曲线：无坐标轴、无网格、无交互，
 * 只保留「形状 + 方向色 + 昨收基准线」，一眼看出当天强弱。
 *
 * 与 trend.js 的取舍不同：这里不做索引轴刻度计算，
 * 也不缓存离屏缓冲——卡片尺寸小、重绘成本低，直接画更快。
 */

import { setupCanvas } from './base.js';
import { readPalette, withAlpha } from '../util/format.js';

/** 把 points / 数字数组统一抽成数字序列 */
function extract(points) {
  const out = [];
  if (!Array.isArray(points)) return out;
  for (const p of points) {
    const v = typeof p === 'number' ? p : p && p.price;
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

/**
 * 降采样：卡片宽不过 170px，两三百个分钟点挤在一起只会画成毛边。
 * 按等宽分桶取均值，首尾各保留一个点，形状不变但线条干净。
 */
function thin(vals, maxN) {
  const n = vals.length;
  if (n <= maxN) return vals;
  const out = [];
  const step = (n - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) {
    const a = Math.floor(i * step);
    const b = i === maxN - 1 ? n - 1 : Math.floor((i + 1) * step);
    let sum = 0;
    let cnt = 0;
    for (let k = a; k <= b && k < n; k++) { sum += vals[k]; cnt++; }
    out.push(cnt ? sum / cnt : vals[a]);
  }
  return out;
}

/** 用二次贝塞尔穿过中点，把折线磨成曲线 */
function tracePath(ctx, xs, ys) {
  const n = xs.length;
  ctx.moveTo(xs[0], ys[0]);
  if (n === 2) { ctx.lineTo(xs[1], ys[1]); return; }
  for (let i = 1; i < n - 1; i++) {
    const xc = (xs[i] + xs[i + 1]) / 2;
    const yc = (ys[i] + ys[i + 1]) / 2;
    ctx.quadraticCurveTo(xs[i], ys[i], xc, yc);
  }
  ctx.lineTo(xs[n - 1], ys[n - 1]);
}

/**
 * 绘制迷你走势
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{price:number}>|number[]} points 当日分时点
 * @param {number} prevClose 昨收（决定方向色与基准线）
 */
export function drawSpark(canvas, points, prevClose) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  // 页面隐藏 / 卡片未布局时不画，等可见后由调用方重绘
  if (rect.width < 4 || rect.height < 4) return;

  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const raw = extract(points);
  // 每 1.4 个 CSS 像素最多一个点，再多也是糊在一起
  const vals = thin(raw, Math.max(24, Math.round((rect.width / 1.4) * 2)));
  if (vals.length < 2) return;

  const pal = readPalette();
  const base = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : vals[0];
  const last = vals[vals.length - 1];
  const color = last > base ? pal.up : last < base ? pal.down : pal.flat;

  // 值域含昨收：这样 0% 那条基准线一定在可视范围内
  let lo = Math.min(base, ...vals);
  let hi = Math.max(base, ...vals);
  if (!(hi > lo)) { hi = lo + Math.max(Math.abs(lo) * 0.001, 1); }
  const pad = (hi - lo) * 0.16;
  lo -= pad;
  hi += pad;

  const padY = 4;
  const yOf = v => h - padY - ((v - lo) / (hi - lo)) * (h - padY * 2);
  const n = vals.length;
  const xOf = i => (i / (n - 1)) * w;
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) { xs.push(xOf(i)); ys.push(yOf(vals[i])); }

  // ---- 面积：只做一层很淡的纵深，别把卡片压暗 ----
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, withAlpha(color, 0.10));
  grad.addColorStop(0.72, withAlpha(color, 0.028));
  grad.addColorStop(1, withAlpha(color, 0));
  ctx.beginPath();
  tracePath(ctx, xs, ys);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ---- 折线 ----
  ctx.beginPath();
  tracePath(ctx, xs, ys);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // ---- 昨收基准 ----
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = withAlpha(pal.flat, 0.34);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yOf(base));
  ctx.lineTo(w, yOf(base));
  ctx.stroke();
  ctx.restore();

  // ---- 末端点：实心 + 一圈淡光，收尾有落点 ----
  const ex = xs[n - 1];
  const ey = ys[n - 1];
  ctx.beginPath();
  ctx.arc(ex, ey, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(color, 0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 1.9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * 区间条 —— 没有分时数据时的替代画法
 *
 * 日经225 / 韩国KOSPI 的数据源只给「今开 / 最高 / 最低 / 现价」，
 * 拉不到分钟线，画折线就成了编造轨迹。改成一条「今日振幅条」：
 * 横条覆盖最低到最高，圆点标出现价所在位置，虚线是昨收。
 * 信息量不如折线，但每一个像素都是真实数据。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{price:number, prevClose?:number, high:number, low:number}} opt
 */
export function drawRange(canvas, opt) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;

  const price = Number(opt?.price);
  const high = Number(opt?.high);
  const low = Number(opt?.low);
  const prevClose = Number(opt?.prevClose);
  if (!(price > 0) || !(high > 0) || !(low > 0)) return;

  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const pal = readPalette();
  const base = prevClose > 0 ? prevClose : low;
  const color = price > base ? pal.up : price < base ? pal.down : pal.flat;

  // 值域把昨收也算进去，否则昨收虚线会跑到条外
  let lo = Math.min(low, price, base);
  let hi = Math.max(high, price, base);
  if (!(hi > lo)) {
    const d = Math.max(Math.abs(lo) * 0.002, 1e-6);
    lo -= d; hi += d;
  }

  const padX = 9;
  const trackH = Math.max(5, Math.min(7, h * 0.15));
  const cy = h * 0.46;
  const xOf = v => padX + ((v - lo) / (hi - lo)) * (w - padX * 2);

  // 轨道
  const r = trackH / 2;
  ctx.beginPath();
  ctx.moveTo(padX, cy - r);
  ctx.lineTo(w - padX, cy - r);
  ctx.arc(w - padX, cy, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(padX, cy + r);
  ctx.arc(padX, cy, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = withAlpha(pal.flat, 0.13);
  ctx.fill();

  // 已走出的一段（从昨收到现价）用方向色实心
  const xBase = xOf(base);
  const xCur = xOf(price);
  ctx.beginPath();
  ctx.moveTo(Math.min(xBase, xCur), cy - r);
  ctx.lineTo(Math.max(xBase, xCur), cy - r);
  ctx.lineTo(Math.max(xBase, xCur), cy + r);
  ctx.lineTo(Math.min(xBase, xCur), cy + r);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.42);
  ctx.fill();

  // 昨收刻度
  ctx.save();
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = withAlpha(pal.flat, 0.7);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xBase, cy - r - 3);
  ctx.lineTo(xBase, cy + r + 3);
  ctx.stroke();
  ctx.restore();

  // 现价圆点（不描边：--bg 可能不是 hex，withAlpha 会算错）
  ctx.beginPath();
  ctx.arc(xCur, cy, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** 清空（无数据时避免残留上一只标的的曲线） */
export function clearSpark(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
