/**
 * 全 A 涨跌分布（国家队页底部「市场温度」卡片）
 *
 * 通达信的「全 A 中位指数」(880009) 是全市场个股涨跌幅排序后取中位数、
 * 逐日累计出来的，所以它的单日涨跌 = 当日个股涨跌幅的中位数。
 * 通达信客户端里配套的涨跌家数分布也来自同一份全量个股涨跌幅。
 *
 * 880 段是通达信自己的板块指数，走私有 TCP 协议（7709 端口），
 * 腾讯 / 新浪 / 东财的 HTTP 行情源一律不收录（实测 pv_none_match、空串）。
 * 纯前端拿不到，只能自己按同样的口径算：
 *   代码表静态内置（pool-a.js）→ 腾讯批量精简行情（s_ 前缀，一次 500 只）
 *   → 本地分档统计 + 取中位数。
 *
 * 口径说明（与通达信略有差异，已尽量贴近）：
 *  - 含 ST 股（通达信的中位指数剔除 ST，但涨跌分布通常保留）
 *  - 剔除停牌（腾讯 s_ 返回价格 0 或带 C/D 状态标记）
 *  - 涨停按板块限幅判定：主板 10% / 创业板科创板 20% / 北交所 30% / 主板 ST 5%
 *  - 涨跌幅超过限幅 +1% 的（新股上市首日无涨跌幅限制）不计入涨停档，归入 >7%
 */

import { getText } from './http.js';
import { poolCodes } from './pool-a.js';

const QURL = 'https://qt.gtimg.cn/q=';
/** 单次请求代码数：500 只约 5.5KB URL，实测 1000 只会 414 */
const BATCH = 500;
/**
 * 盘中 25 秒（比卡片 30 秒轮询略短，保证每轮都真取一次）；
 * 收盘后数据不再变，缓存拉长到 30 分钟，轮询空转但不产生请求。
 * 全市场约 415KB、gzip 后 180KB 左右，盘中半小时内累计几十 MB 是常态。
 */
const TTL_LIVE = 25 * 1000;
const TTL_IDLE = 30 * 60 * 1000;

const cache = { at: 0, data: null };
let inflight = null;

const num = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};

/**
 * 是否在 A 股交易时段（含集合竞价与尾盘，留 5 分钟余量）
 * 一律按北京时间的墙钟算：设备时区可能是任意地方，A 股的开收盘是固定的 UTC+8，
 * 中国无夏令时，直接偏移 8 小时再读 UTC 字段最省事。
 */
function inSession(now = Date.now()) {
  const bj = new Date(now + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const hm = bj.getUTCHours() * 100 + bj.getUTCMinutes();
  return (hm >= 915 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
}

/** 该板块的涨跌幅限制（%） */
function limitOf(code, name) {
  // 北交所（430/83x/87x/92x）
  if (/^(4[3-9]|8[3-9]|920)/.test(code)) return 30;
  // 创业板 / 科创板（含 ST，仍是 20%）
  if (/^(300|301|688|689)/.test(code)) return 20;
  // 主板：ST / *ST 为 5%
  return /ST/i.test(name) ? 5 : 10;
}

/**
 * 解析腾讯 s_ 精简行
 * v_s_sh600000="1~浦发银行~600000~9.78~0.05~0.51~540747~52883~~3257.31~GP-A~";
 *   0 市场 1 名称 2 代码 3 现价 4 涨跌额 5 涨跌幅 6 量(手) 7 额(万) 8 状态 9 总市值 10 类型
 *
 * 涨跌额是精确到分的价差，现价 − 涨跌额 就是昨收，
 * 有了昨收才能算真实涨停价——只看涨跌幅会漏判：
 * 昨收 10.03 的涨停板是 11.03，涨幅只有 9.97%，按「≥9.98%」筛会漏掉。
 */
function parseLine(line) {
  const m = /^v_s_([a-z]{2}\d{6})="([^"]*)"/.exec(line);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 6) return null;

  const price = num(f[3]);
  const change = num(f[4]);
  const pct = num(f[5]);
  const flag = (f[8] || '').trim();       // C=停牌 D=退市 空=正常
  if (!(price > 0) || !Number.isFinite(pct) || flag) return null;

  const code = m[1].slice(2);
  const name = f[1] || '';
  const prevClose = Number.isFinite(change) ? price - change : NaN;
  return { code, name, price, pct, prevClose, limit: limitOf(code, name) };
}

/** 交易所涨停/跌停价：昨收 ×(1±限幅) 四舍五入到分 */
function boardPrice(prevClose, limit, dir) {
  return Math.round(prevClose * (1 + dir * limit / 100) * 100) / 100;
}

