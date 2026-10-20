/**
 * 技术指标计算与解读
 *
 * 只做「已经发生的事实」：均线排列、MACD 金叉死叉、KDJ/RSI 区间、BOLL 位置。
 * 不做预测，也不给买卖建议——指标是滞后的，写成"必涨必跌"是骗人。
 *
 * 所有函数都接受 bar 数组（{ open, high, low, close, date }），
 * 数据不足时返回 null，由 UI 显示「数据不足」而不是塞个假数。
 */

/** 简单移动平均，返回定长数组，前 n-1 位为 null */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均 */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (n + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const last = arr => (arr.length ? arr[arr.length - 1] : null);
const round = (v, n = 2) => (Number.isFinite(v) ? +v.toFixed(n) : null);

/**
 * MA 均线组 + 排列判断
 * 多头排列：MA5 > MA10 > MA20；空头反之
 */
export function calcMA(closes, digits = 2) {
  const periods = [5, 10, 20, 60];
  const res = {};
  for (const p of periods) {
    const v = closes.length >= p ? last(sma(closes, p)) : null;
    res['ma' + p] = round(v, digits);
  }

  const { ma5, ma10, ma20 } = res;
  let align = 'none';
  let text = '数据不足';
  if (ma5 != null && ma10 != null && ma20 != null) {
    if (ma5 > ma10 && ma10 > ma20) { align = 'bull'; text = '多头排列'; }
    else if (ma5 < ma10 && ma10 < ma20) { align = 'bear'; text = '空头排列'; }
    else { align = 'mixed'; text = '均线纠缠'; }
  }
  return { ...res, align, text };
}

/**
 * MACD(12, 26, 9)
 * DIF = EMA12 − EMA26；DEA = EMA9(DIF)；柱 = (DIF − DEA) × 2
 * 金叉/死叉看 DIF 与 DEA 的相对位置变化，柱体长度看动能强弱
 */
export function calcMACD(closes, digits = 2) {
  if (closes.length < 35) return null;

  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);

  const d0 = dif[dif.length - 1];
  const a0 = dea[dea.length - 1];
  const h0 = hist[hist.length - 1];
  const h1 = hist[hist.length - 2] ?? h0;

  // 交叉：今天 DIF 在 DEA 上方、昨天在下方 → 金叉
  const dPrev = dif[dif.length - 2];
  const aPrev = dea[dea.length - 2];
  let cross = 'none';
  if (dPrev != null && aPrev != null) {
    if (dPrev <= aPrev && d0 > a0) cross = 'gold';
    else if (dPrev >= aPrev && d0 < a0) cross = 'dead';
  }

  const zone = d0 >= 0 ? 'above' : 'below';      // 零轴上下
  const momentum = Math.abs(h0) > Math.abs(h1) ? 'expand' : 'shrink';

  const parts = [];
  if (cross === 'gold') parts.push('刚金叉');
  else if (cross === 'dead') parts.push('刚死叉');
  else parts.push(d0 > a0 ? 'DIF 在 DEA 上方' : 'DIF 在 DEA 下方');
  parts.push(zone === 'above' ? '零轴上' : '零轴下');
  parts.push(h0 >= 0 ? `红柱${momentum === 'expand' ? '放大' : '缩短'}` : `绿柱${momentum === 'expand' ? '放大' : '缩短'}`);

  return {
    dif: round(d0, digits),
    dea: round(a0, digits),
    hist: round(h0, digits),
    cross, zone, momentum,
    text: parts.join(' · '),
  };
}

/**
 * KDJ(9, 3, 3)
 * RSV = (C − LLV9) / (HHV9 − LLV9) × 100，K/D 用 2/3 平滑，J = 3K − 2D
 */
export function calcKDJ(bars, digits = 2) {
  if (bars.length < 12) return null;

  let k = 50;
  let d = 50;
  let j = 50;
  const n = 9;

  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - n + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let x = from; x <= i; x++) {
      if (bars[x].high > hh) hh = bars[x].high;
      if (bars[x].low < ll) ll = bars[x].low;
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    j = 3 * k - 2 * d;
  }

  let state = 'neutral';
  let text = '中性';
  if (j >= 100 || k >= 80) { state = 'overbought'; text = '超买'; }
  else if (j <= 0 || k <= 20) { state = 'oversold'; text = '超卖'; }
  else if (k > d) { state = 'strong'; text = 'K 在 D 上方'; }
  else if (k < d) { state = 'weak'; text = 'K 在 D 下方'; }

  return { k: round(k, digits), d: round(d, digits), j: round(j, digits), state, text };
}

/** RSI，用 Wilder 平滑（比简单均值更贴近行情软件口径） */
export function calcRSI(closes, period, digits = 2) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let ag = gain / period;
  let al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (ch > 0 ? ch : 0)) / period;
    al = (al * (period - 1) + (ch < 0 ? -ch : 0)) / period;
  }
  if (ag + al === 0) return 50;
  return round((ag / (ag + al)) * 100, digits);
}

