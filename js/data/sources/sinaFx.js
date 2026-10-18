/**
 * 新浪 — 外汇（离岸人民币 USD/CNH）
 *
 * 为什么不用 hq.sinajs.cn：
 *  那个接口有 Referer 防盗链，只放行 sina 自家域名，浏览器从我们的域名请求一律 403，
 *  改 Referer 也被浏览器禁止（试过 SW 转发同样不行）。
 *  好在 vip.stock.finance.sina.com.cn 的 JSONP 服务不校验来源，可以直连。
 *
 * 接口：/forex/api/jsonp.php/var _cb=/NewForexService.getMinKline?symbol=fx_susdcnh&scale=5&datalen=300
 *   返回 [{d:"2026-10-17 04:50:00", o,l,h,c}]（字符串数字）
 *
 * 该服务没有独立报价接口，所以报价由分钟线推导：
 *   现价 = 最后一根 c
 *   昨收 = 24 小时前那一根的 c
 *   今开 / 最高 / 最低 = 最近 24 小时的首根 o、max(h)、min(l)
 *
 * 为什么用「最近 24 小时」而不是「自然日」：
 *  外汇交易日按纽约 17:00（北京 05:00）切换，而接口的 d 字段是自然日。
 *  按自然日切，北京 00:00~05:00 那几根会被算成"今天"，当日涨跌就退化成
 *  半夜几小时的波动，几乎恒为 0.00%（实测 -0.00%，明显不对）。
 *  按 24 小时滑动窗口取，既躲开日切边界，也与行情软件的口径接近。
 */

import { jsonpVar } from '../http.js';

const API = 'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php';

let seq = 0;
const nextCb = () => `_fx${++seq}_${Date.now().toString(36)}`;

/**
 * 报价与分时来自同一份分钟线，缓存 20s 让两边共用：
 * quotes 每 4s 想刷、series 每 30s 想刷，没有这层缓存会重复打接口。
 */
const CACHE_TTL = 20_000;
const cache = new Map();

const num = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** 最近 24 小时的 5 分钟线根数 */
const DAY_BARS = 288;

/**
 * 取 5 分钟线原始行
 * @param {string} code 如 fx_susdcnh
 * @param {number} datalen
 */
async function fetchMinRows(code, datalen = 320) {
  const cb = nextCb();
  const url = `${API}/var%20${cb}=/NewForexService.getMinKline`
    + `?symbol=${encodeURIComponent(code)}&scale=5&datalen=${datalen}`;
  const raw = await jsonpVar(url, cb, 9000);

  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
  const out = [];
  for (const r of rows) {
    const d = String(r?.d || '');
    const c = num(r?.c);
    if (!d || !(c > 0)) continue;
    out.push({
      d,
      day: d.slice(0, 10),
      time: d.slice(11, 16).replace(':', ''),
      o: num(r.o),
      h: num(r.h),
      l: num(r.l),
      c,
    });
  }
  // 接口按时间升序返回，但保险起见再排一次
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!out.length) throw new Error('外汇分钟线为空');
  return out;
}

/**
 * 报价 + 分时一次取回（共用同一份分钟线，少发一次请求）
 * @param {string} code fx_susdcnh
 */
export async function fetchFxQuoteAndMinute(code, datalen = 320) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.t < CACHE_TTL && !hit.force) return hit.data;

  const rows = await fetchMinRows(code, datalen);

  // 取最近 24 小时作为一个"交易日窗口"，多留几根余量避免边界抖动
  const start = Math.max(0, rows.length - DAY_BARS);
  const today = rows.slice(start);
  if (!today.length) throw new Error('外汇当日数据为空');

  const price = today[today.length - 1].c;
  const open = today[0].o || today[0].c;
  let high = 0;
  let low = 0;
  for (const r of today) {
    if (r.h > high) high = r.h;
    if (!low || r.l < low) low = r.l;
  }

  // 昨收：窗口前一根的收盘。数据不足时退回窗口首根开盘价。
  let prevClose = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (rows[i].c > 0) { prevClose = rows[i].c; break; }
  }
  if (!(prevClose > 0)) prevClose = open;

  const change = prevClose ? +(price - prevClose).toFixed(6) : 0;
  const pct = prevClose ? +((change / prevClose) * 100).toFixed(3) : 0;

  const quote = {
    id: code,
    valid: true,
    name: '',
    price,
    prevClose,
    open,
    high: high || price,
    low: low || price,
    change,
    pct,
    volume: 0,
    amount: 0,
    turnover: 0,
    pe: 0,
    floatCap: 0,
    totalCap: 0,
    time: today[today.length - 1].d,
    digits: 4,
    suspended: false,
    src: 'sinafx',
  };

  const points = today.map(r => ({
    t: r.time,
    price: r.c,
    cumVol: 0,
    cumAmt: 0,
  }));

  const data = { quote, points, prevClose, date: today[today.length - 1].day };
  cache.set(code, { t: Date.now(), data });
  return data;
}

/** 作废缓存（下拉刷新用） */
export function invalidateFx(code) {
  if (!code) cache.clear();
  else cache.delete(code);
}
