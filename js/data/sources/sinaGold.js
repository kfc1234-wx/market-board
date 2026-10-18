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
  const points = [];

  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const head = String(r[0] || '');
    if (!TIME_RE.test(head)) {
      // 表头：第 2 位是昨收
      const p = Number(r[1]);
      if (!prevClose && Number.isFinite(p) && p > 0) prevClose = p;
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

  if (!points.length) throw new Error('黄金分时数据为空');
  return { points, prevClose, date: '' };
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
  return bars.slice(-limit);
}
