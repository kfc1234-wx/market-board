/**
 * 股息率（TTM）数据层
 *
 * 数据源：东方财富 datacenter 的「分红送配」报表 RPT_SHAREBONUS_DET，
 * 响应头 Access-Control-Allow-Origin: *，浏览器直连。
 *
 * 口径（与东财 F10「分红融资」页一致）：
 *   股息率(TTM) = 最近 12 个月内「已实施」分红的每股累计派现 ÷ 当前股价
 * 每股派现 = Σ(PRETAX_BONUS_RMB / 10)，PRETAX_BONUS_RMB 是「每 10 股派现金额（含税）」。
 * 送股 / 转增不产生现金，不计入（BONUS_IT_RATIO / IT_RATIO 忽略）。
 *
 * 两个出口：
 *   getDividend(id)        单只，详情页用
 *   getDividends(ids)      批量，区间明细页一次要几十只，逐只请求会把网络打满
 *
 * 批量走 datacenter 的 `in (...)` 过滤语法，实测 80 只 / 12 个月窗口
 * 一次 16.8KB、130ms 就能全部取回，比 48 次单只请求快两个数量级。
 *
 * 缓存只存「与股价无关」的每股派现 / 笔数 / 最新除权日，
 * 收益率在读取时用调用方给的现价现算——否则缓存里会冻结上一次的价格，
 * 而且批量路径（可能没有价格）与单只路径（有价格）会互相污染。
 */

import { getJSON } from './http.js';

const API = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const TTL = 60 * 60 * 1000; // 股息数据日频，缓存 1 小时
const WINDOW = 365 * 24 * 3600 * 1000; // TTM 窗口
const CHUNK = 60; // 单次批量最多 60 只，URL 长度可控

/** @type {Map<string, {t:number, dps:number, count:number, date:string} | {t:number, none:true}>} */
const cache = new Map();

const isA = id => /^(sh|sz|bj)\d{6}$/.test(id);

/** yyyy-mm-dd（本地时区即可，只用于和除权日比大小） */
function dateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 缓存命中项 → 对外的 {yield, dps, count, date}；无分红返回 null */
function materialize(hit, price) {
  if (!hit || hit.none) return null;
  const p = Number(price);
  return {
    dps: hit.dps,
    count: hit.count,
    date: hit.date,
    yield: Number.isFinite(p) && p > 0 ? +((hit.dps / p) * 100).toFixed(2) : null,
  };
}

/**
 * 拉一批代码的分红记录，返回 Map<纯代码, {dps,count,date}>
 * 网络/解析失败返回 null（调用方据此决定「不写缓存」，避免把暂时性失败
 * 当成「这只票不分红」钉死在缓存里）
 */
async function fetchChunk(codes) {
  const cutoff = dateStr(Date.now() - WINDOW);
  const inList = codes.map(c => `"${c}"`).join(',');
  // 两个条件并置：东财的 filter 语法是相邻括号做 AND
  const filter = `(SECURITY_CODE in (${inList}))(EX_DIVIDEND_DATE>='${cutoff}')`;

  const url = `${API}?reportName=RPT_SHAREBONUS_DET`
    + '&columns=SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS'
    + '&pageNumber=1&pageSize=500&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1'
    + `&filter=${encodeURIComponent(filter)}`;

  try {
    const json = await getJSON(url, { timeout: 10000, retries: 1 });
    const rows = json?.result?.data;
    if (!Array.isArray(rows)) return null;

    const cutoffTs = Date.now() - WINDOW;
    const out = new Map();

    for (const r of rows) {
      // 只认「实施分配」；「预案」「股东大会通过」等尚未落地的现金不能算
      if (!String(r.ASSIGN_PROGRESS || '').includes('实施')) continue;

      const bonus10 = Number(r.PRETAX_BONUS_RMB);
      if (!Number.isFinite(bonus10) || bonus10 <= 0) continue;

      const exDate = String(r.EX_DIVIDEND_DATE || '').slice(0, 10);
      if (!exDate) continue;
      // 服务端已按除权日过滤过，这里再挡一次：万一过滤条件失效，
      // 也不会把三年前的分红算进 TTM
      const t = new Date(exDate.replace(/-/g, '/')).getTime();
      if (Number.isFinite(t) && t < cutoffTs) continue;

      const code = String(r.SECURITY_CODE || '');
      if (!code) continue;

      const cur = out.get(code) || { dps: 0, count: 0, date: '' };
      cur.dps += bonus10 / 10;
      cur.count += 1;
      if (exDate > cur.date) cur.date = exDate;
      out.set(code, cur);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 批量取股息率（TTM）。
 * @param {string[]} ids 腾讯 code（sh600519 / sz000001）
 * @param {{prices?: Map<string,number>|Record<string,number>}} [opt]
 * @returns {Promise<Map<string, ({yield:number|null, dps:number, count:number, date:string}|null)>>}
 *   值 null = 近 12 个月没有已实施分红；键不存在 = 这次没取到（网络失败），可稍后重试
 */
export async function getDividends(ids, opt = {}) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(isA))];
  if (!list.length) return out;

  const prices = opt.prices || {};
  const priceOf = id => (prices instanceof Map ? prices.get(id) : prices[id]);

  const now = Date.now();
  const todo = [];
  for (const id of list) {
    const hit = cache.get(id);
    if (hit && now - hit.t < TTL) out.set(id, materialize(hit, priceOf(id)));
    else todo.push(id);
  }
  if (!todo.length) return out;

  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));

  await Promise.all(chunks.map(async chunk => {
    const got = await fetchChunk(chunk.map(id => id.slice(2)));
    if (!got) return; // 整片失败：不写缓存、不塞结果，留给下次重试

    const t = Date.now();
    for (const id of chunk) {
      const acc = got.get(id.slice(2));
      if (acc && acc.count > 0) {
        const rec = { t, dps: +acc.dps.toFixed(4), count: acc.count, date: acc.date };
        cache.set(id, rec);
        out.set(id, materialize(rec, priceOf(id)));
      } else {
        // 负缓存：市场里不分红的票不少，别每次打开都重查一遍
        cache.set(id, { t, none: true });
        out.set(id, null);
      }
    }
  }));

  return out;
}

/**
 * 取一只 A 股的股息率（TTM）。
 * @param {string} id 腾讯 code（sh600519 / sz000001）
 * @param {{price?:number}} [opt] 当前价；不传则只给累计每股派现，由调用方算
 * @returns {Promise<{yield:number, dps:number, count:number, date:string}|null>}
 *   失败或非个股返回 null
 */
export async function getDividend(id, opt = {}) {
  if (!isA(id)) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < TTL) return materialize(hit, opt.price);
  const m = await getDividends([id], { prices: { [id]: opt.price } });
  return m.has(id) ? m.get(id) : null;
}

/** 下拉刷新时清掉，让下次强制重取 */
export function invalidateDividend(id) {
  if (id) cache.delete(id);
  else cache.clear();
}
