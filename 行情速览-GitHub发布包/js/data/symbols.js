/**
 * 统一标的模型
 *
 * 主键直接复用腾讯行情 code（sh600519 / hk00700 / usNDX / hf_GC）：
 * 可读、唯一、本身就是主数据源的请求参数，省掉一层映射表。
 *
 * @typedef {Object} Symbol
 * @property {string} id      主键，如 sh600519
 * @property {string} name    显示名
 * @property {'CN'|'HK'|'US'|'CME'} market 市场
 * @property {'index'|'stock'|'etf'|'futures'} kind 类型
 * @property {number} [digits] 价格小数位（行情解析时会用原始串推断）
 * @property {boolean} [flow] 是否需要拉取资金流
 * @property {string} [em]    东财 secid（仅搜索/交叉校验用，非必需）
 * @property {'global'|'sinafx'} [src] 数据源标签。缺省=腾讯；global=日/韩指数与美元指数（CNBC 主/东财备）；sinafx=新浪外汇
 * @property {string} [cnbc]  CNBC symbol（src==='global' 时用，如 .N225）
 * @property {string} [secid] 东财 secid（src==='global' 时的备源）
 * @property {string} [fg]    feargreedchart 品种名（nikkei / kospi）
 * @property {number} [divide] src==='sinafx' 时的除法系数（人民币账户黄金按金衡盎司折算）
 * @property {boolean} [timeFromLast] src==='global' 时取 CNBC 的时分秒，而不是固定收盘钟点
 */

/** 内置预设：开箱即用的 7 个指数 + 4 只重点 ETF */
export const PRESET = [
  { id: 'sh000001', em: '1.000001',   name: '上证指数',        market: 'CN',  kind: 'index',   digits: 2 },
  { id: 'usNDX',    em: '100.NDX100', name: '纳斯达克100',     market: 'US',  kind: 'index',   digits: 2 },
  { id: 'usINX',    em: '100.SPX',    name: '标普500',         market: 'US',  kind: 'index',   digits: 2 },
  { id: 'usDJI',    em: '100.DJIA',   name: '道琼斯',          market: 'US',  kind: 'index',   digits: 2 },
  { id: 'hkHSTECH', em: '124.HSTECH', name: '恒生科技指数',    market: 'HK',  kind: 'index',   digits: 2 },
  { id: 'hkHSI',    em: '124.HSI',    name: '恒生指数',        market: 'HK',  kind: 'index',   digits: 2 },

  // 黄金看「现货 + 人民币」两个口径：
  //  现货黄金 = 伦敦金 XAU/USD，腾讯直接有报价（hf_XAU），分时/日K 走新浪 XAU
  //  人民币账户黄金 = 银行账户金（元/克）。没有开放接口，用新浪 fx_sxaucny
  //  （黄金盎司兑人民币，约 27700 元/盎司）除以金衡盎司 31.1034768 折算，
  //  与手机银行报价相差一个点差（约 0.5~1 元/克）。
  { id: 'hf_XAU',    name: '现货黄金',       market: 'PM', kind: 'commodity', digits: 2 },
  { id: 'fx_cnygold', name: '人民币账户黄金', market: 'PM', kind: 'commodity', digits: 2,
    src: 'sinafx', sina: 'fx_sxaucny', divide: 31.1034768 },

  // 美元指数：腾讯没有这个 code，走 CNBC（.DXY）主源 + 东财 100.UDI 备源
  { id: 'usDXY',     name: '美元指数',       market: 'FX', kind: 'index', digits: 2,
    src: 'global', cnbc: '.DXY', secid: '100.UDI', timeFromLast: true },

  // 布伦特原油：ICE 连续合约，腾讯 hf_OIL 有报价，分时/日K 走新浪 OIL
  { id: 'hf_OIL',    name: '布伦特原油',     market: 'CME', kind: 'futures', digits: 2 },

  // 美股指数期货：现货指数收盘后不再产生新点位，期货几乎 24 小时交易，
  // 夜里想盯盘只能看这两个。NQ 腾讯没有报价，走新浪期货分时兜底。
  { id: 'hf_NQ',    em: '101.NQ00Y',  name: '纳指100期货',     market: 'CME', kind: 'futures', digits: 2 },
  { id: 'hf_ES',    em: '101.ES00Y',  name: '标普500期货',     market: 'CME', kind: 'futures', digits: 2 },

  { id: 'sh510300', name: '沪深300ETF华泰柏瑞', market: 'CN', kind: 'etf', digits: 3, flow: true },
  { id: 'sh510050', name: '上证50ETF华夏',      market: 'CN', kind: 'etf', digits: 3, flow: true },
  { id: 'sh588000', name: '科创50ETF华夏',      market: 'CN', kind: 'etf', digits: 3, flow: true },
  { id: 'sh510310', name: '沪深300ETF易方达',   market: 'CN', kind: 'etf', digits: 3, flow: true },

  // 日韩指数与离岸人民币：腾讯没有这几个 code，走独立的适配器
  // 主源 CNBC（CORS 友好、国内可达），东财 secid 留作备源
  { id: 'em_N225',    name: '日经225',      market: 'JP', kind: 'index', digits: 2, src: 'global', cnbc: '.N225', secid: '100.N225', fg: 'nikkei', closeTime: '15:00:00' },
  { id: 'em_KS11',    name: '韩国KOSPI',    market: 'KR', kind: 'index', digits: 2, src: 'global', cnbc: '.KS11', secid: '100.KS11', fg: 'kospi',  closeTime: '15:30:00' },
  { id: 'fx_susdcnh', name: '离岸人民币',   market: 'FX', kind: 'forex', digits: 4, src: 'sinafx' },
];

