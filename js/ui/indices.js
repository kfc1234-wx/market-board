/**
 * 指数行情页
 *
 * 2 列卡片网格：每张卡 = 名称 + 市场标 + 最新价 + 涨跌幅 + 图表区。
 * 点卡片进详情页看分时 / K线。
 *
 * 与看板的区别：
 *  看板要「一屏很多行、可按字段排序」，指数页要「少量、放大、看形状」，
 *  所以不复用看板的 DOM。
 *
 * 展示哪些品种由 store.indexIds 决定，顶栏「调整」打开抽屉勾选。
 * 没有分时数据的品种（日经225 / KOSPI）画「今日振幅条」，不编造走势。
 */

import { h, clear } from '../util/dom.js';
import { fmtPrice, fmtPct, fmtChange, dirClass, pillClass } from '../util/format.js';
import { getSymbol, marketLabel } from '../data/symbols.js';
import { peek, invalidate } from '../data/quotes.js';
import { getMinute } from '../data/series.js';
import { Poller } from '../core/poller.js';
import { tickTo, setText } from './ticker.js';
import { drawSpark, drawRange, clearSpark } from '../chart/spark.js';
import { watchResize } from '../chart/base.js';
import { marketState, effectiveState, parseQuoteTime } from '../market/session.js';
import { getIndexIds, getIndexPool, toggleIndex, hasIndex, subscribe } from '../core/store.js';

const SPARK_TTL = 50_000;

export class Indices {
  constructor(opt) {
    this.listEl = opt.listEl;
    this.statusEl = opt.statusEl;
    this.onOpen = opt.onOpen;

    this.ids = getIndexIds();
    this.quotes = new Map();
    this.sparks = new Map();   // id -> { points, prevClose, at }
    this.nodes = new Map();    // id -> { price, pct, amt, canvas }

    this.active = false;
    this.startedAt = Date.now();
    this.sparkLoading = false;
    this.sparkTimer = 0;
    this.unwatch = null;
    // 休市品种默认收起；用户点过「显示全部」后本次会话不再自动收
    this.showAll = false;
    this.visSig = undefined;

    this.poller = new Poller({
      getIds: () => this.ids,
      onData: map => this.applyQuotes(map),
      onState: () => this.setStatus(),
    });

    this.build();
    this.bindResize();

    // 抽屉里勾选后，store 发通知，这里重建
    this.unsub = subscribe(type => {
      if (type === 'indices') this.reload();
    });
    this.bindPicker();
  }

  /* ---------------- 构建（只跑一次，之后只改数值） ---------------- */

  build() {
    if (!this.listEl) return;
    clear(this.listEl);
    this.nodes.clear();
    // 列表变了以后，旧的分时数据可能不再需要
    for (const id of [...this.sparks.keys()]) {
      if (!this.ids.includes(id)) this.sparks.delete(id);
    }

    const grid = h('div.idxgrid');

    for (const id of this.ids) {
      const sym = getSymbol(id);

      const priceEl = h('div.icard__price', { text: '--' });
      const pctEl = h('span.icard__pct.pill--flat', { text: '--' });
      const amtEl = h('span.icard__amt', { text: '' });
      const canvas = h('canvas');
      // 图表区没有内容时的占位文案（加载中 / 拿不到数据）
      const emptyEl = h('span.icard__empty', { text: '' });

      const card = h('button.icard', {
        type: 'button',
        dataset: { id },
        onclick: () => this.onOpen?.(id),
      }, [
        h('div.icard__top', {}, [
          h('span.icard__name', { text: sym.name }),
          h('span.icard__tag', { text: marketLabel(sym) }),
        ]),
        priceEl,
        h('div.icard__chg', {}, [pctEl, amtEl]),
        h('div.icard__spark', {}, [canvas, emptyEl]),
      ]);

      grid.appendChild(card);
      this.nodes.set(id, { card, price: priceEl, pct: pctEl, amt: amtEl, canvas, empty: emptyEl });
    }

    this.listEl.appendChild(grid);

    // 休市收起后要留一个「有多少被藏起来了」的入口，否则用户会以为品种丢了
    this.visSig = undefined;
    if (this.hideHint) this.hideHint.remove();
    this.hideHint = h('button.idxhide', {
      type: 'button',
      onclick: () => {
        this.showAll = true;
        this.applyVisibility();
        this.loadSparks(true);
      },
    });
    this.hideHint.hidden = true;
    this.listEl.appendChild(this.hideHint);

    this.listEl.appendChild(h('p.idxnote', {
      text: '数据来源：腾讯行情 / CNBC / 新浪财经 / feargreedchart。折线为当日分时；'
        + '日经225、韩国KOSPI 与美元指数的数据源只提供实时报价，卡片内为今日振幅条'
        + '（横条=最低~最高，圆点=现价，虚线=昨收）。离岸人民币按「美元兑人民币」报价，'
        + '数值上升=人民币走弱；人民币账户黄金按 元/克 折算，不含银行点差。'
        + '休市品种默认收起，开盘后自动出现。'
        + '红涨绿跌，行情有数秒至数分钟延迟，仅供参考，不构成投资建议。',
    }));

    this.applyVisibility();

    // 布局尺寸变了，补一次重绘
    requestAnimationFrame(() => this.repaintSparks());
  }

