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

/** 最近 24 小时的 5 分钟线根数（连续品种的兜底窗口长度） */
const DAY_BARS = 288;

/**
 * 按「最近 24 小时」切当日窗口
 *
 * 早先直接取尾部 288 根，对 24×5 的汇率没问题，但对贵金属会翻车：
 * 周末休市时 288 根会一路回溯到上周五，昨收变成周五的价，
 * 周一一开盘就显示 -0.9% 的假跌幅。改成按时间锚定窗口，
 * 休市空档自然被排除，昨收取窗口前一根（即上一交易日收盘）。
 */
function windowStart(rows) {
  const ms = d => {
    const t = Date.parse(String(d || '').replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  };
  const lastMs = ms(rows[rows.length - 1]?.d);
  if (!lastMs) return Math.max(0, rows.length - DAY_BARS);
  const from = lastMs - 24 * 3600e3;
  const i = rows.findIndex(r => ms(r.d) >= from);
  return i > 0 ? i : Math.max(0, rows.length - DAY_BARS);
}

/**
 * 有些品种在 scale > 1 时价格被压了 10000 倍，必须补回来
 *
 * 实测 fx_sxaucny（人民币账户黄金）：
 *   scale=1   → 27578.599   （与 hq.sinajs.cn 实时价一致，单位 元/盎司）
 *   scale=5   → 2.757860    （÷10000）
 *   scale=240 → 2.757860    （÷10000）
 * 连续三次采样比值恒为 10000.00，不是抖动。不补的话再除以 31.1034768，
 * 「元/克」会算成 0.09，K 线也全在 0.08 附近。
 *
 * 按品种声明而不是无脑乘，汇率类（fx_susdcnh）实测比值是 1.0000，不能碰。
 */
const BAR_MUL = { fx_sxaucny: 10000 };

/**
 * 取分钟线原始行
 * @param {string} code 如 fx_susdcnh
 * @param {number} datalen
 * @param {number} [scale] 分钟粒度，默认 5
 */
async function fetchMinRows(code, datalen = 320, scale = 5) {
  const cb = nextCb();
  const url = `${API}/var%20${cb}=/NewForexService.getMinKline`
    + `?symbol=${encodeURIComponent(code)}&scale=${scale}&datalen=${datalen}`;
  const raw = await jsonpVar(url, cb, 9000);

  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
  // scale=1 是真实量级，不用乘
  const mul = scale > 1 ? (BAR_MUL[code] || 1) : 1;
  const out = [];
  for (const r of rows) {
    const d = String(r?.d || '');
    const c = num(r?.c) * mul;
    if (!d || !(c > 0)) continue;
    out.push({
      d,
      day: d.slice(0, 10),
      time: d.slice(11, 16).replace(':', ''),
      o: num(r.o) * mul,
      h: num(r.h) * mul,
      l: num(r.l) * mul,
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
 * @param {string} code fx_susdcnh / fx_sxaucny
 * @param {{datalen?:number, divide?:number}} [opt]
 *        divide：单位折算系数。新浪的 fx_sxaucny 是「元/盎司」，
 *        人民币账户金要「元/克」，传 31.1034768 即可，价、开高低、昨收同步折算。
 */
export async function fetchFxQuoteAndMinute(code, opt = {}) {
  const datalen = opt.datalen ?? 320;
  const div = opt.divide > 0 ? opt.divide : 1;
  const key = div === 1 ? code : `${code}@${div}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL && !hit.force) return hit.data;

  const rows = await fetchMinRows(code, datalen);

  // 取最近 24 小时作为一个"交易日窗口"，多留几根余量避免边界抖动
  const start = windowStart(rows);
  const today = rows.slice(start);
  if (!today.length) throw new Error('外汇当日数据为空');

  const price = today[today.length - 1].c / div;
  const open = (today[0].o || today[0].c) / div;
  let high = 0;
  let low = 0;
  for (const r of today) {
    if (r.h / div > high) high = r.h / div;
    if (!low || r.l / div < low) low = r.l / div;
  }

  // 昨收：窗口前一根的收盘。数据不足时退回窗口首根开盘价。
  let prevClose = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (rows[i].c > 0) { prevClose = rows[i].c / div; break; }
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
    digits: div === 1 ? 4 : 2,
    suspended: false,
    src: 'sinafx',
  };

  const points = today.map(r => ({
    t: r.time,
    price: r.c / div,
    cumVol: 0,
    cumAmt: 0,
  }));

  const data = { quote, points, prevClose, date: today[today.length - 1].day };
  cache.set(key, { t: Date.now(), data });
  return data;
}

/**
 * '2026-10-20 02:00:00' 往前推 backMin 分钟后的日期
 * 这个服务的大周期线标的是「区间结束时间」：22:00 那根其实是 18:00–22:00，
 * 02:00 那根是前一晚 22:00–次日 02:00。不往前推，夜盘会被算到第二天去，
 * 日K 末尾就会冒出一根「明天」的假 K 线。
 */
function dayOf(d, backMin = 0) {
  const s = String(d || '');
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!parts || !backMin) return s.slice(0, 10);
  const t = Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5]);
  return new Date(t - backMin * 60000).toISOString().slice(0, 10);
}

/**
 * 4 小时线 → 日线（人民币账户金的日K来源）
 *
 * 这个服务只给到 scale=240（4 小时）且没有 1440，所以日线在本地合并：
 * 同一天的第一根开盘、最后一根收盘、最高最低取极值。900 根 ≈ 150 个交易日，
 * 够画日K并聚合出周/月线，一次约 90KB，比 5 分钟线省得多。
 */
export async function fetchFxDaily(code, opt = {}) {
  const div = opt.divide > 0 ? opt.divide : 1;
  const scale = opt.scale ?? 240;
  const rows = await fetchMinRows(code, opt.datalen ?? 900, scale);

  const byDay = new Map();
  for (const r of rows) {
    const day = dayOf(r.d, scale);
    let b = byDay.get(day);
    if (!b) {
      b = { date: day, open: r.o / div, close: r.c / div, high: r.h / div, low: r.l / div, volume: 0 };
      byDay.set(day, b);
    } else {
      b.close = r.c / div;
      if (r.h / div > b.high) b.high = r.h / div;
      if (r.l / div < b.low) b.low = r.l / div;
    }
  }

  const bars = [...byDay.values()]
    .filter(b => b.date && b.close > 0 && b.high >= b.low)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!bars.length) throw new Error('黄金日线为空');
  return bars;
}

/** 作废缓存（下拉刷新用） */
export function invalidateFx(code) {
  if (!code) cache.clear();
  else cache.delete(code);
}
