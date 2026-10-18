/**
 * 时间序列聚合层
 * 统一分时 / K 线的取数、缓存与降级。
 * 黄金走新浪，其余走腾讯；黄金的周/月线在本地由日线聚合。
 */

import { fetchMinute, fetchKline } from './sources/tencent.js';
import { fetchGoldMinute, fetchGoldDaily } from './sources/sinaGold.js';
import { fetchFxQuoteAndMinute } from './sources/sinaFx.js';
import { getSymbol } from './symbols.js';

const MINUTE_TTL = 30_000;
const KLINE_TTL = 90_000;

const minuteCache = new Map(); // id -> {t, data}
const klineCache = new Map();  // id:period -> {t, data}

const isGold = sym => sym.market === 'CME' || sym.id.startsWith('hf_');
const isFx = sym => sym.src === 'sinafx';
/** 日韩指数（CNBC/东财）只有实时报价，没有分时 / K线接口 */
const isGlobalIndex = sym => sym.src === 'global';

/**
 * 计算均价线（VWAP 近似）
 * 用「累计量的差分」做加权，量纲常数会自动约掉，
 * 因此不必区分「手」还是「股」，也不用依赖成交额字段。
 */
function buildAvg(points) {
  const out = new Array(points.length);
  let pv = 0;
  let vv = 0;
  let lastCum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // 接口偶尔给一个明显跑偏的均价（甚至 0.01），
    // 直接采信会在图上拉出一条竖直假线，偏离现价 20% 以上就当它没有
    if (p.avg > 0 && Math.abs(p.avg - p.price) / p.price < 0.2) {
      out[i] = p.avg;
      continue;
    }
    const dv = Math.max(0, (p.cumVol || 0) - lastCum);
    lastCum = p.cumVol || 0;
    if (dv > 0) {
      pv += p.price * dv;
      vv += dv;
    }
    out[i] = vv > 0 ? pv / vv : p.price;
  }
  return out;
}

/**
 * 分时
 * @param {string} id
 * @param {{maxAge?:number}} [opt]
 */
export async function getMinute(id, opt = {}) {
  const maxAge = opt.maxAge ?? MINUTE_TTL;
  const sym = getSymbol(id);
  const c = minuteCache.get(sym.id);
  if (c && Date.now() - c.t < maxAge) return c.data;

  if (isGlobalIndex(sym)) {
    throw new Error('该指数暂无分时数据');
  }

  let data;
  if (isFx(sym)) {
    const f = await fetchFxQuoteAndMinute(sym.id);
    data = {
      points: f.points,
      prevClose: f.prevClose,
      avg: [],
      date: f.date,
      kind: 'fx',
    };
  } else if (isGold(sym)) {
    const code = sym.id.replace(/^hf_/, '');
    const g = await fetchGoldMinute(code);
    data = {
      points: g.points,
      prevClose: g.prevClose,
      avg: buildAvg(g.points),
      date: g.date,
      kind: 'gold',
    };
  } else {
    const m = await fetchMinute(sym);
    data = {
      points: m.points,
      prevClose: m.prevClose,
      avg: buildAvg(m.points),
      date: m.date,
      kind: 'std',
    };
  }

  minuteCache.set(sym.id, { t: Date.now(), data });
  return data;
}

/** 由昨收补全（分时接口不总是带昨收） */
export function fillPrevClose(data, prevClose) {
  if (data && !data.prevClose && prevClose > 0) data.prevClose = prevClose;
  return data;
}

/**
 * 把日线聚合成周线 / 月线
 * @param {Array} bars 升序日线
 * @param {'week'|'month'} period
 */
export function aggregate(bars, period) {
  if (!bars.length) return [];
  const groups = new Map();

  const keyOf = dateStr => {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    if (period === 'month') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    // 以周一为一周起点
    const day = (d.getDay() + 6) % 7;
    const monday = new Date(d.getTime() - day * 86400000);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  };

  for (const b of bars) {
    const k = keyOf(b.date);
    let g = groups.get(k);
    if (!g) {
      g = { date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, volume: b.volume };
      groups.set(k, g);
    } else {
      g.close = b.close;
      g.high = Math.max(g.high, b.high);
      g.low = Math.min(g.low, b.low);
      g.volume += b.volume;
      g.date = b.date;
    }
  }
  return [...groups.values()];
}

/**
 * K线
 * @param {string} id
 * @param {'day'|'week'|'month'} period
 */
export async function getKline(id, period = 'day') {
  const sym = getSymbol(id);
  const key = `${sym.id}:${period}`;
  const c = klineCache.get(key);
  if (c && Date.now() - c.t < KLINE_TTL) return c.data;

  if (isGlobalIndex(sym) || isFx(sym)) {
    throw new Error('该品种暂无 K 线数据');
  }

  let bars;
  if (isGold(sym)) {
    const code = sym.id.replace(/^hf_/, '');
    if (period === 'day') {
      bars = await fetchGoldDaily(code, 160);
    } else {
      const daily = await fetchGoldDaily(code, 420);
      bars = aggregate(daily, period);
    }
  } else {
    bars = await fetchKline(sym, period, 160);
  }

  klineCache.set(key, { t: Date.now(), data: bars });
  return bars;
}

/** 清空缓存（切标的时可选） */
export function clearSeriesCache() {
  minuteCache.clear();
  klineCache.clear();
}
