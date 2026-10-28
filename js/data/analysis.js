/**
 * 「行情分析」页的数据层：三因子实时编码 + 查表
 *
 * 分工
 *  - 历史统计（16 格的赔率）是常量，编译在 analysis-data.js 里
 *  - 这里只负责算「今天落进哪一格」，再把那一格的赔率取出来
 *
 * 三因子（必须与 scripts/build-analysis.py 完全同口径，否则状态不可比）
 *  d 方向 当日涨跌幅 >= 0 记 1
 *  v 强度 量比 = 当日成交量 / 前 5 日均量，按内置四分位切 4 档
 *  p 性质 投机溢价 = 创业板指涨跌幅 - 上证涨跌幅，按内置中位数切 2 档
 *
 * 为什么量比要「折算」：盘中成交量是未完成的累计值，上午 10 点的 0.5 倍量
 * 与收盘的 0.5 倍量不是一回事。按已交易时间线性放大后再比，才勉强可比。
 * A 股成交量是 U 型分布，线性折算在早盘会低估、尾盘会高估，属于已知偏差；
 * 收盘后不折算，所以「收盘口径」的数字是准的。
 */

import { getQuotes } from './quotes.js';
import { getJSON } from './http.js';
import { getBreadth, getBucketRows } from './breadth.js';
import {
  ANALYSIS_DATA, ANALYSIS_INDICES, VOLUME_LABELS, PREMIUM_LABELS,
} from './analysis-data.js';

const KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=';

/** 实时因子 60 秒一轮：量比变化很慢，没必要跟看板同一个节奏 */
const TTL = 60 * 1000;
/** 日线取 60 根足够：只要前 5 日均量 */
const BARS = 60;

const cache = new Map(); // indexId -> {t, data}
const barsCache = new Map(); // indexId -> {t, bars}

