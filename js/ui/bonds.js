/**
 * 国债收益率页
 *
 * 结构（自上而下）：
 *   1. Hero —— 中美同期限并排 + 该期限的中美利差，期限可切（2 / 5 / 10 / 30 年）
 *   2. 中国国债四档（2/5/10/30 年）+ 10Y−2Y 期限利差
 *   3. 美国国债四档 + 期限利差
 *
 * 为什么 Hero 的期限切换会连数字一起换：
 *   只切利差的话，上面摆着 10 年、下面写着「2 年利差」，读起来是矛盾的；
 *   所以选中哪个期限，两国的收益率和利差都换成那个期限，一个控件管一块区域。
 *
 * 数据是日频（T+1），所以状态栏显示「数据日期」而不是「盘中」，
 * 轮询也放到 10 分钟一次，没必要按行情节奏刷。
 */

import { h, clear } from '../util/dom.js';
import { shortDate } from '../util/format.js';
import { getYields, peekYields, invalidateYields, bp, TENORS } from '../data/bonds.js';
import { drawYieldLine } from '../chart/yieldline.js';

const REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_TERM = '10';

/** 详情页可选的观察窗口（按交易日根数截尾部） */
const RANGES = [
  { key: '1m', label: '1月', n: 22 },
  { key: '3m', label: '3月', n: 66 },
  { key: '6m', label: '6月', n: 130 },
];

/** 收益率 → 千分位保留 3 位（国债报价习惯：1.648%） */
const fmtYield = v => (Number.isFinite(v) && v > 0 ? v.toFixed(3) : '--');

