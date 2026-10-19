/**
 * feargreedchart — 日经225 / 韩国KOSPI 兜底源
 *
 * 为什么加这一层：
 *  这两个品种目前只有 CNBC 一个源能稳定取到（东财 push2 在部分网络整体不可达）。
 *  单点一旦失联，两张卡就同时显示「暂无数据」。这里补一个**完全独立**的第二条腿。
 *
 * 为什么选它：
 *  - 公开 JSON，无需 Key / 注册 / Cookie，也不校验 Referer
 *  - 响应头 `Access-Control-Allow-Origin: *`，浏览器可直接 fetch（真实 Chrome 已验证）
 *  - 直连可达，不依赖任何代理
 *  - 上游是日经官方 / 韩国交易所的收盘数据，实测与 CNBC、新浪三方对齐
 *
 * 接口：
 *  GET https://nikkei.feargreedchart.com/api/?action=nikkei
 *  GET https://kospi.feargreedchart.com/api/?action=kospi
 *
 * 注意：它本质是「恐惧贪婪指数」站，指数点位是附带字段：
 *  - 只给 level + change_pct，**没有 open / high / low**
 *  - nikkei 的 change_pct 只有 2 位小数，反算昨收会有 ±0.01% 误差
 *  - kospi 附带 recent_30d（最近 30 个收盘点位），可以拿到**精确昨收**
 *  所以：kospi 走 recent_30d，nikkei 只能反算。兜底场景够用。
 */

import { getJSON } from '../http.js';

const HOSTS = {
  nikkei: 'https://nikkei.feargreedchart.com/api/?action=nikkei',
  kospi: 'https://kospi.feargreedchart.com/api/?action=kospi',
};

/**
 * 日经的 change_pct 只有 2 位小数（-0.62），反算昨收会偏 2~3 点：
 * 实测涨跌额 -404.99 vs 真实 -407.59，肉眼可见地不准。
 *
 * history 接口能给精确点位（65324.2890625），但固定返回 1657 条、约 220KB，
 * 浏览器实测下载 10~15 秒，**绝对不能挡在刷新链路上**。
 * 所以这里走「后台预热」：先用反算值出图，同时静默拉一次写进缓存，
 * 下一轮轮询（5~20 秒后）就自动用上精确值。缓存按交易日期命中，一天只拉一次。
 */
const HIST = 'https://nikkei.feargreedchart.com/api/?action=nikkei-history';
const PREV_KEY = 'stk.fgprev.v1';

let warming = false;

function readPrev(date) {
  try {
    const o = JSON.parse(localStorage.getItem(PREV_KEY) || 'null');
    if (o && o.date === date && Number(o.prev) > 0) return Number(o.prev);
  } catch { /* 无痕模式 / 配额满，忽略 */ }
  return 0;
}

function savePrev(date, prev) {
  try {
    localStorage.setItem(PREV_KEY, JSON.stringify({ date, prev }));
  } catch { /* 同上 */ }
}

/** 后台拉精确昨收；失败静默，不影响已经显示出去的反算值 */
function warmNikkeiPrev(date, price) {
  if (warming) return;
  warming = true;

  getJSON(HIST, { timeout: 30000, retries: 0 })
    .then(json => {
      const h = json?.history;
      if (!Array.isArray(h) || h.length < 2) return;

      const last = h[h.length - 1];
      const prev = h[h.length - 2];
      // 末项是今天且点位对得上 → 昨收取倒数第二；否则末项自己就是昨收
      const sameDay = String(last?.date || '') === date
        && Math.abs(Number(last?.nikkei) - price) < price * 0.0005;
      const out = Number(sameDay ? prev?.nikkei : last?.nikkei);
      if (out > 0 && out !== price) savePrev(date, out);
    })
    .catch(() => { /* 拉不到就继续用反算值 */ })
    .finally(() => { warming = false; });
}

const num = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * 从 recent_30d 里认出昨收。
 * 数组末项通常就是今天；若末项与现价对不上，说明今天还没落进序列，末项即昨收。
 */
function pickPrevClose(arr, price) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const last = num(arr[arr.length - 1]);
  const prev = num(arr[arr.length - 2]);
  // 末项 ≈ 现价 → 末项是今天，昨收在倒数第二
  if (last > 0 && Math.abs(last - price) / price < 0.0005) return prev > 0 ? prev : 0;
  // 否则末项本身是昨收
  return last > 0 ? last : 0;
}

/**
 * 批量取全球指数（兜底）
 * @param {Array<{id:string, fg:string, closeTime?:string}>} items
 *        fg = 'nikkei' | 'kospi'
 * @returns {Promise<Record<string, any>>} 以本地 id 为键
 */
export async function fetchFgGlobal(items) {
  const list = items.filter(it => it.fg && HOSTS[it.fg]);
  if (!list.length) return {};

  // 两个品种在不同 host 上，只能各发一次；任一失败不影响另一个
  const settled = await Promise.allSettled(list.map(async it => {
    const json = await getJSON(HOSTS[it.fg], { timeout: 9000, retries: 0 });
    const box = it.fg === 'nikkei' ? json?.nikkei : json?.kospi;

    const price = num(box?.level);
    if (!(price > 0)) return null;

    const pct = num(box?.change_pct);
    const date = String(box?.level_date || json?.updated || '').slice(0, 10);

    let prevClose = 0;
    if (it.fg === 'kospi') prevClose = pickPrevClose(json?.kospi?.recent_30d, price);
    else if (it.fg === 'nikkei') {
      prevClose = readPrev(date);                     // 命中缓存就是精确值
      if (!(prevClose > 0)) warmNikkeiPrev(date, price); // 没命中就先反算，后台补精确值
    }
    // 拿不到真实昨收才反算，误差上限约 0.01%
    if (!(prevClose > 0) && pct !== 0) {
      prevClose = +(price / (1 + pct / 100)).toFixed(4);
    }

    const change = prevClose ? +(price - prevClose).toFixed(2) : 0;
    if (!prevClose && !pct) {
      // 既没昨收也没涨跌幅，说明这条记录还不完整，交给上层判无效
      return null;
    }

    // 该接口不带时分，用市场收盘钟点补全，让「已收盘 · 10-19」有时间可解析
    const time = date ? `${date} ${it.closeTime || '00:00:00'}` : '';

    return {
      id: it.id,
      valid: true,
      name: '',
      price,
      prevClose,
      open: 0,
      high: 0,
      low: 0,
      change,
      pct,
      volume: 0,
      amount: 0,
      turnover: 0,
      pe: 0,
      floatCap: 0,
      totalCap: 0,
      time,
      digits: 2,
      suspended: false,
      src: 'fg',
    };
  }));

  const out = Object.create(null);
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out[r.value.id] = r.value;
  }
  if (!Object.keys(out).length) throw new Error('feargreedchart 解析为空');
  return out;
}
