/**
 * 腾讯行情适配器
 *
 * 覆盖：A股 / 港股 / 美股指数 / 外盘期货（黄金）的报价、分时、K线。
 * 注意三个坑：
 *  1) 行情是 GBK 编码，需要 TextDecoder('gbk')
 *  2) 美股指数分时/K线必须用 usMinute / usfqkline 专用端点，普通端点只返回 1 条
 *  3) K线键名不统一：A股是 qfqday，港股/美指是 day
 */

import { getText, getJSON, loadScript, GBK_SUPPORTED } from '../http.js';

const QT = 'https://qt.gtimg.cn/q=';
const APP = 'https://web.ifzq.gtimg.cn/appstock/app';

/** 标准品种字段下标（A股/港股/美股指数 / ETF 均一致） */
const F = {
  name: 1, code: 2, price: 3, prevClose: 4, open: 5, volume: 6,
  time: 30, change: 31, pct: 32, high: 33, low: 34,
  amountWan: 37, turnover: 38, pe: 39, floatCap: 44, totalCap: 45,
};

const num = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** 从价格字符串推断小数位，保证 1.430 不会显示成 1.43 */
function digitsOf(str, fallback = 2) {
  if (typeof str !== 'string') return fallback;
  const i = str.indexOf('.');
  if (i < 0) return fallback;
  const d = str.length - i - 1;
  return d >= 0 && d <= 4 ? d : fallback;
}

/**
 * 解析 `v_code="1~名称~..."` 形式的返回体
 * @returns {Record<string, any>}
 */
export function parseQuoteText(text) {
  const out = Object.create(null);
  const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1];
    const body = m[2];
    if (!body) continue;
    out[id] = id.startsWith('hf_') ? parseFutures(body) : parseStandard(body, id);
  }
  return out;
}

function parseStandard(body, id) {
  const f = body.split('~');
  if (f.length < 35) return { id, valid: false };

  const priceStr = f[F.price] || '';
  const prevStr = f[F.prevClose] || '';
  const price = num(priceStr);
  const prevClose = num(prevStr);
  const change = num(f[F.change]);
  const pct = num(f[F.pct]);

  // 美股 / 期货的成交额字段不可靠，统一置 0，UI 侧改用成交量
  const isOverseas = id.startsWith('us');
  const amount = isOverseas ? 0 : num(f[F.amountWan]) * 1e4;

  const totalCapYi = num(f[F.totalCap]);

  return {
    id,
    valid: true,
    name: f[F.name] || '',
    price,
    prevClose,
    open: num(f[F.open]),
    high: num(f[F.high]),
    low: num(f[F.low]),
    change: change || (price && prevClose ? +(price - prevClose).toFixed(4) : 0),
    pct: pct || (price && prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(3) : 0),
    volume: num(f[F.volume]),
    amount,
    turnover: num(f[F.turnover]),
    pe: num(f[F.pe]),
    floatCap: num(f[F.floatCap]),
    totalCap: totalCapYi ? totalCapYi * 1e8 : 0,
    time: f[F.time] || '',
    digits: digitsOf(priceStr, 2),
    suspended: price === 0,
  };
}

/**
 * 外盘期货（hf_）是逗号分隔的另一套结构：
 * 0=现价 1=涨跌幅 2=买 3=卖 4=最高 5=最低 6=时间 7=昨收 8=今开 12=日期 13=名称
 */
function parseFutures(body) {
  const f = body.split(',');
  if (f.length < 13) return { id: '', valid: false };
  const price = num(f[0]);
  const prevClose = num(f[7]);
  const change = prevClose ? +(price - prevClose).toFixed(4) : 0;
  return {
    id: '',
    valid: true,
    name: f[13] || '',
    price,
    prevClose,
    open: num(f[8]),
    high: num(f[4]),
    low: num(f[5]),
    change,
    pct: num(f[1]) || (prevClose ? +((change / prevClose) * 100).toFixed(3) : 0),
    volume: 0,
    amount: 0,
    turnover: 0,
    pe: 0,
    floatCap: 0,
    totalCap: 0,
    time: `${f[12] || ''} ${f[6] || ''}`.trim(),
    digits: digitsOf(f[0], 2),
    suspended: false,
  };
}

