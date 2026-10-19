/**
 * 国家队追踪页（独立自选清单）
 *
 * 与「自选」看板完全隔离的第二份清单，用户自行从搜索页添加 / 本页删除。
 * 交互对齐自选看板：点行进详情、编辑态批量删除、长按快捷删除、实时报价轮询。
 *
 * 底部汇总卡：
 *  - 交易量汇总：清单内所有标的今日合计成交量
 *  - 资金量汇总：清单内 ETF 今日净流入合计
 */

import { h, clear } from '../util/dom.js';
import {
  fmtPrice, fmtPct, fmtSignedBig, fmtVolume, dirClass, pillClass,
} from '../util/format.js';
import { getNTeam, takeNTeam, addNTeam, subscribe } from '../core/store.js';
import { getSymbol, kindLabel, kindClass, codeText } from '../data/symbols.js';
import { getQuotes, invalidate } from '../data/quotes.js';
import { getFlow, getLiveFlow } from '../data/flows.js';
import { tickTo, setText } from './ticker.js';
import { actionSheet, toast, snackbar } from './toast.js';
import { effectiveState, stateText } from '../market/session.js';

const QUOTE_MS = 15 * 1000;

export class NTeam {
  constructor(opt = {}) {
    this.listEl = opt.listEl;
    this.summaryEl = opt.summaryEl;
    this.volVal = opt.volVal;
    this.volNote = opt.volNote;
    this.flowVal = opt.flowVal;
    this.flowNote = opt.flowNote;
    this.statusEl = opt.statusEl;
    this.editBtn = opt.editBtn;
    this.onOpen = opt.onOpen || (() => {});
    this.onAdd = opt.onAdd || (() => {});

    this.quotes = new Map();
    this.flows = new Map();
    /** 当日实时资金流（id → {net, ...}），跟报价一起 15s 刷新 */
    this.liveFlow = new Map();
    this.liveAt = 0;
    this.nodes = new Map();   // id -> { row, price, pct, sub }
    this.signature = null;    // 空列表时 sig 为 ''，不能用 '' 做初始值（会误判命中跳过 build）
    this.active = false;
    this.editing = false;
    this.timer = 0;
    this.flowLoading = false;
    this.flowTimer = 0;

    this.editBtn?.addEventListener('click', () => this.toggleEdit());
    this.unsubStore = subscribe(type => {
      if (type === 'nteam') this.rerender();
    });
  }