/** 基点带符号，1 位小数 */
function fmtBp(v) {
  if (!Number.isFinite(v)) return '--';
  if (Math.abs(v) < 0.05) return '0.0bp';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}bp`;
}

/** 收益率上行 → 红（与全站红涨绿跌一致），下行 → 绿 */
function dirText(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return 'text-flat';
  return v > 0 ? 'text-up' : 'text-down';
}

export class Bonds {
  constructor(opt = {}) {
    this.bodyEl = opt.bodyEl;
    this.statusEl = opt.statusEl;

    this.active = false;
    this.data = null;
    this.term = DEFAULT_TERM;   // Hero 当前展示的期限
    this.rangeKey = '3m';       // 走势详情默认看 3 个月
    this.nodes = new Map();     // tenorKey -> { val, chg }
    this.termBtns = new Map();  // tenorKey -> button
    this.timer = 0;
    this.loading = false;

    this.build();
  }

  /* ---------------- 骨架（只建一次） ---------------- */

  build() {
    if (!this.bodyEl) return;
    clear(this.bodyEl);

    // ---- 1. Hero ----
    this.cnLabel = h('span', { text: `中国 ${DEFAULT_TERM} 年` });
    this.usLabel = h('span', { text: `美国 ${DEFAULT_TERM} 年` });

    this.heroCn = h('span.bhero__val', { text: '--' });
    this.heroCnChg = h('span.bhero__chg', { text: '' });
    this.heroUs = h('span.bhero__val', { text: '--' });
    this.heroUsChg = h('span.bhero__chg', { text: '' });
    this.heroSpread = h('strong.bspread__val', { text: '--' });
    this.heroSpreadNote = h('span.bspread__note', { text: '' });

    // 期限切换：一个 segment 控件管住上面整块
    const terms = h('div.bterms', { role: 'group', 'aria-label': '切换期限' },
      TENORS.map(t => {
        const on = t.key === DEFAULT_TERM;
        const btn = h('button.bterm' + (on ? '.is-on' : ''), {
          type: 'button',
          dataset: { term: t.key },
          text: `${t.key}年`,
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => this.setTerm(t.key),
        });
        this.termBtns.set(t.key, btn);
        return btn;
      }));

    const hero = h('section.bhero', {}, [
      h('div.bhero__pair', {}, [
        h('div.bhero__side.bhero__side--tap', {
          role: 'button',
          tabindex: '0',
          onclick: () => this.openDetail('cn', this.term),
        }, [
          h('div.bhero__label', {}, [h('i.bdot.bdot--cn'), this.cnLabel]),
          this.heroCn,
          this.heroCnChg,
        ]),
        h('div.bhero__side.bhero__side--us.bhero__side--tap', {
          role: 'button',
          tabindex: '0',
          onclick: () => this.openDetail('us', this.term),
        }, [
          h('div.bhero__label', {}, [h('i.bdot.bdot--us'), this.usLabel]),
          this.heroUs,
          this.heroUsChg,
        ]),
      ]),
      terms,
      h('div.bhero__foot', {}, [
        h('div.bspread', {}, [
          h('span.bspread__label', { text: '中美利差' }),
          this.heroSpread,
        ]),
        this.heroSpreadNote,
      ]),
    ]);

    // ---- 2/3. 两国分档 ----
    const cnCard = this.makeGridCard('中国国债', 'CN');
    const usCard = this.makeGridCard('美国国债', 'US');

    this.listNote = h('p.bnote', { text: '' });

    this.bodyEl.appendChild(hero);
    this.bodyEl.appendChild(cnCard);
    this.bodyEl.appendChild(usCard);
    this.bodyEl.appendChild(this.listNote);

    // 先用缓存渲染，避免切回页面时数字先变 '--'
    const snap = peekYields();
    if (snap) this.apply(snap);
  }

  /** 切换 Hero 的期限（同时改两国数值与利差） */
  setTerm(key) {
    if (key === this.term) return;
    this.term = key;
    for (const [k, el] of this.termBtns) {
      const on = k === key;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.paint();
  }

  /** 一个国家一组：4 个期限 + 期限利差行 */
  makeGridCard(title, tag) {
    const grid = h('div.bgrid');
    const isCn = tag === 'CN';

    for (const t of TENORS) {
      const valEl = h('span.brow__val', { text: '--' });
      const chgEl = h('span.brow__chg', { text: '' });
      // 点击整行 → 该期限的收益率历史走势（收益率是日频单值，画的是收盘线不是真 K 线）
      const row = h('div.brow.brow--tap', {
        dataset: { tenor: t.key },
        role: 'button',
        tabindex: '0',
        'aria-label': `${isCn ? '中国' : '美国'} ${t.key} 年收益率走势`,
        onclick: () => this.openDetail(isCn ? 'cn' : 'us', t.key),
      }, [
        h('span.brow__term', {}, [
          h('b', { text: t.key }),
          h('em', { text: '年' }),
        ]),
        valEl,
        chgEl,
      ]);
      grid.appendChild(row);
      this.nodes.set((isCn ? 'cn' : 'us') + t.key, { val: valEl, chg: chgEl });
    }

    // 期限利差（10Y - 2Y）单独一行，用横线隔开
    const spreadEl = h('span.brow__val.brow__val--spread', { text: '--' });
    this.nodes.set((isCn ? 'cn' : 'us') + 'spread', { val: spreadEl, chg: null });
    grid.appendChild(h('div.brow.brow--spread', {}, [
      h('span.brow__term', {}, [h('b', { text: '10Y−2Y' })]),
      spreadEl,
      h('span.brow__chg.brow__chg--hint', { text: '期限利差' }),
    ]));

    // 该国的数据日期。两国发布节奏不同（美国 T+1），日期不一致时得写明白，
    // 否则用户会以为美国那半张卡是坏的 / 卡住没刷新。
    const dateEl = h('span.bcard__date', { text: '' });
    if (isCn) this.cnDateEl = dateEl;
    else this.usDateEl = dateEl;

    return h('section.bcard', {}, [
      h('div.bcard__head', {}, [
        h('h2.bcard__title', { text: title }),
        dateEl,
        h('span.bcard__tag' + (isCn ? '' : '.bcard__tag--us'), { text: tag }),
      ]),
      grid,
    ]);
  }

  /* ---------------- 收益率走势详情 ---------------- */

  /**
   * 全屏走势层（懒建，第一次点击才创建）
   *
   * 为什么不复用详情页那套：那边是行情（有价格/涨跌/五档/K线切换），
   * 这里只有一条收益率曲线，硬套会把一堆用不上的控件也带出来。
   */
  ensureDetail() {
    if (this.detailEl) return;

    this.dtTitle = h('div.bd__title', { text: '' });
    this.dtVal = h('span.bd__val', { text: '--' });
    this.dtChg = h('span.bd__chg', { text: '' });
    this.dtDate = h('span.bd__date', { text: '' });
    this.dtCanvas = h('canvas');
    this.dtStats = h('div.bd__stats');
    this.dtNote = h('p.bd__note', { text: '' });
    this.dtChart = h('div.bd__chart', {}, [this.dtCanvas]);

    this.rangeBtns = new Map();
    const rangeBar = h('div.bd__ranges', {}, RANGES.map(r => {
      const btn = h('button.bd__range' + (r.key === this.rangeKey ? '.is-on' : ''), {
        type: 'button',
        text: r.label,
        onclick: () => this.setRange(r.key),
      });
      this.rangeBtns.set(r.key, btn);
      return btn;
    }));

    const back = h('button.bd__back', {
      type: 'button',
      'aria-label': '返回',
      html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
        + '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/></svg>',
      onclick: () => this.closeDetail(),
    });

    this.detailEl = h('div.bd', { hidden: true }, [
      h('div.bd__bar', {}, [back, this.dtTitle]),
      h('div.bd__hero', {}, [this.dtVal, this.dtChg, this.dtDate]),
      rangeBar,
      this.dtChart,
      this.dtStats,
      this.dtNote,
    ]);
    document.body.appendChild(this.detailEl);

    this.onResize = () => { if (!this.detailEl.hidden) this.paintDetail(); };
    window.addEventListener('resize', this.onResize);
  }

  openDetail(country, term) {
    if (!this.data) return;
    this.ensureDetail();
    this.dtCtx = { country, term };
    this.dtHover = null;
    this.dtEnd = null;
    this.detailEl.hidden = false;
    // 先等一帧让 flex 布局生效，canvas 拿到真实尺寸才画得准
    requestAnimationFrame(() => this.paintDetail());
  }

  closeDetail() {
    if (!this.detailEl) return;
    this.detailEl.hidden = true;
  }

  setRange(key) {
    this.rangeKey = key;
    this.dtHover = null;      // 换窗口后旧索引已经指向另一天
    for (const [k, el] of this.rangeBtns) el.classList.toggle('is-on', k === key);
    this.paintDetail();
  }

  paintDetail() {
    const ctx = this.dtCtx;
    const d = this.data;
    if (!ctx || !d || !this.detailEl || this.detailEl.hidden) return;

    const label = ctx.country === 'cn' ? '中国' : '美国';
    this.dtTitle.textContent = `${label} ${ctx.term} 年国债`;

    const key = ctx.country + ctx.term;
    const all = (d.history || [])
      .filter(r => Number.isFinite(r[key]) && r[key] > 0)
      .map(r => ({ date: r.date, v: r[key] }));

    const n = (RANGES.find(r => r.key === this.rangeKey) || RANGES[1]).n;
    const points = all.slice(-n);

    if (points.length < 2) {
      this.dtVal.textContent = '--';
      this.dtChg.textContent = '';
      this.dtDate.textContent = '';
      clear(this.dtStats);
      this.dtStats.appendChild(h('span', { text: '该期限历史数据不足，暂时画不出走势' }));
      this.dtNote.textContent = '';
      return;
    }

    const last = points[points.length - 1];

    // 光标状态跨重绘保留，但窗口滑到新的一天后旧索引指向的是另一天，清掉重来
    this.dtPoints = points;
    if (last.date !== this.dtEnd) { this.dtHover = null; this.dtEnd = last.date; }
    if (Number.isInteger(this.dtHover) && this.dtHover >= points.length) this.dtHover = null;

    // 没开光标就显示末值（与改动前完全一致），开着就显示光标那天
    this.setHero(this.dtHover == null ? points.length - 1 : this.dtHover);

    const vs = points.map(p => p.v);
    const hi = Math.max(...vs);
    const lo = Math.min(...vs);
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const spanBp = bp(last.v, points[0].v);

    clear(this.dtStats);
    const cell = (k, v, cls) => h('div.bd__stat', {}, [
      h('span.bd__stat-k', { text: k }),
      h('span.bd__stat-v' + (cls ? '.' + cls : ''), { text: v }),
    ]);
    this.dtStats.appendChild(cell('最高', `${fmtYield(hi)}%`));
    this.dtStats.appendChild(cell('最低', `${fmtYield(lo)}%`));
    this.dtStats.appendChild(cell('均值', `${fmtYield(avg)}%`));
    this.dtStats.appendChild(cell('区间变化', fmtBp(spanBp), dirText(spanBp)));

    this.dtNote.textContent = `区间 ${shortDate(points[0].date)} ~ ${shortDate(last.date)}，`
      + `共 ${points.length} 个交易日。曲线是到期收益率的每日收盘值，`
      + '收益率上行对应债券价格下跌（红色即收益率走高）。'
      + '副图柱体为每日基点变化。数据来自东方财富公开接口，仅供参考。';

    // 尺寸在隐藏状态下量不到，rAF 里已经布局完成
    drawYieldLine(this.dtCanvas, points, {
      digits: 3,
      hover: this.dtHover,
      // 光标移动只回写上方数字，画面由 yieldline 自己重绘：
      // 这里若再调 paintDetail 会整块重建，拖动时手感会顿
      onHover: i => {
        this.dtHover = i;
        this.setHero(i == null ? points.length - 1 : i);
      },
    });
  }

  /**
   * 上方大数字：收益率 + 当日 bp + 日期
   * @param {number} idx dtPoints 的下标
   */
  setHero(idx) {
    const pts = this.dtPoints;
    if (!pts || !pts.length) return;

    const i = Math.max(0, Math.min(pts.length - 1, idx));
    const cur = pts[i];
    const prev = pts[i - 1];
    const dayBp = prev ? bp(cur.v, prev.v) : NaN;
    const cls = Number.isFinite(dayBp) ? dirText(dayBp) : '';

    this.dtVal.textContent = `${fmtYield(cur.v)}%`;
    this.dtVal.className = 'bd__val ' + cls;
    this.dtChg.textContent = Number.isFinite(dayBp) ? fmtBp(dayBp) : '';
    this.dtChg.className = 'bd__chg ' + cls;
    this.dtDate.textContent = shortDate(cur.date);
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    this.active = true;
    // 页面在后台时 schedule 会跳过刷新，回来后最多要等一个周期；
    // 这里回前台立刻补一次（数据超过 60s 就重新取）
    this.onVisible = () => {
      if (!this.active || document.hidden) return;
      if (!this.data || Date.now() - (this.data.fetchedAt || 0) > 60_000) this.load();
    };
    document.addEventListener('visibilitychange', this.onVisible);
    this.load();
    this.schedule();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    if (this.onVisible) {
      document.removeEventListener('visibilitychange', this.onVisible);
      this.onVisible = null;
    }
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.active) return;
      if (!document.hidden) await this.load();
      this.schedule();
    }, REFRESH_MS);
  }

  async refreshNow() {
    invalidateYields();
    await this.load(true);
  }

  /* ---------------- 数据 ---------------- */

  async load(force = false) {
    if (this.loading) return;
    this.loading = true;
    try {
      const data = await getYields({ force });
      this.apply(data);
    } catch (err) {
      this.setStatus('数据源暂不可达', false);
      if (!this.data) this.paintEmpty();
    } finally {
      this.loading = false;
    }
  }

  apply(data) {
    if (!data) return;
    this.data = data;
    this.paint();
    // 详情开着时跟着刷新（10 分钟一轮，日频数据本就很少变）
    if (this.detailEl && !this.detailEl.hidden) this.paintDetail();

    // 两国发布节奏不同（美国 T+1），日期不一样时分别写出来，
    // 免得看到两个不同日期的人以为是数据错乱
    const { dates, date } = data;
    const lag = !!(dates.cn && dates.us && dates.cn !== dates.us);
    this.setStatus(lag
      ? `中国 ${shortDate(dates.cn)} · 美国 ${shortDate(dates.us)} · 日频`
      : `${shortDate(date)} · 日频`, false);
  }

  /* ---------------- 渲染 ---------------- */

  /** 两国各自的数据日期小标；比对方旧的标成「延后」色 */
  paintDates(d) {
    const newest = [d.dates.cn, d.dates.us].filter(Boolean).sort().pop() || '';
    for (const [el, date] of [[this.cnDateEl, d.dates.cn], [this.usDateEl, d.dates.us]]) {
      if (!el) continue;
      el.textContent = date ? shortDate(date) : '';
      el.classList.toggle('is-lag', !!date && date !== newest);
      el.title = date ? `数据日期 ${date}` : '';
    }
  }

  paint() {
    const d = this.data;
    if (!d) return;
    const { last, prevOf } = d;

    // Hero：跟着当前期限走（否则会出现「10 年数字 + 2 年利差」的矛盾）
    const t = this.term;
    const cnCell = last['cn' + t];
    const usCell = last['us' + t];
    const cn = cnCell ? cnCell.v : null;
    const us = usCell ? usCell.v : null;
    const cnBp = cnCell ? bp(cn, prevOf['cn' + t]) : null;
    const usBp = usCell ? bp(us, prevOf['us' + t]) : null;

    this.cnLabel.textContent = `中国 ${t} 年`;
    this.usLabel.textContent = `美国 ${t} 年`;

    this.heroCn.textContent = fmtYield(cn);
    this.heroCn.className = 'bhero__val ' + dirText(cnBp);
    this.heroCnChg.textContent = fmtBp(cnBp);
    this.heroCnChg.className = 'bhero__chg ' + dirText(cnBp);

    this.heroUs.textContent = fmtYield(us);
    this.heroUs.className = 'bhero__val ' + dirText(usBp);
    this.heroUsChg.textContent = fmtBp(usBp);
    this.heroUsChg.className = 'bhero__chg ' + dirText(usBp);

    if (Number.isFinite(cn) && Number.isFinite(us)) {
      const diff = (cn - us) * 100;
      this.heroSpread.textContent = fmtBp(diff);
      // 利差的负号是「水平差」不是「涨跌」，染红绿会被读成在跌，保持中性高对比色
      this.heroSpread.className = 'bspread__val';
      // 两边日期不同时，利差本身是「跨日相减」，必须点明
      const mixed = d.dates.cn !== d.dates.us;
      this.heroSpreadNote.textContent = (diff < 0 ? '中国低于美国' : '中国高于美国')
        + (mixed ? `（美方数据 ${shortDate(d.dates.us)}）` : '');
    } else {
      this.heroSpread.textContent = '--';
      this.heroSpreadNote.textContent = '';
    }

    // 分档
    for (const ten of TENORS) {
      this.setRow('cn' + ten.key, last[ten.cn], bp(last[ten.cn]?.v, prevOf[ten.cn]));
      this.setRow('us' + ten.key, last[ten.us], bp(last[ten.us]?.v, prevOf[ten.us]));
    }
    // 期限利差用接口自己给的值（与「10年−2年」直接相减可能因四舍五入差 0.1bp）
    this.setSpread('cn', last.cnSpread);
    this.setSpread('us', last.usSpread);

    this.paintDates(d);

    this.listNote.textContent = '口径：中国为银行间国债到期收益率，美国为国债恒定到期收益率，'
      + `均为日频。中国最新一期 ${shortDate(d.dates.cn)}，美国最新一期 ${shortDate(d.dates.us)}`
      + '——美国国债按美东时间收盘后发布，通常比中国晚一个交易日，'
      + '两边日期不同属正常。收益率上行 = 债券价格下跌，红色即收益率走高。'
      + '中美利差 = 同一期限的中国收益率 − 美国收益率。'
      + '数据来自东方财富公开接口，仅供参考，不构成投资建议。';
  }

  setRow(key, cell, change) {
    const node = this.nodes.get(key);
    if (!node) return;
    const ok = !!cell && Number.isFinite(cell.v) && cell.v > 0;
    node.val.textContent = ok ? `${fmtYield(cell.v)}%` : '--';
    node.val.className = 'brow__val ' + (ok ? dirText(change) : 'text-flat');
    if (node.chg) {
      node.chg.textContent = ok ? fmtBp(change) : '';
      node.chg.className = 'brow__chg ' + dirText(change);
    }
  }

  setSpread(key, cell) {
    const node = this.nodes.get(key + 'spread');
    if (!node) return;
    const ok = !!cell && Number.isFinite(cell.v);
    // 接口给的是百分点，换成基点更好读
    node.val.textContent = ok ? `${(cell.v * 100).toFixed(1)}bp` : '--';
    // 期限利差没有涨跌语义，正负只代表陡峭 / 倒挂，用中性色
    node.val.className = 'brow__val brow__val--spread' + (ok ? '' : ' text-flat');
  }

  paintEmpty() {
    this.heroCn.textContent = '--';
    this.heroUs.textContent = '--';
    this.heroSpread.textContent = '--';
    for (const node of this.nodes.values()) {
      node.val.textContent = '--';
      if (node.chg) node.chg.textContent = '';
    }
    for (const el of [this.cnDateEl, this.usDateEl]) {
      if (el) { el.textContent = ''; el.classList.remove('is-lag'); }
    }
    this.listNote.textContent = '暂时取不到国债收益率数据，下拉可重试。';
  }

  setStatus(text, live) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.dataset.live = live ? '1' : '0';
  }

  /** 主题切换后重绘（颜色取自 CSS 变量的元素只需重新 paint，没有 canvas 了） */
  repaint() {
    this.paint();
    // 主题切换时如果走势页正开着，画布也要跟着换色：
    // 调色板是在绘制那一刻读的，不重绘就会一直停在旧主题的底色上
    if (this.detailEl && !this.detailEl.hidden) this.paintDetail();
  }

  destroy() {
    this.stop();
    if (this.onResize) {
      window.removeEventListener('resize', this.onResize);
      this.onResize = null;
    }
    this.detailEl?.remove();
    this.detailEl = null;
  }
}