  /**
   * 当前应隐藏（休市）的品种
   *
   * 全被隐藏时返回空集：宁可多显示几张收盘卡，也不要给用户一个空页面。
   * 判断用 effectiveState 而不是 marketState——时段上该开盘但行情时间落后
   * 十几分钟的（节假日、临时休市）也算休市，否则会留一张永不更新的卡。
   */
  hiddenSet() {
    if (this.showAll) return new Set();
    const byMarket = new Map();
    const out = new Set();
    for (const id of this.ids) {
      const m = getSymbol(id).market;
      if (!byMarket.has(m)) byMarket.set(m, effectiveState(this.quotes.get(id), m));
      if (byMarket.get(m) === 'closed') out.add(id);
    }
    return out.size >= this.ids.length ? new Set() : out;
  }

  applyVisibility() {
    if (!this.nodes.size) return;

    const hidden = this.hiddenSet();
    const sig = [...hidden].sort().join(',');
    if (sig === this.visSig) return;

    const first = this.visSig === undefined;
    this.visSig = sig;

    let n = 0;
    for (const [id, node] of this.nodes) {
      const hide = hidden.has(id);
      node.card.hidden = hide;
      if (hide) n++;
    }

    if (this.hideHint) {
      this.hideHint.hidden = !n;
      if (n) this.hideHint.textContent = `已隐藏 ${n} 个休市品种 · 点此显示全部`;
    }

    // 卡片从隐藏变可见时，canvas 之前在 display:none 里量不到尺寸，必须补画
    if (!first) requestAnimationFrame(() => this.repaintSparks());
  }

  /** 勾选变更后重建列表 */
  reload() {
    const next = getIndexIds();
    if (next.join('|') === this.ids.join('|')) return;
    this.ids = next;
    this.build();

    if (this.active) {
      this.poller.stop();
      this.poller.start();
      const snap = peek(this.ids);
      if (snap.size) this.applyQuotes(snap);
      else this.paint();
      this.loadSparks(false);
    }
  }

  bindResize() {
    if (!this.listEl) return;
    this.unwatch = watchResize(this.listEl, () => this.repaintSparks());
  }

  /* ---------------- 选择抽屉 ---------------- */

  bindPicker() {
    this.pickerEl = document.getElementById('idx-picker');
    this.pickerListEl = document.getElementById('idx-picker-list');
    const openBtn = document.getElementById('idx-add');

    openBtn?.addEventListener('click', () => this.openPicker());
    this.pickerEl?.addEventListener('click', e => {
      if (e.target === this.pickerEl) this.closePicker();
    });
    document.getElementById('idx-picker-done')?.addEventListener('click', () => this.closePicker());

    this.renderPicker();
  }

