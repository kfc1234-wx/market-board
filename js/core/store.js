/**
 * 自选与偏好持久化
 *
 * 存储结构：
 * { v:1, items:[{id,name,kind,market,digits,flow,at}], prefs:{theme,sort,lastTab} }
 *
 * 容错：
 *  - 版本不符 → 备份原数据到 stk.watch.v0.bak 后重置
 *  - setItem 抛错（Safari 隐私模式）→ 降级为内存态，UI 提示
 */

import { DEFAULT_WATCH, INDEX_POOL, getSymbol, registerSymbols } from '../data/symbols.js';

const KEY = 'stk.watch.v1';
const BAK = 'stk.watch.v0.bak';
const VERSION = 1;
const MAX_ITEMS = 50;

/** 指数页默认展示的 9 个品种（原 6 个 + 日经 / KOSPI / 离岸人民币） */
const DEFAULT_INDEXES = [
  'usNDX', 'usINX', 'sh000001', 'hf_GC', 'usDJI', 'hkHSTECH',
  'em_N225', 'em_KS11', 'fx_susdcnh',
];

/** 候选池里允许出现在指数页的 id（顺序即抽屉里的顺序） */
const POOL_IDS = INDEX_POOL.map(s => s.id);
const POOL_SET = new Set(POOL_IDS);

const DEFAULT_PREFS = {
  theme: 'dark',      // dark | auto | light —— 行情类 App 默认深色，可切跟随系统或浅色
  sort: 'pctDesc',    // pctDesc | chgDesc | flowDesc | nameAsc
  lastTab: 'board',
};

let state = null;
let persistable = true;
const listeners = new Set();

function blank() {
  return {
    v: VERSION,
    indexIds: DEFAULT_INDEXES.slice(),
    items: DEFAULT_WATCH.map((id, i) => {
      const s = getSymbol(id);
      return { id, name: s.name, kind: s.kind, market: s.market, digits: s.digits, flow: !!s.flow, at: i };
    }),
    nteam: [],            // 「国家队」独立自选清单，默认空，用户自行增删
    prefs: { ...DEFAULT_PREFS },
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const s = getSymbol(raw.id);
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : s.name,
    kind: s.kind,
    market: s.market,
    digits: Number.isFinite(raw.digits) ? raw.digits : s.digits,
    flow: !!(raw.flow ?? s.flow),
    at: Number.isFinite(raw.at) ? raw.at : 0,
  };
}

/** 启动时调用一次 */
export function initStore() {
  if (state) return state;

  let parsed = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (parsed && parsed.v !== VERSION) {
    // 旧版本：备份后重置
    try { localStorage.setItem(BAK, JSON.stringify(parsed)); } catch { /* 忽略 */ }
    parsed = null;
  }

  if (parsed && Array.isArray(parsed.items)) {
    const items = parsed.items.map(normalizeItem).filter(Boolean);
    const seen = new Set();
    const nteam = Array.isArray(parsed.nteam)
      ? parsed.nteam.map(normalizeItem).filter(Boolean)
      : [];
    const nteamSeen = new Set();
    state = {
      v: VERSION,
      indexIds: sanitizeIndexIds(parsed.indexIds),
      items: items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true))).slice(0, MAX_ITEMS),
      nteam: nteam.filter(it => (nteamSeen.has(it.id) ? false : (nteamSeen.add(it.id), true))).slice(0, MAX_ITEMS),
      prefs: { ...DEFAULT_PREFS, ...(parsed.prefs || {}) },
    };
    if (!state.items.length) state.items = blank().items;
  } else {
    state = blank();
  }

  registerSymbols(state.items);
  persist();
  return state;
}

/** 过滤掉不再存在的品种；老数据没有这个字段时补默认值 */
function sanitizeIndexIds(raw) {
  if (!Array.isArray(raw)) return DEFAULT_INDEXES.slice();
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !POOL_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  // 全部被删光会让页面空掉，这种情况下退回默认
  return out.length ? out : DEFAULT_INDEXES.slice();
}

function persist() {
  if (!persistable) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    persistable = false;
  }
}

function emit(type) {
  for (const fn of listeners) {
    try { fn(type, state); } catch (e) { console.error(e); }
  }
}

/** 订阅变更 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getItems() {
  return state ? state.items.slice() : [];
}

export function getIds() {
  return state ? state.items.map(it => it.id) : [];
}

export function getItem(id) {
  return state ? state.items.find(it => it.id === id) || null : null;
}

export function hasItem(id) {
  return !!getItem(id);
}

export function getPrefs() {
  return state ? { ...state.prefs } : { ...DEFAULT_PREFS };
}

/**
 * 添加自选
 * @returns {{ok:boolean, reason?:string}}
 */
