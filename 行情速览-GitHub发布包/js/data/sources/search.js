/**
 * 搜索建议
 *
 * 东财 searchapi 无 CORS 头也不支持 callback，浏览器里取不到；
 * 改用两家「脚本赋值」型接口（天然绕开跨域）：
 *   主：腾讯 smartbox  → v_hint="sh~588000~科创50ETF华夏~kc50etfhx~ETF^..."
 *   备：新浪 suggest3  → var suggestvalue="名称,11,600519,sh600519,..."
 *
 * 另配一份内置目录，保证断网或远程失败时仍能搜到常见标的。
 */

import { loadScript } from '../http.js';
import { PRESET } from '../symbols.js';

/** 常见标的目录（名称会在拿到真实报价后被权威值覆盖） */
const CATALOG = [
  ...PRESET.map(s => ({ id: s.id, name: s.name, kind: s.kind, market: s.market })),
  { id: 'sh510500', name: '中证500ETF南方', kind: 'etf', market: 'CN' },
  { id: 'sh510330', name: '沪深300ETF华夏', kind: 'etf', market: 'CN' },
  { id: 'sz159919', name: '沪深300ETF嘉实', kind: 'etf', market: 'CN' },
  { id: 'sz159915', name: '创业板ETF易方达', kind: 'etf', market: 'CN' },
  { id: 'sz159949', name: '创业板50ETF华安', kind: 'etf', market: 'CN' },
  { id: 'sh588080', name: '科创50ETF易方达', kind: 'etf', market: 'CN' },
  { id: 'sh588090', name: '科创50ETF工银', kind: 'etf', market: 'CN' },
  { id: 'sh512480', name: '半导体ETF国联安', kind: 'etf', market: 'CN' },
  { id: 'sh512760', name: '芯片ETF国泰', kind: 'etf', market: 'CN' },
  { id: 'sh512880', name: '证券ETF国泰', kind: 'etf', market: 'CN' },
  { id: 'sh512170', name: '医疗ETF华宝', kind: 'etf', market: 'CN' },
  { id: 'sh512690', name: '酒ETF鹏华', kind: 'etf', market: 'CN' },
  { id: 'sh515790', name: '光伏ETF华泰柏瑞', kind: 'etf', market: 'CN' },
  { id: 'sh515030', name: '新能源车ETF华夏', kind: 'etf', market: 'CN' },
  { id: 'sh512660', name: '军工ETF国泰', kind: 'etf', market: 'CN' },
  { id: 'sh518880', name: '黄金ETF华安', kind: 'etf', market: 'CN' },
  { id: 'sh510880', name: '红利ETF华泰柏瑞', kind: 'etf', market: 'CN' },
  { id: 'sh510180', name: '上证180ETF华安', kind: 'etf', market: 'CN' },
  { id: 'sh513100', name: '纳指ETF国泰', kind: 'etf', market: 'CN' },
  { id: 'sh513050', name: '中概互联网ETF易方达', kind: 'etf', market: 'CN' },
  { id: 'sz159920', name: '恒生ETF华夏', kind: 'etf', market: 'CN' },
  { id: 'sh600519', name: '贵州茅台', kind: 'stock', market: 'CN' },
  { id: 'sz000858', name: '五粮液', kind: 'stock', market: 'CN' },
  { id: 'sz300750', name: '宁德时代', kind: 'stock', market: 'CN' },
  { id: 'sz002594', name: '比亚迪', kind: 'stock', market: 'CN' },
  { id: 'sh601318', name: '中国平安', kind: 'stock', market: 'CN' },
  { id: 'sh600036', name: '招商银行', kind: 'stock', market: 'CN' },
  { id: 'sh601899', name: '紫金矿业', kind: 'stock', market: 'CN' },
  { id: 'sz000001', name: '平安银行', kind: 'stock', market: 'CN' },
];

/** 类型 → kind */
function kindOf(typeText, market) {
  const t = String(typeText || '').toUpperCase();
  if (t.startsWith('ZS')) return 'index';
  if (t.includes('ETF') || t.includes('LOF')) return 'etf';
  if (t.startsWith('GP-A')) return 'stock';
  if (t.startsWith('GP')) return market === 'HK' ? 'stock' : 'stock';
  if (t === 'WH' || t === 'QH') return 'futures';
  return 'stock';
}

