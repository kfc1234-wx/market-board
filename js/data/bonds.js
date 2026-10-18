/**
 * 国债收益率（中国 / 美国）
 *
 * 数据源：东方财富「数据中心 - 中美国债收益率」
 *   https://data.eastmoney.com/cjsj/zmgzsyl.html
 *
 * 这是**日频**宏观数据（T+1，随债券市场交易日更新），不是逐笔行情，
 * 所以不并入 quotes.js 的实时轮询体系，单独走一个带 10 分钟缓存的模块。
 *
 * 一个请求同时返回中国与美国的整条关键期限曲线，性价比很高。
 * 接口返回按日期倒序，这里统一转成正序。
 */

const API = 'https://datacenter.eastmoney.com/api/data/get';
// 东财公开页面自带的只读 token，非账号凭证
const TOKEN = '894050c76af8597a853f5b408b759f5d';
const TTL = 10 * 60 * 1000;

/** 接口列名 → 内部字段名（列名是东财的指标编号，语义只能靠官方页面确认） */
const COLS = {
  cn2: 'EMM00588704',
  cn5: 'EMM00166462',
  cn10: 'EMM00166466',
  cn30: 'EMM00166469',
  cnSpread: 'EMM01276014',
  us2: 'EMG00001306',
  us5: 'EMG00001308',
  us10: 'EMG00001310',
  us30: 'EMG00001312',
  usSpread: 'EMG01339436',
};

/** 四档关键期限，顺序即收益率曲线的横轴顺序 */
export const TENORS = [
  { key: '2', label: '2年', cn: 'cn2', us: 'us2' },
  { key: '5', label: '5年', cn: 'cn5', us: 'us5' },
  { key: '10', label: '10年', cn: 'cn10', us: 'us10' },
  { key: '30', label: '30年', cn: 'cn30', us: 'us30' },
];

let cache = { at: 0, data: null };
let inflight = null;

function toNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pickRow(row) {
  const out = {};
  for (const [k, col] of Object.entries(COLS)) out[k] = toNum(row[col]);
  return out;
}

/**
 * 取中美国债收益率
 * @param {{force?: boolean, days?: number}} [opt]
 * @returns {Promise<{
 *   date: string, prevDate: string,
 *   latest: Record<string, number|null>, prev: Record<string, number|null>,
 *   history: Array<{date: string} & Record<string, any>>,
 *   fetchedAt: number
 * }>}
 */
export async function getYields(opt = {}) {
  const { force = false, days = 130 } = opt;
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL) return cache.data;
  if (inflight) return inflight;

  const ps = Math.max(30, Math.min(500, days));
  const url = `${API}?type=RPTA_WEB_TREASURYYIELD&sty=ALL&st=SOLAR_DATE&sr=-1&token=${TOKEN}`
    + `&p=1&ps=${ps}&pageNo=1&pageNum=1`;

  inflight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const rows = json && json.result && json.result.data;
      if (!Array.isArray(rows) || !rows.length) throw new Error('接口无数据');

      const parsed = [];
      for (const r of rows) {
        const date = String(r.SOLAR_DATE || '').slice(0, 10);
        if (!date) continue;
        parsed.push({ date, ...pickRow(r) });
      }
      // 接口是倒序（最新在前），内部统一正序，画图和取前值都方便
      parsed.reverse();

      // 中美假期不同，某一天可能只有一边有数；至少要有一个 10 年期才保留
      const history = parsed.filter(r => r.cn10 > 0 || r.us10 > 0);
      if (!history.length) throw new Error('收益率全为空');

      const latest = history[history.length - 1];

      // 各期限独立向前找最近一个有效值：不能直接取 history[n-2]，
      // 因为那一行对应的该期限可能是 null（另一国休市）
      const prev = {};
      for (const key of Object.keys(COLS)) {
        let v = null;
        for (let i = history.length - 2; i >= 0; i--) {
          if (history[i][key] > 0) { v = history[i][key]; break; }
        }
        prev[key] = v;
      }

      // 上一期日期：找一行「两国 10 年期至少有一个有效」的最近日期
      let prevDate = '';
      for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].cn10 > 0 || history[i].us10 > 0) { prevDate = history[i].date; break; }
      }

      const data = { date: latest.date, prevDate, latest, prev, history, fetchedAt: Date.now() };
      cache = { at: Date.now(), data };
      return data;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}

/** 清缓存（下拉刷新用） */
export function invalidateYields() {
  cache = { at: 0, data: null };
}

/** 同步快照：切回页面时先渲染旧数据，避免闪 '--' */
export function peekYields() {
  return cache.data;
}

/**
 * 基点差：1bp = 0.01 个百分点
 * @returns {number|null}
 */
export function bp(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return (cur - prev) * 100;
}
