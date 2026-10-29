/**
 * 「行情分析」页
 *
 * v1.34 版式重做：从「统计体检报告」改回看盘工具。
 *
 * 一屏之内只回答三个问题
 *   1 今天像历史上的哪几天（60 个最相似的交易日）
 *   2 那些天之后 5 / 20 / 60 日怎么走的（分布 + 上涨概率）
 *   3 具体是哪几天（可展开看明细）
 *
 * 统计口径、校准结果、参数怎么选的，全部收进底部可展开的「方法」里，
 * 不再占正文版面 —— 该被验证的是结论，不是过程。
 */
import { h } from '../util/dom.js';
import { getArms, fetchBars, adjustVolumeRatio, QUAD } from '../data/analysis.js';
import { getQuotes } from '../data/quotes.js';
import { fmtPrice, fmtBig } from '../util/format.js';

/**
 * 历史库（105KB）改成按需加载。
 *
 * 之前是静态 import，main.js 一 import Analysis 就把 analog.js →
 * analysis-history.js 整条链拉进首屏：实测停在自选页、一次没进过分析页，
 * 也会下载 105KB。改成进入本页 refresh 时才 import，首屏省掉这 14%。
 *
 * INDICES / HORIZONS 是纯常量，留在本地，不必等模块。
 */
const INDICES = [
  { id: 'sh000001', name: '上证指数', short: '上证' },
  { id: 'sz399001', name: '深证成指', short: '深证' },
  { id: 'sz399006', name: '创业板指', short: '创业板' },
];
const HORIZONS = [5, 20, 60];

let ANALOG = null;
function analogMod() {
  if (!ANALOG) ANALOG = import('../data/analog.js');
  return ANALOG;
}

/** 与历史库同源；量比变化很慢，60 秒一轮足够 */
const REFRESH_MS = 60 * 1000;
const SHOW_ROWS = 8;

const signed = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '--');
const signedPct = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '--');
const plain = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const intPct = v => (Number.isFinite(v) ? Math.round(v) + '%' : '--');
const dirClass = v => (!Number.isFinite(v) || Math.abs(v) < 1e-9 ? 'text-flat' : (v > 0 ? 'text-up' : 'text-down'));

function phaseLabel() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return '休市';
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const AM0 = 9 * 60 + 30;
  const AM1 = 11 * 60 + 30;
  const PM0 = 13 * 60;
  const PM1 = 15 * 60;
  let el = 0;
  if (m > AM0 && m <= AM1) el = m - AM0;
  else if (m > AM1 && m <= PM0) el = 120;
  else if (m > PM0 && m <= PM1) el = 120 + (m - PM0);
  else if (m > PM1) el = 240;
  if (el >= 240) return '已收盘';
  if (el > 0) return '盘中';
  if (m < 9 * 60 + 15) return '盘前';
  if (m <= 9 * 60 + 30) return '集合竞价';
  if (m < 13 * 60) return '午间休市';
  return '盘前';
}

const shortDay = d => (d ? d.slice(5) : '');
const agoText = d => (d >= 365 ? `${(d / 365).toFixed(1)} 年前`
  : d >= 45 ? `${Math.round(d / 30)} 个月前`
    : `${Math.max(1, d)} 天前`);


/**
 * 卡片底部说明。哪几档淡出、为什么淡出、概率数值能不能当真，
 * 全按这只指数自己的校准结果生成——不同指数差别很大，
 * 写死「5 日与 60 日淡着显示」不一定对。
 */
