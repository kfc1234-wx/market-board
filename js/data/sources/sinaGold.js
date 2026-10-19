/**
 * 新浪 — 黄金分时 / 日K
 *
 * 腾讯 hfkline / hfMinute 对 hf_GC 不可用（返回 "Can't load controller"），
 * 所以黄金的图表走新浪外盘期货接口。
 *
 * 特点：
 *  - CME 电子盘 06:00 → 次日 05:00（北京时间），约 1380 根分钟线
 *  - 无 CORS，只能 JSONP
 *  - 返回体首行是注释，无影响
 */

import { jsonpVar } from '../http.js';

const JSONP = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php';

let seq = 0;
const nextCb = () => `_sg${++seq}_${Date.now().toString(36)}`;

/** 形如 "06:01" 的分时行 */
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * 分时（1 分钟粒度）
 * 行结构：[时间, 价, ?, ?, 均价, "YYYY-MM-DD HH:MM:SS"]
 * 首行是表头：[日期, 昨收, 交易所, "", 起始时间, 开盘价, ...]，长度与普通行不同
 * @param {string} code 品种代码，如 GC
 */
export async function fetchGoldMinute(code = 'GC') {
  const cb = nextCb();
  const url = `${JSONP}/var%20${cb}=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${code}`;
  const raw = await jsonpVar(url, cb, 9000);

  // 可能是对象 {minLine_1d:[...]} 也可能直接是数组
  let rows = null;
  if (Array.isArray(raw)) rows = raw;
  else if (raw && Array.isArray(raw.minLine_1d)) rows = raw.minLine_1d;
  else if (raw) {
    const k = Object.keys(raw).find(k => Array.isArray(raw[k]));
    if (k) rows = raw[k];
  }
  if (!rows || !rows.length) throw new Error('黄金分时数据为空');

  let prevClose = 0;
  let open = 0;
  let date = '';
  const points = [];

  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const head = String(r[0] || '');
    if (!TIME_RE.test(head)) {
      // 表头：[日期, 昨收, 交易所, "", 起始时间, 开盘价, ...]
      const p = Number(r[1]);
      if (!prevClose && Number.isFinite(p) && p > 0) prevClose = p;
      const o = Number(r[5]);
      if (!open && Number.isFinite(o) && o > 0) open = o;
      if (!date && /^\d{4}-\d{2}-\d{2}$/.test(head)) date = head;
      continue;
    }
    const price = Number(r[1]);
    if (!Number.isFinite(price) || price <= 0) continue;
    points.push({
      t: head.replace(':', ''),
      price,
      cumVol: 0,
      cumAmt: 0,
      avg: Number(r[4]) || 0,
      timeLabel: head,
    });
  }

  if (!points.length) throw new Error('分时数据为空');
  return { points, prevClose, date, open };
}

/**
 * 外盘期货报价（由分时推导）
 *
 * 新浪没有独立的外盘期货报价接口，但分时最后一根就是最新价，
 * 表头里有昨收和今开，最高/最低从分钟线里扫。这样 NQ 这种
 * 腾讯没有报价的品种也能有完整的「现价 / 涨跌 / 开高低」。
 *
 * 分时一次约 900 行、60KB，比报价重得多，所以缓存 10s：
 * 期货不是高频交易场景，10 秒足够，也避免把手机流量打满。
 */
const QUOTE_TTL = 10_000;
const quoteCache = new Map(); // code -> { t, data }

export async function fetchFuturesQuote(code = 'NQ') {
  const hit = quoteCache.get(code);
  if (hit && Date.now() - hit.t < QUOTE_TTL) return hit.data;

  const m = await fetchGoldMinute(code);
  const pts = m.points;
  if (!pts.length) throw new Error('期货分时数据为空');

  let high = 0;
  let low = 0;
  for (const p of pts) {
    if (!high || p.price > high) high = p.price;
    if (!low || p.price < low) low = p.price;
  }

  const last = pts[pts.length - 1];
  const price = last.price;
  const prevClose = m.prevClose || 0;
  const change = prevClose ? +(price - prevClose).toFixed(4) : 0;

  const out = {
    id: code,
    valid: true,
    name: '',
    price,
    prevClose,
    open: m.open || 0,
    high,
    low,
    change,
    pct: prevClose ? +((change / prevClose) * 100).toFixed(3) : 0,
    volume: 0,
    amount: 0,
    turnover: 0,
    pe: 0,
    floatCap: 0,
    totalCap: 0,
    // 分时的 timeLabel 只有 "21:42"，补上日期才能被 parseQuoteTime 解析
    time: m.date ? `${m.date} ${last.timeLabel}` : last.timeLabel,
    digits: 2,
    suspended: false,
  };
  quoteCache.set(code, { t: Date.now(), data: out });
  return out;
}

/**
 * 日K（可追溯到 2016 年，按需截取尾部）
 * @param {string} code
 * @param {number} limit
 */
export async function fetchGoldDaily(code = 'GC', limit = 160) {
  const cb = nextCb();
  const url = `${JSONP}/var%20${cb}=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${code}`;
  const raw = await jsonpVar(url, cb, 9000);

  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
  if (!rows.length) throw new Error('黄金K线数据为空');

  const bars = rows.map(r => ({
    date: String(r.date || r.d || ''),
    open: Number(r.open) || 0,
    close: Number(r.close) || 0,
    high: Number(r.high) || 0,
    low: Number(r.low) || 0,
    volume: Number(r.volume) || 0,
  })).filter(b => b.date && b.close);

  if (!bars.length) throw new Error('黄金K线数据为空');
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 新浪日K 的 open 偶尔越界（实测 NQ 2200 根里 63 根、ES 78 根、GC 36 根，
  // 例如 NQ 2026-10-19：open 29973.75 > high 29813.5），会把 K 线画成相反方向。
  // 期货连续合约日切不跳空，越界时用前一根收盘价代入，再夹回 [low, high] 兜底。
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.high > 0) || !(b.low > 0)) continue;
    if (b.open >= b.low && b.open <= b.high) continue;
    const prev = i > 0 ? bars[i - 1].close : b.close;
    b.open = Math.max(b.low, Math.min(b.high, prev || b.close));
  }

  return bars.slice(-limit);
}
