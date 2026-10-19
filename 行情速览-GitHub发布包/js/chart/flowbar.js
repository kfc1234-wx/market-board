/**
 * ETF 资金流柱状图
 *
 * - 零轴居中，正数向上（红）、负数向下（绿），与行情配色一致
 * - 叠加 MA5 净流入均线（虚线），看趋势而非单日噪声
 * - 轻点显示当日详情；柱数 ≤10 时直接在柱端标数值
 */

import {
  setupCanvas, scaleLinear, textRight, textCenter, dashLine, watchResize,
} from './base.js';
import { readPalette, withAlpha, shortDate, fmtSignedBig, fmtBig } from '../util/format.js';

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function ma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export class FlowBarChart {
  constructor(host, opt = {}) {
    this.host = host;
    this.opt = opt;

    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);

    this.rows = [];
    this.crossIndex = -1;
    this.palette = readPalette();
    this.env = null;
    this.geom = null;
    this.dead = false;

    this._bindPointer();

    this.unwatch = watchResize(host, () => {
      if (this.dead) return;
      this._rebuildEnv();
      this.render();
    });
  }

  _rebuildEnv() {
    this.env = setupCanvas(this.canvas);
  }

  setPalette() {
    this.palette = readPalette();
    this.render();
  }

  /** @param {Array<{date:string,net:number,main:number,netPct:number}>} rows */
  setData(rows) {
    this.rows = Array.isArray(rows) ? rows.slice(-20) : [];
    this.crossIndex = -1;
    this.render();
  }

  render() {
    if (this.dead || !this.env) return;
    const { ctx, w, h } = this.env;
    const pal = this.palette;
    ctx.clearRect(0, 0, w, h);

    const rows = this.rows;
    if (!rows.length) {
      this.geom = null;
      return;
    }

    const padRight = 56;
    const padTop = 10;
    const padBottom = 18;
    const plotW = Math.max(10, w - padRight);
    const plotH = Math.max(30, h - padTop - padBottom);

    let maxAbs = 0;
    for (const r of rows) {
      const a = Math.abs(r.net);
      if (a > maxAbs) maxAbs = a;
    }
    if (!maxAbs) maxAbs = 1;
    const domain = maxAbs * 1.18;

    const y = scaleLinear(-domain, domain, padTop + plotH, padTop);
    const zeroY = y(0);
    const bw = plotW / rows.length;
    const barW = Math.max(1, bw * 0.62);

    // 网格 + 右轴
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = -domain + (domain * 2 * i) / 4;
      const yy = y(v);
      const isZero = Math.abs(v) < 1e-9;
      ctx.strokeStyle = isZero ? withAlpha(pal.text2, 0.5) : pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yy) + 0.5);
      ctx.lineTo(plotW, Math.round(yy) + 0.5);
      ctx.stroke();

      ctx.fillStyle = pal.text2;
      textRight(ctx, isZero ? '0' : fmtBig(v, 1), w - 4, yy);
    }

    // 柱
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cx = bw * (i + 0.5);
      const top = r.net >= 0 ? y(r.net) : zeroY;
      const hh = Math.max(1, Math.abs(y(r.net) - zeroY));
      ctx.fillStyle = withAlpha(r.net >= 0 ? pal.up : pal.down, 0.9);
      ctx.fillRect(cx - barW / 2, top, barW, hh);

      // 柱数少时直接标数值
      if (rows.length <= 10 && Math.abs(r.net) > 0) {
        ctx.fillStyle = r.net >= 0 ? pal.up : pal.down;
        ctx.font = '9px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = r.net >= 0 ? 'bottom' : 'top';
        const label = fmtBig(r.net, 1);
        if (r.net >= 0) ctx.fillText(label, cx, top - 2);
        else ctx.fillText(label, cx, zeroY + hh + 2);
        ctx.textBaseline = 'middle';
      }
    }

    // MA5 均线
    const avg = ma(rows.map(r => r.net), 5);
    ctx.strokeStyle = pal.ma5;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < avg.length; i++) {
      if (avg[i] == null) { started = false; continue; }
      const cx = bw * (i + 0.5);
      const cy = y(avg[i]);
      if (!started) { ctx.moveTo(cx, cy); started = true; }
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // 日期轴
    ctx.fillStyle = pal.text2;
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'top';
    const yLabel = padTop + plotH + 4;
    const picks = [0, 0.33, 0.66, 1].map(f => Math.round((rows.length - 1) * f));
    const seen = new Set();
    picks.forEach((idx, k) => {
      if (seen.has(idx)) return;
      seen.add(idx);
      const txt = shortDate(rows[idx].date);
      if (k === 0) {
        const prev = ctx.textAlign; ctx.textAlign = 'left'; ctx.fillText(txt, 1, yLabel); ctx.textAlign = prev;
      } else if (k === picks.length - 1) {
        textRight(ctx, txt, plotW - 2, yLabel);
      } else {
        textCenter(ctx, txt, bw * (idx + 0.5), yLabel);
      }
    });

    this.geom = { y, bw, plotW, padTop, plotH, zeroY, rows };

    if (this.crossIndex >= 0) this._drawCrosshair();
  }

  _bindPointer() {
    const c = this.canvas;

    const showAt = clientX => {
      if (!this.geom) return;
      const rect = c.getBoundingClientRect();
      const px = clientX - rect.left;
      const idx = clamp(Math.floor(px / this.geom.bw), 0, this.geom.rows.length - 1);
      if (idx === this.crossIndex) return;
      this.crossIndex = idx;
      this.render();
      this.opt.onHover?.(this.geom.rows[idx]);
    };

    c.addEventListener('pointerdown', e => {
      this._down = true;
      showAt(e.clientX);
    });
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') showAt(e.clientX);
    });
    c.addEventListener('pointerup', () => { this._down = false; });
    c.addEventListener('pointerleave', e => {
      if (e.pointerType !== 'mouse') return;
      if (this.crossIndex >= 0) {
        this.crossIndex = -1;
        this.render();
        this.opt.onHover?.(null);
      }
    });
  }

  _drawCrosshair() {
    const g = this.geom;
    if (!g || this.crossIndex < 0) return;
    const row = g.rows[this.crossIndex];
    if (!row) return;

    const { ctx, w } = this.env;
    const pal = this.palette;
    const cx = g.bw * (this.crossIndex + 0.5);

    ctx.strokeStyle = withAlpha(pal.text2, 0.55);
    ctx.lineWidth = 1;
    dashLine(ctx, Math.round(cx) + 0.5, g.padTop, Math.round(cx) + 0.5, g.padTop + g.plotH, [3, 3]);

    const info = `${row.date}  净流入 ${fmtSignedBig(row.net)}  主力 ${fmtSignedBig(row.main)}`;
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    const iw = Math.min(ctx.measureText(info).width + 14, w - 8);
    ctx.fillStyle = withAlpha(pal.bg, 0.9);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(4, g.padTop - 8, iw, 20, 4); else ctx.rect(4, g.padTop - 8, iw, 20);
    ctx.fill();
    ctx.fillStyle = row.net >= 0 ? pal.up : pal.down;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(info, 11, g.padTop + 2);
  }

  destroy() {
    this.dead = true;
    if (this.unwatch) this.unwatch();
    this.canvas.remove();
  }
}
