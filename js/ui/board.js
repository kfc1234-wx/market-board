/** 自选看板 */

import { h, clear } from '../util/dom.js';
import {
  fmtPrice, fmtPct, fmtChange, fmtSignedBig, fmtVolume, dirClass, pillClass, shortDate,
} from '../util/format.js';
import { getItems, getPrefs, setPref, takeItem, addItem, subscribe } from '../core/store.js';
import { getSymbol, kindLabel, kindClass, codeText } from '../data/symbols.js';
import { getQuotes, peek, invalidate } from '../data/quotes.js';
import { getFlow, peekFlow } from '../data/flows.js';
import { Poller } from '../core/poller.js';
import { tickTo, setText } from './ticker.js';
import { actionSheet, toast, snackbar } from './toast.js';
import { marketState, effectiveState, stateText, parseQuoteTime } from '../market/session.js';

const SORT_LABEL = {
  pctDesc: '涨跌幅',
  chgDesc: '涨跌额',
  flowDesc: '净流入',
  nameAsc: '名称',
};
const SORT_ORDER = ['pctDesc', 'chgDesc', 'flowDesc', 'nameAsc'];

export class Board {
  constructor(opt) {
    this.listEl = opt.listEl;
    this.emptyEl = opt.emptyEl;
    this.statusEl = opt.statusEl;
    this.sortBtn = opt.sortBtn;
    this.sortLabel = opt.sortLabel;
    this.editBtn = opt.editBtn;
    this.onOpen = opt.onOpen;
    this.onAdd = opt.onAdd;
    this.onStatus = opt.onStatus || (() => {});

    this.quotes = new Map();
    this.flows = new Map();
    this.nodes = new Map();   // id -> {row, price, pct, sub}
    this.signature = '';
    this.flowTimer = 0;
    this.flowLoading = false;
    this.active = false;
    this.editing = false;
    this.prevVolume = new Map(); // id -> { vol, at } 上一次累计成交量（突增检测）
    this.volAlertCooldown = new Map(); // id -> 下次可再次提示的时间戳

    this.poller = new Poller({
      getIds: () => getItems().map(it => it.id),
      onData: map => this.applyQuotes(map),
      onState: st => this.handleState(st),
    });

    this.sortBtn?.addEventListener('click', () => this.cycleSort());
    this.editBtn?.addEventListener('click', () => this.toggleEdit());
    this.unsubStore = subscribe(type => {
      if (type === 'add' || type === 'remove' || type === 'prefs') {
        this.rerender();
        if (type === 'add' || type === 'remove') this.loadFlows(true);
      }
    });
  }

  start() {
    this.active = true;
    this.rerender();
    this.poller.start();
    this.loadFlows(true);
    this.scheduleFlowRefresh();
  }

  stop() {
    this.active = false;
    this.poller.stop();
    clearTimeout(this.flowTimer);
    // 离开看板时退出编辑态，回来是干净的浏览状态
    if (this.editing) this.toggleEdit(false);
  }

  /** 立即刷新（下拉刷新） */
  refreshNow() {
    invalidate();
    this.flows.clear();
    this.nodes.forEach(n => { n.flowLoaded = false; });
    this.rerender();
    return Promise.all([
      this.poller.refreshNow(),
      this.loadFlows(true),
    ]);
  }

  cycleSort() {
    const cur = getPrefs().sort;
    const i = SORT_ORDER.indexOf(cur);
    const next = SORT_ORDER[(i + 1) % SORT_ORDER.length];
    setPref('sort', next);
    if (this.sortLabel) this.sortLabel.textContent = SORT_LABEL[next] || '排序';
    this.rerender();
  }

  /** 切换到编辑态：每行左侧露出删除按钮 */
  toggleEdit(force) {
    this.editing = typeof force === 'boolean' ? force : !this.editing;
    this.listEl?.classList.toggle('is-editing', this.editing);
    if (this.editBtn) {
      this.editBtn.textContent = this.editing ? '完成' : '编辑';
      this.editBtn.classList.toggle('is-active', this.editing);
    }
  }

  /** 删除 + 撤销条 */
  deleteItem(item) {
    const taken = takeItem(item.id);
    if (!taken) return;

    const name = item.name || getSymbol(item.id).name;
    snackbar({
      text: `已删除「${name}」`,
      actionLabel: '撤销',
      onAction: () => {
        const res = addItem(taken.item);
        if (!res.ok) toast(res.reason || '撤销失败');
      },
    });
  }