export function addItem(sym) {
  initStore();
  if (!sym || !sym.id) return { ok: false, reason: '无效标的' };
  if (hasItem(sym.id)) return { ok: false, reason: '已在自选' };
  if (state.items.length >= MAX_ITEMS) return { ok: false, reason: `最多 ${MAX_ITEMS} 个自选` };

  const s = getSymbol(sym.id);
  const item = {
    id: sym.id,
    name: sym.name || s.name,
    kind: sym.kind || s.kind,
    market: sym.market || s.market,
    digits: sym.digits ?? s.digits,
    flow: !!(sym.flow ?? s.flow),
    at: Date.now(),
  };
  state.items.push(item);
  registerSymbols([item]);
  persist();
  emit('add');
  return { ok: true };
}

export function removeItem(id) {
  initStore();
  const i = state.items.findIndex(it => it.id === id);
  if (i < 0) return false;
  state.items.splice(i, 1);
  persist();
  emit('remove');
  return true;
}

/**
 * 取出并移除，返回被删条目以便「撤销」。
 * 排序是按字段实时计算的，所以撤销时直接 addItem 回去即可归位。
 * @returns {{item:object, index:number}|null}
 */
export function takeItem(id) {
  initStore();
  const i = state.items.findIndex(it => it.id === id);
  if (i < 0) return null;
  const [item] = state.items.splice(i, 1);
  persist();
  emit('remove');
  return { item, index: i };
}

/** 指数页当前展示的品种 */
export function getIndexIds() {
  initStore();
  return state.indexIds.slice();
}

/** 指数页候选池（顺序固定） */
export function getIndexPool() {
  return POOL_IDS.slice();
}

export function hasIndex(id) {
  initStore();
  return state.indexIds.includes(id);
}

/**
 * 设置指数页展示项（会按候选池顺序重排，保证每次进来顺序一致）
 * @param {string[]} ids
 */
export function setIndexIds(ids) {
  initStore();
  const next = sanitizeIndexIds(ids);
  state.indexIds = next;
  persist();
  emit('indices');
  return next;
}

/** 勾选 / 取消勾选单个品种；至少保留 1 个 */
export function toggleIndex(id) {
  initStore();
  if (!POOL_SET.has(id)) return state.indexIds.slice();

  const has = state.indexIds.includes(id);
  if (has && state.indexIds.length <= 1) return state.indexIds.slice();

  const set = new Set(state.indexIds);
  if (has) set.delete(id);
  else set.add(id);

  // 按候选池顺序归位，而不是追加到末尾
  return setIndexIds(POOL_IDS.filter(x => set.has(x)));
}

export function setPref(key, value) {
  initStore();
  if (!(key in DEFAULT_PREFS)) return;
  state.prefs[key] = value;
  persist();
  emit('prefs');
}

/** 应用到 <html> 的 data-theme */
export function applyTheme() {
  const theme = getPrefs().theme;
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.setAttribute('data-theme', theme);
  } else {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    root.setAttribute('data-theme', mq.matches ? 'light' : 'dark');
  }
}

/** 是否可持久化（隐私模式下会是 false） */
export function canPersist() {
  return persistable;
}

/* ---------- 「国家队」独立自选清单（与自选完全隔离） ---------- */

export function getNTeam() {
  initStore();
  return state.nteam.slice();
}

export function hasNTeam(id) {
  initStore();
  return state.nteam.some(it => it.id === id);
}

/**
 * 添加到国家队清单
 * @param {object} sym  Symbol 形状
 * @returns {{ok:boolean, reason?:string}}
 */
export function addNTeam(sym) {
  initStore();
  if (!sym || !sym.id) return { ok: false, reason: '无效标的' };
  if (hasNTeam(sym.id)) return { ok: false, reason: '已在国家队' };
  if (state.nteam.length >= MAX_ITEMS) return { ok: false, reason: `最多 ${MAX_ITEMS} 个` };

  const s = getSymbol(sym.id);
  const item = {
    id: sym.id,
    name: sym.name || s.name,
    kind: sym.kind || s.kind,
    market: sym.market || s.market,
    digits: sym.digits ?? s.digits,
    flow: !!(sym.flow ?? s.flow),
    at: Date.now(),
  };
  state.nteam.push(item);
  registerSymbols([item]);
  persist();
  emit('nteam');
  return { ok: true };
}

/** 取出并移除，返回被删条目以便「撤销」 */
export function takeNTeam(id) {
  initStore();
  const i = state.nteam.findIndex(it => it.id === id);
  if (i < 0) return null;
  const [item] = state.nteam.splice(i, 1);
  persist();
  emit('nteam');
  return { item, index: i };
}
