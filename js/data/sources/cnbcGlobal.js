/**
 * CNBC 报价 — 日经225 / 韩国KOSPI
 *
 * 为什么换掉东方财富：
 *  东财 push2.eastmoney.com 在部分网络下**整体不可达**（连接被重置、返回空响应），
 *  而同一个东财的 datacenter.eastmoney.com 却是通的（国债收益率就走它），
 *  所以不是接口下线，是 CDN 节点 / 线路问题。这两张卡长期显示「暂无数据」就是它。
 *
 * 为什么选 CNBC：
 *  - 公开 JSON，响应头带 Access-Control-Allow-Origin: *，浏览器可直接 fetch，不需要 JSONP
 *  - 不需要 Key / Cookie，也不校验 Referer
 *  - 一次请求可拿多个品种（symbols=.N225|.KS11）
 *  - 给出的字段够画振幅条：现价 / 今开 / 最高 / 最低 / 昨收
 *
 * 接口：GET https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol
 *        ?symbols=.N225|.KS11&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1
 * 注意：last / open / high / low / previous_day_closing / change / change_pct
 *       都是「带千分位与正负号的字符串」，必须自己剥壳，不能直接 Number()。
 */

import { getJSON } from '../http.js';

const API = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

/** '65,324.29' / '+1.39%' / '-898.34' / '-' → 数字（无效给 0，交给上层判空） */
const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim().replace(/[,%\s]/g, '').replace(/^\+/, '');
  if (!s || s === '-' || s === 'N/A' || s === 'UNCH') return 0;
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
};

/** '10/16/26' → '2026-10-16'（CNBC 用两位年） */
function usDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(v || '').trim());
  if (!m) {
    // 已经是 ISO 就原样截断
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
  }
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/**
 * 批量取全球指数
 * @param {Array<{id:string, cnbc:string, closeTime?:string}>} items
 *        id=本地主键（沿用 em_xxx，避免动已持久化的自选），cnbc=CNBC symbol（如 .N225）
 * @returns {Promise<Record<string, any>>} 以本地 id 为键
 */
export async function fetchCnbcGlobal(items) {
  if (!items.length) return {};

  const symbols = items.map(x => x.cnbc).filter(Boolean).join('|');
  if (!symbols) return {};

  const url = `${API}?symbols=${encodeURIComponent(symbols)}`
    + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';

  const json = await getJSON(url, { timeout: 9000, retries: 1 });
  const box = json?.FormattedQuoteResult?.FormattedQuote;
  const rows = Array.isArray(box) ? box : (box ? [box] : []);
  if (!rows.length) throw new Error('CNBC 全球指数为空');

  const byCode = new Map();
  for (const it of items) {
    if (it.cnbc) byCode.set(it.cnbc.toUpperCase(), it);
  }

  const out = Object.create(null);
  for (const row of rows) {
    const hit = byCode.get(String(row?.symbol || '').toUpperCase());
    if (!hit) continue;

    const price = num(row.last);
    const prevClose = num(row.previous_day_closing);
    // 停牌 / 未开盘时 last 是 '-'，num 得 0，交给上层判无效
    if (!(price > 0)) continue;

    const change = row.change !== undefined
      ? num(row.change)
      : (prevClose ? +(price - prevClose).toFixed(4) : 0);
    const pct = row.change_pct !== undefined
      ? num(row.change_pct)
      : (prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(3) : 0);

    const date = usDate(row.last_time) || usDate(row.last_timedate);
    // 只有日期没有时分，用该市场收盘钟点补全，让「已收盘 · 10-16」这类展示有时间可解析
    const time = date ? `${date} ${hit.closeTime || '00:00:00'}` : '';

    out[hit.id] = {
      id: hit.id,
      valid: true,
      name: String(row.name || row.shortName || '').trim(),
      price,
      prevClose,
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      change,
      pct,
      volume: num(row.volume),
      amount: 0,
      turnover: 0,
      pe: 0,
      floatCap: 0,
      totalCap: 0,
      time,
      digits: 2,
      suspended: false,
      src: 'cnbc',
    };
  }

  if (!Object.keys(out).length) throw new Error('CNBC 全球指数解析为空');
  return out;
}
