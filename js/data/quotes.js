/**
 * 报价聚合层
 *
 * 职责：
 *  - 内存缓存（TTL 4s）—— 看板与详情页共享，避免重复请求
 *  - 250ms 合并窗口 —— 多处同时请求时归并成一次批量
 *  - 同源最小间隔 1.2s —— 腾讯无公开限额，但高频会被拒
 *  - 失败保留旧缓存，UI 侧标记「延迟」
 */

import { fetchQuotes } from './sources/tencent.js';
import { fetchCnbcGlobal } from './sources/cnbcGlobal.js';
import { fetchFgGlobal } from './sources/fgGlobal.js';
import { fetchEmGlobal } from './sources/emGlobal.js';
import { fetchFxQuoteAndMinute } from './sources/sinaFx.js';
import { fetchFuturesQuote } from './sources/sinaGold.js';
import { getSymbol } from './symbols.js';
import { patchCatalogName } from './sources/search.js';

const TTL = 4000;
const MIN_GAP = 1200;
const CHUNK = 40;

/** @type {Map<string, {t:number, data:any}>} */
const cache = new Map();

/**
 * 新数据源的失败退避
 *
 * 东财 / 新浪外汇是 JSONP，一旦域名不可达（运营商拦截、海外网络、临时故障），
 * 每次轮询都要等满超时才返回，会把整轮刷新拖死。
 * 连续失败就指数退避（5s → 10s → 20s → 40s，上限 60s），成功一次即清零。
 */
const backoff = new Map(); // key -> { fail, until }

function canTry(key) {
  const b = backoff.get(key);
  return !b || Date.now() >= b.until;
}

function markFail(key) {
  const b = backoff.get(key) || { fail: 0, until: 0 };
  b.fail += 1;
  b.until = Date.now() + Math.min(60_000, 5000 * 2 ** (b.fail - 1));
  backoff.set(key, b);
}

function markOk(key) {
  backoff.delete(key);
}

let pending = new Set();
let waiters = [];
let timer = 0;
let lastCallAt = 0;
let lastOk = true;
let lastError = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 取缓存快照 */
function collect(ids) {
  const out = new Map();
  const now = Date.now();
  for (const id of ids) {
    const c = cache.get(id);
    if (!c) continue;
    out.set(id, { ...c.data, at: c.t, age: now - c.t, stale: now - c.t > TTL * 2.5 });
  }
  return out;
}

/**
 * 获取报价
 * @param {string[]} ids
 * @param {{maxAge?:number}} [opt]
 * @returns {Promise<Map<string, any>>} 永远不会 reject，取不到就没有对应 key
 */
export function getQuotes(ids, opt = {}) {
  const maxAge = opt.maxAge ?? TTL;
  const now = Date.now();
  const need = [];

  for (const id of ids) {
    const c = cache.get(id);
    if (!c || now - c.t > maxAge) need.push(id);
  }
  if (!need.length) return Promise.resolve(collect(ids));

  for (const id of need) pending.add(id);

  return new Promise(resolve => {
    waiters.push({ resolve, ids });
    if (timer) clearTimeout(timer);
    // 合并窗口：把这一轮事件循环里所有请求攒到一起
    timer = setTimeout(flush, 250);
  });
}

