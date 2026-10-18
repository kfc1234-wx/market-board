/**
 * 新浪 — ETF 资金流
 *
 * 腾讯的 ff_ 接口对 ETF 返回 pv_none_match（不支持），东财 push2 在本网络被 TCP 封禁，
 * 因此 ETF 资金流走新浪这条线：`quotes_service/api/jsonp_v2.php`。
 *
 * 该域名无 CORS 头，只能用 JSONP 脚本注入。
 * 返回形如：var _cb1=([{...}])
 *
 * 字段口径（已用成交额反算校验）：
 *   netamount  净流入额（元）        = 主动买 - 主动卖
 *   ratioamount 净流入率（小数）      ← 如 -0.00442853 = -0.44%，展示前需 ×100
 *   r0_net     主力（特大单）净额（元）
 *   r0_ratio   主力净占比（小数）
 *   trade / changeratio 收盘价 / 涨跌幅（小数）
 */

import { jsonpVar } from '../http.js';

const BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/jsonp_v2.php';

let seq = 0;

/**
 * 拉取某只 ETF 的近 N 日资金流
 * @param {string} id 腾讯 code，如 sh510300
 * @param {number} days
 * @returns {Promise<Array<{date:string,net:number,netPct:number,main:number,mainPct:number,close:number,chgPct:number}>>}
 */
export async function fetchFlow(id, days = 20) {
  // 变量名必须唯一，否则并发请求会互相覆盖
  const cb = `_sff${++seq}_${Date.now().toString(36)}`;
  const url = `${BASE}/var%20${cb}=/MoneyFlow.ssl_qsfx_zjlrqs`
    + `?page=1&num=${days}&sort=opendate&asc=0&daima=${encodeURIComponent(id)}`;

  const raw = await jsonpVar(url, cb, 8000);
  const rows = Array.isArray(raw) ? raw : [];
  if (!rows.length) throw new Error('资金流数据为空');

  const list = rows.map(r => {
    const chgRaw = Number(r.changeratio);
    const pctRaw = Number(r.ratioamount);
    const mainPctRaw = Number(r.r0_ratio);
    return {
      date: String(r.opendate || ''),
      net: Number(r.netamount) || 0,
      // 源里是小数（-0.00442853），统一成百分数（-0.4428）
      netPct: Number.isFinite(pctRaw) ? +(pctRaw * 100).toFixed(4) : 0,
      main: Number(r.r0_net) || 0,
      mainPct: Number.isFinite(mainPctRaw) ? +(mainPctRaw * 100).toFixed(4) : 0,
      close: Number(r.trade) || 0,
      // 源里是小数（-0.00556），统一成百分数（-0.556）
      chgPct: Number.isFinite(chgRaw) ? +(chgRaw * 100).toFixed(3) : 0,
    };
  }).filter(x => x.date);

  // 源是倒序（最新在前），统一转正序
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}

/** 派生指标 */
export function flowStats(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { today: null, main: 0, mainPct: 0, netPct: 0, d5: 0, d10: 0, d20: 0, streak: 0, streakDir: 0 };
  }
  const last = rows[rows.length - 1];
  const sum = n => rows.slice(-n).reduce((s, r) => s + r.net, 0);

  // 连续净流入/流出天数
  let streak = 0;
  let streakDir = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i].net;
    const dir = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (dir === 0) break;
    if (streakDir === 0) { streakDir = dir; streak = 1; }
    else if (dir === streakDir) streak++;
    else break;
  }

  return {
    today: last,
    main: last.main,
    mainPct: last.mainPct,
    netPct: last.netPct,
    d5: sum(5),
    d10: sum(10),
    d20: sum(20),
    streak,
    streakDir,
  };
}
