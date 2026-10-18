/**
 * 分时图
 *
 * 设计要点：
 *  - X 轴用「索引轴」而非时间轴：等距排列，天然规避 A 股午休空档、
 *    港股半日市、美股夏令时切换造成的时序拉伸
 *  - Y 轴围绕昨收对称：昨收永远在垂直中央，视觉与主流行情软件一致
 *  - 涨跌填充用 clip 分区，穿线时不会串色
 *  - 十字光标走「缓存静态层 + 只重绘十字」的路子，低端机也能 60fps
 */

import {
  setupCanvas, makeBuffer, scaleLinear, textRight, textCenter, dashLine, watchResize, abbr,
} from './base.js';
import { readPalette, withAlpha, fmtMinuteTime } from '../util/format.js';

export class TrendChart {
  /**
   * @param {HTMLElement} host
   * @param {{digits?:number, timeLabels?:string[], onHover?:(p:any|null)=>void}} [opt]
   */
  constructor(host, opt = {}) {
    this.host = host;
    this.opt = opt;
    this.digits = opt.digits ?? 2;

    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);

    this.data = null;
    this.crossIndex = -1;
    this.palette = readPalette();
    this.dead = false;
    this.buf = null;
    this.geom = null;

    this._bindPointer();

    this.unwatch = watchResize(host, () => {
      if (this.dead) return;
      this._rebuildEnv();
      this.render();
    });
  }

  _rebuildEnv() {
    const env = setupCanvas(this.canvas);
    this.env = env;
    this.buf = makeBuffer(env.w, env.h, env.dpr);
    this.dirty = true;
  }

  setPalette() {
    this.palette = readPalette();
    this.dirty = true;
  }

  /**
   * @param {{points:Array<{t:string,price:number,cumVol:number}>, avg:number[],
   *          prevClose:number, axisCount?:number}} data
   */
  setData(data) {
    this.data = data;
    this.crossIndex = -1;
    this.dirty = true;
    this.render();
  }

  /** 只更新最后一个价格（盘中增量刷新） */
  patchLast(price) {
    if (!this.data || !this.data.points.length || !price) return;
    const pts = this.data.points;
    const last = pts.length - 1;
    if (Math.abs(pts[last].price - price) < 1e-9) return;
    pts[last].price = price;
    this.dirty = true;
    this.render();
  }

  /** 计算布局与映射，返回几何信息 */
  _layout(w, h) {
    const padRight = 56;
    const padTop = 12;
    const padBottom = 18;
    const gap = 10;

    const usable = h - padTop - padBottom;
    const priceH = Math.max(60, usable * 0.78);
    const volH = Math.max(24, usable - priceH - gap);

    return {
      padRight, padTop, padBottom, gap,
      plotW: Math.max(10, w - padRight),
      priceTop: padTop,
      priceH,
      volTop: padTop + priceH + gap,
      volH,
    };
  }

  render() {
    if (this.dead || !this.env) return;
    if (!this.data || !this.data.points.length) {
      this._clear();
      return;
    }

    const { ctx, w, h, dpr } = this.env;
    const pal = this.palette;
    const pts = this.data.points;
    const avg = this.data.avg || [];
    const prevClose = this.data.prevClose || pts[0].price;
    const axisCount = Math.max(this.data.axisCount || pts.length, pts.length);

    const L = this._layout(w, h);

    // Y 域围绕昨收对称
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of pts) {
      if (p.price > hi) hi = p.price;
      if (p.price < lo) lo = p.price;
    }
    if (avg.length) {
      for (const a of avg) {
        if (a > hi) hi = a;
        if (a < lo) lo = a;
      }
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) { hi = prevClose; lo = prevClose; }

    // 上下各自贴合当日真实振幅。手机屏纵向只有 400px 左右，
    // 强制以昨收对称会让单边行情把曲线全挤到下半屏，上半屏整片空白。
    const upDev = Math.max(hi - prevClose, 0);
    const downDev = Math.max(prevClose - lo, 0);
    let span = upDev + downDev;
    if (!Number.isFinite(span) || span <= 0) span = Math.max(prevClose * 0.004, 0.001);
    const padDev = span * 0.14;

    const yMax = prevClose + upDev + padDev;
    const yMin = prevClose - downDev - padDev;

    const y = scaleLinear(yMin, yMax, L.priceTop + L.priceH, L.priceTop);
    const xOf = i => (L.plotW * (i + 0.5)) / axisCount;
    const y0 = y(prevClose);

    // ---------- 静态层 ----------
    const b = this.buf.ctx;
    b.clearRect(0, 0, w, h);

    const upColor = hi - prevClose >= Math.abs(lo - prevClose) ? pal.up : pal.down;
    const lastPrice = pts[pts.length - 1].price;
    const tint = lastPrice >= prevClose ? pal.up : pal.down;

    // 横向网格 + 右轴标签
    b.font = '10px -apple-system, "PingFang SC", sans-serif';
    b.textBaseline = 'middle';

    // 只在最高 / 最低两条画网格，中间那条留给昨收虚线：轴上只有三个数字，最干净
    const tickYs = [];
    for (const lv of [yMax, yMin]) {
      const yy = y(lv);
      b.strokeStyle = pal.grid;
      b.lineWidth = 1;
      b.beginPath();
      b.moveTo(0, Math.round(yy) + 0.5);
      b.lineTo(L.plotW, Math.round(yy) + 0.5);
      b.stroke();

      // 右轴只留价格：颜色不跟涨跌，避免半屏红绿；百分比交给顶部大字
      b.fillStyle = pal.axis;
      textRight(b, this._fmt(lv), w - 8, yy);
      tickYs.push(yy);
    }

    // 昨收虚线
    b.strokeStyle = withAlpha(pal.text2, 0.5);
    b.lineWidth = 1;
    dashLine(b, 0, Math.round(y0) + 0.5, L.plotW, Math.round(y0) + 0.5, [3, 3]);
    // 昨收价与上下边界的刻度挨太近时就不重复标，避免两个数字叠在一起
    if (tickYs.every(ty => Math.abs(ty - y0) > 15)) {
      b.fillStyle = pal.text2;
      textRight(b, this._fmt(prevClose), w - 8, y0);
    }

    // 涨跌分区填充
    const areaPath = () => {
      b.beginPath();
      b.moveTo(xOf(0), y0);
      for (let i = 0; i < pts.length; i++) b.lineTo(xOf(i), y(pts[i].price));
      b.lineTo(xOf(pts.length - 1), y0);
      b.closePath();
    };

    // 面积只做一层很淡的纵深：单边行情下如果填满到昨收线，半屏都会被染色
    b.save();
    b.beginPath();
    b.rect(0, L.priceTop, L.plotW, L.priceH);
    b.clip();
    const gradArea = b.createLinearGradient(0, L.priceTop, 0, L.priceTop + L.priceH);
    gradArea.addColorStop(0, withAlpha(tint, 0.11));
    gradArea.addColorStop(0.55, withAlpha(tint, 0.04));
    gradArea.addColorStop(1, withAlpha(tint, 0));
    b.fillStyle = gradArea;
    areaPath();
    b.fill();
    b.restore();

    // 价格线
    b.strokeStyle = tint;
    b.lineWidth = 1.6;
    b.lineJoin = 'round';
    b.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const xx = xOf(i);
      const yy = y(pts[i].price);
      if (i === 0) b.moveTo(xx, yy); else b.lineTo(xx, yy);
    }
    b.stroke();

    // 均价线
    if (avg.length) {
      b.strokeStyle = withAlpha(pal.ma5, 0.8);
      b.lineWidth = 1.2;
      b.beginPath();
      let sketch = false;
      let prevYv = null;
      const avgN = Math.min(avg.length, axisCount);
      const maxJump = L.priceH * 0.22;
      for (let i = 0; i < avgN; i++) {
        // 均价偶尔有 0 / 明显跑偏的值，直接连过去会拉出一条竖直的假线
        if (!(avg[i] > 0)) continue;
        if (avg[i] < lo - span * 0.15 || avg[i] > hi + span * 0.15) continue;
        const yy = y(avg[i]);
        if (prevYv != null && Math.abs(yy - prevYv) > maxJump) continue;
        prevYv = yy;
        const xx = xOf(i);
        if (!sketch) { b.moveTo(xx, yy); sketch = true; } else b.lineTo(xx, yy);
      }
      b.stroke();
    }

    // 最新价光点
    const lastX = xOf(pts.length - 1);
    const lastY = y(lastPrice);
    b.beginPath();
    b.arc(lastX, lastY, 2.6, 0, Math.PI * 2);
    b.fillStyle = tint;
    b.fill();
    b.beginPath();
    b.arc(lastX, lastY, 5.2, 0, Math.PI * 2);
    b.strokeStyle = withAlpha(tint, 0.35);
    b.lineWidth = 1.2;
    b.stroke();

    // ---------- 成交量 ----------
    // 分时接口给的是「累计量」，必须先差分再取最大值，
    // 否则第一根的累计值会把后面所有柱子压成看不见
    const deltas = new Array(pts.length);
    let vmax = 0;
    let prevCum = 0;
    for (let i = 0; i < pts.length; i++) {
      const cum = pts[i].cumVol || 0;
      const dv = Math.max(0, cum - prevCum);
      prevCum = cum;
      deltas[i] = dv;
      if (dv > vmax) vmax = dv;
    }
    if (vmax > 0) {
      // 一根柱子至少给 3px。分钟数多的时候按桶聚合，
      // 否则 390 根挤在 330px 里会糊成一片噪点。
      const barMax = Math.max(24, Math.floor(L.plotW / 3.2));
      const step = Math.max(1, Math.ceil(pts.length / barMax));
      const bucket = [];
      const dirs = [];
      for (let s0 = 0; s0 < pts.length; s0 += step) {
        const last = Math.min(s0 + step - 1, pts.length - 1);
        let sum = 0;
        for (let k = s0; k <= last; k++) sum += deltas[k];
        bucket.push(sum);
        dirs.push(last === 0 || pts[last].price >= pts[s0 === 0 ? 0 : s0 - 1].price);
      }

      // 开盘第一分钟往往是一天里的巨量，直接拿它当满格会把后面所有柱子压成一条线。
      // 用 97 分位当满格，超出部分裁顶，整体量能分布才看得出来。
      const sorted = bucket.filter(d => d > 0).sort((a, b2) => a - b2);
      const clipMax = sorted.length ? sorted[Math.floor(sorted.length * 0.97)] || vmax : vmax;
      const slotW = L.plotW / (bucket.length || 1);
      const bw = Math.max(1, slotW * 0.68);

      for (let i = 0; i < bucket.length; i++) {
        if (!bucket[i]) continue;
        const hh = Math.min(1, bucket[i] / clipMax) * (L.volH - 2);
        if (hh < 0.6) continue;
        b.fillStyle = withAlpha(dirs[i] ? pal.up : pal.down, 0.5);
        b.fillRect(i * slotW + (slotW - bw) / 2, L.volTop + L.volH - hh, bw, hh);
      }
    }

    // 时间轴
    b.fillStyle = pal.text2;
    b.font = '10px -apple-system, "PingFang SC", sans-serif';
    b.textBaseline = 'top';
    const yLabel = L.volTop + L.volH + 4;

    const labels = this.opt.timeLabels;
    if (labels && labels.length) {
      const n = labels.length;
      for (let i = 0; i < n; i++) {
        const frac = n === 1 ? 0 : i / (n - 1);
        const xx = frac * L.plotW;
        const txt = labels[i];
        if (i === 0) {
          const prev = b.textAlign; b.textAlign = 'left'; b.fillText(txt, 0, yLabel); b.textAlign = prev;
        } else if (i === n - 1) {
          textRight(b, txt, L.plotW - 2, yLabel);
        } else {
          textCenter(b, txt, xx, yLabel);
        }
      }
    } else if (pts.length > 1) {
      const pick = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round((pts.length - 1) * f));
      for (let i = 0; i < pick.length; i++) {
        const idx = pick[i];
        const xx = xOf(idx);
        const txt = fmtMinuteTime(pts[idx].t);
        if (i === 0) textCenter(b, txt, Math.max(14, xx), yLabel);
        else if (i === pick.length - 1) textRight(b, txt, L.plotW - 2, yLabel);
        else textCenter(b, txt, xx, yLabel);
      }
    }

    this.geom = { L, xOf, y, y0, axisCount, prevClose, tint, upColor };
    this._blit();
  }

  _fmt(v) {
    return Number.isFinite(v) ? v.toFixed(this.digits) : '--';
  }

  _clear() {
    if (!this.env) return;
    this.env.ctx.clearRect(0, 0, this.env.w, this.env.h);
  }

  /** 把静态层贴到主画布 */
  _blit() {
    const { ctx, w, h } = this.env;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.buf.canvas, 0, 0, w, h);
    this.dirty = false;
    if (this.crossIndex >= 0) this._drawCrosshair();
  }

  _bindPointer() {
    const c = this.canvas;
    let downAt = 0;
    let downX = 0;
    let moved = false;

    const posOf = e => {
      const r = c.getBoundingClientRect();
      return e.clientX - r.left;
    };

    const showAt = clientX => {
      if (!this.data || !this.data.points.length || !this.geom) return;
      const { L, axisCount } = this.geom;
      const px = posOf({ clientX });
      let idx = Math.round((px / L.plotW) * axisCount - 0.5);
      idx = Math.max(0, Math.min(this.data.points.length - 1, idx));
      if (idx === this.crossIndex) return;
      this.crossIndex = idx;
      this._blit();
    };

    const hide = () => {
      if (this.crossIndex < 0) return;
      this.crossIndex = -1;
      this._blit();
      this.opt.onHover?.(null);
    };

    c.addEventListener('pointerdown', e => {
      downAt = Date.now();
      downX = e.clientX;
      moved = false;
      c.setPointerCapture?.(e.pointerId);
    });

    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') { showAt(e.clientX); return; }
      if (downAt && Math.abs(e.clientX - downX) > 8) moved = true;
      if (downAt && !moved) showAt(e.clientX);
    });

    c.addEventListener('pointerup', e => {
      const held = Date.now() - downAt;
      if (!moved && held > 100) showAt(e.clientX);
      else if (!moved && held <= 100) hide();
      downAt = 0;
    });

    c.addEventListener('pointercancel', () => { downAt = 0; hide(); });
    c.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse') hide();
    });
  }

  _drawCrosshair() {
    const g = this.geom;
    if (!g || this.crossIndex < 0) return;
    const { ctx, w, h } = this.env;
    const pal = this.palette;
    const { L, xOf, y } = g;

    const p = this.data.points[this.crossIndex];
    const avgArr = this.data.avg || [];
    const avgV = avgArr[this.crossIndex];
    const xx = xOf(this.crossIndex);
    const yy = y(p.price);

    // 竖线
    ctx.strokeStyle = withAlpha(pal.text2, 0.6);
    ctx.lineWidth = 1;
    dashLine(ctx, Math.round(xx) + 0.5, L.priceTop, Math.round(xx) + 0.5, L.volTop + L.volH, [3, 3]);

    // 横线
    dashLine(ctx, 0, Math.round(yy) + 0.5, L.plotW, Math.round(yy) + 0.5, [3, 3]);

    // 价格气泡
    const up = p.price >= g.prevClose;
    const label = this._fmt(p.price);
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = up ? pal.up : pal.down;
    ctx.beginPath();
    const bx = w - tw - 2;
    const by = Math.max(L.priceTop, Math.min(L.priceTop + L.priceH - 18, yy - 9));
    ctx.roundRect ? ctx.roundRect(bx, by, tw, 18, 4) : ctx.rect(bx, by, tw, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + tw / 2, by + 9);

    // 顶部信息条交给详情页头部（DOM）联动显示：图内再画一份会和曲线本身抢位置，
    // 小屏上还会被右轴气泡挡住。这里只留一个跟着光标走的底部时间气泡。
    const pct = g.prevClose ? ((p.price - g.prevClose) / g.prevClose) * 100 : 0;
    const tlabel = fmtMinuteTime(p.t);
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    const tw2 = ctx.measureText(tlabel).width + 10;
    const tx = Math.max(0, Math.min(L.plotW - tw2, xx - tw2 / 2));
    ctx.fillStyle = withAlpha(pal.text2, 0.9);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx, L.volTop + L.volH + 1, tw2, 15, 3);
    else ctx.rect(tx, L.volTop + L.volH + 1, tw2, 15);
    ctx.fill();
    ctx.fillStyle = pal.bg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tlabel, tx + tw2 / 2, L.volTop + L.volH + 9);

    this.opt.onHover?.({
      ...p,
      pct,
      avg: avgV,
      index: this.crossIndex,
    });
  }

  destroy() {
    this.dead = true;
    if (this.unwatch) this.unwatch();
    this.canvas.remove();
  }
}
