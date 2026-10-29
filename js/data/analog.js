/**
 * 相似历史日匹配（analog matching）
 *
 * 不做硬分格：把今天的五个特征标准化后，丢进历史里找距离最近的 K 天，
 * 直接看这些天的后续收益分布。好处是没有空格子、样本量自适应，
 * 也不会因为某个分位边界切得巧不巧而得出完全不同的结论。
 *
 * 五个特征（全部只用当日收盘及之前的数据，与历史库同一套算法）
 *   1 当日涨跌幅
 *   2 量比 = 当日量 ÷ 前 5 日均量
 *   3 20 日动量
 *   4 20 日波动（日涨跌幅的标准差）
 *   5 20 日相对强弱 = 创业板 20 日动量 − 上证 20 日动量
 *     注意这是**市场风格**（资金偏小盘还是偏大盘），三只指数共用同一条序列，
 *     不是「这只指数自己的相对强弱」。
 *
 * 三个约束，都是为了不骗自己
 *   · 标准化参数只用历史库的候选池，不含今天
 *   · 候选日必须「60 个交易日的收益都走完」，否则三个持有期不是同一批样本
 *   · 相邻交易日几乎重复，强制拉开 5 天的间隔，否则 60 个邻居其实只有十来个独立信息
 */
import { HISTORY } from './analysis-history.js';

export const HORIZONS = [5, 20, 60];

/** 页面上的指数切换项 */
export const INDICES = [
  { id: 'sh000001', name: '上证指数', short: '上证' },
  { id: 'sz399001', name: '深证成指', short: '深证' },
  { id: 'sz399006', name: '创业板指', short: '创业板' },
];
const K = HISTORY.meta.k;
const GAP = HISTORY.meta.gap;
const MAX_H = Math.max(...HORIZONS);

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = xs => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
};

/** 20 日相对强弱序列：三只指数共用，只算一次 */
let RS = null;
function relStrength() {
  if (RS) return RS;
  const cyb = HISTORY.close.sz399006;
  const sh = HISTORY.close.sh000001;
  const n = Math.min(cyb.length, sh.length);
  RS = new Array(n).fill(NaN);
  for (let i = 20; i < n; i++) {
    RS[i] = ((cyb[i] / cyb[i - 20] - 1) - (sh[i] / sh[i - 20] - 1)) * 100;
  }
  return RS;
}

/** 一个指数的历史特征表与候选池（算一次缓存住） */
const FEAT = new Map();
function featsOf(indexId) {
  if (FEAT.has(indexId)) return FEAT.get(indexId);

  const close = HISTORY.close[indexId];
  const vr = HISTORY.vr[indexId];
  const rs = relStrength();
  const n = close.length;

  const pct = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (close[i - 1] > 0) pct[i] = (close[i] / close[i - 1] - 1) * 100;
  }

  const rows = [];
  for (let i = 20; i < n; i++) {
    if (!Number.isFinite(pct[i]) || !(vr[i] > 0) || !Number.isFinite(rs[i])) continue;
    const ps = pct.slice(i - 19, i + 1);
    if (ps.some(x => !Number.isFinite(x))) continue;
    rows.push({
      i,
      date: HISTORY.dates[i],
      f: [pct[i], vr[i], (close[i] / close[i - 20] - 1) * 100, stdev(ps), rs[i]],
      pct: pct[i],
      vr: vr[i],
      rs: rs[i],
    });
  }

  // 候选池：60 个交易日的收益必须都已走完，否则三档不是同一批样本
  const pool = rows.filter(r => r.i + MAX_H < n);
  const mu = [0, 1, 2, 3, 4].map(j => mean(pool.map(r => r.f[j])));
  const sd = [0, 1, 2, 3, 4].map(j => stdev(pool.map(r => r.f[j])) || 1);

  const out = { close, rows, pool, mu, sd, last: n - 1 };
  FEAT.set(indexId, out);
  return out;
}

/** 从实时日线算今天的特征（与历史库同一套公式） */
export function todayVector(bars, barsSh, barsCyb) {
  if (!bars || bars.length < 21) return null;
  const close = bars.map(b => b.close);
  const m = close.length;
  const pcts = [];
  for (let i = 1; i < m; i++) {
    pcts.push(close[i - 1] > 0 ? (close[i] / close[i - 1] - 1) * 100 : NaN);
  }
  const last20 = pcts.slice(-20);
  if (last20.some(x => !Number.isFinite(x))) return null;

  // 量比的分母必须是「状态日之前」的 5 天。
  //
  // 早前这里按「今天」切：盘前时最后一根 K 线就是上一交易日，它会被同时算进
  // 分子和分母，量比被硬压向 1（实测最多低估 26%），足以把今天的特征推到
  // 另一片区域、换掉「最像的 60 天」。改成以状态日为准，盘中盘前都对。
  const stateDate = bars[bars.length - 1].date;
  const prev5 = bars.filter(b => b.date < stateDate).slice(-5);
  if (prev5.length < 5) return null;
  const vr = (bars[bars.length - 1].vol || 0) / mean(prev5.map(b => b.vol));

  const mom20 = (close[m - 1] / close[m - 21] - 1) * 100;

  let rs = NaN;
  if (barsSh && barsCyb && barsSh.length > 20 && barsCyb.length > 20) {
    const eSh = barsSh[barsSh.length - 1].date;
    const eCyb = barsCyb[barsCyb.length - 1].date;
    const end = eSh < eCyb ? eSh : eCyb;
    const iS = barsSh.findIndex(b => b.date === end);
    const iC = barsCyb.findIndex(b => b.date === end);
    if (iS >= 20 && iC >= 20) {
      rs = ((barsCyb[iC].close / barsCyb[iC - 20].close - 1)
        - (barsSh[iS].close / barsSh[iS - 20].close - 1)) * 100;
    }
  }

  return {
    date: bars[bars.length - 1].date,
    f: [pcts[pcts.length - 1], vr, mom20, stdev(last20), rs],
    pct: pcts[pcts.length - 1],
    vr,
    mom20,
    vol20: stdev(last20),
    rs,
  };
}

