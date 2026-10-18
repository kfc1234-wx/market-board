/**
 * 东方财富 — 全球指数（日经225 / 韩国KOSPI）
 *
 * 为什么单独开一个适配器：
 *  腾讯行情没有日本、韩国的指数 code（jp_/kr_ 前缀一律 pv_none_match），
 *  新浪 hq.sinajs.cn 的 int_nikkei 早已停更（报 44,946，真实值在 65,000 上方），
 *  所以这两个品种只能走东财。
 *
 * 走 JSONP 而不是 fetch：
 *  东财 push2 的跨域头不保证存在，而 jsonp 通道（cb=）是东财 web 端自己在用的方式，
 *  既躲开 CORS，也不用关心 Referer。
 *
 * 接口：GET /api/qt/ulist.np/get?fltt=2&secids=100.N225,100.KS11&fields=...
 *   fltt=2 让价格直接返回数字（不放大 100 倍）
 *   f2=最新价 f3=涨跌幅 f4=涨跌额 f12=代码 f14=名称
 *   f15=最高 f16=最低 f17=今开 f18=昨收
 */

import { jsonpVar, getJSON } from '../http.js';

const API = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

let seq = 0;
const nextCb = () => `_em${++seq}_${Date.now().toString(36)}`;

const num = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const FIELDS = 'f2,f3,f4,f12,f14,f15,f16,f17,f18';

/**
 * 双通道取数：
 *  先试 fetch（东财 push2 多数情况带 Access-Control-Allow-Origin:*，能过就直接过）；
 *  被 CORS 拦掉再退回 JSONP（cb= 是东财自家 web 端在用的方式）。
 * 两条路都走一遍，不把可用性押在单一路径上。
 */
async function requestRaw(secids) {
  const base = `${API}?fltt=2&secids=${encodeURIComponent(secids)}&fields=${FIELDS}`;

  try {
    const json = await getJSON(base, { timeout: 6000, retries: 0 });
    if (json && json.data) return json;
  } catch {
    // 落到 JSONP
  }

  const cb = nextCb();
  return jsonpVar(`${base}&cb=${cb}`, cb, 6000);
}

/**
 * 批量取全球指数
 * @param {Array<{id:string, secid:string, digits?:number}>} items
 * @returns {Promise<Record<string, any>>} 以本地 id 为键
 */
export async function fetchEmGlobal(items) {
  if (!items.length) return {};

  const secids = items.map(x => x.secid).filter(Boolean).join(',');
  if (!secids) return {};

  const raw = await requestRaw(secids);
  const diff = raw?.data?.diff;
  const rows = Array.isArray(diff) ? diff : (diff && typeof diff === 'object' ? Object.values(diff) : []);
  if (!rows.length) throw new Error('东财全球指数为空');

  // 用 f12（代码）反查本地 id：secid 的尾段就是 f12
  const byCode = new Map();
  for (const it of items) {
    const code = String(it.secid || '').split('.')[1];
    if (code) byCode.set(code.toUpperCase(), it);
  }

  const out = Object.create(null);
  for (const row of rows) {
    const code = String(row?.f12 || '').toUpperCase();
    const hit = byCode.get(code);
    if (!hit) continue;

    const price = num(row.f2);
    const prevClose = num(row.f18);
    // 停牌 / 未开盘时东财给的是 '-'，num 会变成 0，交给上层判无效
    if (!(price > 0)) continue;

    const change = num(row.f4) || (prevClose ? +(price - prevClose).toFixed(4) : 0);
    const pct = Number.isFinite(Number(row.f3)) && row.f3 !== '-'
      ? num(row.f3)
      : (prevClose ? +((change / prevClose) * 100).toFixed(3) : 0);

    out[hit.id] = {
      id: hit.id,
      valid: true,
      name: String(row.f14 || '').trim(),
      price,
      prevClose,
      open: num(row.f17),
      high: num(row.f15),
      low: num(row.f16),
      change,
      pct,
      volume: 0,
      amount: 0,
      turnover: 0,
      pe: 0,
      floatCap: 0,
      totalCap: 0,
      time: '',          // 该接口不带时间戳，UI 侧回落到「已收盘」
      digits: 2,
      suspended: false,
      src: 'em',
    };
  }

  if (!Object.keys(out).length) throw new Error('东财全球指数解析为空');
  return out;
}