function noteText(d, c20, numOk, rankOk) {
  const parts = [
    `这三行是那 ${d.kUsed} 天之后真实发生过的涨跌：粗条 = 中间一半，细线 = 九成范围，竖线 = 中位。`,
    `20 日这一档最差 ${signedPct(d.stats[20].worst, 1)}、最好 ${signedPct(d.stats[20].best, 1)}。`,
  ];

  const cal = d.calib || {};
  const weak = HORIZONS.filter(hz => {
    const c = cal[`h${hz}`];
    return (!c || c.gain < 2) && (!c || c.ic < 0.30);
  });

  if (rankOk && !numOk && c20) {
    // 压到一句：这段本来就长，再铺开就占六七行，用户会跳过
    parts.push(`这个指数波动大，概率数值不够准（Brier 只改善 ${c20.gain.toFixed(1)}%），`
      + `但高低排序有效（秩相关 ${c20.ic.toFixed(2)}），看相对高低就好。`);
  }

  if (weak.length) {
    const names = weak.map(hz => `${hz} 日`).join('、');
    parts.push(`${names}淡着显示，那几档历史上和抛硬币差不多。`);
  }

  return parts.join('');
}

/**
 * 「哪几档不能当真」——按这只指数自己的校准结果说。
 * 写死「5 日与 60 日接近 50/50」不一定对：不同指数的校准差别很大，
 * 说法必须跟着各自数据走。
 */
function weakDesc(d) {
  const cal = d.calib || {};
  const bad = [];        // 数值与排序都不行
  const rankOnly = [];   // 数值不行、但排序有效
  const solid = [];      // 数值站得住

  for (const hz of HORIZONS) {
    const c = cal[`h${hz}`];
    if (!c) { bad.push(hz); continue; }
    if (c.gain >= 2) solid.push(hz);
    else if (c.ic >= 0.30) rankOnly.push(hz);
    else bad.push(hz);
  }

  const list = xs => xs.map(hz => `${hz} 日`).join('、');
  const parts = [];
  if (bad.length) parts.push(`${list(bad)}这${bad.length > 1 ? '几' : '一'}档的校准和抛硬币差不多`);
  if (rankOnly.length) {
    parts.push(`${list(rankOnly)}这一档概率的数值偏弱、但高低排序有效，只看相对高低`);
  }
  if (solid.length) parts.push(`${list(solid)}这档的概率数值才值得看`);
  if (!bad.length && !rankOnly.length) return '三档的校准都优于抛硬币，但仍不足以当信号';
  return parts.join('；');
}

export class Analysis {
  constructor({ bodyEl, statusEl }) {
    this.bodyEl = bodyEl;
    this.statusEl = statusEl;
    this.indexId = 'sh000001';
    this.active = false;
    this.timer = 0;
    this.seq = 0;
    this.data = null;
    this.arms = null;
    this.armsLoading = false;
    this.error = null;
    this.expanded = false;
    this.volumeScaled = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (!this.data) this.paint();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.timer = 0;
  }

  refreshNow() {
    return this.refresh({ force: true });
  }

  setIndex(id) {
    if (id === this.indexId) return;
    this.indexId = id;
    this.data = null;
    this.expanded = false;
    this.error = null;
    this.paint();
    this.refresh({ force: true });
  }

  async refresh(opt = {}) {
    if (!this.active && !opt.force) return;
    const seq = ++this.seq;
    try {
      const [bars, barsSh, barsCyb, quotes] = await Promise.all([
        fetchBars(this.indexId),
        fetchBars('sh000001'),
        fetchBars('sz399006'),
        getQuotes([this.indexId], { maxAge: 3000 }),
      ]);
      if (seq !== this.seq) return;

      const q = quotes.get(this.indexId);
      if (!q || !q.valid) throw new Error('指数报价不可用');

      const M = await analogMod();
      if (seq !== this.seq) return;
      const tv = M.todayVector(bars, barsSh, barsCyb);
      if (!tv) throw new Error('日线不足 21 根，算不出特征');

      // 盘中量比要折算成收盘口径，否则跟历史比没有意义
      const adj = adjustVolumeRatio(tv.vr);
      const today = { ...tv, vr: adj.vr, f: [tv.f[0], adj.vr, tv.f[2], tv.f[3], tv.f[4]] };

      const res = M.analogs(this.indexId, today);
      if (!res) throw new Error('历史样本不足');

      this.volumeScaled = adj.scaled;
      this.hMeta = M.historyMeta();
      this.data = {
        ...res,
        price: q.price, pct: q.pct, change: q.change, amount: q.amount, time: q.time,
      };
      this.error = null;
      this.paint();
      this.loadArms();
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = err && err.message ? err.message : '取数失败';
      this.paint();
    }
  }