  renderPicker() {
    if (!this.pickerListEl) return;
    clear(this.pickerListEl);

    for (const id of getIndexPool()) {
      const sym = getSymbol(id);
      const on = hasIndex(id);

      const row = h('button.ipick' + (on ? '.is-on' : ''), {
        type: 'button',
        dataset: { id },
        onclick: () => {
          toggleIndex(id);
          this.renderPicker();
        },
      }, [
        h('span.ipick__check', {
          html: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
            + '<path d="M3.4 8.4l3 3 6.2-6.6" fill="none" stroke="currentColor" '
            + 'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        }),
        h('span.ipick__name', { text: sym.name }),
        h('span.ipick__tag', { text: marketLabel(sym) }),
      ]);
      this.pickerListEl.appendChild(row);
    }
  }

  openPicker() {
    if (!this.pickerEl) return;
    this.renderPicker();
    this.pickerEl.hidden = false;
    requestAnimationFrame(() => this.pickerEl.classList.add('is-open'));
  }

  closePicker() {
    if (!this.pickerEl || this.pickerEl.hidden) return;
    this.pickerEl.classList.remove('is-open');
    setTimeout(() => {
      if (!this.pickerEl.classList.contains('is-open')) this.pickerEl.hidden = true;
    }, 220);
  }

  pickerOpen() {
    return !!this.pickerEl && !this.pickerEl.hidden;
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    this.active = true;

    // 先拿同步缓存快照渲染，避免切回本页时数字先闪一下 '--'
    const snap = peek(this.ids);
    if (snap.size) this.applyQuotes(snap);
    else this.paint();

    this.poller.start();
    this.loadSparks();
    this.scheduleSpark();
    // 首屏 8 秒后还没数的卡，主动补一句说明（否则要等下一次轮询才变成文字）
    clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => this.markStale(), 8400);
    // 页面从 hidden 变可见时，canvas 之前的布局尺寸是 0，补一次重绘
    requestAnimationFrame(() => this.repaintSparks());
  }

  stop() {
    this.active = false;
    this.poller.stop();
    clearTimeout(this.sparkTimer);
    clearTimeout(this.emptyTimer);
    this.closePicker();
  }

  refreshNow() {
    invalidate();
    this.sparks.clear();
    this.repaintSparks();
    return Promise.all([this.poller.refreshNow(), this.loadSparks(true)]);
  }

  /* ---------------- 数据 ---------------- */

  applyQuotes(map) {
    if (map) for (const [id, q] of map) this.quotes.set(id, q);

    // 报价可能比分时先到：空卡片一拿到数据就补画振幅条，
    // 否则「加载中…」会一直压在图上（日经 / KOSPI 每轮都会走这条路径）
    let revived = false;
    for (const [id, node] of this.nodes) {
      const q = this.quotes.get(id);
      if (node.card.classList.contains('is-empty') && q && q.valid && q.price > 0) {
        revived = true;
        break;
      }
    }

    this.paint();
    if (revived) this.repaintSparks();
    this.setStatus();
  }

  paint() {
    for (const id of this.ids) {
      const node = this.nodes.get(id);
      if (!node) continue;

      const q = this.quotes.get(id);
      const sym = getSymbol(id);

      if (!q || !q.valid || !(q.price > 0)) {
        node.card.classList.add('is-empty');
        setText(node.price, '--');
        setText(node.pct, '--');
        node.price.className = 'icard__price';
        node.pct.className = 'icard__pct pill--flat';
        setText(node.amt, '');
        // 首屏 8 秒内算"加载中"，之后还没数就明说没拿到
        setText(node.empty, Date.now() - this.startedAt > 8000 ? '数据源暂不可达' : '加载中…');
        continue;
      }
      node.card.classList.remove('is-empty');

      // 指数最多 2 位小数，汇率保留 4 位
      const maxDigits = sym.kind === 'index' ? 2 : 4;
      const digits = Math.min(q.digits ?? sym.digits ?? 2, maxDigits);

      tickTo(node.price, q.price, v => fmtPrice(v, digits));
      tickTo(node.pct, q.pct, v => fmtPct(v));
      node.price.className = 'icard__price ' + dirClass(q.pct);
      node.pct.className = 'icard__pct ' + pillClass(q.pct);
      node.amt.className = 'icard__amt ' + dirClass(q.pct);
      setText(node.amt, fmtChange(q.change, digits));
    }

    // 每轮报价刷新都重新判一次开闭市：15:00 收盘、21:30 开盘都能自己触发
    this.applyVisibility();
  }

  setStatus() {
    if (!this.statusEl) return;

    // 只统计露在屏上的市场：全盘休市时还报「盘中」会让人以为数据卡了
    const hidden = this.hiddenSet();
    const shown = this.ids.filter(id => !hidden.has(id));
    const markets = (shown.length ? shown : this.ids).map(id => getSymbol(id).market);
    const open = markets.some(m => ['open', 'pre', 'post'].includes(marketState(m)));
    if (open) {
      this.statusEl.textContent = '盘中';
      this.statusEl.dataset.live = '1';
      return;
    }

    const anyQ = [...this.quotes.values()].find(q => q.time);
    const t = anyQ ? parseQuoteTime(anyQ.time) : null;
    this.statusEl.textContent = t
      ? `已收盘 · ${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`
      : '已收盘';
    this.statusEl.dataset.live = '0';
  }

  /* ---------------- 图表区 ---------------- */

  async loadSparks(force = false) {
    if (this.sparkLoading) return;
    this.sparkLoading = true;

    // 收起的休市品种不用拉分时：那条线当天不会再动，拉了也是白花请求
    const hidden = this.hiddenSet();

    try {
      for (const id of this.ids) {
        if (!this.active && !force) break;
        if (hidden.has(id) && !force) continue;

        const cached = this.sparks.get(id);
        const fresh = cached && !force && Date.now() - cached.at < SPARK_TTL;

        if (!fresh) {
          try {
            const m = await getMinute(id, { maxAge: force ? 0 : 30_000 });
            this.sparks.set(id, {
              points: m.points,
              prevClose: m.prevClose || 0,
              at: Date.now(),
            });
          } catch {
            // 没有分时的品种走振幅条，由 paintSpark 兜底；这里不删旧图
            this.paintSpark(id);
            continue;
          }
          // 串行且留间隔，避免多个分时接口同时打出去
          await new Promise(r => setTimeout(r, 70));
        }

        this.paintSpark(id);
      }
    } finally {
      this.sparkLoading = false;
    }
  }

  paintSpark(id) {
    const node = this.nodes.get(id);
    if (!node) return;

    const data = this.sparks.get(id);
    const q = this.quotes.get(id);

    if (data && Array.isArray(data.points) && data.points.length > 1) {
      const base = data.prevClose || (q && q.prevClose) || 0;
      drawSpark(node.canvas, data.points, base);
      if (node.empty) node.empty.hidden = true;
      return;
    }

    // 无分时 → 画今日振幅条（只用真实的高/低/现价/昨收）
    if (q && q.valid && q.high > 0 && q.low > 0 && q.price > 0) {
      drawRange(node.canvas, {
        price: q.price,
        prevClose: q.prevClose,
        high: q.high,
        low: q.low,
      });
      if (node.empty) node.empty.hidden = true;
      return;
    }

    clearSpark(node.canvas);
    if (node.empty) node.empty.hidden = false;
  }

  repaintSparks() {
    for (const id of this.ids) this.paintSpark(id);
  }

  /** 给「一直没拿到数据」的卡补上说明文案 */
  markStale() {
    if (Date.now() - this.startedAt < 8000) return;
    for (const node of this.nodes.values()) {
      if (!node.card.classList.contains('is-empty')) continue;
      if (!node.empty.textContent) node.empty.textContent = '数据源暂不可达';
      node.empty.hidden = false;
    }
  }

  /** 主题切换后整体重绘 */
  repaint() {
    this.paint();
    this.repaintSparks();
  }

  scheduleSpark() {
    clearTimeout(this.sparkTimer);
    this.sparkTimer = setTimeout(async () => {
      if (!this.active) return;
      if (!document.hidden) await this.loadSparks(false);
      this.scheduleSpark();
    }, 62_000);
  }

  destroy() {
    this.stop();
    this.unwatch?.();
    this.unsub?.();
  }
}