/**
 * 默认自选（首次启动写入）
 * 日韩指数与离岸人民币是指数页专供，不默认塞进自选看板；
 * 美元指数 / 人民币账户黄金虽然也走独立源，但属于日常要盯的，照常进自选。
 */
const POOL_ONLY = new Set(['em_N225', 'em_KS11', 'fx_susdcnh']);
export const DEFAULT_WATCH = PRESET.filter(s => !POOL_ONLY.has(s.id)).map(s => s.id);

/** 指数页候选池（含数据源） */
export const INDEX_POOL = PRESET.filter(s =>
  s.kind === 'index' || s.kind === 'futures' || s.kind === 'forex' || s.kind === 'commodity');

/** 东财 secid → 腾讯 code（美股指数两边编码完全不同，必须显式映射） */
const EM2TX = {
  '100.NDX100': 'usNDX',  '100.SPX': 'usINX',   '100.DJIA': 'usDJI',
  '100.IXIC':   'usIXIC',
  '124.HSTECH': 'hkHSTECH', '124.HSI': 'hkHSI',
  '101.GC00Y':  'hf_GC',
  '101.NQ00Y':  'hf_NQ',   '101.ES00Y':  'hf_ES',
  '100.UDI':    'usDXY',                     // 美元指数
  '122.XAU':    'hf_XAU',                    // 现货黄金（黄金/美元）
  '112.B00Y':   'hf_OIL',                    // 布伦特原油当月连续
};

/** 内置标的索引 */
const BUILTIN = new Map(PRESET.map(s => [s.id, s]));

/** 用户搜索添加过的标的（运行时缓存，持久化在 store 里） */
const runtime = new Map();

/**
 * 从东财搜索建议条目映射为 Symbol。
 * 放行：A股、港股、指数、外盘期货、以及「场内 ETF」（Fund 且 QuoteID 以 1./0. 开头）。
 * 过滤：场外基金、美股个股、板块。
 * @param {any} item
 * @returns {Symbol|null}
 */
export function fromSearch(item) {
  if (!item || !item.QuoteID || !item.Classify) return null;
  const quoteId = String(item.QuoteID);
  const [mkt, codeRaw] = quoteId.split('.');
  const code = codeRaw || '';
  const classify = item.Classify;

  // --- A 股 ---
  if (classify === 'AStock') {
    if (mkt !== '1' && mkt !== '0') return null;
    return make((mkt === '1' ? 'sh' : 'sz') + code, item.Name, 'CN', 'stock', 2);
  }

  // --- 港股 ---
  if (classify === 'HK') {
    if (mkt !== '116' && mkt !== '124') return null;
    const id = 'hk' + code;
    return make(id, item.Name, 'HK', 'stock', 3);
  }

  // --- 指数（含 A 股指数、港股指数、美股指数）---
  if (classify === 'UniversalIndex') {
    if (mkt === '1') return make('sh' + code, item.Name, 'CN', 'index', 2);
    if (mkt === '0') return make('sz' + code, item.Name, 'CN', 'index', 2);
    if (mkt === '124') {
      const id = EM2TX[quoteId] || ('hk' + code);
      return make(id, item.Name, 'HK', 'index', 2);
    }
    if (mkt === '100') {
      const id = EM2TX[quoteId];
      return id ? make(id, item.Name, 'US', 'index', 2) : null; // 未收录的美股指数跳过
    }
    return null;
  }

  // --- 外盘期货（GC00Y → hf_GC）---
  if (classify === 'UniversalFutures') {
    const mapped = EM2TX[quoteId];
    if (mapped) return builtinOr(mapped, item.Name, 'CME', 'futures', 2);
    if (mkt !== '101') return null;
    const id = 'hf_' + code.replace(/00Y$/, '');
    return make(id, item.Name, 'CME', 'futures', 2);
  }

  // --- 全球指数（美元指数 UDI → usDXY，走 CNBC/东财）---
  if (classify === 'QQZS') {
    const mapped = EM2TX[quoteId];
    return mapped ? builtinOr(mapped, item.Name, 'FX', 'index', 2) : null;
  }

  // --- 现货贵金属（122.XAU → hf_XAU）---
  if (classify === 'FORPM') {
    const mapped = EM2TX[quoteId];
    return mapped ? builtinOr(mapped, item.Name, 'PM', 'commodity', 2) : null;
  }

  // --- 基金：只放行场内 ETF / LOF（QuoteID 为 1.xxx 或 0.xxx）---
  if (classify === 'Fund') {
    if (mkt !== '1' && mkt !== '0') return null;
    const prefix = mkt === '1' ? 'sh' : 'sz';
    const id = prefix + code;
    const sym = make(id, item.Name, 'CN', 'etf', 3);
    // 场内基金走新浪资金流；个别 LOF 无数据时会自动降级为「暂无数据」
    sym.flow = true;
    return sym;
  }

  return null;
}