  async loadArms() {
    if (this.armsLoading) return;
    this.armsLoading = true;
    const prev = this.arms;
    try {
      const arms = await getArms();
      if (arms) this.arms = arms;
    } catch {
      /* 拿不到就显示 -- */
    } finally {
      this.armsLoading = false;
    }
    const cur = this.arms;
    const changed = !prev !== !cur || (cur && (!prev || prev.arms !== cur.arms || prev.up !== cur.up));
    if (this.active && changed) this.paint();
  }

  repaintTheme() {
    this.paint();
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  // ---------------------------------------------------------------- 渲染

  paint() {
    if (!this.bodyEl) return;
    const top = this.bodyEl.scrollTop;
    this.bodyEl.replaceChildren();

    this.bodyEl.appendChild(this.buildTabs());

    if (this.error && !this.data) {
      this.bodyEl.appendChild(h('div.an-empty', {}, [
        h('p.an-empty__title', { text: '暂时取不到该指数的数据' }),
        h('p.an-empty__sub', { text: this.error }),
      ]));
      this.setStatus('连接中断');
      this.bodyEl.scrollTop = top;
      return;
    }

    if (!this.data) {
      this.bodyEl.appendChild(h('div.an-skel', {}, [
        h('div.an-skel__card'), h('div.an-skel__card'), h('div.an-skel__card'),
      ]));
      this.setStatus('连接中');
      this.bodyEl.scrollTop = top;
      return;
    }

    const d = this.data;
    this.bodyEl.appendChild(this.buildHero(d));
    this.bodyEl.appendChild(this.buildAnalog(d));
    // 「最像的那几天」明细表按需求隐藏。buildList 与 this.expanded 都还在，
    // 想恢复只把这行打开即可——它只是主卡的佐证，删掉不影响结论。
    this.bodyEl.appendChild(this.buildQuad(d));
    this.bodyEl.appendChild(this.buildMethod(d));
    this.bodyEl.appendChild(this.buildFoot(d));

    this.setStatus(this.error
      ? `取数失败 · 仍是 ${shortDay(d.asOf)} 的数据`
      : `${phaseLabel()} · ${shortDay(d.asOf)}`);
    this.bodyEl.scrollTop = top;
  }

  buildTabs() {
    const bar = h('div.an-tabs', { role: 'tablist', 'aria-label': '选择指数' });
    for (const it of INDICES) {
      const on = it.id === this.indexId;
      bar.appendChild(h('button.an-tab' + (on ? '.is-active' : ''), {
        type: 'button',
        role: 'tab',
        text: it.short,
        'aria-selected': String(on),
        onclick: () => this.setIndex(it.id),
      }));
    }
    return bar;
  }

  buildHero(d) {
    const hasArms = this.arms && Number.isFinite(this.arms.arms);
    const meta = INDICES.find(x => x.id === this.indexId) || INDICES[0];
    return h('div.an-hero', {}, [
      h('div.an-hero__top', {}, [
        h('div.an-hero__name', {}, [
          h('span', { text: meta.name }),
          h('span.an-badge', { text: '相似日' }),
        ]),
        h('span.an-hero__time', {
          text: phaseLabel() === '盘前' || phaseLabel() === '休市'
            ? `${shortDay(d.asOf)} 收盘`
            : phaseLabel(),
        }),
      ]),

      h('div.an-hero__price', {}, [
        h('strong', { text: fmtPrice(d.price, 2) }),
        h('span.an-hero__pct.' + dirClass(d.pct), { text: signedPct(d.pct) }),
      ]),

      h('div.an-hero__grid', {}, [
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: d.amount > 0 ? fmtBig(d.amount) : '--' }),
          h('span.an-hero__note', { text: '成交额' }),
        ]),
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: plain(d.today.vr) }),
          h('span.an-hero__note', { text: this.volumeScaled ? '量比 · 折算' : '量比' }),
        ]),
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: signed(d.today.rs, 1) }),
          h('span.an-hero__note', { text: '相对强弱' }),
        ]),
        h('div.an-cell', {}, [
          h('strong.an-hero__num' + (hasArms ? '' : '.is-muted'), {
            text: hasArms ? this.arms.arms.toFixed(2) : '--',
          }),
          h('span.an-hero__note', {
            text: hasArms ? `${this.arms.up}涨 ${this.arms.down}跌` : '全 A 广度',
          }),
        ]),
      ]),
    ]);
  }

  /** 主卡：60 个相似日之后怎么走 */
  buildAnalog(d) {
    const s20 = d.stats[20];
    const calOf = hz => (d.calib && d.calib[`h${hz}`] ? d.calib[`h${hz}`] : null);
    const c20 = calOf(20);

    // 「有用」是两件事，别混成一个判据：
    //   gain（Brier 改善）高 = 概率的数值准，可以说「六成会涨」
    //   ic（排序稳定）高      = 高低排序准，只能说「这格比那格强」
    // 两者不一定同向：出现过 gain 只有 0.7% 但 ic 0.47 的指数，只看 gain
    // 会把三档全部淡出，等于页面上什么都不给。
    const numOk = (c20 ? c20.gain : 0) >= 5;
    const rankOk = (c20 ? c20.ic : 0) >= 0.30;
    const tag = numOk
      ? { text: '20 日这档较可靠', cls: '.is-ok' }
      : rankOk
        ? { text: '排序可用 · 数值偏弱', cls: '' }
        : { text: '信号偏弱', cls: '' };

    // 三行共用一条刻度，才看得出长短
    const lo = Math.min(...HORIZONS.map(x => d.stats[x].p10), 0);
    const hi = Math.max(...HORIZONS.map(x => d.stats[x].p90), 0);
    const pad = (hi - lo) * 0.08 || 1;
    const min = lo - pad;
    const max = hi + pad;
    const span = (max - min) || 1;
    const pos = v => ((v - min) / span) * 100;
    // 刻度标的是细线两端（10%~90% 分位），不是加了留白的画布边界
    const scaleLo = Math.min(...HORIZONS.map(x => d.stats[x].p10));
    const scaleHi = Math.max(...HORIZONS.map(x => d.stats[x].p90));

    const rows = HORIZONS.map(hz => {
      const s = d.stats[hz];
      const c = calOf(hz);
      // 数值与排序都弱才淡出。只看 Brier 会把「排序强、数值弱」的指数整行抹掉，
      // 那反而丢了它唯一有价值的部分。
      const weak = (c ? c.gain : 0) < 2 && (c ? c.ic : 0) < 0.30;
      return h('div.an-bar' + (weak ? '.is-weak' : ''), {}, [
        h('div.an-bar__top', {}, [
          h('span.an-bar__k', { text: `${hz} 日后` }),
          h('span.an-bar__up', { text: `${intPct(s.up)} 上涨` }),
          h('span.an-bar__v.' + dirClass(s.p50), { text: signedPct(s.p50, 1) }),
        ]),
        h('div.an-track', {}, [
          h('i.an-track__bed'),
          h('i.an-track__zero', { style: { left: pos(0) + '%' } }),
          h('i.an-track__range', { style: { left: pos(s.p10) + '%', width: (pos(s.p90) - pos(s.p10)) + '%' } }),
          h('i.an-track__box' + (s.p50 >= 0 ? '.is-up' : '.is-down'), {
            style: { left: pos(s.p25) + '%', width: Math.max(2, pos(s.p75) - pos(s.p25)) + '%' },
          }),
          h('i.an-track__med', { style: { left: pos(s.p50) + '%' } }),
        ]),
      ]);
    });

    return h('div.an-card.an-card--analog', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: `历史上和今天最像的 ${d.kUsed} 天` }),
        h('span.an-tag' + tag.cls, { text: tag.text }),
      ]),

      h('div.an-lead', {}, [
        h('p.an-lead__cap', { text: `这 ${d.kUsed} 天，20 个交易日之后` }),
        h('div.an-lead__row', {}, [
          h('strong.an-lead__num', { text: intPct(s20.up) }),
          h('span.an-lead__unit', { text: '是涨的' }),
        ]),
        h('p.an-lead__sub', {}, [
          h('span', { text: '中位 ' }),
          h('em.' + dirClass(s20.p50), { text: signedPct(s20.p50, 1) }),
          h('span', { text: `，一半的结果落在 ${signedPct(s20.p25, 1)} 到 ${signedPct(s20.p75, 1)} 之间` }),
        ]),
      ]),

      h('div.an-bars', {}, [
        h('div.an-bar.an-bar--legend', {}, [
          h('div.an-bar__top', {}, [
            h('span.an-bar__k', { text: '' }),
            h('span.an-bar__up', { text: '上涨概率' }),
            h('span.an-bar__v', { text: '中位涨跌' }),
          ]),
        ]),
        ...rows,
      ]),

      h('div.an-scale', {}, [
        h('span', { text: signedPct(scaleLo, 1) }),
        h('span', { text: '0' }),
        h('span', { text: signedPct(scaleHi, 1) }),
      ]),

      h('p.an-card__note', {
        text: noteText(d, c20, numOk, rankOk),
      }),
    ]);
  }

  buildList(d) {
    const rows = this.expanded ? d.rows : d.rows.slice(0, SHOW_ROWS);
    const item = r => h('div.an-sim', {}, [
      h('div.an-sim__main', {}, [
        h('span.an-sim__date', { text: shortDay(r.date) }),
        h('span.an-sim__pct.' + dirClass(r.pct), { text: signedPct(r.pct) }),
        h('span.an-sim__fwd.' + dirClass(r.h20), { text: `20日后 ${signedPct(r.h20, 1)}` }),
      ]),
      h('div.an-sim__sub', {}, [
        h('span', { text: `量比 ${plain(r.vr)}` }),
        h('span.an-dot', { text: '·' }),
        h('span', { text: `强弱 ${signed(r.rs, 1)}` }),
        h('span.an-dot', { text: '·' }),
        h('span', { text: agoText(r.calDays) }),
      ]),
    ]);

    return h('div.an-card', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: '最像的那几天' }),
        h('span.an-card__hint', { text: '按相似度排序' }),
      ]),
      h('div.an-sims', {}, rows.map(item)),
      d.rows.length > SHOW_ROWS
        ? h('button.an-more', {
          type: 'button',
          text: this.expanded ? '收起' : `展开全部 ${d.rows.length} 天`,
          onclick: () => {
            this.expanded = !this.expanded;
            this.paint();
          },
        })
        : null,
    ]);
  }

  /** 四象限参照：今天站在哪一类 */
  buildQuad(d) {
    const q = QUAD[d.quadKey];
    const rows = ['1-1', '1-0', '0-1', '0-0'].map(key => {
      const stat = d.quad && d.quad[key];
      if (!stat) return null;
      const cur = key === d.quadKey;
      return h('div.an-qt' + (cur ? '.is-cur' : ''), {}, [
        h('span.an-qt__name', {}, [
          h('em', { text: QUAD[key].code }),
          h('i', { text: QUAD[key].name }),
        ]),
        h('span.an-qt__up', { text: intPct(stat.up) }),
        h('span.an-qt__med.' + dirClass(stat.med), { text: signedPct(stat.med, 1) }),
        h('span.an-qt__n', { text: String(stat.n) }),
      ]);
    }).filter(Boolean);

    return h('div.an-card.an-card--quad', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: '今天站在哪一类' }),
        h('span.an-pill', { text: q ? `${q.code} ${q.name}` : '--' }),
      ]),
      h('div.an-qts', {}, [
        h('div.an-qt.an-qt--head', {}, [
          h('span', { text: '方向 × 强弱' }), h('span', { text: '20日涨' }),
          h('span', { text: '中位' }), h('span', { text: 'n' }),
        ]),
        ...rows,
      ]),
      h('p.an-card__note', {
        text: '四类只做定位用：同样是「跌」，小盘强与小盘弱之后的表现并不一样，'
          + '但单看类别远不如上面那 60 个相似日具体。',
      }),
    ]);
  }

  /** 方法：参数、校准、局限。默认收起 */
  buildMethod(d) {
    const cal = d.calib || {};
    const c20 = cal.h20 || null;

    const binRow = b => h('div.an-cal__row', {}, [
      h('span', { text: `${Math.round(b[0] * 100)}~${Math.round(Math.min(b[1], 1) * 100)}%` }),
      h('span', { text: String(b[2]) }),
      h('span', { text: `${b[3]}%` }),
      h('span', { text: `${b[4]}%` }),
    ]);

    const calBlock = c20 && c20.bins.length ? h('div.an-cal', {}, [
      h('div.an-cal__row.an-cal__row--head', {}, [
        h('span', { text: '预测收涨' }), h('span', { text: '样本' }),
        h('span', { text: '预测' }), h('span', { text: '实际' }),
      ]),
      ...c20.bins.map(binRow),
    ]) : null;

    const m = this.hMeta;
    return h('details.an-method', {}, [
      h('summary.an-method__sum', { text: '方法 · 这 60 天是怎么挑出来的' }),
      h('div.an-method__body', {}, [
        h('p.an-method__p', {
          text: '把今天和历史上每一个交易日都放进同一个五维空间，算距离，取最近的 60 天。'
            + '五个维度是：当日涨跌幅、量比、20 日动量、20 日波动、20 日相对强弱（创业板 − 上证，'
            + '衡量的是当时资金偏小盘还是偏大盘，三只指数共用同一条）。'
            + '每个维度都按历史分布标准化，所以「涨 2%」和「量比 1.2」不会因为量纲不同而失衡。',
        }),
        h('p.an-method__p', {
          text: `两条硬规则：相似的交易日之间至少隔 ${m.gap} 个交易日（相邻日几乎是同一段行情，`
            + '不隔开的话 60 个邻居其实只有十来个独立样本）；候选日必须「60 个交易日的收益都走完」，'
            + '这样三个持有期看的是同一批日子。',
        }),
        calBlock,
        c20 ? h('p.an-method__p', {
          text: '上表是走查结果：把预测的「收涨概率」分四档，看实际兑现了多少。'
            + `按 Brier 分数算，比「永远猜 50%」好 ${c20.gain.toFixed(1)}%；`
            + `预测中位与实际的秩相关 ${c20.ic.toFixed(2)}；`
            + `把预测最强与最弱的 1/5 分开，实际差 ${signedPct(c20.spread, 1)}。`
            + `样本 ${c20.n} 个交易日。`,
        }) : null,
        h('p.an-method__p.an-method__p--warn', {
          text: '三条边界：① 概率是「历史上相似日子的频率」，不是未来概率，市场环境换了就不可比；'
            + `② ${weakDesc(d)}；`
            + `③ 历史库截止 ${m.lastDate}，之后的新交易日只会被匹配、不会进库，更新要重新生成数据文件。`,
        }),
      ]),
    ]);
  }

  buildFoot(d) {
    const m = this.hMeta;
    const nb = text => h('span.an-nb', { text });
    const out = [
      h('p', {}, [
        '历史库 ', nb(m.from), ' 至 ', nb(m.lastDate), `（${m.bars} 个交易日）。能参与匹配的是 `,
        nb(m.poolFrom), ' 至 ', nb(m.poolTo), '——最后 60 个交易日要先等收益走完。',

      ]),
    ];
    if (m.ageDays > 0) {
      out.push(h('p.an-foot__warn', {}, [
        '注意：这份历史库停在 ', nb(m.lastDate), `，已经 ${m.ageDays} 天没有更新。`
        + '页面照旧用它做匹配，但越久越不准，要重新生成数据文件才会滚到最新。',
      ]));
    }
    out.push(h('p', {
      text: '这 60 天之后的涨跌是已经发生的历史，不是对未来的预测。样本有限、市场环境会变，'
        + '未计交易成本与冲击成本，指数本身也不可直接交易。',
    }));
    return h('div.an-foot', {}, out);
  }
}
