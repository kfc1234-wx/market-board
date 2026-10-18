/**
 * K 线图（含成交量副图、MA5/10/20、十字光标、双指缩放、横向平移）
 *
 * 手势状态机：
 *   pointerdown → pending
 *     ├ 停留 >220ms 且位移 <8px  → cross（十字光标）
 *     ├ 横向位移 >8px 且 |dx|>|dy|*1.2 → pan
 *     └ 落下第二根手指 → pinch（以中点为锚，保持索引不漂移）
 *
 * canvas 上设了 touch-action: pan-y，竖向滚页交给浏览器，横向手势由我们接管。
 */

import {
  setupCanvas, makeBuffer, scaleLinear, textRight, textCenter, dashLine, watchResize,
} from './base.js';
import { readPalette, withAlpha, shortDate, fmtPrice } from '../util/format.js';

const MIN_BARS = 25;
const MAX_BARS = 200;
const DEFAULT_BARS = 60;

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/** 计算 MA 序列（基于全量 bars，保证可视区边缘连续） */
function movingAverage(bars, n) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export class KlineChart {
  constructor(host, opt = {}) {
    this.host = host;
    this.opt = opt;
    this.digits = opt.digits ?? 2;

    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);

    this.bars = [];
    this.mas = { 5: [], 10: [], 20: [] };
    this.count = DEFAULT_BARS;
    this.start = 0;
    this.crossIndex = -1;

    this.palette = readPalette();
    this.env = null;
    this.buf = null;
    this.geom = null;
    this.dead = false;

    this._pointers = new Map();
    this._mode = null;
    this._longPressTimer = 0;
    this._gesture = null;

    this._bindGestures();

    this.unwatch = watchResize(host, () => {
      if (this.dead) return;
      this._rebuildEnv();
      this._renderStatic();
      this._blit();
    });
  }

  _rebuildEnv() {
    const env = setupCanvas(this.canvas);
    this.env = env;
    this.buf = makeBuffer(env.w, env.h, env.dpr);
  }

  setPalette() {
    this.palette = readPalette();
    this._renderStatic();
    this._blit();
  }

  /**
   * @param {Array} bars 升序日线
   * @param {{keepView?:boolean}} [opt]
   */
  setData(bars, opt = {}) {
    const prevLen = this.bars.length;
    const wasAtRight = this.start + this.count >= prevLen - 1;

    this.bars = bars;
    this.mas = { 5: movingAverage(bars, 5), 10: movingAverage(bars, 10), 20: movingAverage(bars, 20) };

    this.count = clamp(this.count, MIN_BARS, MAX_BARS);
    if (!opt.keepView || wasAtRight || prevLen === 0) {
      this.start = Math.max(0, bars.length - this.count);
    } else {
      this.start = clamp(this.start, 0, Math.max(0, bars.length - this.count));
    }
    if (this.crossIndex >= 0) this.opt.onHover?.(null);
    this.crossIndex = -1;
    this._renderStatic();
    this._blit();
  }

  _layout(w, h) {
    const padRight = 52;
    const padTop = 22;      // 顶部留给 MA 图例
    const padBottom = 16;
    const gap = 7;
    const usable = h - padTop - padBottom;
    const priceH = Math.max(60, usable * 0.74);
    const volH = Math.max(26, usable - priceH - gap);
    return {
      padRight, padTop, padBottom, gap,
      plotW: Math.max(10, w - padRight),
      priceTop: padTop,
      priceH,
      volTop: padTop + priceH + gap,
      volH,
    };
  }

  _visible() {
    const end = Math.min(this.bars.length, this.start + this.count);
    return { from: this.start, to: end, list: this.bars.slice(this.start, end) };
  }

  _renderStatic() {
    if (this.dead || !this.env || !this.buf) return;
    // 静态层必须画进离屏缓冲：_blit 会先 clearRect 再贴图，
    // 若直接画在可见 canvas 上会被这一贴覆盖成空白
    const { w, h } = this.env;
    const b = this.buf.ctx;
    const pal = this.palette;
    b.clearRect(0, 0, w, h);

    if (!this.bars.length) {
      this.geom = null;
      return;
    }

    const L = this._layout(w, h);
    const { from, list } = this._visible();
    if (!list.length) { this.geom = null; return; }

    let hi = -Infinity;
    let lo = Infinity;
    for (const bar of list) {
      if (bar.high > hi) hi = bar.high;
      if (bar.low < lo) lo = bar.low;
    }
    // 把可视区内的均线也纳入取值范围，避免均线被裁掉
    for (const n of [5, 10, 20]) {
      const arr = this.mas[n];
      for (let i = from; i < from + list.length; i++) {
        const v = arr[i];
        if (v == null) continue;
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) {
      hi = (hi || 1) * 1.01;
      lo = (lo || 1) * 0.99;
    }
    const padY = (hi - lo) * 0.06;
    const yMax = hi + padY;
    const yMin = lo - padY;

    const y = scaleLinear(yMin, yMax, L.priceTop + L.priceH, L.priceTop);
    const bw = L.plotW / this.count;
    const bodyW = Math.max(1, bw * 0.62);

    let vmax = 0;
    for (const bar of list) if (bar.volume > vmax) vmax = bar.volume;
    const yv = scaleLinear(0, vmax || 1, L.volTop + L.volH, L.volTop);

    // 横向网格 + 右轴
    b.font = '10px -apple-system, "PingFang SC", sans-serif';
    b.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) * i) / 4;
      const yy = y(v);
      b.strokeStyle = pal.grid;
      b.lineWidth = 1;
      b.beginPath();
      b.moveTo(0, Math.round(yy) + 0.5);
      b.lineTo(L.plotW, Math.round(yy) + 0.5);
      b.stroke();

      b.fillStyle = pal.text2;
      textRight(b, fmtPrice(v, this.digits), w - 4, yy);
    }

    // 成交量区顶线
    b.strokeStyle = pal.grid;
    b.beginPath();
    b.moveTo(0, Math.round(L.volTop) + 0.5);
    b.lineTo(L.plotW, Math.round(L.volTop) + 0.5);
    b.stroke();

    // ---------- 蜡烛 + 量柱 ----------
    for (let i = 0; i < list.length; i++) {
      const bar = list[i];
      const cx = bw * (i + 0.5);
      const up = bar.close >= bar.open;
      const color = up ? pal.up : pal.down;

      // 影线
      b.strokeStyle = color;
      b.lineWidth = 1;
      b.beginPath();
      b.moveTo(Math.round(cx) + 0.5, y(bar.high));
      b.lineTo(Math.round(cx) + 0.5, y(bar.low));
      b.stroke();

      // 实体
      const yOpen = y(bar.open);
      const yClose = y(bar.close);
      const top = Math.min(yOpen, yClose);
      const bodyH = Math.max(1, Math.abs(yClose - yOpen));
      b.fillStyle = color;

      if (bodyH <= 1.5) {
        // 一字 / 十字：画一条横杠
        b.fillRect(cx - bodyW / 2, top - 0.75, bodyW, 1.5);
      } else if (up) {
        // 阳线空心
        b.strokeStyle = color;
        b.lineWidth = Math.max(1, Math.min(1.4, bodyW * 0.18));
        b.strokeRect(cx - bodyW / 2, top, bodyW, bodyH);
      } else {
        b.fillRect(cx - bodyW / 2, top, bodyW, bodyH);
      }

      // 量柱
      const vh = vmax ? (bar.volume / vmax) * (L.volH - 2) : 0;
      if (vh > 0) {
        b.fillStyle = withAlpha(color, 0.5);
        b.fillRect(cx - bodyW / 2, L.volTop + L.volH - vh, bodyW, vh);
      }
    }

    // ---------- 均线 ----------
    const drawMA = (n, color) => {
      const arr = this.mas[n];
      b.strokeStyle = color;
      b.lineWidth = 1;
      b.beginPath();
      let started = false;
      for (let i = 0; i < list.length; i++) {
        const v = arr[from + i];
        if (v == null) { started = false; continue; }
        const cx = bw * (i + 0.5);
        const cy = y(v);
        if (!started) { b.moveTo(cx, cy); started = true; }
        else b.lineTo(cx, cy);
      }
      b.stroke();
    };
    drawMA(5, pal.ma5);
    drawMA(10, pal.ma10);
    drawMA(20, pal.ma20);

    // ---------- MA 图例不在这里画 ----------
    // 图例要跟着十字光标变，属于动态层（_drawLegend），画进静态层会在光标移动后停住

    // ---------- 日期轴 ----------
    b.fillStyle = pal.text2;
    b.textBaseline = 'top';
    const yLabel = L.volTop + L.volH + 4;
    const picks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round((list.length - 1) * f));
    const seen = new Set();
    picks.forEach((idx, k) => {
      if (seen.has(idx)) return;
      seen.add(idx);
      const txt = shortDate(list[idx].date);
      const cx = bw * (idx + 0.5);
      if (k === 0) {
        const prev = b.textAlign; b.textAlign = 'left'; b.fillText(txt, 1, yLabel); b.textAlign = prev;
      } else if (k === picks.length - 1) {
        textRight(b, txt, L.plotW - 2, yLabel);
      } else {
        textCenter(b, txt, cx, yLabel);
      }
    });

    this.geom = { L, y, yv, bw, bodyW, from, list, yMax, yMin, vmax };
  }

  _blit() {
    if (!this.env) return;
    const { ctx, w, h } = this.env;
    ctx.clearRect(0, 0, w, h);
    if (this.buf) ctx.drawImage(this.buf.canvas, 0, 0, w, h);
    this._drawLegend();
    if (this.crossIndex >= 0) this._drawCrosshair();
  }

  /** MA 图例：有光标时显示光标那根的均线，否则显示可视区最后一根 */
  _drawLegend() {
    const g = this.geom;
    if (!g) return;
    const ctx = this.env.ctx;
    const pal = this.palette;
    const abs = this.crossIndex >= 0 ? this.crossIndex : g.from + g.list.length - 1;

    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lx = 2;
    for (const [n, color] of [[5, pal.ma5], [10, pal.ma10], [20, pal.ma20]]) {
      const v = this.mas[n][abs];
      const txt = `MA${n}: ${v != null ? v.toFixed(this.digits) : '--'}`;
      ctx.fillStyle = color;
      ctx.fillText(txt, lx, 11);
      lx += ctx.measureText(txt).width + 10;
    }
  }

  /** 把静态层重新画到 buf 并贴图 */
  render() {
    if (this.dead || !this.env) return;
    this._renderStatic();
    this._blit();
  }

  _bindGestures() {
    const c = this.canvas;

    const localX = e => {
      const r = c.getBoundingClientRect();
      return e.clientX - r.left;
    };

    // 传入的必须是 canvas 局部坐标（不能用 clientX，否则 canvas 左边有边距时整根偏移）
    const showAt = x => {
      if (!this.geom) return;
      const { bw, from } = this.geom;
      const rel = Math.floor(x / bw);
      const idx = clamp(from + rel, from, from + this.geom.list.length - 1);
      if (idx === this.crossIndex) return;
      this.crossIndex = idx;
      this._blit();
    };

    const hideCross = () => {
      if (this.crossIndex < 0) return;
      this.crossIndex = -1;
      this._blit();
      this.opt.onHover?.(null);
    };

    const clearLongPress = () => {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = 0;
    };

    c.addEventListener('pointerdown', e => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }

      if (this._pointers.size === 2) {
        // 进入缩放
        clearLongPress();
        this._mode = 'pinch';
        const pts = [...this._pointers.values()];
        this._gesture = {
          d0: Math.abs(pts[0].x - pts[1].x) || 1,
          count0: this.count,
          start0: this.start,
          midAbs: this._absIndexOf(clientXOf(pts) - c.getBoundingClientRect().left),
        };
        return;
      }

      if (this._pointers.size > 1) return;

      // 十字线已经在图上时，按下即进入拖动（不必再等一次长按）；
      // 若这一下没拖动就抬手，视为「轻点关闭」，所以先不跳位置，等移动
      if (this.crossIndex >= 0) {
        clearLongPress();
        this._mode = 'cross';
        this._tapClose = true;
        this._gesture = { x0: e.clientX, y0: e.clientY, start0: this.start, moved: true };
        return;
      }

      this._mode = 'pending';
      this._tapClose = false;
      this._gesture = { x0: e.clientX, y0: e.clientY, start0: this.start, moved: false };

      clearLongPress();
      this._longPressTimer = setTimeout(() => {
        if (this._mode === 'pending' && this._gesture && !this._gesture.moved) {
          this._mode = 'cross';
          showAt(localX(e));
        }
      }, 220);
    });

    c.addEventListener('pointermove', e => {
      if (!this._pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse' && this.geom) showAt(localX(e));
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._mode === 'pinch' && this._pointers.size === 2 && this.geom) {
        const pts = [...this._pointers.values()];
        const d = Math.abs(pts[0].x - pts[1].x) || 1;
        const ratio = d / this._gesture.d0;
        const next = clamp(Math.round(this._gesture.count0 * ratio), MIN_BARS, Math.min(MAX_BARS, this.bars.length));
        if (next !== this.count) {
          this.count = next;
          this.start = clamp(
            Math.round(this._gesture.midAbs - (this._gesture.midAbs - this._gesture.start0) * (this._gesture.count0 / this.count)),
            0,
            Math.max(0, this.bars.length - this.count),
          );
          this.render();
        }
        return;
      }

      if (!this.geom) return;

      if (this._mode === 'pending' && this._gesture) {
        const dx = e.clientX - this._gesture.x0;
        const dy = e.clientY - this._gesture.y0;
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          clearLongPress();
          this._mode = 'pan';
          this._gesture.moved = true;
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          // 竖向让位给页面滚动
          clearLongPress();
          this._mode = null;
          return;
        }
      }

      if (this._mode === 'pan' && this._gesture) {
        const dx = e.clientX - this._gesture.x0;
        const delta = Math.round(-dx / this.geom.bw);
        const next = clamp(this._gesture.start0 + delta, 0, Math.max(0, this.bars.length - this.count));
        if (next !== this.start) {
          this.start = next;
          this.crossIndex = -1;
          this.render();
        }
        return;
      }

      if (this._mode === 'cross') {
        // 抬手关闭的判定要用「有没有真的拖过」
        if (this._tapClose) {
          if (Math.abs(e.clientX - this._gesture.x0) < 6) return;
          this._tapClose = false;
        }
        showAt(localX(e));
      }
    });

    const endPointer = e => {
      this._pointers.delete(e.pointerId);
      clearLongPress();
      if (this._pointers.size === 0) {
        if (this._mode === 'pending') {
          // 轻点：切换十字光标
          if (this.crossIndex >= 0) hideCross();
          else if (this.geom) showAt(localX(e));
        } else if (this._tapClose) {
          // 有十字线时按下既没拖也没长按 → 轻点关掉
          hideCross();
        }
        this._tapClose = false;
        this._mode = null;
        this._gesture = null;
      } else if (this._pointers.size === 1) {
        // 从双指退回单指：重置为待定，避免误判为平移
        this._mode = 'pending';
        const p = [...this._pointers.values()][0];
        this._gesture = { x0: p.x, y0: p.y, start0: this.start, moved: true };
      }
    };

    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse' && this._pointers.size === 0) hideCross();
    });

    function clientXOf(pts) {
      return (pts[0].x + pts[1].x) / 2;
    }
  }

  _absIndexOf(relX) {
    if (!this.geom) return 0;
    const rel = Math.floor(relX / this.geom.bw);
    return clamp(this.geom.from + rel, 0, this.bars.length - 1);
  }

  _drawCrosshair() {
    const g = this.geom;
    if (!g || this.crossIndex < 0) return;
    const bar = this.bars[this.crossIndex];
    if (!bar) return;

    const { ctx, w } = this.env;
    const pal = this.palette;
    const { L, y, bw, from, list } = g;

    const rel = this.crossIndex - from;
    const cx = bw * (rel + 0.5);
    const cy = y(bar.close);

    // 十字线
    ctx.strokeStyle = withAlpha(pal.text2, 0.6);
    ctx.lineWidth = 1;
    dashLine(ctx, Math.round(cx) + 0.5, L.priceTop, Math.round(cx) + 0.5, L.volTop + L.volH, [3, 3]);
    dashLine(ctx, 0, Math.round(cy) + 0.5, L.plotW, Math.round(cy) + 0.5, [3, 3]);

    // 右轴价格气泡
    const label = fmtPrice(bar.close, this.digits);
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 12;
    const bx = w - tw - 2;
    const by = Math.max(L.priceTop, Math.min(L.priceTop + L.priceH - 18, cy - 9));
    ctx.fillStyle = bar.close >= bar.open ? pal.up : pal.down;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, tw, 18, 4); else ctx.rect(bx, by, tw, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + tw / 2, by + 9);

    // 底部日期气泡：跟轴上刻度统一成 MM-DD，免得整串年月日糊住半条轴
    const dlabel = shortDate(bar.date);
    const dw = ctx.measureText(dlabel).width + 10;
    const dx = clamp(cx - dw / 2, 0, L.plotW - dw);
    ctx.fillStyle = withAlpha(pal.text2, 0.9);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(dx, L.volTop + L.volH + 1, dw, 15, 3); else ctx.rect(dx, L.volTop + L.volH + 1, dw, 15);
    ctx.fill();
    ctx.fillStyle = pal.bg;
    ctx.textAlign = 'center';
    ctx.fillText(dlabel, dx + dw / 2, L.volTop + L.volH + 9);

    // 顶部 OHLC 信息条不再画在图上：数值统一交给详情页头部（DOM）联动，
    // 图内重复一份会在小屏上和 MA 图例、日期气泡抢位置
    const prevBar = this.bars[this.crossIndex - 1];
    const chgPct = prevBar && prevBar.close ? ((bar.close - prevBar.close) / prevBar.close) * 100 : 0;

    // 「距今涨幅」：从光标这根 K 线到今天（最新一根）的涨跌幅，正数=之后涨了
    const lastBar = this.bars[this.bars.length - 1] || bar;
    const lastClose = lastBar.close;
    const gapPct = bar.close ? ((lastClose - bar.close) / bar.close) * 100 : 0;
    const gapDays = Math.max(0, this.bars.length - 1 - this.crossIndex);

    this.opt.onHover?.({
      ...bar,
      prevClose: prevBar ? prevBar.close : null,
      chgPct,
      dayPct: chgPct,
      gapPct,
      gapDays,
      lastClose,
      isLast: this.crossIndex === this.bars.length - 1,
      index: this.crossIndex,
      ma5: this.mas[5][this.crossIndex],
      ma10: this.mas[10][this.crossIndex],
      ma20: this.mas[20][this.crossIndex],
    });
  }

  destroy() {
    this.dead = true;
    clearTimeout(this._longPressTimer);
    if (this.unwatch) this.unwatch();
    this.canvas.remove();
  }
}
