/**
 * 「行情分析」页的数据层：量比折算、广度（ARMS）、日线取数
 *
 * v1.34 起这一页改用「相似历史日匹配」，不再有 16 格的静态赔率表，
 * 所以这个文件只留下三件还需要的工具：
 *   · fetchBars   三只指数的日线（匹配要从实时日线算今天的特征）
 *   · 量比折算    盘中成交量是未完成值，不折算就没法跟历史比
 *   · getArms     全 A 广度，只作参照、不进模型
 *
 * 为什么量比要「折算」：上午 10 点的 0.5 倍量与收盘的 0.5 倍量不是一回事。
 * 按已交易时间线性放大后再比才勉强可比。A 股成交量是 U 型分布，线性折算
 * 早盘会低估、尾盘会高估，属已知偏差；收盘后不折算，那个数字是准的。
 */

import { getJSON } from './http.js';
import { getBreadth, getBucketRows } from './breadth.js';

const KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=';

/** 特征最多要 21 根（20 日动量），取 60 根留余量 */
const BARS = 60;
const TTL = 60 * 1000;

const barsCache = new Map();

/** 四象限：方向 × 强弱 */
export const QUAD = {
  '1-1': { code: 'C1', name: '风险偏好上行', note: '普涨且小盘更强' },
  '1-0': { code: 'C2', name: '权重护盘', note: '涨但资金偏大盘' },
  '0-1': { code: 'C3', name: '结构分化', note: '跌但小盘抗跌' },
  '0-0': { code: 'C4', name: '系统性走弱', note: '跌且小盘更弱' },
};

/**
 * 已交易分钟数（0~240）
 * 一律按北京墙钟算：设备时区可能是任意地方，A 股开收盘固定 UTC+8。
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
export function adjustVolumeRatio(vr) {
  const el = sessionElapsed();
  if (!Number.isFinite(vr) || !(el >= 15 && el < 235)) {
    return { vr, scaled: false, elapsed: el };
  }
  return { vr: vr / (el / 240), scaled: true, elapsed: el };
}

export async function fetchBars(id) {
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

/**
 * 全 A 广度：ARMS 与涨跌结构
 *
 * 这是**当日实测值**，不进模型——相似日匹配的五个特征全是纯指数的，
 * 历史全 A 家数与成交额拿不到，混进来会让「历史样本」与「今天」不是同一套算法。
 * 它的作用是把「广度」这条信息补回来。
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
