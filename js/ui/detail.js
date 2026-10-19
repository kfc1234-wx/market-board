/** 详情页：报价头部 + 分时/日K/周K/月K + ETF 资金流 */

import { h, clear } from '../util/dom.js';
import { fmtPrice, fmtPct, fmtChange, fmtVolume, fmtBig, fmtMinuteTime, dirClass } from '../util/format.js';
import { getSymbol, kindLabel, codeText, isPreset } from '../data/symbols.js';
import { getQuotes } from '../data/quotes.js';
import { getDividend } from '../data/dividend.js';
import { getMinute, getKline, fillPrevClose } from '../data/series.js';
import { marketState, effectiveState, stateText, shortTime } from '../market/session.js';
import { TrendChart } from '../chart/trend.js';
import { KlineChart } from '../chart/kline.js';
import { tickTo, setText } from './ticker.js';
import { renderFlowPanel } from './flow.js';

/** 各市场单日分钟数与时段（用于索引轴） */
const MARKET_TZ = {
  CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', US: 'America/New_York',
  CME: 'America/New_York', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  FX: 'Asia/Shanghai', PM: 'Asia/Shanghai',
};
// FX 不写固定值：外汇一天 288 根 5 分钟线，但「今天走到几点」是变的，交给数据决定
const AXIS_COUNT = { CN: 241, HK: 332, US: 391, CME: 1380, JP: 300, KR: 390 };
const SEGMENTS = {
  CN: [[570, 690], [780, 900]],
  HK: [[570, 720], [780, 960]],
  US: [[570, 960]],
  CME: [[360, 1740]],
  JP: [[540, 900]],
  KR: [[540, 930]],
  FX: [[0, 1440]],
  PM: [[0, 1440]],
};

function hm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