function make(id, name, market, kind, digits) {
  return { id, name: String(name || id).trim(), market, kind, digits };
}

/**
 * 命中内置目录就整份复用（保留 src / cnbc / divide 等取数参数），
 * 否则按传入的默认值构造。搜索添加「美元指数 / 现货黄金 / 布伦特原油」
 * 时必须走这条，不然会丢掉数据源标签，卡片变「暂无数据」。
 */
function builtinOr(id, name, market, kind, digits) {
  const hit = BUILTIN.get(id);
  if (hit) return { ...hit };
  return make(id, name, market, kind, digits);
}

/**
 * 推断一个 id 的类型（用于持久化后重建、或直接输入代码）
 * @param {string} id
 * @returns {Symbol}
 */
export function inferSymbol(id) {
  const hit = BUILTIN.get(id) || runtime.get(id);
  if (hit) return hit;

  if (id.startsWith('em_')) {
    const code = id.slice(3);
    return {
      id, name: code, market: 'JP', kind: 'index', digits: 2,
      src: 'global', cnbc: '.' + code, secid: '100.' + code,
    };
  }
  if (id.startsWith('fx_')) {
    return { id, name: '离岸人民币', market: 'FX', kind: 'forex', digits: 4, src: 'sinafx' };
  }
  if (id.startsWith('hf_')) {
    return { id, name: id.slice(3), market: 'CME', kind: 'futures', digits: 2 };
  }
  if (id.startsWith('us')) {
    return { id, name: id.slice(2), market: 'US', kind: 'index', digits: 2 };
  }
  if (id.startsWith('hk')) {
    return { id, name: id.slice(2), market: 'HK', kind: 'stock', digits: 3 };
  }
  if (id.startsWith('sh') || id.startsWith('sz')) {
    const code = id.slice(2);
    const prefix = id.slice(0, 2);
    // 5xxxxx / 15xxxx / 16xxxx / 18xxxx 为场内基金
    const isFund = /^5/.test(code) || /^1[568]/.test(code);
    // sh000001 与 sz000001 同名不同物：只有沪市 000xxx 才是指数
    const isIndex = prefix === 'sh' && (/^000/.test(code) || /^950/.test(code));
    return {
      id,
      name: code,
      market: 'CN',
      kind: isFund ? 'etf' : isIndex ? 'index' : 'stock',
      digits: isFund ? 3 : 2,
      flow: !!isFund,
    };
  }
  return { id, name: id, market: 'CN', kind: 'stock', digits: 2 };
}

/** 注册用户添加的标的，供后续解析复用 */
export function registerSymbols(list) {
  for (const s of list) {
    if (s && s.id) runtime.set(s.id, { ...s });
  }
}

/** 取标的元信息 */
export function getSymbol(id) {
  const hit = BUILTIN.get(id) || runtime.get(id);
  return hit ? { ...hit } : inferSymbol(id);
}

export const isPreset = id => BUILTIN.has(id);

/** 市场中文名 */
export function marketLabel(id) {
  const s = typeof id === 'string' ? getSymbol(id) : id;
  return {
    CN: 'A股', HK: '港股', US: '美股', CME: '期货',
    JP: '日本', KR: '韩国', FX: '外汇', PM: '贵金属',
  }[s.market] || '—';
}

/** 类型徽标文案 */
export function kindLabel(sym) {
  const s = typeof sym === 'string' ? getSymbol(sym) : sym;
  return {
    index: '指数', stock: '股票', etf: 'ETF',
    futures: '期货', forex: '汇率', commodity: '现货',
  }[s.kind] || '';
}

/** 类型徽标 class */
export function kindClass(sym) {
  const s = typeof sym === 'string' ? getSymbol(sym) : sym;
  return s.kind === 'etf' ? 'badge--etf' : s.kind === 'index' ? 'badge--index'
    : s.kind === 'futures' ? 'badge--futures'
      : s.kind === 'commodity' ? 'badge--futures'
        : s.kind === 'forex' ? 'badge--fx' : '';
}

/**
 * 代码展示用：去掉市场前缀（US/HK 指数保留原名）
 */
export function codeText(id) {
  if (id === 'fx_cnygold') return 'CNY/g';
  if (id === 'usDXY') return 'DXY';
  if (id.startsWith('em_')) return 'EM·' + id.slice(3);
  if (id.startsWith('fx_')) return 'CNH';
  if (id.startsWith('hf_')) return id.slice(3);
  if (id.startsWith('us')) return 'US·' + id.slice(2);
  if (id.startsWith('hk')) return id.slice(2);
  return id.slice(2);
}