/**
 * 批量报价（一次可请求 40+ 个代码）
 * @param {string[]} codes 腾讯 code 列表
 */
export async function fetchQuotes(codes) {
  const url = QT + encodeURI(codes.join(','));
  let text;

  if (GBK_SUPPORTED) {
    text = await getText(url, { encoding: 'gbk', timeout: 6000, retries: 1 });
  } else {
    // 极老 iOS 兜底：把接口当脚本加载，读全局 v_* 变量
    await loadScript(url, 7000);
    const parts = [];
    for (const c of codes) {
      const v = window['v_' + c];
      if (v) parts.push(`v_${c}="${v}";`);
      try { delete window['v_' + c]; } catch { window['v_' + c] = undefined; }
    }
    text = parts.join('');
  }

  const parsed = parseQuoteText(text);
  // 期货返回体里没有 code 字段，用请求参数回填
  for (const c of codes) {
    const q = parsed[c];
    if (q && q.valid) q.id = c;
  }
  return parsed;
}

/**
 * 分时
 * A股/港股：minute/query，元素 "0930 1311.57 335 43937595.00"（时间 价 累计量 累计额）
 * 美股指数：usMinute/query，只有 3 段（无成交额）
 * @param {import('../symbols.js').Symbol} sym
 */
export async function fetchMinute(sym) {
  const ep = sym.market === 'US' ? 'usMinute' : 'minute';
  const url = `${APP}/${ep}/query?code=${encodeURIComponent(sym.id)}`;
  const json = await getJSON(url, { timeout: 8000, retries: 1 });

  const node = json?.data?.[sym.id];
  const rows = node?.data?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('分时数据为空');

  const points = [];
  for (const row of rows) {
    const seg = row.split(' ');
    if (seg.length < 2) continue;
    const price = num(seg[1]);
    if (!price) continue;
    points.push({
      t: seg[0],
      price,
      cumVol: num(seg[2]),
      cumAmt: num(seg[3]),
    });
  }
  if (!points.length) throw new Error('分时数据为空');

  // 昨收优先取同一响应里的快照，其次留给上层用报价补
  const qt = node?.qt?.[sym.id];
  const prevClose = qt ? num(qt[4]) : 0;

  return {
    date: node?.data?.date || '',
    points,
    prevClose,
  };
}

/**
 * K线
 * 股票：fqkline（qfq 复权），键名 qfqday / qfqweek / qfqmonth
 * 美股指数：usfqkline，键名 day / week / month
 * 数组顺序：日期, 开, 收, 高, 低, 量
 * @param {import('../symbols.js').Symbol} sym
 * @param {'day'|'week'|'month'} period
 * @param {number} limit
 */
export async function fetchKline(sym, period = 'day', limit = 160) {
  const ep = sym.market === 'US' ? 'usfqkline' : 'fqkline';
  const url = `${APP}/${ep}/get?param=${encodeURIComponent(sym.id)},${period},,,${limit},qfq`;
  const json = await getJSON(url, { timeout: 8000, retries: 1 });

  const node = json?.data?.[sym.id];
  if (!node) throw new Error('K线数据为空');

  const rows = node['qfq' + period] || node[period] || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('K线数据为空');

  const bars = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const open = num(r[1]);
    const close = num(r[2]);
    const high = num(r[3]);
    const low = num(r[4]);
    if (!close) continue;
    bars.push({
      date: String(r[0]),
      open,
      close,
      high,
      low,
      volume: num(r[5]),
    });
  }
  if (!bars.length) throw new Error('K线数据为空');
  return bars;
}