/** RSI 组（6/12/24） */
export function calcRSISet(closes, digits = 2) {
  const rsi6 = calcRSI(closes, 6, digits);
  const rsi12 = calcRSI(closes, 12, digits);
  const rsi24 = calcRSI(closes, 24, digits);
  if (rsi6 == null) return null;

  let state = 'neutral';
  let text = '中性';
  if (rsi6 >= 80) { state = 'overbought'; text = '超买'; }
  else if (rsi6 <= 20) { state = 'oversold'; text = '超卖'; }
  else if (rsi6 >= 50) { state = 'strong'; text = '强势区'; }
  else { state = 'weak'; text = '弱势区'; }

  return { rsi6, rsi12, rsi24, state, text };
}

/**
 * BOLL(20, 2)：中轨 = MA20，上下轨 = 中轨 ± 2 倍标准差
 */
export function calcBOLL(closes, digits = 2) {
  const n = 20;
  if (closes.length < n) return null;

  const midArr = sma(closes, n);
  const mid = last(midArr);
  const from = closes.length - n;
  let variance = 0;
  for (let i = from; i < closes.length; i++) variance += (closes[i] - mid) ** 2;
  const sd = Math.sqrt(variance / n);

  const up = mid + 2 * sd;
  const low = mid - 2 * sd;
  const price = closes[closes.length - 1];

  let pos = 'mid';
  let text = '中轨附近';
  if (price > up) { pos = 'above'; text = '突破上轨'; }
  else if (price < low) { pos = 'below'; text = '跌破下轨'; }
  else if (price > mid) { pos = 'upper'; text = '中轨上方'; }
  else { pos = 'lower'; text = '中轨下方'; }

  const width = mid ? (sd * 4 / mid) * 100 : 0;

  return {
    up: round(up, digits),
    mid: round(mid, digits),
    low: round(low, digits),
    pos, text,
    width: round(width, 2),   // 带宽，越窄说明波动收敛得越厉害
  };
}

/**
 * 综合倾向：把五个指标各投一票
 *
 * 明确不做「强烈买入」这种措辞——分数只用来描述当前状态偏多还是偏空，
 * 而且刻意把结论写软，避免被当成交易信号。
 */
export function summarize({ ma, macd, kdj, rsi, boll }) {
  let score = 0;
  let total = 0;

  if (ma && ma.align !== 'none') {
    total++;
    if (ma.align === 'bull') score++;
    else if (ma.align === 'bear') score--;
  }
  if (macd) {
    total++;
    if (macd.cross === 'gold') score += 1;
    else if (macd.cross === 'dead') score -= 1;
    else if (macd.dif != null && macd.dea != null) score += macd.dif > macd.dea ? 1 : -1;
  }
  if (kdj) {
    total++;
    if (kdj.state === 'overbought') score -= 0.5;
    else if (kdj.state === 'oversold') score += 0.5;
    else score += kdj.k > kdj.d ? 1 : -1;
  }
  if (rsi) {
    total++;
    if (rsi.state === 'overbought') score -= 0.5;
    else if (rsi.state === 'oversold') score += 0.5;
    else score += rsi.rsi6 >= 50 ? 1 : -1;
  }
  if (boll) {
    total++;
    if (boll.pos === 'above') score += 0.5;
    else if (boll.pos === 'below') score -= 0.5;
    else score += boll.pos === 'upper' ? 1 : -1;
  }

  if (!total) return { label: 'none', text: '数据不足' };

  const ratio = score / total;
  if (ratio >= 0.6) return { label: 'bull', text: '指标偏多' };
  if (ratio >= 0.2) return { label: 'lean-bull', text: '略偏多' };
  if (ratio <= -0.6) return { label: 'bear', text: '指标偏空' };
  if (ratio <= -0.2) return { label: 'lean-bear', text: '略偏空' };
  return { label: 'neutral', text: '多空胶着' };
}

/**
 * 一次算全套
 * @param {Array<{open:number,high:number,low:number,close:number}>} bars
 * @param {number} digits 价格小数位
 * @param {boolean} [withBoll] 数据太少时跳过 BOLL（周/月线常见）
 */
export function analyze(bars, digits = 2) {
  if (!Array.isArray(bars) || bars.length < 6) return null;
  const closes = bars.map(b => b.close).filter(v => Number.isFinite(v) && v > 0);
  if (closes.length < 6) return null;

  const ma = calcMA(closes, digits);
  const macd = calcMACD(closes, digits);
  const kdj = calcKDJ(bars, Math.min(digits, 2));
  const rsi = calcRSISet(closes, Math.min(digits, 2));
  const boll = calcBOLL(closes, digits);

  return { ma, macd, kdj, rsi, boll, bias: summarize({ ma, macd, kdj, rsi, boll }), n: bars.length };
}