/** 四象限：方向 × 溢价 */
export const QUAD = {
  '1-1': { code: 'C1', name: '风险偏好上行', note: '普涨且小盘更强' },
  '1-0': { code: 'C2', name: '权重护盘', note: '涨但资金偏大盘' },
  '0-1': { code: 'C3', name: '结构分化', note: '跌但小盘抗跌' },
  '0-0': { code: 'C4', name: '系统性走弱', note: '跌且小盘更弱' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 已交易分钟数（0~240）
 * 一律按北京墙钟算：设备时区可能是任意地方，A 股开收盘是固定 UTC+8。
 */
export function sessionElapsed(now = Date.now()) {
  const bj = new Date(now + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return 0;
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const AM0 = 9 * 60 + 30;
  const AM1 = 11 * 60 + 30;
  const PM0 = 13 * 60;
  const PM1 = 15 * 60;
  if (m <= AM0) return 0;
  if (m <= AM1) return m - AM0;
  if (m <= PM0) return 120;
  if (m <= PM1) return 120 + (m - PM0);
  return 240;
}

/**
 * 盘中折算量比
 * 开盘前 15 分钟样本太薄（一两笔就能把量比顶到天上），不折算；
 * 14:55 之后基本收敛，也不折算。
 */
function adjustVolumeRatio(vr) {
  const el = sessionElapsed();
  if (!(el >= 15 && el < 235)) return { vr, scaled: false, elapsed: el };
  return { vr: vr / (el / 240), scaled: true, elapsed: el };
}

async function fetchBars(id) {
  const c = barsCache.get(id);
  if (c && Date.now() - c.t < TTL) return c.bars;

  const j = await getJSON(`${KLINE}${id},day,,,${BARS}`, { timeout: 9000, retries: 1 });
  const node = (j && j.data ? j.data[id] : null) || {};
  const rows = node.day || [];
  const bars = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const vol = Number(r[5]);
    if (!Number.isFinite(vol) || vol <= 0) continue;
    bars.push({ date: String(r[0]), close: Number(r[2]), vol });
  }
  if (!bars.length) throw new Error('日线为空');
  barsCache.set(id, { t: Date.now(), bars });
  return bars;
}

/** 今日涨跌幅的符号 */
const dirOf = pct => (Number.isFinite(pct) && pct >= 0 ? 1 : 0);

/** 量比落档（与 Python 端四分位切法一致：左闭右开） */
function volBucket(vr, bounds) {
  if (!Number.isFinite(vr)) return 0;
  if (vr <= bounds[0]) return 1;
  if (vr <= bounds[1]) return 2;
  if (vr <= bounds[2]) return 3;
  return 4;
}

/**
 * 状态中文名
 *
 * 名字本身就是 16 格的唯一键，所以量能档必须编进前半段，不能再用
 * 「缩量上涨 · 缩量」这种把同一个词说两遍的写法。
 * 4 个量能档 x 2 个方向 = 8 种前半段，再乘 2 个溢价档 = 16 种，正好一一对应。
 */
const COMBO = {
  1: { 1: '无量上涨', 2: '缩量上涨', 3: '量价齐升', 4: '巨量拉升' },
  0: { 1: '无量下跌', 2: '缩量下跌', 3: '量价齐跌', 4: '放量杀跌' },
};

export function stateName(d, v, p) {
  if (!v) return '—';
  return `${COMBO[d][v]} · ${PREMIUM_LABELS[p]}`;
}

/**
 * 全 A 广度：ARMS 与涨跌结构
 *
 * 这是**当日实测值**，不参与状态判定——16 格的因子口径是纯指数的，
 * 历史全 A 家数与成交额拿不到，混进来会让「历史样本」与「今日状态」不是同一套算法。
 * 它的作用是把「广度」这条信息补回来，与截图里那张卡的 ARMS 对位。
 *
 * @returns {Promise<null|{arms:number, up:number, down:number, upAmt:number,
 *   downAmt:number, ratioCount:number, ratioAmt:number, at:number, partial:boolean}>}
 */
export async function getArms() {
  try {
    const b = await getBreadth();
    if (!b || !b.up || !b.down) return null;
    const upRows = getBucketRows('up') || [];
    const downRows = getBucketRows('down') || [];
    let upAmt = 0;
    let downAmt = 0;
    for (const r of upRows) upAmt += Number(r.amount) || 0;
    for (const r of downRows) downAmt += Number(r.amount) || 0;
    if (!(upAmt > 0 && downAmt > 0)) return null;

    const ratioCount = b.up / b.down;
    const ratioAmt = upAmt / downAmt;
    return {
      arms: ratioCount / ratioAmt,
      up: b.up,
      down: b.down,
      upAmt,
      downAmt,
      ratioCount,
      ratioAmt,
      median: b.median,
      at: b.at || Date.now(),
      partial: !!b.partial,
    };
  } catch {
    return null;
  }
}

/**
 * 取一个指数的今日三因子与赔率
 * @param {string} indexId
 * @param {{force?:boolean}} [opt]
 */
export async function getAnalysis(indexId = 'sh000001', opt = {}) {
  const meta = ANALYSIS_INDICES.find(x => x.id === indexId) || ANALYSIS_INDICES[0];
  const table = ANALYSIS_DATA.indices[meta.id];
  if (!table) throw new Error('没有该指数的基准数据');

  const c = cache.get(meta.id);
  if (!opt.force && c && Date.now() - c.t < TTL) return c.data;

  // 三个指数都要报价：溢价因子要用到上证与创业板，不管当前选的是谁
  const ids = [...new Set([meta.id, 'sh000001', 'sz399006'])];
  const [quotes, bars] = await Promise.all([
    getQuotes(ids, { maxAge: 3000 }),
    fetchBars(meta.id),
  ]);

  const q = quotes.get(meta.id);
  const qSh = quotes.get('sh000001');
  const qCyb = quotes.get('sz399006');
  if (!q || !q.valid) throw new Error('指数报价不可用');

  // 量比 = 当前成交量 / 今日之前 5 个交易日的均量。
  //
  // 这里必须按日期过滤而不是简单 slice(-6)：盘前和休市时，日线最后一根
  // 就是「上一交易日」，而报价返回的成交量也是那一天的全天量，
  // 直接往前数 5 根会把当天自己混进均量里，量比恒等于「自己比自己」。
  // 统一取「日期 < 今天」的最后 5 根，两种时点都能落到正确的分母上。
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const last5 = bars.filter(b => b.date < today).slice(-5);
  let volumeRatio = NaN;
  if (last5.length === 5) {
    const ma = last5.reduce((s, b) => s + b.vol, 0) / 5;
    const todayVol = Number(q.volume);
    if (ma > 0 && todayVol > 0) volumeRatio = todayVol / ma;
  }

  const adj = adjustVolumeRatio(volumeRatio);
  const vr = adj.vr;

  // 溢价：创业板 - 上证，当日
  const premium = (qCyb && qCyb.valid && qSh && qSh.valid)
    ? qCyb.pct - qSh.pct
    : NaN;

  const d = dirOf(q.pct);
  const v = volBucket(vr, table.bounds.vr);
  const p = Number.isFinite(premium) ? (premium > table.bounds.premium ? 1 : 0) : 0;

  const key = `${d}-${v}-${p}`;
  const sample = table.states[key] || null;

  // 数据所属交易日：盘前/休市时页面显示的是上一交易日的收盘状态，
  // 不标出来会被误读成「今天涨了这么多」
  const asOf = bars.length ? bars[bars.length - 1].date : '';

  const data = {
    meta: ANALYSIS_DATA.meta,
    asOf,
    indexId: meta.id,
    name: meta.name,
    short: meta.short,
    price: q.price,
    pct: q.pct,
    change: q.change,
    amount: q.amount,
    volume: q.volume,
    time: q.time,
    factors: { d, v, p },
    volumeRatio: Number.isFinite(vr) ? vr : NaN,
    volumeRatioRaw: Number.isFinite(volumeRatio) ? volumeRatio : NaN,
    volumeScaled: adj.scaled,
    elapsed: adj.elapsed,
    premium,
    stateKey: key,
    stateName: stateName(d, v, p),
    quadKey: `${d}-${p}`,
    quad: QUAD[`${d}-${p}`],
    sample,
    quadSample: table.quad[`${d}-${p}`] || null,
    table,
    at: Date.now(),
  };

  cache.set(meta.id, { t: Date.now(), data });
  return data;
}

/** 同步读上次快照（切回页面时先占位，避免白屏） */
export function peekAnalysis(indexId = 'sh000001') {
  const c = cache.get(indexId);
  return c ? c.data : null;
}

export { ANALYSIS_INDICES };
