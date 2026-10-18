/**
 * ETF 资金流聚合层
 *
 * - TTL 90s（日频数据，没必要更快）
 * - 请求串行 400ms 间隔，避免新浪侧被判定为异常流量
 * - 连续失败 3 次 → 该标的冷却 120s
 * - 失败时返回上一次快照并标记 stale，绝不阻塞报价渲染
 */

import { fetchFlow, flowStats } from './sources/sinaFlow.js';

const TTL = 90_000;
const GAP = 400;
const MAX_FAIL = 3;
const COOLDOWN = 120_000;

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
    const rows = await serial(() => fetchFlow(id, 20));
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

/** 同步读缓存（不触发请求） */
export function peekFlow(id) {
  const c = cache.get(id);
  if (!c) return null;
  return { rows: c.data, stats: flowStats(c.data), stale: Date.now() - c.t > TTL * 2, at: c.t };
}

/** 是否有可用缓存 */
export function hasFlow(id) {
  return cache.has(id);
}

export { flowStats };
