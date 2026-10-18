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
 */

import { getJSON } from './http.js';

const API = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const TTL = 60 * 60 * 1000; // 股息数据日频，缓存 1 小时

/** @type {Map<string, {t:number, v:any}>} */
const cache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 从 secid（如 600519.SH）取纯代码与市场，反推腾讯 id */
function txIdOf(secucode) {
  if (!secucode) return '';
  const [code, mkt] = String(secucode).split('.');
  if (!code || !mkt) return '';
  const prefix = mkt === 'SH' ? 'sh' : mkt === 'SZ' ? 'sz' : mkt === 'BJ' ? 'bj' : '';
  return prefix ? prefix + code : '';
}

/**
 * 取一只 A 股的股息率（TTM）。
 * @param {string} id 腾讯 code（sh600519 / sz000001）
 * @param {{price?:number}} [opt] 当前价；不传则只给累计每股派现，由调用方算
 * @returns {Promise<{yield:number, dps:number, count:number, date:string}|null>}
 *   失败或非个股返回 null
 */
export async function getDividend(id, opt = {}) {
  if (!/^(sh|sz|bj)\d{6}$/.test(id)) return null;

  const cached = cache.get(id);
  if (cached && Date.now() - cached.t < TTL) return cached.v;

  // 转成东财 secid：sh600519 -> 600519.SH
  const code = id.slice(2);
  const mkt = id[0] === 's' && id[1] === 'h' ? 'SH' : id[1] === 'z' ? 'SZ' : 'BJ';
  const filter = `(SECURITY_CODE="${code}")`;

  const url = `${API}?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=${encodeURIComponent(filter)}`
    + '&pageNumber=1&pageSize=20&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1';

  try {
    const json = await getJSON(url, { timeout: 8000, retries: 1 });
    const rows = json?.result?.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('无分红数据');

    // 最近 12 个月窗口，按除权日累加「已实施」的每股派现
    const now = Date.now();
    const cutoff = now - 365 * 24 * 3600 * 1000;
    let dps = 0;
    let count = 0;
    let lastDate = '';

    for (const r of rows) {
      const prog = String(r.ASSIGN_PROGRESS || '');
      // 只认「实施分配」；「预案」「股东大会通过」等尚未落地的现金不能算
      if (!prog.includes('实施')) continue;
      const exDate = String(r.EX_DIVIDEND_DATE || '').slice(0, 10);
      const t = exDate ? new Date(exDate.replace(/-/g, '/')).getTime() : 0;
      if (t && t < cutoff) continue; // 超过 12 个月
      const bonus10 = Number(r.PRETAX_BONUS_RMB);
      if (!Number.isFinite(bonus10) || bonus10 <= 0) continue;
      dps += bonus10 / 10;
      count += 1;
      if (!lastDate) lastDate = exDate;
    }

    if (!count) throw new Error('近 12 个月无已实施分红');

    const price = Number(opt.price);
    const v = {
      dps: +dps.toFixed(4),
      count,
      date: lastDate,
      yield: Number.isFinite(price) && price > 0 ? +((dps / price) * 100).toFixed(2) : null,
      txId: txIdOf(rows[0]?.SECUCODE) || '',
    };
    cache.set(id, { t: now, v });
    return v;
  } catch (e) {
    // 失败不缓存，下次再试
    return null;
  }
}

/** 下拉刷新时清掉，让下次强制重取 */
export function invalidateDividend(id) {
  if (id) cache.delete(id);
  else cache.clear();
}