  start() {
    this.active = true;
    this.rerender();
    this.refreshNow();
    this.scheduleQuotes();
    this.scheduleFlowRefresh();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.flowTimer);
    if (this.editing) this.toggleEdit(false);
  }

  refreshNow() {
    invalidate();
    this.flows.clear();
    this.liveFlow.clear();
    this.rerender();
    return Promise.all([this.refreshQuotes(true), this.loadFlows(true)]);
  }

  toggleEdit(force) {
    this.editing = typeof force === 'boolean' ? force : !this.editing;
    this.listEl?.classList.toggle('is-editing', this.editing);
    if (this.editBtn) {
      this.editBtn.textContent = this.editing ? '完成' : '编辑';
      this.editBtn.classList.toggle('is-active', this.editing);
    }
  }

  /* ---------------- 渲染 ---------------- */

  rerender() {
    const items = getNTeam();
    const sig = items.map(it => it.id).join('|');

    if (sig === this.signature) { this.paint(); return; }
    this.signature = sig;
    this.build(items);
    this.paint();
    this.paintSummary();
  }

  build(items) {
    if (!this.listEl) return;
    clear(this.listEl);
    this.nodes.clear();

    if (!items.length) {
      this.listEl.appendChild(h('div.nte-empty', {}, [
        h('p.nte-empty__title', { text: '国家队清单还是空的喵' }),
        h('p.nte-empty__sub', { text: '去搜索页把想追踪的标的加进来，即可在此统一看交易量与资金量' }),
        h('button.btn.btn--primary', {
          type: 'button',
          text: '去添加',
          onclick: () => this.onAdd(),
        }),
      ]));
      return;
    }

    for (const item of items) {
      const sym = getSymbol(item.id);
      const row = h('div.row', {
        dataset: { id: item.id },
        class: item.kind === 'etf' ? 'row--etf' : '',
      });

      const del = h('button.row__del', {
        type: 'button',
        'aria-label': '从国家队删除',
        html: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
          + '<path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        onpointerdown: e => e.stopPropagation(),
        onclick: e => { e.stopPropagation(); this.deleteItem(item); },
      });
      row.appendChild(del);

      const head = h('div.row__head', {}, [
        h('span.row__name', { text: item.name || sym.name }),
        h(`span.badge.${kindClass(sym).trim()}`, { text: kindLabel(sym) }),
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
      this.nodes.set(item.id, { row, price, pct, sub });
    }

    this.listEl.appendChild(h('button.row-add', {
      type: 'button',
      html: '<span class="row-add__ico">'
        + '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">'
        + '<ellipse cx="12" cy="16.4" rx="5.2" ry="4.3" fill="currentColor"/>'
        + '<ellipse cx="5.9" cy="11.1" rx="2.1" ry="2.5" fill="currentColor"/>'
        + '<ellipse cx="10.1" cy="7.2" rx="2.1" ry="2.6" fill="currentColor"/>'
        + '<ellipse cx="13.9" cy="7.2" rx="2.1" ry="2.6" fill="currentColor"/>'
        + '<ellipse cx="18.1" cy="11.1" rx="2.1" ry="2.5" fill="currentColor"/></svg>'
        + '</span><span>添加标的</span>',
      onclick: () => this.onAdd(),
    }));
  }

  deleteItem(item) {
    const taken = takeNTeam(item.id);
    if (!taken) return;
    const name = item.name || getSymbol(item.id).name;
    snackbar({
      text: `已删除「${name}」`,
      actionLabel: '撤销',
      onAction: () => {
        const res = addNTeam(taken.item);
        if (!res.ok) toast(res.reason || '撤销失败');
      },
    });
  }

  bindRow(row, item) {
    let timer = 0;
    let longPressed = false;
    let startX = 0, startY = 0, moved = false;
    const clearTimer = () => { clearTimeout(timer); timer = 0; };

    row.addEventListener('pointerdown', e => {
      longPressed = false; moved = false;
      startX = e.clientX; startY = e.clientY;
      clearTimer();
      if (this.editing) return;
      timer = setTimeout(async () => {
        longPressed = true;
        const act = await actionSheet({
          title: item.name,
          actions: [
            { label: '查看详情', value: 'open' },
            { label: '从国家队删除', value: 'remove', danger: true },
          ],
        });
        if (act === 'open') this.onOpen(item.id);
        else if (act === 'remove') this.deleteItem(item);
      }, 550);
    });
    row.addEventListener('pointermove', e => {
      if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) { moved = true; clearTimer(); }
    });
    row.addEventListener('pointerup', () => {
      clearTimer();
      if (this.editing) return;
      if (!longPressed && !moved) this.onOpen(item.id);
    });
    row.addEventListener('pointercancel', clearTimer);
    row.addEventListener('pointerleave', clearTimer);
  }

  /* ---------------- 行情 ---------------- */

  async refreshQuotes(force = false) {
    const ids = [...this.nodes.keys()];
    if (!ids.length) return;

    // 资金量和报价同一批标的，顺手一起刷：一次批量 JSONP，不额外增加轮询压力。
    // 不 await，让它自己画完，别拖慢报价首屏。
    this.refreshLiveFlow(force).catch(() => {});

    const map = await getQuotes(ids, force ? { maxAge: 0 } : undefined);
    if (!this.active) return;
    for (const [id, q] of map) this.quotes.set(id, q);
    this.paint();
    this.paintSummary();
    this.setStatus(this.liveText());
  }

  /**
   * 当日实时资金流
   * 日频历史接口（getFlow）一天只出一根，盘中刷新也是同一个数，
   * 所以「今日净流入」走实时接口，跟着报价 15s 滚一次。
   */
  async refreshLiveFlow(force = false) {
    const etfs = getNTeam().filter(it => it.kind === 'etf').map(it => it.id);
    if (!etfs.length) return;
    const map = await getLiveFlow(etfs, force ? { force: true } : undefined);
    if (!this.active || !map.size) return;
    for (const [id, v] of map) this.liveFlow.set(id, v);
    this.liveAt = Date.now();
    this.paint();
    this.paintSummary();
  }

  /** 今日净流入：实时值优先，取不到再退回日频快照 */
  netOf(id, flow) {
    const lv = this.liveFlow.get(id);
    if (lv && Number.isFinite(lv.net)) return lv.net;
    const today = flow?.stats?.today;
    return Number.isFinite(today?.net) ? today.net : NaN;
  }

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
      const digits = Math.min(q.digits ?? item.digits ?? 2, 4);
      tickTo(node.price, q.price, v => fmtPrice(v, digits));
      tickTo(node.pct, q.pct, v => fmtPct(v));
      node.price.className = 'row__price ' + dirClass(q.pct);
      node.pct.className = 'pill ' + pillClass(q.pct);
      this.renderSub(node.sub, item, q, flow);
    }
  }

  renderSub(el, item, q, flow) {
    clear(el);
    el.appendChild(h('span', { text: codeText(item.id) }));

    if (item.kind === 'etf') {
      const net = this.netOf(item.id, flow);
      if (Number.isFinite(net)) {
        el.appendChild(h('span.row__sep', { text: '·' }));
        el.appendChild(h('span.row__flow ' + dirClass(net), { text: `净流入 ${fmtSignedBig(net)}` }));
      }
    } else if (q) {
      el.appendChild(h('span.row__sep', { text: '·' }));
      el.appendChild(h('span', { text: stateText(effectiveState(q, item.market)) }));
    }

    if (q && q.valid && q.volume > 0) {
      el.appendChild(h('span.row__sep', { text: '·' }));
      el.appendChild(h('span.row__vol', { text: `量 ${fmtVolume(q.volume)}` }));
    }
  }

  /* ---------------- 底部汇总：交易量 + 资金量 ---------------- */

  paintSummary() {
    if (!this.summaryEl) return;
    const items = getNTeam();
    if (!items.length) { this.summaryEl.hidden = true; return; }

    let vol = 0, volN = 0;
    let flowSum = 0, flowN = 0;
    for (const it of items) {
      const q = this.quotes.get(it.id);
      if (q && q.valid && q.volume > 0) { vol += q.volume; volN++; }
      const f = this.flows.get(it.id);
      const net = this.netOf(it.id, f);
      if (Number.isFinite(net)) { flowSum += net; flowN++; }
    }

    this.volVal.textContent = vol > 0 ? fmtVolume(vol) : '--';
    this.volNote.textContent = volN ? `今日合计成交量 · ${volN}/${items.length} 只` : '今日合计成交量';

    if (flowN > 0) {
      this.flowVal.textContent = fmtSignedBig(flowSum);
      this.flowVal.className = 'nte-sum__val ' + dirClass(flowSum);
      // 标一下「实时」：这条跟着 15s 轮询滚，和顶部报价同一个节奏
      const live = this.liveFlow.size > 0;
      this.flowNote.textContent = live
        ? '资金量汇总 · ETF 净流入 · 实时'
        : '资金量汇总 · ETF 净流入';
    } else {
      this.flowVal.textContent = '--';
      this.flowVal.className = 'nte-sum__val';
      this.flowNote.textContent = '资金量汇总 · 暂无可统计的 ETF';
    }

    this.summaryEl.hidden = false;
  }

  /* ---------------- 资金流 ---------------- */

  async loadFlows(force = false) {
    if (this.flowLoading) return;
    const etfs = getNTeam().filter(it => it.kind === 'etf');
    if (!etfs.length) return;
    this.flowLoading = true;
    try {
      for (const it of etfs) {
        if (!this.active && !force) break;
        const res = await getFlow(it.id, force ? { force: true } : undefined);
        this.flows.set(it.id, res);
        this.paint();
        this.paintSummary();
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      this.flowLoading = false;
    }
  }

  scheduleFlowRefresh() {
    clearTimeout(this.flowTimer);
    this.flowTimer = setTimeout(async () => {
      if (!this.active) return;
      if (!document.hidden) await this.loadFlows(false);
      this.scheduleFlowRefresh();
    }, 95_000);
  }

  scheduleQuotes() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.active) return;
      if (!document.hidden) await this.refreshQuotes(false);
      this.scheduleQuotes();
    }, QUOTE_MS);
  }

  liveText() {
    const items = getNTeam();
    if (!items.length) return '空闲';
    return '盘中';
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  repaint() { this.paint(); }

  destroy() {
    this.stop();
    this.unsubStore?.();
  }
}