/** 分档：区间左闭右开，涨跌停各自独立成档，互不重叠 */
function emptyBuckets() {
  return { zt: 0, up7: 0, up57: 0, up35: 0, up03: 0, dn03: 0, dn35: 0, dn57: 0, dn7: 0, dt: 0 };
}

function tally(rows) {
  const b = emptyBuckets();
  let up = 0, down = 0, flat = 0;
  const pcts = [];

  for (const r of rows) {
    const p = r.pct;
    pcts.push(p);
    if (p > 0) up++;
    else if (p < 0) down++;
    else flat++;

    const L = r.limit;
    const ok = Number.isFinite(r.prevClose) && r.prevClose > 0;
    // 涨跌停按价格判定（A 股最小变动 0.01，容差 0.005 足够）；
    // 昨收拿不到时退化成按涨跌幅粗判，宁可少判也不误判。
    const ztHit = ok
      ? Math.abs(r.price - boardPrice(r.prevClose, L, 1)) <= 0.005
      : (p >= L - 0.02 && p <= L + 1);
    const dtHit = ok
      ? Math.abs(r.price - boardPrice(r.prevClose, L, -1)) <= 0.005
      : (p <= -(L - 0.02) && p >= -(L + 1));

    if (ztHit) { b.zt++; continue; }
    if (dtHit) { b.dt++; continue; }

    if (p >= 7) b.up7++;
    else if (p >= 5) b.up57++;
    else if (p >= 3) b.up35++;
    else if (p > 0) b.up03++;
    else if (p === 0) { /* 平盘单列，不进任何档 */ }
    else if (p > -3) b.dn03++;
    else if (p > -5) b.dn35++;
    else if (p > -7) b.dn57++;
    else b.dn7++;
  }

  // 中位涨跌幅 = 通达信 880009 的单日口径
  pcts.sort((a, b2) => a - b2);
  const mid = pcts.length
    ? (pcts.length % 2 ? pcts[(pcts.length - 1) / 2]
      : (pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2)
    : NaN;

  return { buckets: b, up, down, flat, median: mid, total: rows.length };
}

async function fetchBatch(codes) {
  // s_ 前缀 = 精简行情：每只约 60 字节（只有名称/现价/涨跌幅），
  // 不加前缀会给完整五档，全市场一次要多传 8 倍流量。
  const url = QURL + codes.map(c => 's_' + c).join(',');
  const text = await getText(url, { encoding: 'gbk', timeout: 12000, retries: 1 });
  const out = [];
  for (const line of text.split('\n')) {
    const r = parseLine(line);
    if (r) out.push(r);
  }
  return out;
}

/** 抓全量并统计 */
async function fetchAll() {
  const codes = poolCodes();
  const chunks = [];
  for (let i = 0; i < codes.length; i += BATCH) chunks.push(codes.slice(i, i + BATCH));

  // 并发 4：腾讯批量接口能吃，但别一次把 12 条全甩出去
  const rows = [];
  let failed = 0;
  const queue = chunks.slice();
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const chunk = queue.shift();
      try {
        rows.push(...await fetchBatch(chunk));
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);

  // 掉超过 1/4 的分片就认为不可信，宁可报错也不要给出错的分布
  if (failed > chunks.length / 4 || !rows.length) throw new Error('全 A 行情抓取不完整');
  if (failed) console.warn(`[breadth] ${failed}/${chunks.length} 批失败，分布略有缺失`);

  const res = tally(rows);
  return { ...res, at: Date.now(), partial: failed > 0 };
}

/**
 * 取全 A 涨跌分布
 * @param {{force?: boolean}} [opt]
 */
export async function getBreadth(opt = {}) {
  const ttl = inSession() ? TTL_LIVE : TTL_IDLE;
  if (!opt.force && cache.data && Date.now() - cache.at < ttl) return cache.data;

  // 同一时刻只允许一次全量抓取，多张卡片共用
  if (inflight) return inflight;

  inflight = fetchAll()
    .then(data => {
      cache.data = data;
      cache.at = Date.now();
      return data;
    })
    .catch(err => {
      // 抓取失败时退回上一次成功的结果（并标记 stale），别让卡片直接空掉
      if (cache.data) return { ...cache.data, stale: true };
      throw err;
    })
    .finally(() => { inflight = null; });

  return inflight;
}

/** 同步读上次快照（首屏先用它占位，避免白块） */
export function peekBreadth() {
  return cache.data;
}