async function flush() {
  timer = 0;
  const ids = [...pending];
  pending.clear();
  const group = waiters;
  waiters = [];

  if (!ids.length) {
    for (const w of group) w.resolve(collect(w.ids));
    return;
  }

  // 按数据源分组：腾讯是批量文本接口，全球指数走 CNBC（东财兜底），新浪外汇是 JSONP
  const txCodes = [];
  const globalItems = [];
  const fxItems = [];
  for (const id of ids) {
    const sym = getSymbol(id);
    if (!sym || !sym.id) continue;
    if (sym.src === 'global') globalItems.push({
      id: sym.id,
      cnbc: sym.cnbc,
      secid: sym.secid,
      fg: sym.fg,
      closeTime: sym.closeTime,
      timeFromLast: sym.timeFromLast,
    });
    else if (sym.src === 'sinafx') fxItems.push({ id: sym.id, sina: sym.sina, divide: sym.divide });
    else txCodes.push(sym.id);
  }

  let ok = false;

  // --- 腾讯（A股 / 港股 / 美股指数 / 期货）---
  try {
    for (const part of chunk(txCodes, CHUNK)) {
      const wait = Math.max(0, MIN_GAP - (Date.now() - lastCallAt));
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();

      const quotes = await fetchQuotes(part);
      const at = Date.now();
      for (const code of part) {
        const q = quotes[code];
        if (!q || !q.valid) continue;
        cache.set(code, { t: at, data: q });
        // 用权威名称校正本地目录
        if (q.name) patchCatalogName(code, q.name);
      }
      ok = true;
    }
  } catch (e) {
    lastError = e;
  }

  // --- 外盘期货补漏：腾讯没有纳指期货（hf_NQ 返回 none_match），
  // 这类缺失的 hf_ 品种改走新浪期货分时推导报价。
  // 标普期货 hf_ES 腾讯有，不会进这里。
  const futMissing = txCodes.filter(c => c.startsWith('hf_') && !cache.has(c));
  if (futMissing.length && canTry('sinahf')) {
    try {
      for (const code of futMissing) {
        const q = await fetchFuturesQuote(code.slice(3));
        cache.set(code, { t: Date.now(), data: { ...q, id: code } });
      }
      markOk('sinahf');
      ok = true;
    } catch (e) {
      lastError = e;
      markFail('sinahf');
    }
  }

  // --- 日韩指数：CNBC 主源 → feargreedchart 兜底 → 东财补漏 ---
  if (globalItems.length) {
    let got = {};
    if (canTry('cnbc')) {
      try {
        got = await fetchCnbcGlobal(globalItems);
        markOk('cnbc');
        ok = true;
      } catch (e) {
        lastError = e;
        markFail('cnbc');
      }
    }

    // feargreedchart：独立第三方，CORS 开放、无需 Key，专治 CNBC 单点失联
    let missing = globalItems.filter(it => !got[it.id]);
    if (missing.length && canTry('fg')) {
      try {
        const rest = await fetchFgGlobal(missing);
        got = { ...got, ...rest };
        markOk('fg');
        ok = true;
      } catch (e) {
        lastError = e;
        markFail('fg');
      }
    }

    missing = globalItems.filter(it => !got[it.id]);
    if (missing.length && canTry('em')) {
      try {
        const rest = await fetchEmGlobal(missing);
        got = { ...got, ...rest };
        markOk('em');
        ok = true;
      } catch (e) {
        lastError = e;
        markFail('em');
      }
    }

    const at = Date.now();
    for (const id of Object.keys(got)) {
      const q = got[id];
      if (!q || !q.valid) continue;
      cache.set(id, { t: at, data: q });
    }
  }

  // --- 新浪外汇（离岸人民币 / 人民币账户黄金）---
  for (const it of fxItems) {
    const code = it.id;
    if (!canTry('fx:' + code)) continue;
    try {
      const { quote } = await fetchFxQuoteAndMinute(it.sina || code, { divide: it.divide });
      if (quote && quote.valid) {
        cache.set(code, { t: Date.now(), data: { ...quote, id: code } });
        markOk('fx:' + code);
        ok = true;
      }
    } catch (e) {
      lastError = e;
      markFail('fx:' + code);
    }
  }

  lastOk = ok;
  for (const w of group) w.resolve(collect(w.ids));
}

/** 作废缓存（下拉刷新用） */
export function invalidate(ids) {
  if (!ids) cache.clear();
  else for (const id of ids) cache.delete(id);
}

/** 最近一次拉取是否成功 */
export function lastFetchOk() {
  return lastOk;
}

export function lastFetchError() {
  return lastError;
}

/** 同步取缓存（不触发请求），用于首屏快速渲染 */
export function peek(ids) {
  return collect(ids);
}

/** 预先登记名称（搜索添加后立刻显示友好名，不用等行情） */
export function seedName(id, name) {
  const c = cache.get(id);
  if (c && name) cache.set(id, { ...c, data: { ...c.data, name } });
  patchCatalogName(id, name);
}