  handleState(st) {
    if (st === 'offline') this.setStatus('离线', 2);
    else if (st === 'stale') this.setStatus('数据延迟', 2);
    else this.setStatus(this.liveText(), 1);
  }

  liveText() {
    const items = getItems();
    if (!items.length) return '空闲';
    const markets = [...new Set(items.map(it => it.market))];
    const open = markets.some(m => {
      const st = marketState(m);
      return st === 'open' || st === 'pre' || st === 'post';
    });
    if (!open) {
      const anyQuote = [...this.quotes.values()].find(q => q.time);
      const t = anyQuote ? parseQuoteTime(anyQuote.time) : null;
      if (!t) return '已收盘';
      const mm = String(t.mo).padStart(2, '0');
      const dd = String(t.d).padStart(2, '0');
      return `已收盘 · ${mm}-${dd}`;
    }
    return '盘中';
  }

  setStatus(text, live) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.dataset.live = String(live);
  }

  /** 按当前排序返回条目 */
  sortedItems() {
    const items = getItems();
    const sort = getPrefs().sort;

    const pctOf = id => this.quotes.get(id)?.pct ?? -Infinity;
    const chgOf = id => this.quotes.get(id)?.change ?? -Infinity;
    const flowOf = id => {
      const f = this.flows.get(id);
      if (!f || !f.stats?.today) return -Infinity;
      return f.stats.today.net;
    };

    const list = items.slice();
    if (sort === 'pctDesc') list.sort((a, b) => pctOf(b.id) - pctOf(a.id));
    else if (sort === 'chgDesc') list.sort((a, b) => chgOf(b.id) - chgOf(a.id));
    else if (sort === 'flowDesc') {
      list.sort((a, b) => {
        const av = flowOf(a.id);
        const bv = flowOf(b.id);
        if (av === -Infinity && bv === -Infinity) return 0;
        return bv - av;
      });
    } else if (sort === 'nameAsc') {
      list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    }
    return list;
  }

  rerender() {
    const items = this.sortedItems();
    const sig = items.map(it => it.id).join('|') + '#' + getPrefs().sort;

    const empty = !items.length;
    if (this.emptyEl) this.emptyEl.hidden = !empty;
    if (this.listEl) this.listEl.hidden = empty;

    if (sig === this.signature) {
      this.paint();
      return;
    }
    this.signature = sig;
    this.build(items);
    this.paint();
  }

  build(items) {
    if (!this.listEl) return;
    clear(this.listEl);
    this.nodes.clear();

    for (const item of items) {
      const sym = getSymbol(item.id);
      const row = h('div.row', {
        dataset: { id: item.id },
        class: item.kind === 'etf' ? 'row--etf' : '',
      });

      // 删除按钮常驻 DOM，靠 is-editing 控制显隐，切换编辑态零重建
      const del = h('button.row__del', {
        type: 'button',
        'aria-label': '从自选删除',
        html: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
          + '<path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        onpointerdown: e => e.stopPropagation(),
        onclick: e => { e.stopPropagation(); this.deleteItem(item); },
      });
      row.appendChild(del);

      const head = h('div.row__head', {}, [
        h('span.row__name', { text: item.name || sym.name }),
        h(`span.badge.${kindClass(sym).trim()}`, { text: kindLabel(sym) }),
        this.badgeStale(),
      ]);

      const sub = h('div.row__sub');
      const main = h('div.row__main', {}, [head, sub]);

      const price = h('div.row__price', { text: '--' });
      const pct = h('span.pill.pill--flat', { text: '--' });
      const right = h('div.row__right', {}, [price, pct]);

      row.appendChild(main);
      row.appendChild(right);

      this.bindRow(row, item);
      this.listEl.appendChild(row);
      this.nodes.set(item.id, { row, price, pct, sub, head });
    }

    // 底部添加入口：从看板直达搜索页，不必先点底部「搜索」
    if (this.onAdd) {
      this.listEl.appendChild(h('button.row-add', {
        type: 'button',
        html: '<span class="row-add__ico">'
          + '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">'
          + '<ellipse cx="12" cy="16.4" rx="5.2" ry="4.3" fill="currentColor"/>'
          + '<ellipse cx="5.9" cy="11.1" rx="2.1" ry="2.5" fill="currentColor"/>'
          + '<ellipse cx="10.1" cy="7.2" rx="2.1" ry="2.6" fill="currentColor"/>'
          + '<ellipse cx="13.9" cy="7.2" rx="2.1" ry="2.6" fill="currentColor"/>'
          + '<ellipse cx="18.1" cy="11.1" rx="2.1" ry="2.5" fill="currentColor"/></svg>'
          + '</span><span>添加自选</span>',
        onclick: () => this.onAdd(),
      }));

      this.listEl.appendChild(h('p.board__foot', {
        text: '长按任意一行可快速删除 · 点「编辑」批量移除 · 数据仅为公开行情快照',
      }));
    }
  }

  badgeStale() {
    const el = h('span.badge.badge--stale', { text: '延迟' });
    el.hidden = true;
    return el;
  }

  bindRow(row, item) {
    let timer = 0;
    let longPressed = false;
    let startX = 0;
    let startY = 0;
    let moved = false;

    const clearTimer = () => { clearTimeout(timer); timer = 0; };

    row.addEventListener('pointerdown', e => {
      longPressed = false;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      clearTimer();
      if (this.editing) return;
      timer = setTimeout(async () => {
        longPressed = true;
        const act = await actionSheet({
          title: item.name,
          actions: [
            { label: '查看详情', value: 'open' },
            { label: '从自选中删除', value: 'remove', danger: true },
          ],
        });
        if (act === 'open') this.onOpen?.(item.id);
        else if (act === 'remove') this.deleteItem(item);
      }, 550);
    });

    row.addEventListener('pointermove', e => {
      if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
        moved = true;
        clearTimer();
      }
    });

    row.addEventListener('pointerup', () => {
      clearTimer();
      if (this.editing) return;
      if (!longPressed && !moved) this.onOpen?.(item.id);
    });

    row.addEventListener('pointercancel', clearTimer);
    row.addEventListener('pointerleave', clearTimer);
  }

  applyQuotes(map) {
    for (const [id, q] of map) this.quotes.set(id, q);
    this.detectVolumeSurge(map);
    // 必须走 rerender 而不是 paint：涨跌幅排序依赖最新报价，
    // 只 paint 的话新加入的标的会一直停在末尾（首帧无报价 → -Infinity）。
    // rerender 内部用签名比对，顺序没变时等价于 paint，不会重建 DOM。
    this.rerender();
    this.setStatus(this.liveText(), 1);
  }

  /**
   * 成交量突增检测
   *
   * 累计成交量每轮都在涨，所以不能用「相对增幅」做阈值——基数越大越容易漏报，
   * 反而刚开盘基数小时稍有波动就误报。改用「区间内绝对增量」+「相对增幅」双门槛：
   *  - 绝对增量 ≥ 阈值：量真的放大了一大截（单位视品种而定）
   *  - 相对增幅 ≥ 30%：排除那种本来就天量成交、自然爬升的情况
   * 任一不满足都不报。同一标的冷却 60s，避免一个放量行情连续刷屏。
   */
  detectVolumeSurge(map) {
    const now = Date.now();
    for (const [id, q] of map) {
      if (!q || !q.valid || !q.volume) continue;
      const sym = getSymbol(id);
      // 只有这些品种的 volume 是有意义的累计成交量（手/股）；期货、外汇为 0 或非累计
      if (!sym || (sym.kind !== 'stock' && sym.kind !== 'etf' && sym.kind !== 'index')) continue;

      const prev = this.prevVolume.get(id);
      // 首次见到：只记录基准，不报（无法判断「突然」）
      if (!prev) {
        this.prevVolume.set(id, { vol: q.volume, at: now });
        continue;
      }

      const delta = q.volume - prev.vol;
      // 间隔太短（<3s，通常是同一轮重复/下拉刷新刚起步）不报，避免噪音
      const elapsed = now - prev.at;
      this.prevVolume.set(id, { vol: q.volume, at: now });
      if (delta <= 0 || elapsed < 3000) continue;

      const rel = prev.vol > 0 ? delta / prev.vol : 0;
      // 绝对增量阈值：A股/ETF 按手，美股指数按股（量级不同）
      const absFloor = sym.market === 'US' ? 5_000_000 : 50_000;
      if (delta < absFloor || rel < 0.3) continue;

      const cooldown = this.volAlertCooldown.get(id) || 0;
      if (now < cooldown) continue;
      this.volAlertCooldown.set(id, now + 60_000);

      const name = q.name || sym.name;
      toast(`「${name}」成交量骤增：${fmtVolume(delta)}（+${Math.round(rel * 100)}%）`, 2600);
      this.highlight(id);
    }
  }

  /** 更新所有行的数值 */
  paint() {
    for (const [id, node] of this.nodes) {
      const item = getSymbol(id);
      const q = this.quotes.get(id);
      const flow = this.flows.get(id);

      if (!q || !q.valid) {
        setText(node.price, '--');
        setText(node.pct, '--');
        node.pct.className = 'pill pill--flat';
        this.renderSub(node.sub, item, null, flow);
        continue;
      }

      const maxDigits = item.kind === 'index' ? 2 : 4;
      const digits = Math.min(q.digits ?? item.digits ?? 2, maxDigits);
      tickTo(node.price, q.price, v => fmtPrice(v, digits));
      tickTo(node.pct, q.pct, v => fmtPct(v));
      node.price.className = 'row__price ' + dirClass(q.pct);
      node.pct.className = 'pill ' + pillClass(q.pct);
      this.renderSub(node.sub, item, q, flow);

      const stale = node.head.querySelector('.badge--stale');
      if (stale) stale.hidden = !(q.stale || (q.age && q.age > 12000));
    }
  }

  /** 子行：代码 · 资金流/交易状态 · 成交量，净流入按方向染色 */
  renderSub(el, item, q, flow) {
    clear(el);
    el.appendChild(h('span', { text: codeText(item.id) }));

    if (item.kind === 'etf') {
      const net = flow?.stats?.today?.net;
      if (Number.isFinite(net)) {
        el.appendChild(h('span.row__sep', { text: '·' }));
        el.appendChild(h('span.row__flow ' + dirClass(net), {
          text: `净流入 ${fmtSignedBig(net)}`,
        }));
      } else if (flow?.error) {
        el.appendChild(h('span.row__sep', { text: '·' }));
        el.appendChild(h('span', { text: '资金流延迟' }));
      }
    } else if (q) {
      el.appendChild(h('span.row__sep', { text: '·' }));
      el.appendChild(h('span', { text: stateText(effectiveState(q, item.market)) }));
    }

    // 成交量：A股/港股/美股指数/ETF 都有累计成交量（期货/外汇为 0，跳过）
    if (q && q.valid && q.volume > 0) {
      el.appendChild(h('span.row__sep', { text: '·' }));
      el.appendChild(h('span.row__vol', { text: `量 ${fmtVolume(q.volume)}` }));
    }
  }

  /** 拉取 ETF 资金流（串行，避免打爆接口） */
  async loadFlows(force = false) {
    if (this.flowLoading) return;
    const etfs = getItems().filter(it => it.kind === 'etf');
    if (!etfs.length) return;

    this.flowLoading = true;
    try {
      for (const it of etfs) {
        if (!this.active && !force) break;
        const cached = peekFlow(it.id);
        if (cached && !force) {
          this.flows.set(it.id, cached);
          continue;
        }
        const res = await getFlow(it.id, force ? { force: true } : undefined);
        this.flows.set(it.id, res);
        this.paint();
        // 首屏先把已有数据画出来，后面的不阻塞交互
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      this.flowLoading = false;
    }
    // 全部到齐后按「资金流排序」重新归位（顺序未变时等价于 paint）
    this.rerender();
  }

  scheduleFlowRefresh() {
    clearTimeout(this.flowTimer);
    this.flowTimer = setTimeout(async () => {
      if (!this.active) return;
      if (!document.hidden) await this.loadFlows(false);
      this.scheduleFlowRefresh();
    }, 95_000);
  }

  highlight(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.row.classList.remove('is-flash');
    // 强制重排以重启动画
    void node.row.offsetWidth;
    node.row.classList.add('is-flash');
    node.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  destroy() {
    this.stop();
    this.unsubStore?.();
  }
}