/** 外汇：按实际分钟线的首尾时间线性分 5 段 */
function fxLabels(points) {
  const fallback = ['00:00', '06:00', '12:00', '18:00', '24:00'];
  if (!Array.isArray(points) || points.length < 2) return fallback;
  const toMin = t => {
    const n = String(t || '').replace(':', '');
    const h = Number(n.slice(0, 2));
    const m = Number(n.slice(2, 4));
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const a = toMin(points[0].t);
  const b = toMin(points[points.length - 1].t);
  if (a == null || b == null || b <= a) return fallback;
  return [0, 0.25, 0.5, 0.75, 1].map(f => hm(Math.round((a + (b - a) * f) / 5) * 5));
}

/** 从报价时间戳里抠出日期（腾讯 A股形如 20261019150003，美指可能带分隔符） */
function quoteDate(q) {
  const d = String(q?.time || '').replace(/\D/g, '');
  if (d.length < 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 按交易时段等分生成 5 个时间刻度 */
function timeLabelsFor(market) {
  const segs = SEGMENTS[market] || SEGMENTS.CN;
  const total = segs.reduce((s, [a, b]) => s + (b - a), 0);
  const out = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    let left = total * f;
    let minute = segs[0][0];
    for (const [a, b] of segs) {
      const len = b - a;
      if (left <= len) { minute = a + left; break; }
      left -= len;
      minute = b;
    }
    out.push(hm(Math.round(minute / 5) * 5));
  }
  return out;
}

export class Detail {
  constructor({ root, onBack }) {
    this.root = root;
    this.onBack = onBack;
    this.id = '';
    this.sym = null;
    this.quote = null;
    this.period = 'trend';
    this.chart = null;
    this.timer = 0;
    this.active = false;
    this.reqSeq = 0;
    /** K 线十字光标是否正压在图上（此时头部显示历史那根，不被轮询刷回实时） */
    this.hovering = false;
  }

  open(id) {
    this.id = id;
    this.sym = getSymbol(id);
    this.active = true;
    this.period = 'trend';
    this.quote = null;
    this.hovering = false;
    // 复用同一个 Detail 实例切换标的时，必须先把上一张图表和挂起的请求作废。
    // 否则 chart 仍指向旧实例，showTab('trend') 会因为「period 未变 && chart 存在」直接 return，
    // 而旧 canvas 已被 buildShell 清出 DOM → 图表区空白。
    this.destroyChart();
    this.reqSeq++;
    this.buildShell();
    this.root.hidden = false;
    this.root.classList.remove('is-closing');

    this.loadQuote();
    this.showTab('trend');
    this.schedulePoll();
  }

  /** 返回按钮：交给外层改路由，由路由回调触发 hide() */
  close() {
    this.onBack?.();
  }

  /** 收起覆盖层（路由驱动） */
  hide() {
    if (!this.active) {
      this.root.hidden = true;
      return;
    }
    this.active = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.destroyChart();
    this.root.classList.add('is-closing');
    setTimeout(() => {
      // 若这 160ms 内又 open 了新标的，绝不能把新内容清掉
      if (this.active) return;
      this.root.hidden = true;
      this.root.classList.remove('is-closing');
      clear(this.root);
    }, 160);
  }

  buildShell() {
    const sym = this.sym;
    clear(this.root);

    const back = h('button.dbar__back', {
      type: 'button',
      'aria-label': '返回',
      html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      onclick: () => this.close(),
    });

    this.nameEl = h('div.dbar__name', { text: sym.name });
    this.metaEl = h('div.dbar__meta', { text: `${codeText(sym.id)} · ${kindLabel(sym)}` });

    const bar = h('div.dbar', {}, [back, h('div.dbar__title', {}, [this.nameEl, this.metaEl])]);

    this.priceEl = h('span.quote__price', { text: '--' });
    this.chgEl = h('span.quote__chg.text-flat', { text: '' });

    this.gridEl = h('dl.quote__grid');
    this.fillGrid(null);

    // 量能行：成交量 / 成交额 / 外盘 / 内盘（实时，随轮询刷新）
    this.volCells = [0, 1, 2, 3].map(() => h('dd', { text: '--' }));
    this.volLabels = [];
    this.volEl = h('dl.quote__grid.quote__grid--vol', {},
      ['成交量', '成交额', '外盘', '内盘'].map((label, i) => {
        const dt = h('dt', { text: label });
        this.volLabels.push(dt);
        return h('div.quote__cell', {}, [dt, this.volCells[i]]);
      }));

    // 五档盘口（只有真正有买卖盘的品种才显示，指数 / 期货自动隐藏）
    this.depthEl = this.buildDepth();

    // 个股：加一条股息率(TTM) 信息行
    this.divEl = null;
    if (sym.kind === 'stock') {
      this.divEl = h('div.quote__div', { text: '股息率(TTM) --' });
    }

    const quote = h('div.quote', {}, [
      h('div.quote__main', {}, [this.priceEl, this.chgEl]),
      this.gridEl,
      this.volEl,
      this.depthEl,
      this.divEl,
    ]);
    this.quoteEl = quote;

    // 子 tab
    const tabs = [
      { key: 'trend', label: '分时' },
      { key: 'day', label: '日K' },
      { key: 'week', label: '周K' },
      { key: 'month', label: '月K' },
    ];
    if (sym.kind === 'etf') tabs.push({ key: 'flow', label: '资金' });

    this.tabEls = new Map();
    const tabbar = h('div.subtabs');
    for (const t of tabs) {
      const btn = h('button.subtab', {
        type: 'button',
        text: t.label,
        onclick: () => this.showTab(t.key),
      });
      this.tabEls.set(t.key, btn);
      tabbar.appendChild(btn);
    }

    this.bodyEl = h('div.chartwrap');

    const wrap = h('div.detail__body', {}, [bar, quote, tabbar, this.bodyEl]);
    this.root.appendChild(wrap);
  }

  fillGrid(q, digits = this.sym.digits || 2) {
    clear(this.gridEl);
    const d = digits;
    const cells = [
      ['今开', q?.open],
      ['昨收', q?.prevClose],
      ['最高', q?.high],
      ['最低', q?.low],
    ];
    for (const [label, v] of cells) {
      this.gridEl.appendChild(h('div.quote__cell', {}, [
        h('dt', { text: label }),
        h('dd', { text: Number.isFinite(v) && v ? fmtPrice(v, d) : '--' }),
      ]));
    }
  }

  /**
   * 五档盘口骨架：左列卖五→卖一（自上而下），右列买一→买五，
   * 成交软件习惯的紧凑双列，高度只占 5 行。
   * 每行固定节点，轮询时只改文本，避免每 5 秒重建 DOM 抖动。
   */
  buildDepth() {
    this.askRows = [];
    this.bidRows = [];
    this.depthRatio = h('span.depth__ratio', { text: '' });

    const col = (labels, sink) => h('div.depth__col', {}, labels.map(label => {
      const p = h('span.depth__p', { text: '--' });
      const v = h('span.depth__v', { text: '--' });
      sink.push({ p, v });
      return h('div.depth__row', {}, [h('span.depth__tag', { text: label }), p, v]);
    }));

    // 卖盘自上而下显示卖五→卖一（价格由高到低，视觉上向现价收拢）
    const askLabels = ['卖五', '卖四', '卖三', '卖二', '卖一'];
    const bidLabels = ['买一', '买二', '买三', '买四', '买五'];

    // 「实时」小胶囊：拖动光标回看历史时盘口仍常驻且继续刷新，
    // 必须标一下它对应的是此刻而不是光标那一刻，否则等于张冠李戴
    this.depthLiveEl = h('em.depth__live', { text: '实时', hidden: true });
    const depthTitle = h('span.depth__title', { text: '五档盘口' });
    depthTitle.appendChild(this.depthLiveEl);

    const el = h('div.depth', { hidden: true }, [
      h('div.depth__head', {}, [depthTitle, this.depthRatio]),
      h('div.depth__grid', {}, [
        col(askLabels, this.askRows),
        col(bidLabels, this.bidRows),
      ]),
    ]);
    return el;
  }

  /** 更新五档 + 委比；没有盘口数据时整块隐藏 */
  paintDepth(q, digits) {
    if (!this.depthEl) return;
    const asks = Array.isArray(q.asks) ? q.asks : [];
    const bids = Array.isArray(q.bids) ? q.bids : [];
    if (!asks.length && !bids.length) {
      this.depthEl.hidden = true;
      return;
    }
    this.depthEl.hidden = false;

    const base = q.prevClose;
    const paintRow = (row, item) => {
      if (!item) {
        row.p.textContent = '--';
        row.v.textContent = '--';
        row.p.className = 'depth__p';
        return;
      }
      row.p.textContent = fmtPrice(item.p, digits);
      // 量以「手」为单位，不足一万时直接显示整数更清爽
      row.v.textContent = item.v >= 1e4 ? fmtVolume(item.v) : String(item.v);
      row.p.className = 'depth__p ' + (base ? dirClass(item.p - base) : '');
    };

    // asks 是买一~卖一正序（下标 0 = 卖一），左列要卖五→卖一，所以反着填
    for (let i = 0; i < 5; i++) paintRow(this.askRows[i], asks[4 - i]);
    for (let i = 0; i < 5; i++) paintRow(this.bidRows[i], bids[i]);

    // 委比 =（委买 − 委卖）/（委买 + 委卖）
    const sumB = bids.reduce((s, x) => s + (x.v || 0), 0);
    const sumA = asks.reduce((s, x) => s + (x.v || 0), 0);
    if (sumA + sumB > 0) {
      const ratio = ((sumB - sumA) / (sumB + sumA)) * 100;
      this.depthRatio.textContent = `委比 ${ratio > 0 ? '+' : ''}${ratio.toFixed(1)}%`;
      this.depthRatio.className = 'depth__ratio ' + dirClass(ratio);
    } else {
      this.depthRatio.textContent = '';
    }
  }

  /** 实时量能：成交量（手）/ 成交额 / 外盘 / 内盘 */
  paintVol(q) {
    if (!this.volCells) return;
    const [vol, amt, outer, inner] = this.volCells;
    // 期货 / 贵金属 / 汇率源里没有量，四项全空时整行收起，别占着一排 --
    const has = q.volume > 0 || q.amount > 0 || q.outer > 0 || q.inner > 0;
    this.volEl.hidden = !has;
    if (!has) return;
    vol.textContent = q.volume > 0 ? `${fmtVolume(q.volume)}手` : '--';
    amt.textContent = q.amount > 0 ? fmtBig(q.amount) : '--';
    outer.textContent = q.outer > 0 ? fmtVolume(q.outer) : '--';
    inner.textContent = q.inner > 0 ? fmtVolume(q.inner) : '--';
    outer.className = q.outer > 0 ? 'text-up' : '';
    inner.className = q.inner > 0 ? 'text-down' : '';
  }

  async loadQuote() {
    const ids = [this.id];
    const map = await getQuotes(ids, { maxAge: 0 });
    const q = map.get(this.id);
    if (!q) return;
    this.quote = q;
    this.paintQuote();
    this.loadDividend(q);
    if (this.period === 'trend' && this.chart instanceof TrendChart) {
      this.chart.patchLast(q.price);
    } else if (this.chart instanceof KlineChart) {
      const st = effectiveState(q, this.sym.market);
      this.chart.syncLast({
        date: quoteDate(q),
        trading: st === 'open' || st === 'post',
        open: q.open,
        price: q.price,
        high: q.high,
        low: q.low,
        // 日线的量是当日累计值可直接对齐；周/月线是区间累计，今日量不能覆盖
        volume: this.period === 'day' ? q.volume : 0,
      });
    }
  }

  /** 个股：异步拉股息率(TTM)，不阻塞报价首屏 */
  async loadDividend(q) {
    if (!this.divEl || !q) return;
    const seq = this.reqSeq;
    const div = await getDividend(this.id, { price: q.price });
    if (seq !== this.reqSeq || !this.active) return; // 已切走别的标的
    clear(this.divEl);
    if (!div) {
      this.divEl.appendChild(h('span', { text: '股息率(TTM) --' }));
      return;
    }
    this.divEl.appendChild(h('span', { text: '股息率(TTM) ' }));
    if (div.yield != null) {
      this.divEl.appendChild(h('span.div-yield', { text: `${div.yield.toFixed(2)}%` }));
    } else {
      this.divEl.appendChild(h('span.div-yield', { text: '--' }));
    }
    if (Number.isFinite(div.dps)) {
      this.divEl.appendChild(h('span', { text: ` · 每股派现 ${div.dps.toFixed(2)}元` }));
    }
  }

  /**
   * 量能 + 五档：永远跟最新一次报价走
   *
   * 这两块描述的是「此刻的委托与成交」，与光标停在哪根 K 线无关，
   * 所以回看历史时不冻结、不隐藏，只把「实时」标点亮，把量能行的
   * 标签从「成交量」换成「今量」，说明它是今日累计而不是光标那根。
   */
  paintLive(q, digits) {
    this.paintVol(q);
    this.paintDepth(q, digits);
    if (this.depthLiveEl) this.depthLiveEl.hidden = !this.hovering;
    if (this.volLabels?.length) {
      const names = this.hovering
        ? ['今量', '今额', '外盘', '内盘']
        : ['成交量', '成交额', '外盘', '内盘'];
      this.volLabels.forEach((dt, i) => { dt.textContent = names[i]; });
    }
  }

  paintQuote() {
    const q = this.quote;
    if (!q) return;
    const maxDigits = this.sym.kind === 'index' ? 2 : 4;
    const digits = Math.min(q.digits ?? this.sym.digits ?? 2, maxDigits);

    // 盘口与量能先更新：即使正在回看历史，它们也要跟着轮询继续动
    this.paintLive(q, digits);
    // 光标压在 K 线上时头部（价格/四格/时间）归光标管，轮询回来也不能顶掉
    if (this.hovering) return;

    tickTo(this.priceEl, q.price, v => fmtPrice(v, digits));
    this.priceEl.className = 'quote__price ' + dirClass(q.pct);

    const chg = `${fmtChange(q.change, digits)}  ${fmtPct(q.pct)}`;
    setText(this.chgEl, chg);
    this.chgEl.className = 'quote__chg ' + dirClass(q.pct);

    this.fillGrid(q, digits);

    const st = effectiveState(q, this.sym.market);
    const t = shortTime(q.time);
    this.metaEl.textContent = `${codeText(this.sym.id)} · ${kindLabel(this.sym)} · ${stateText(st)}${t ? ' · ' + t : ''}`;

    // 内置品种用自己起的短名（「现货黄金」而不是数据源的「伦敦金（现货黄金）」），
    // 搜索添加的标的才用数据源给的权威名称
    if (q.name && !isPreset(this.id) && q.name !== this.nameEl.textContent) {
      this.nameEl.textContent = q.name;
    }
  }

  /**
   * 分时十字光标联动
   * - 大价格换成光标那一分钟的价格，副行给相对昨收的涨跌幅
   * - 四格换成这一分钟真正有意义的四项：均价 / 涨跌额 / 累计量 / 昨收
   * - 传 null 交还实时报价
   */
  onTrendHover(info) {
    if (!this.priceEl) return;

    if (!info) {
      if (!this.hovering) return;
      this.hovering = false;
      this.quoteEl?.classList.remove('is-cursor');
      this.paintQuote();
      return;
    }

    this.hovering = true;
    this.quoteEl?.classList.add('is-cursor');
    // 盘口与量能不再收起：它们跟的是「此刻」，不是光标那一刻，
    // 保持常驻能让主人一边回看走势一边盯着当下的挂单变化
    if (this.depthLiveEl) this.depthLiveEl.hidden = false;
    if (this.volLabels?.length) {
      this.volLabels[0].textContent = '今量';
      this.volLabels[1].textContent = '今额';
    }
    const d = this._digits();
    const pct = Number.isFinite(info.pct) ? info.pct : 0;
    const tint = Math.abs(pct) < 0.005 ? 0 : pct;
    const base = this.chart?.geom?.prevClose ?? this.quote?.prevClose;

    setText(this.priceEl, fmtPrice(info.price, d), info.price);
    this.priceEl.className = 'quote__price ' + dirClass(tint);

    clear(this.chgEl);
    this.chgEl.className = 'quote__chg';
    this.chgEl.append(
      h('span', { class: dirClass(tint), text: `较昨收 ${fmtPct(pct)}` }),
    );

    const cells = [
      ['均价', Number.isFinite(info.avg) && info.avg > 0 ? fmtPrice(info.avg, d) : '--'],
      ['涨跌', Number.isFinite(base) ? fmtChange(info.price - base, d) : '--'],
      ['累计量', fmtVolume(info.cumVol)],
      ['昨收', fmtPrice(base, d)],
    ];
    clear(this.gridEl);
    for (const [label, text] of cells) {
      this.gridEl.appendChild(h('div.quote__cell', {}, [
        h('dt', { text: label }),
        h('dd', { text }),
      ]));
    }

    this.metaEl.textContent = `${codeText(this.sym.id)} · ${kindLabel(this.sym)} · 回看 ${fmtMinuteTime(info.t)}`;
  }

  /**
   * K 线十字光标联动
   * - 大价格换成光标所在那根的收盘价，四格换成「开 / 高 / 低 / 量」
   * - 副行给「当日」与「距今」两个涨跌幅（距今 = 从这根 K 线到今天走出来的幅度）
   * - 传 null 表示光标离开，交还实时报价
   */
  onKlineHover(info) {
    if (!this.priceEl) return;

    if (!info) {
      if (!this.hovering) return;
      this.hovering = false;
      this.quoteEl?.classList.remove('is-cursor');
      this.paintQuote();
      return;
    }

    this.hovering = true;
    this.quoteEl?.classList.add('is-cursor');
    // 同分时：盘口常驻，标注「实时」即可，不再整块隐藏
    if (this.depthLiveEl) this.depthLiveEl.hidden = false;
    if (this.volLabels?.length) {
      this.volLabels[0].textContent = '今量';
      this.volLabels[1].textContent = '今额';
    }
    const d = this._digits();
    // 幅度小于 0.005% 的染红染绿只是噪音，按平盘上灰
    const tint = v => (Math.abs(v) < 0.005 ? 0 : v);
    const dayPct = tint(info.dayPct);
    const gapPct = info.isLast ? 0 : tint(info.gapPct);

    // 光标跟着手指连续跳，420ms 的滚动动画追不上，直接落值
    setText(this.priceEl, fmtPrice(info.close, d), info.close);
    this.priceEl.className = 'quote__price ' + dirClass(dayPct);

    clear(this.chgEl);
    this.chgEl.className = 'quote__chg';
    // 周K / 月K 上「当日」其实是「当周 / 当月」
    const unit = { day: '当日', week: '当周', month: '当月' }[this.period] || '当日';
    this.chgEl.append(
      h('span', { class: dirClass(dayPct), text: `${unit} ${fmtPct(info.dayPct)}` }),
      h('span.quote__gap ' + dirClass(gapPct), {
        text: info.isLast ? '距今 0.00%' : `距今 ${fmtPct(info.gapPct)}`,
      }),
    );

    // K 线上「昨收」没有意义，换成开高低 + 量
    const cells = [
      ['开', fmtPrice(info.open, d)],
      ['高', fmtPrice(info.high, d)],
      ['低', fmtPrice(info.low, d)],
      ['量', fmtVolume(info.volume)],
    ];
    clear(this.gridEl);
    for (const [label, text] of cells) {
      this.gridEl.appendChild(h('div.quote__cell', {}, [
        h('dt', { text: label }),
        h('dd', { text }),
      ]));
    }

    this.metaEl.textContent = `${codeText(this.sym.id)} · ${kindLabel(this.sym)} · 回看 ${info.date}`;
  }

  schedulePoll() {
    clearTimeout(this.timer);
    const loop = async () => {
      if (!this.active) return;
      if (!document.hidden && navigator.onLine) {
        try { await this.loadQuote(); } catch { /* 静默 */ }
      }
      const st = this.quote ? effectiveState(this.quote, this.sym.market) : marketState(this.sym.market);
      const gap = st === 'open' || st === 'pre' || st === 'post' ? 5000 : 30000;
      this.timer = setTimeout(loop, gap);
    };
    this.timer = setTimeout(loop, 5000);
  }

  /** 切换子 tab */
  async showTab(key) {
    if (this.period === key && this.chart) return;
    this.period = key;
    for (const [k, el] of this.tabEls) el.classList.toggle('is-active', k === key);

    // 切走时如果光标还压在旧图上，头部要退回实时
    if (this.hovering) {
      this.hovering = false;
      this.quoteEl?.classList.remove('is-cursor');
      this.paintQuote();
    }

    this.destroyChart();
    clear(this.bodyEl);

    if (key === 'flow') {
      this.flowPanel = renderFlowPanel(this.bodyEl, this.id, this.sym);
      return;
    }

    this.legendEl = h('div.chart-legend');
    this.hostEl = h('div.canvas-host');
    this.stateEl = h('div.chart-state', { text: '加载中…' });
    // K 线模式由 canvas 自绘带数值的 MA 图例，DOM 这份只给分时用，避免重复
    if (key === 'trend') {
      this.bodyEl.appendChild(this.legendEl);
      this.setLegend([
        { color: 'var(--text)', text: '价格' },
        { color: 'var(--chart-ma5)', text: '均价' },
      ]);
    }
    this.bodyEl.appendChild(this.hostEl);
    this.bodyEl.appendChild(this.stateEl);

    const seq = ++this.reqSeq;
    try {
      if (key === 'trend') {
        const data = await getMinute(this.id, { maxAge: 25_000 });
        if (seq !== this.reqSeq) return;
        if (!data.prevClose && this.quote) fillPrevClose(data, this.quote.prevClose);
        this.hideState();
        this.chart = new TrendChart(this.hostEl, {
          digits: this._digits(),
          onHover: info => this.onTrendHover(info),
          // 外汇 / 贵金属是近 24 小时连续报价，没有固定开收盘，刻度按实际数据首尾等分
          timeLabels: (this.sym.market === 'FX' || this.sym.market === 'PM')
            ? fxLabels(data.points)
            : timeLabelsFor(this.sym.market),
        });
        this.chart.setData({
          ...data,
          axisCount: AXIS_COUNT[this.sym.market] || data.points.length,
        });
      } else {
        const bars = await getKline(this.id, key);
        if (seq !== this.reqSeq) return;
        this.hideState();
        this.chart = new KlineChart(this.hostEl, {
          digits: this._digits(),
          onHover: info => this.onKlineHover(info),
        });
        this.chart.setData(bars, { keepView: false });
      }
    } catch (e) {
      if (seq !== this.reqSeq) return;
      this.showState(this.errorText(key, e));
    }
  }

  _digits() {
    const max = this.sym.kind === 'index' ? 2 : 4;
    return Math.min(this.quote?.digits ?? this.sym.digits ?? 2, max);
  }

  errorText(key, e) {
    const msg = String(e?.message || e || '');
    // 日韩指数（CNBC / 东财）只提供实时报价，没有分时与 K 线
    if (this.sym.src === 'global') {
      return key === 'trend' ? '该指数数据源仅提供实时报价' : '该指数暂无 K 线数据';
    }
    if (this.sym.kind === 'forex' && key !== 'trend') return '汇率暂无 K 线数据';
    if (this.sym.kind === 'commodity') return '该品种暂无图表数据';
    if (this.sym.kind === 'futures') return '该品种暂无图表数据';
    if (msg.includes('为空')) return '暂无数据';
    return '加载失败，请稍后重试';
  }

  hideState() {
    if (this.stateEl) this.stateEl.hidden = true;
  }

  showState(text) {
    if (!this.stateEl) return;
    clear(this.stateEl);
    this.stateEl.hidden = false;
    this.stateEl.appendChild(h('div', { text }));
    // 「该指数数据源仅提供实时报价」这类是能力边界，重试也没用，别给假希望
    if (text.includes('仅提供实时报价') || text.includes('暂无 K 线数据')) {
      this.stateEl.onclick = null;
      return;
    }
    this.stateEl.appendChild(h('div.chart-state__hint', { text: '轻点重试' }));
    this.stateEl.onclick = () => {
      this.chart = null;
      this.showTab(this.period === 'flow' ? 'trend' : this.period);
    };
  }

  setLegend(items) {
    if (!this.legendEl) return;
    clear(this.legendEl);
    for (const it of items) {
      this.legendEl.appendChild(h('span.legend-item', {}, [
        h('span.legend-dot', { style: { background: it.color } }),
        h('span', { text: it.text }),
      ]));
    }
  }

  destroyChart() {
    this.hovering = false;
    if (this.flowPanel) {
      this.flowPanel.destroy();
      this.flowPanel = null;
    }
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  /** 主题切换后重绘 */
  repaintTheme() {
    if (this.chart && typeof this.chart.setPalette === 'function') this.chart.setPalette();
  }
}
