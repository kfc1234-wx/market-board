/**
 * 国家队追踪页（独立自选清单）
 *
 * 与「自选」看板完全隔离的第二份清单，用户自行从搜索页添加 / 本页删除。
 * 交互对齐自选看板：点行进详情、编辑态批量删除、长按快捷删除、实时报价轮询。
 *
 * 底部汇总卡：
 *  - 交易量汇总：清单内所有标的今日合计成交量
 *  - 资金量汇总：清单内 ETF 今日净流入合计
 *  - 两格都可点，分别进「成交量汇总比照」「资金量汇总比照」二级页
 *
 * 汇总比照页（ntsum.js）：
 *  - 每个标的按今日 / 昨日 / 5 日 / 10 日 / 30 日横向比一遍
 *  - 资金流原本只拉 ETF，为了这个页扩到全清单（股票走同一个接口）
 *  - 资金流历史接口按 40 天拉，30 日窗口才不会缺尾部
 */

import { h, clear } from '../util/dom.js';
import {
  fmtPrice, fmtPct, fmtSignedBig, fmtVolume, dirClass, pillClass,
} from '../util/format.js';
import { getNTeam, takeNTeam, addNTeam, subscribe } from '../core/store.js';
import { getSymbol, kindLabel, kindClass, codeText } from '../data/symbols.js';
import { getQuotes, invalidate } from '../data/quotes.js';
import { getFlow, getLiveFlow } from '../data/flows.js';
import { getKline } from '../data/series.js';
import { tickTo, setText } from './ticker.js';
import { actionSheet, toast, snackbar } from './toast.js';
import { effectiveState, stateText } from '../market/session.js';
import { Distribution } from './distribution.js';
import { NTeamSum } from './ntsum.js';

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

    /** 底部全 A 涨跌分布卡片（跨 rerender 复用同一个节点，避免重复建 DOM） */
    this.distSlot = null;
    this.dist = null;
    /** id → 完整日线数组（升序）| null，null 表示该标的取不到日线 */
    this.kbars = new Map();
    this.kLoading = false;
    /** 汇总比照页的重绘合并到一帧，避免连续多只标的加载完就重建十几次列表 */
    this.sumRaf = 0;
    /** 汇总比照二级页（懒建，第一次点汇总格才创建） */
    this.sumPanel = null;
    this.onVisible = () => { if (!document.hidden) this.dist?.resume(); };
    document.addEventListener('visibilitychange', this.onVisible);

    this.editBtn?.addEventListener('click', () => this.toggleEdit());
    // 汇总卡两格：点哪格进哪个比照页（成交量为 vol、资金量为 flow）
    this.summaryEl?.addEventListener('click', e => {
      const cell = e.target.closest('[data-sum]');
      if (cell) this.openSum(cell.dataset.sum);
    });
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
    this.dist?.start();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.flowTimer);
    this.dist?.stop();
    // 比照页是全屏覆盖层，切到别的 tab 时必须收起来，否则会盖住新页面
    this.closeSum();
    if (this.editing) this.toggleEdit(false);
  }

  refreshNow() {
    invalidate();
    this.flows.clear();
    this.liveFlow.clear();
    this.kbars.clear();
    this.rerender();
    this.dist?.load(true);
    return Promise.all([
      this.refreshQuotes(true),
      this.loadFlows(true),
      this.loadKlines(true),
    ]);
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

    // 清单被清空时，比照页还开着只会显示一堆空行，直接收起来
    if (!items.length) this.closeSum();

    if (sig === this.signature) { this.paint(); this.paintSum(); return; }
    this.signature = sig;
    this.build(items);
    this.paint();
    this.paintSummary();
    this.paintSum();
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
      this.listEl.appendChild(this.mountDist());
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

    this.listEl.appendChild(this.mountDist());
  }

  /**
   * 挂载底部涨跌分布卡片。
   * 节点跨 rerender 复用：clear(listEl) 只把节点摘下来，
   * 卡片内部的 DOM 和数据都还在，下次直接 append 回去即可，不必重建。
   */
  mountDist() {
    if (!this.distSlot) {
      this.distSlot = h('div.dist-slot');
      this.dist = new Distribution(this.distSlot);
    }
    return this.distSlot;
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
    this.paintSum();
    this.setStatus(this.liveText());
  }

  /**
   * 当日实时资金流
   * 日频历史接口（getFlow）一天只出一根，盘中刷新也是同一个数，
   * 所以「今日净流入」走实时接口，跟着报价 15s 滚一次。
   *
   * 取全清单而不只是 ETF：资金量比照页的「今日」窗口要用它，
   * 股票与 ETF 走的是同一条批量接口，多带几只不增加请求数。
   */
  async refreshLiveFlow(force = false) {
    const ids = getNTeam().map(it => it.id);
    if (!ids.length) return;
    const map = await getLiveFlow(ids, force ? { force: true } : undefined);
    if (!this.active || !map.size) return;
    for (const [id, v] of map) this.liveFlow.set(id, v);
    this.liveAt = Date.now();
    this.paint();
    this.paintSummary();
    this.paintSum();
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
      // 资金量汇总仍只统计 ETF：这条走的是实时接口（15s 一滚），
      // 股票没有对应的实时值，混进来会变成「ETF 实时 + 股票滞后」的假合计。
      if (it.kind !== 'etf') continue;
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

  /* ---------------- 汇总比照（成交量 / 资金量） ---------------- */

  /** 懒建比照页：第一次点汇总格才创建，平时不占内存 */
  ensureSum() {
    if (this.sumPanel) return this.sumPanel;
    this.sumPanel = new NTeamSum({
      onClose: () => this.closeSum(),
      onWin: () => this.paintSum(),
    });
    return this.sumPanel;
  }

  /** 打开比照页：mode = 'vol'（成交量）| 'flow'（资金量） */
  openSum(mode) {
    const items = getNTeam();
    if (!items.length) return;
    this.ensureSum().show(mode);
    // 日线是比照页的主数据源，没拉全就先补一次（打开时多半已经在拉了）
    if (this.kbars.size < items.length) this.loadKlines();
    this.paintSum();
  }

  closeSum() {
    this.sumPanel?.hide();
  }

  /**
   * 拉全清单日线（完整序列，先不截窗口）
   *
   * 五个窗口共用同一条日线，所以这里存整段、由 sumData 按窗口切；
   * 只留最近 5 根的话，10 日 / 30 日窗口就没得算。
   */
  async loadKlines(force = false) {
    if (this.kLoading) return;
    const queue = getNTeam().slice();
    if (!queue.length) return;
    this.kLoading = true;
    // 并发 3 路：腾讯日线一次只能取一只，串行太慢、全并发又容易被限速
    const worker = async () => {
      while (queue.length) {
        if (!this.active && !force) return;
        const it = queue.shift();
        try {
          const bars = await getKline(it.id, 'day');
          this.kbars.set(it.id, Array.isArray(bars) && bars.length ? bars : null);
        } catch {
          this.kbars.set(it.id, null);   // 停牌 / 无日线：比照页里显示 --
        }
        this.paintSum();
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      this.kLoading = false;
      this.paintSum();
    }
  }

  /** 重绘合并到一帧：连续多只标的加载完，不会把列表重建十几次 */
  paintSum() {
    if (!this.sumPanel?.open) return;
    if (this.sumRaf) return;
    this.sumRaf = requestAnimationFrame(() => {
      this.sumRaf = 0;
      if (!this.sumPanel?.open) return;
      const { rows, meta } = this.sumData();
      this.sumPanel.update(rows, meta);
    });
  }

  /**
   * 汇总比照的数据
   *
   * 交易日历取「清单里日线最长的那只」作为基准：
   * 每只标的的日线长度不同（停牌、新上市），各自 slice(-N) 得到窗口
   * 起止日期会不一样，同一张表里就变成「你 5 天我 3 天」。
   * 所以统一用一条日历切窗口，再拿日期去各自的日线 / 资金流里取值。
   */
  sumData() {
    const mode = this.sumPanel?.mode || 'vol';
    const win = this.sumPanel?.win || 'd5';
    const items = getNTeam();

    // 基准日历
    let cal = [];
    for (const it of items) {
      const b = this.kbars.get(it.id);
      if (Array.isArray(b) && b.length > cal.length) cal = b.map(x => x.date);
    }

    const wantDays = win === 'today' || win === 'yesterday' ? 1 : (WIN_N[win] || 5);
    const dates = win === 'today'
      ? cal.slice(-1)
      : win === 'yesterday'
        ? cal.slice(-2, -1)
        : cal.slice(-wantDays);
    const today = localDate();

    const rows = [];
    for (const it of items) {
      const bars = (this.kbars.get(it.id) || [])
        .filter(b => b && b.date && Number.isFinite(b.close));
      const flowRows = this.flows.get(it.id)?.rows;
      const flow = Array.isArray(flowRows) ? flowRows : [];

      let value = NaN;
      let series = [];

      if (mode === 'vol') {
        const byDate = new Map(bars.map(b => [b.date, Number(b.volume) || 0]));
        series = dates.filter(d => byDate.has(d)).map(d => ({ date: d, v: byDate.get(d) }));
        if (series.length) value = series.reduce((s, d) => s + d.v, 0);

        // 「今日」若正好是今天，用实时报价的量覆盖：与底部汇总格同源。
        // 日线有缓存，盘中会滞后几分钟，不覆盖的话点进去和刚才那格对不上。
        if (win === 'today' && dates[0] === today) {
          const q = this.quotes.get(it.id);
          if (q && q.valid && q.volume > 0) {
            value = q.volume;
            series = [{ date: dates[0], v: q.volume }];
          }
        }
      } else {
        const byDate = new Map(flow.map(r => [r.date, Number(r.net) || 0]));
        series = dates.filter(d => byDate.has(d)).map(d => ({ date: d, v: byDate.get(d) }));
        if (series.length) value = series.reduce((s, d) => s + d.v, 0);

        // 今日同理：日频历史接口盘中不更新，用实时接口的值覆盖
        if (win === 'today' && dates[0] === today) {
          const lv = this.liveFlow.get(it.id);
          if (lv && Number.isFinite(lv.net)) {
            value = lv.net;
            series = [{ date: dates[0], v: lv.net }];
          }
        }
      }

      rows.push({
        id: it.id,
        name: it.name || getSymbol(it.id).name,
        kind: it.kind,
        value,
        series,
        days: series.length,
        wantDays,
      });
    }

    return {
      rows,
      meta: {
        start: dates[0] || '',
        end: dates[dates.length - 1] || '',
        tradeDays: dates.length,
        loading: this.kLoading || this.flowLoading,
      },
    };
  }

  /* ---------------- 资金流 ---------------- */

  async loadFlows(force = false) {
    if (this.flowLoading) return;
    // 原来是只看 ETF（行内「净流入」只给 ETF 显示），现在股票也要：
    // 资金量比照页要横着比，只有 ETF 就没得比了。同一条接口股票照样支持。
    const items = getNTeam();
    if (!items.length) return;
    this.flowLoading = true;
    try {
      for (const it of items) {
        if (!this.active && !force) break;
        const res = await getFlow(it.id, force ? { force: true } : undefined);
        this.flows.set(it.id, res);
        this.paint();
        this.paintSummary();
        this.paintSum();
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      this.flowLoading = false;
      this.paintSum();
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
    if (this.sumRaf) cancelAnimationFrame(this.sumRaf);
    this.sumPanel?.destroy();
    document.removeEventListener('visibilitychange', this.onVisible);
    this.unsubStore?.();
  }
}

/** 多日窗口 → 交易日根数（今日 / 昨日 单独按 1 根处理） */
const WIN_N = { d5: 5, d10: 10, d30: 30 };

/** 本机日期 YYYY-MM-DD，用来判断日线最后一根是不是「今天」 */
function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