/** smartbox 结果解析 */
function parseSmartbox(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const seg of raw.split('^')) {
    const f = seg.split('~');
    if (f.length < 4) continue;
    const mkt = f[0];
    const code = f[1];
    const name = f[2];
    const type = f[4] || '';
    if (!mkt || !code) continue;

    let id = '';
    let market = 'CN';
    let kind = kindOf(type, mkt);

    if (mkt === 'sh' || mkt === 'sz') {
      id = mkt + code;
      market = 'CN';
    } else if (mkt === 'hk') {
      id = 'hk' + code;
      market = 'HK';
    } else if (mkt === 'us') {
      // 只收指数；美股个股不在本期范围（腾讯美股个股 code 形如 ndaq.oq，映射复杂）
      if (kind !== 'index') continue;
      id = 'us' + String(code).toUpperCase();
      market = 'US';
    } else if (mkt === 'hf' || mkt === 'qh') {
      id = 'hf_' + String(code).toUpperCase();
      market = 'CME';
      kind = 'futures';
    } else {
      continue;
    }

    // 只保留可交易且有行情支持的类别
    if (!['index', 'stock', 'etf', 'futures'].includes(kind)) continue;
    if (market === 'CN' && kind === 'stock' && !/^\d{6}$/.test(code)) continue;

    out.push({
      id,
      name: String(name || code),
      kind,
      market,
      digits: kind === 'etf' || market === 'HK' ? 3 : 2,
      flow: kind === 'etf' && market === 'CN',
    });
  }
  return out;
}

/** 新浪 suggest 结果解析（类型代码：11=A股 31=港股 41=美股 ...） */
function parseSinaSuggest(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const seg of raw.split(';')) {
    const f = seg.split(',');
    if (f.length < 5) continue;
    const codeWithMkt = f[3] || '';
    if (!/^(sh|sz|hk|gb_)/.test(codeWithMkt)) continue;
    const m = /^(sh|sz|hk)(\d{5,6})$/.exec(codeWithMkt);
    if (!m) continue;
    const market = m[1] === 'hk' ? 'HK' : 'CN';
    const id = m[1] + m[2];
    const kind = market === 'CN' && /^[15]/.test(m[2]) ? 'etf' : 'stock';
    out.push({
      id,
      name: String(f[4] || f[0] || m[2]).trim(),
      kind,
      market,
      digits: kind === 'etf' ? 3 : market === 'HK' ? 3 : 2,
      flow: kind === 'etf' && market === 'CN',
    });
  }
  // 去重
  const seen = new Set();
  return out.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** 本地目录匹配 */
function localMatch(keyword) {
  const k = keyword.trim().toLowerCase();
  if (!k) return [];
  const scored = [];
  for (const item of CATALOG) {
    const name = item.name.toLowerCase();
    const code = item.id.replace(/^[a-z_]+/, '');
    let score = -1;
    if (code === k) score = 100;
    else if (name === k) score = 95;
    else if (code.startsWith(k)) score = 80;
    else if (name.startsWith(k)) score = 70;
    else if (name.includes(k)) score = 50;
    else if (code.includes(k)) score = 40;
    if (score > 0) scored.push({ ...item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(({ score, ...rest }) => rest);
}

/** 远程：腾讯 smartbox */
async function remoteSmartbox(keyword) {
  const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(keyword)}&t=all&c=1&_=${Date.now()}`;
  await loadScript(url, 6000);
  const raw = window.v_hint;
  try { delete window.v_hint; } catch { window.v_hint = undefined; }
  return parseSmartbox(raw);
}

/** 远程：新浪 suggest（备用，MIME 更规范） */
async function remoteSina(keyword) {
  const url = `https://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(keyword)}&_=${Date.now()}`;
  await loadScript(url, 6000);
  const raw = window.suggestvalue;
  try { delete window.suggestvalue; } catch { window.suggestvalue = undefined; }
  return parseSinaSuggest(raw);
}

/**
 * 搜索
 * @param {string} keyword
 * @returns {Promise<Array<{id:string,name:string,kind:string,market:string,digits:number,flow:boolean}>>}
 */
export async function suggest(keyword) {
  const k = (keyword || '').trim();
  if (!k) return [];

  const local = localMatch(k);

  let remote = [];
  try {
    remote = await remoteSmartbox(k);
  } catch {
    try {
      remote = await remoteSina(k);
    } catch {
      remote = [];
    }
  }

  // 用户直接输入 6 位代码时，本地合成一条（即便远程无结果也能添加）
  const extras = [];
  if (/^\d{6}$/.test(k)) {
    const guess = k.startsWith('6') || k.startsWith('5') || k.startsWith('9') ? 'sh' + k
      : k.startsWith('0') || k.startsWith('3') || k.startsWith('1') ? 'sz' + k : '';
    if (guess && !remote.some(x => x.id === guess) && !local.some(x => x.id === guess)) {
      extras.push({
        id: guess,
        name: k,
        kind: /^[15]/.test(k) ? 'etf' : 'stock',
        market: 'CN',
        digits: /^[15]/.test(k) ? 3 : 2,
        flow: /^[15]/.test(k),
      });
    }
  }

  // 本地命中优先，远程补充，按 id 去重
  const seen = new Set();
  const merged = [];
  for (const item of [...local, ...remote, ...extras]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
    if (merged.length >= 20) break;
  }
  return merged;
}

/** 供外部校正名称（拿到真实报价后调用） */
export function patchCatalogName(id, name) {
  const hit = CATALOG.find(x => x.id === id);
  if (hit && name) hit.name = name;
}

export { CATALOG };