/**
 * 找相似日并汇总
 * @param {string} indexId
 * @param {{date:string,f:number[]}} today
 * @param {{k?:number}} [opt]
 */
export function analogs(indexId, today, opt = {}) {
  const M = featsOf(indexId);
  const k = Math.max(10, Math.min(opt.k || K, 120));
  if (!today || today.f.some(x => !Number.isFinite(x))) return null;

  const z0 = today.f.map((v, j) => (v - M.mu[j]) / M.sd[j]);
  const scored = M.pool
    .filter(r => r.date < today.date)          // 只用今天之前
    .map(r => {
      let d2 = 0;
      for (let j = 0; j < 5; j++) {
        const z = (r.f[j] - M.mu[j]) / M.sd[j] - z0[j];
        d2 += z * z;
      }
      return { r, d: Math.sqrt(d2) };
    })
    .sort((a, b) => a.d - b.d);

  const picked = [];
  for (const { r, d } of scored) {
    if (picked.some(p => Math.abs(p.r.i - r.i) < GAP)) continue;   // 相邻日算同一段行情
    picked.push({ r, d });
    if (picked.length >= k) break;
  }
  if (picked.length < 10) return null;

  // 距今多久按「自然日」算，不按历史库末尾算：库是静态的，
  // 用库末尾会让半年前的相似日永远显示成「1 个月前」。
  const todayMs = Date.parse(`${today.date}T00:00:00Z`);
  const rows = picked.map(({ r, d }) => {
    const calDays = Math.round((todayMs - Date.parse(`${r.date}T00:00:00Z`)) / 86400000);
    const out = { date: r.date, calDays, dist: d, pct: r.pct, vr: r.vr, rs: r.rs };
    for (const h of HORIZONS) {
      const c0 = M.close[r.i];
      const c1 = M.close[r.i + h];
      out[`h${h}`] = c1 > 0 ? (c1 / c0 - 1) * 100 : NaN;
    }
    return out;
  });

  const stats = {};
  for (const h of HORIZONS) {
    const xs = rows.map(r => r[`h${h}`]).filter(Number.isFinite).sort((a, b) => a - b);
    if (xs.length < 5) return null;      // 收益缺失太多就不给分布，宁可报错也不出 NaN
    stats[h] = {
      n: xs.length,
      up: (xs.filter(x => x > 0).length / xs.length) * 100,
      p10: quantile(xs, 0.10),
      p25: quantile(xs, 0.25),
      p50: quantile(xs, 0.50),
      p75: quantile(xs, 0.75),
      p90: quantile(xs, 0.90),
      worst: xs[0],
      best: xs[xs.length - 1],
    };
  }

  // 四象限归属（方向 × 强弱），用于「今天站在哪一类」
  const pmed = median(M.pool.map(r => r.rs));
  const d = today.f[0] >= 0 ? 1 : 0;
  const p = today.f[4] > pmed ? 1 : 0;

  return {
    indexId, k, kUsed: rows.length, asOf: today.date,
    today, rows, stats,
    quadKey: `${d}-${p}`,
    quad: HISTORY.quad[indexId] || {},        // 整张四象限表，UI 自己按 key 取
    calib: HISTORY.calib[indexId] || null,
    meanDist: mean(rows.map(r => r.dist)),
  };
}

/**
 * 数据覆盖面，页脚要标出来。
 *
 * 三个日期必须分开说，否则读者会以为「最近三个月没进来」是 bug：
 *   lastDate  历史库本身截止到哪天
 *   poolFrom/poolTo  能参与匹配的区间（末端要留 60 个交易日让收益走完）
 *   ageDays   库距今几天，超过 0 就是「静态数据在用」，得在页面上讲
 */
export function historyMeta() {
  const n = HISTORY.dates.length;
  const last = HISTORY.dates[n - 1];
  const bjToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    ...HISTORY.meta,
    lastDate: last,
    poolFrom: HISTORY.dates[20],
    poolTo: HISTORY.dates[Math.max(0, n - 1 - MAX_H)],
    ageDays: Math.max(0, Math.round(
      (Date.parse(`${bjToday}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000)),
  };
}
