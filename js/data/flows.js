/**
 * ETF 资金流聚合层
 *
 * 两条通道：
 *  - 日频历史 getFlow：序列（近 20 日）、5/10/20 日累计、连续流入天数，TTL 90s
 *  - 当日实时 getLiveFlow：盘中随成交滚动的今日净流入，TTL 12s，可批量
 * 历史接口一天只生成一根，盘中刷新也不会变，所以「今日」必须用实时那条覆盖。
 *
 * - 请求串行 400ms 间隔，避免新浪侧被判定为异常流量
 * - 连续失败 3 次 → 该标的冷却 120s
 * - 失败时返回上一次快照并标记 stale，绝不阻塞报价渲染
 */

import { fetchFlow, fetchFlowLive, flowStats } from './sources/sinaFlow.js';

const TTL = 90_000;
const GAP = 400;
const MAX_FAIL = 3;
const COOLDOWN = 120_000;
/** 实时值只做「今日」的覆盖，刷新跟着报价轮询走，12s 内复用同一份 */
const LIVE_TTL = 12_000;

/** @type {Map<string, {t:number, data:any}>} */
const cache = new Map();
/** @type {Map<string, {fails:number, until:number}>} */
const health = new Map();

let lastCallAt = 0;
let chain = Promise.resolve();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function serial(fn) {
  const task = chain.then(async () => {
    const wait = Math.max(0, GAP - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  chain = task.catch(() => {});
  return task;
}

/** 拉多少天：国家队汇总比照最长要 30 日窗口，40 天留出停牌 / 节假日的余量 */
const HISTORY_DAYS = 40;

/**
 * 获取资金流
 * @param {string} id
 * @param {{maxAge?:number, force?:boolean}} [opt]
 * @returns {Promise<{rows:Array, stats:object, stale:boolean, error?:string}>}
 */
export async function getFlow(id, opt = {}) {
  const maxAge = opt.maxAge ?? TTL;
  const c = cache.get(id);

  if (!opt.force && c && Date.now() - c.t < maxAge) {
    return { rows: c.data, stats: flowStats(c.data), stale: false };
  }

  const h = health.get(id);
  if (!opt.force && h && h.until > Date.now()) {
    // 冷却中：有旧数据就先给旧的
    if (c) return { rows: c.data, stats: flowStats(c.data), stale: true, error: 'cooling' };
    return { rows: [], stats: flowStats([]), stale: true, error: 'cooling' };
  }

  try {
    const rows = await serial(() => fetchFlow(id, HISTORY_DAYS));
    cache.set(id, { t: Date.now(), data: rows });
    health.set(id, { fails: 0, until: 0 });
    return { rows, stats: flowStats(rows), stale: false };
  } catch (e) {
    const prev = health.get(id) || { fails: 0, until: 0 };
    const fails = prev.fails + 1;
    health.set(id, {
      fails,
      until: fails >= MAX_FAIL ? Date.now() + COOLDOWN : 0,
    });
    if (c) return { rows: c.data, stats: flowStats(c.data), stale: true, error: String(e.message || e) };
    return { rows: [], stats: flowStats([]), stale: true, error: String(e.message || e) };
  }
}

/* ---------------- 当日实时资金流 ---------------- */

let liveKey = '';
let liveAt = 0;
/** @type {Map<string, any>} */
let liveData = new Map();

/**
 * 批量取当日实时资金流
 * @param {string[]} ids
 * @param {{force?:boolean}} [opt]
 * @returns {Promise<Map<string, {net:number, main:number, mainPct:number, close:number, chgPct:number, volume:number}>>}
 */
export async function getLiveFlow(ids, opt = {}) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();

  // 同一批代码直接复用；批量接口一次就能拉完，不必像历史那样串行排队
  const key = [...list].sort().join(',');
  if (!opt.force && key === liveKey && Date.now() - liveAt < LIVE_TTL) return liveData;

  try {
    const data = await fetchFlowLive(list);
    liveKey = key;
    liveAt = Date.now();
    liveData = data;
    return data;
  } catch {
    // 静默降级：调用方继续用日频快照，界面上不会跳成 -- 
    return key === liveKey ? liveData : new Map();
  }
}

/** 同步读缓存（不触发请求） */export function peekFlow(id) {
  const c = cache.get(id);
  if (!c) return null;
  return { rows: c.data, stats: flowStats(c.data), stale: Date.now() - c.t > TTL * 2, at: c.t };
}

/** 是否有可用缓存 */
export function hasFlow(id) {
  return cache.has(id);
}

export { flowStats };
