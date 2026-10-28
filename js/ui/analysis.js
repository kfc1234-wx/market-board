/**
 * 「行情分析」页
 *
 * 版式对齐常见的「指数复盘 · 三因子模型」：指数卡 / 今日状态 / 研究基准 /
 * 四象限坐标 / 模型判读。数据分两路：
 *   静态  —— analysis-data.js 里 16 格的历史赔率（8 年日线分层统计）
 *   实时  —— 今天落进哪一格（报价 + 前 5 日均量 + 创业板对上证的溢价）
 * 两路都到位才可能显示赔率；实时没算出来就退化成「数据不足」，不猜。
 *
 * 与截图的一处刻意不同：ARMS 只作展示，不参与状态判定。
 * 历史全 A 家数与成交额拿不到，硬塞进因子会让「历史样本」与「今日状态」
 * 不是同一套算法，那才是真正的错误。
 */

import { h, clear } from '../util/dom.js';
import { fmtPct, fmtPrice, fmtBig, dirClass } from '../util/format.js';
import {
  getAnalysis, getArms, peekAnalysis, ANALYSIS_INDICES, sessionElapsed,
} from '../data/analysis.js';

/** 量比变化很慢，60 秒一轮足够；ARMS 走 breadth 的 25 秒缓存，这里不催 */
const REFRESH_MS = 60 * 1000;

const VOL = ['', '极缩量', '缩量', '放量', '巨量'];
const QUAD_NAME = {
  '1-1': '风险偏好上行',
  '1-0': '权重护盘',
  '0-1': '结构分化',
  '0-0': '系统性走弱',
};

const signed = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '--');
/** 百分点：赔率与超额都带 %，不带会看成绝对收益 */
const signedPct = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '--');
const plain = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const pctInt = v => (Number.isFinite(v) ? Math.round(v) + '%' : '--');

/** 当前处于哪个时段（只用于界面上那行小字） */
function phaseLabel() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return '休市';
  const m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const el = sessionElapsed();
  if (el >= 240) return '已收盘';
  if (el > 0) return '盘中';
  if (m < 9 * 60 + 15) return '盘前';
  if (m <= 9 * 60 + 30) return '集合竞价';
  if (m < 13 * 60) return '午间休市';
  return '盘前';
}

const shortDay = ts => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 三档赔率里最有优势的那一档 */
function bestHorizon(sample) {
  if (!sample) return null;
  const rows = [[5, sample.h5], [20, sample.h20], [60, sample.h60]]
    .filter(x => Array.isArray(x[1]));
  if (!rows.length) return null;
  rows.sort((a, b) => b[1][0] - a[1][0]);
  return { days: rows[0][0], ex: rows[0][1][0], win: rows[0][1][1] };
}

/** 偏强 / 偏弱 · 短期 / 中期 */
function stance(sample) {
  if (!sample) return { text: '样本不足', tone: 'flat' };
  const b = bestHorizon(sample);
  if (!b) return { text: '样本不足', tone: 'flat' };
  const tone = b.ex > 0.25 ? 'up' : (b.ex < -0.25 ? 'down' : 'flat');
  const word = b.days <= 5 ? '短期' : (b.days <= 20 ? '短期偏中' : '中期');
  const label = tone === 'up' ? '偏强' : (tone === 'down' ? '偏弱' : '中性');
  return { text: `${label} · ${word}`, tone };
}

/** 当前状态在 16 格里按 T+20 超额排第几（1 = 最强） */
function stateRank(d) {
  const t = d.table;
  if (!t || !d.sample) return null;
  const rows = Object.entries(t.states)
    .filter(([, v]) => Array.isArray(v.h20))
    .sort((a, b) => b[1].h20[0] - a[1].h20[0]);
  const i = rows.findIndex(([k]) => k === d.stateKey);
  return i < 0 ? null : i + 1;
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
    this.armsEl = null;
    this.armsNoteEl = null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (!this.data) this.paint();   // 先出骨架，别让首屏白着
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
    this.data = peekAnalysis(id);
    this.error = null;
    this.paint();
    this.refresh({ force: true });
  }

  async refresh(opt = {}) {
    if (!this.active && !opt.force) return;
    const seq = ++this.seq;

    try {
      const data = await getAnalysis(this.indexId, opt);
      if (seq !== this.seq) return;      // 切了指数，旧请求作废
      this.data = data;
      this.error = null;
      this.paint();
      this.loadArms();
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = err && err.message ? err.message : '取数失败';
      this.paint();
    }
  }

  /**
   * ARMS 单独一路：它要拉全 A 五千多只，比指数慢一个量级。
   * 不能让它卡住主卡渲染，所以异步补。
   *
   * 不按 seq 丢弃结果：ARMS 是全市场广度，跟当前看哪只指数无关。
   * 早先按 seq 判，60 秒刷新定时器的 ++seq 一撞上就算「过期」，
   * 结果被静默扔掉，于是那格一直停在「--」。
   */
  async loadArms() {
    if (this.armsLoading) return;
    this.armsLoading = true;
    const prev = this.arms;
    try {
      const arms = await getArms();
      if (arms) this.arms = arms;
    } catch {
      /* 拿不到就保持原样，页面显示「--」 */
    } finally {
      this.armsLoading = false;
    }
    // 值没变就别重绘：paint 会整页重建，60 秒一轮刷下来没必要一直抖
    const cur = this.arms;
    const changed = !prev !== !cur
      || (cur && (prev.arms !== cur.arms || prev.up !== cur.up || prev.down !== cur.down));
    // 顶部小格与「方向」行说明都用 ARMS，统一重绘最省事（paint 内部保留 scrollTop）
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
    clear(this.bodyEl);
    this.armsEl = null;
    this.armsNoteEl = null;

    const tabBar = this.buildTabs();
    this.bodyEl.appendChild(tabBar);

    if (this.error && !this.data) {
      this.bodyEl.appendChild(h('div.an-empty', {}, [
        h('p.an-empty__title', { text: '暂时取不到该指数的数据' }),
        h('p.an-empty__sub', { text: this.error }),
      ]));
      this.setStatus('连接中断');
      this.bodyEl.scrollTop = top;
      return;
    }

    const d = this.data;
    if (!d) {
      this.bodyEl.appendChild(h('div.an-skel', {}, [
        h('div.an-skel__card'), h('div.an-skel__card'), h('div.an-skel__card'),
      ]));
      this.setStatus('连接中');
      this.bodyEl.scrollTop = top;
      return;
    }

    this.bodyEl.appendChild(this.buildHero(d));
    this.bodyEl.appendChild(this.buildState(d));
    this.bodyEl.appendChild(this.buildBase(d));
    this.bodyEl.appendChild(this.buildQuad(d));
    this.bodyEl.appendChild(this.buildRead(d));
    this.bodyEl.appendChild(this.buildFoot(d));

    this.setStatus(`${phaseLabel()} · ${shortDay(d.at)}`);
    this.bodyEl.scrollTop = top;
  }

  buildTabs() {
    const bar = h('div.an-tabs', { role: 'tablist', 'aria-label': '选择指数' });
    for (const it of ANALYSIS_INDICES) {
      const on = it.id === this.indexId;
      const btn = h('button.an-tab' + (on ? '.is-active' : ''), {
        type: 'button',
        role: 'tab',
        text: it.short,
        'aria-selected': String(on),
        onclick: () => this.setIndex(it.id),
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  buildHero(d) {
    const t = d.table;
    const hasArms = this.arms && Number.isFinite(this.arms.arms);

    this.armsEl = h('strong.an-hero__num' + (hasArms ? '' : '.is-muted'), {
      text: hasArms ? this.arms.arms.toFixed(2) : '--',
    });
    this.armsNoteEl = h('span.an-hero__note', {
      text: hasArms ? `${this.arms.up}涨 ${this.arms.down}跌` : '全 A 广度',
    });

    return h('div.an-hero', {}, [
      h('div.an-hero__top', {}, [
        h('div.an-hero__name', {}, [
          h('span', { text: d.name }),
          h('span.an-badge', { text: '三因子' }),
        ]),
        h('span.an-hero__time', {
          text: phaseLabel() === '盘前' || phaseLabel() === '休市'
            ? `${d.asOf.slice(5)} 收盘`
            : phaseLabel(),
        }),
      ]),

      h('div.an-hero__price', {}, [
        h('strong', { text: fmtPrice(d.price, 2) }),
        h('span.an-hero__pct.' + dirClass(d.pct), { text: fmtPct(d.pct) }),
      ]),

      h('div.an-hero__grid', {}, [
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: d.amount > 0 ? fmtBig(d.amount) : '--' }),
          h('span.an-hero__note', { text: '成交额' }),
        ]),
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: plain(d.volumeRatio) }),
          h('span.an-hero__note', { text: d.volumeScaled ? '量比 · 折算' : '量比' }),
        ]),
        h('div.an-cell', {}, [this.armsEl, this.armsNoteEl]),
        h('div.an-cell', {}, [
          h('strong.an-hero__num', { text: signed(d.premium) }),
          h('span.an-hero__note', { text: '投机溢价' }),
        ]),
      ]),

      h('div.an-hero__foot', {}, [
        h('span', { text: '16 状态' }),
        h('span.an-dot', { text: '·' }),
        h('span', { text: `样本外排序 IC ${Number.isFinite(t.ic) ? t.ic.toFixed(2) : '--'}` }),
        h('span.an-dot', { text: '·' }),
        h('span', { text: d.quad ? `${d.quad.code} ${d.quad.name}` : '' }),
      ]),
    ]);
  }

  buildState(d) {
    const b = d.table.bounds;
    const v = d.factors.v;
    const armsNum = this.arms && Number.isFinite(this.arms.arms)
      ? this.arms.arms.toFixed(2)
      : '--';

    const dirRow = h('div.an-row', {}, [
      h('span.an-row__icon.an-row__icon--dir', { text: '向' }),
      h('div.an-row__body', {}, [
        h('div.an-row__title', {}, [
          h('span.an-row__label', { text: '方向 · 涨跌幅' }),
          h('strong.an-row__val.' + dirClass(d.pct), { text: fmtPct(d.pct) }),
        ]),
        h('p.an-row__sub', {
          text: `${d.factors.d ? '收涨' : '收跌'}，记 D${d.factors.d}　·　广度 ARMS ${armsNum}`,
        }),
      ]),
    ]);

    // 折算说明只在盘中出现；收盘后不折算，也就没必要占一行字
    const scaleNote = d.volumeScaled
      ? `　·　按 ${Math.round(d.elapsed / 240 * 100)}% 折算`
      : '';

    const volRow = h('div.an-row', {}, [
      h('span.an-row__icon.an-row__icon--vol', { text: '强' }),
      h('div.an-row__body', {}, [
        h('div.an-row__title', {}, [
          h('span.an-row__label', { text: '强度 · 量比' }),
          h('strong.an-row__val', { text: plain(d.volumeRatio) }),
        ]),
        h('p.an-row__sub', {
          text: v
            ? `${VOL[v]}档 · 边界 ${b.vr.map(x => x.toFixed(2)).join(' / ')}${scaleNote}`
            : '日线不足 6 根，无法计算量比',
        }),
      ]),
    ]);

    const premRow = h('div.an-row', {}, [
      h('span.an-row__icon.an-row__icon--prem', { text: '质' }),
      h('div.an-row__body', {}, [
        h('div.an-row__title', {}, [
          h('span.an-row__label', { text: '性质 · 投机溢价' }),
          h('strong.an-row__val', { text: signed(d.premium) }),
        ]),
        h('p.an-row__sub', {
          text: `${d.factors.p ? '高' : '低'}溢价档 · 分界 ${b.premium.toFixed(2)}　·　创业板 − 上证`,
        }),
      ]),
    ]);

    return h('div.an-card', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: '今日状态' }),
        h('span.an-pill', { text: d.stateName }),
      ]),
      dirRow, volRow, premRow,
      h('p.an-card__note', {
        text: '口径：量比 = 当日成交量 ÷ 前 5 日均量（盘中线性折算）；'
          + '投机溢价 = 创业板 − 上证，单位百分点；'
          + 'ARMS = 涨跌家数比 ÷ 涨跌成交额比，仅参照、不参与判定。',
      }),
    ]);
  }

  buildBase(d) {
    const s = d.sample;
    const st = stance(s);

    if (!s) {
      return h('div.an-card.an-card--base', {}, [
        h('div.an-card__head', {}, [
          h('h2.an-card__title', { text: '研究基准 · 同状态历史赔率' }),
          h('span.an-stance.is-flat', { text: '样本不足' }),
        ]),
        h('p.an-card__note', { text: '当前状态在历史样本里没有足够观测，不给赔率。' }),
      ]);
    }

    const kpi = (label, arr) => h('div.an-kpi', {}, [
      h('strong.an-kpi__val.' + dirClass(arr[0]), { text: signedPct(arr[0]) }),
      h('span.an-kpi__label', { text: label }),
    ]);

    const meta = (label, val, warn) => h('div.an-meta', {}, [
      h('strong.an-meta__val' + (warn ? '.is-warn' : ''), { text: val }),
      h('span.an-meta__label', { text: label }),
    ]);

    const b = bestHorizon(s);
    const win = Array.isArray(s.h20) ? s.h20[1] : null;
    const conf = Array.isArray(s.h20) ? s.h20[2] : null;
    const rank = stateRank(d);

    return h('div.an-card.an-card--base', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: '研究基准 · 同状态历史赔率' }),
        h('span.an-stance.is-' + st.tone, { text: st.text }),
      ]),

      h('div.an-kpis', {}, [
        kpi('T+5', s.h5),
        kpi('T+20', s.h20),
        kpi('T+60', s.h60),
      ]),

      h('div.an-metas', {}, [
        meta('样本数', String(s.n)),
        meta('20日胜率', pctInt(win)),
        meta('置信度', pctInt(conf), conf != null && conf < 60),
        meta('该格序位', rank ? `${rank}/16` : '--'),
      ]),

      b ? h('div.an-window', {}, [
        h('span', {
          text: b.ex > 0.25
            ? `建议窗口 ${b.days} 日 —— 三档里超额最高的一档`
            : '三档超额都不明显，没有值得持有的窗口',
        }),
      ]) : null,

      h('p.an-card__note', {
        text: '基准口径：16 格（方向 × 量比 × 溢价）全样本分层统计，超额已减去同期全样本均值，未计成本。'
          + (rank ? `当前这一格的 T+20 超额在 16 格里排第 ${rank} 位。` : ''),
      }),
    ]);
  }

  buildQuad(d) {
    const quad = d.table.quad;
    if (!quad) return h('div');
    const order = ['1-1', '1-0', '0-1', '0-0'];

    const head = h('div.an-qtr.an-qtr--head', {}, [
      h('span', { text: '形态' }),
      h('span', { text: 'T+5' }),
      h('span', { text: 'T+20' }),
      h('span', { text: 'T+60' }),
      h('span', { text: '胜率' }),
      h('span', { text: 'n' }),
    ]);

    const rows = [head];
    for (const key of order) {
      const q = quad[key];
      if (!q) continue;
      const cur = key === d.quadKey;
      const numCell = v => h('span.' + dirClass(v), { text: signed(v) });
      rows.push(h('div.an-qtr' + (cur ? '.is-cur' : ''), {}, [
        h('span.an-qtr__name', {}, [
          h('em', { text: (d.quad && cur ? d.quad.code : codeOf(key)) }),
          h('i', { text: QUAD_NAME[key] }),
        ]),
        numCell(q.h5[0]),
        numCell(q.h20[0]),
        numCell(q.h60[0]),
        h('span', { text: pctInt(q.h20[1]) }),
        h('span', { text: String(q.n) }),
      ]));
    }

    return h('div.an-card', {}, [
      h('div.an-card__head', {}, [
        h('h2.an-card__title', { text: '四象限坐标 · 超额与胜率' }),
        h('span.an-card__hint', { text: '方向 × 溢价' }),
      ]),
      h('div.an-qtrs', {}, rows),
      h('p.an-card__note', {
        text: '四象限只用来确认「今天站在历史的哪个位置」。它对单个交易日的方向几乎没有解释力，'
          + '真正有信息量的是上面那一格的样本。',
      }),
    ]);
  }

  buildRead(d) {
    const s = d.sample;
    const lines = [];

    lines.push(
      `方向：${fmtPct(d.pct)}，${d.factors.d ? '收涨' : '收跌'}；量比 ${plain(d.volumeRatio)}（${VOL[d.factors.v] || '--'}档）；`
      + `溢价 ${signed(d.premium)}（${d.factors.p ? '高' : '低'}溢价）→ ${d.stateName}。`);

    if (this.arms) {
      const tone = this.arms.arms > 1
        ? `家数优势（${this.arms.ratioCount.toFixed(2)} 倍）大于成交额优势（${this.arms.ratioAmt.toFixed(2)} 倍），上涨股的平均资金强度反而弱于下跌股`
        : `成交额优势（${this.arms.ratioAmt.toFixed(2)} 倍）大于家数优势（${this.arms.ratioCount.toFixed(2)} 倍），资金集中在上涨股上`;
      lines.push(`广度：ARMS ${this.arms.arms.toFixed(2)}，${tone}。它只做参照——历史全 A 家数拿不到，没进模型。`);
    }

    if (s) {
      // T+20 与后面的数字之间用不换行空格：普通空格会让「T+20」孤零零留在行尾
      lines.push(
        `基准：同状态 ${s.n} 个历史样本，T+5\u00A0${signedPct(s.h5[0])}、T+20\u00A0${signedPct(s.h20[0])}、`
        + `T+60\u00A0${signedPct(s.h60[0])}（相对全样本均值的超额），20 日胜率 ${pctInt(s.h20[1])}。`);
      const b = bestHorizon(s);
      lines.push(b && b.ex > 0.25
        ? `窗口：三档里 ${b.days} 日一档超额最高，这个形态的收益集中在${b.days === 5 ? '一周' : b.days === 20 ? '一个月' : '三个月'}内，拉长反而回吐。`
        : '窗口：三档超额都落在噪声范围内，这个形态没有可用的持有期。');
    }

    const t = d.table;
    lines.push(
      `体检：样本外排序 IC ${Number.isFinite(t.ic) ? t.ic.toFixed(2) : '--'}（16 格排序在未参与拟合的样本里还剩多少），`
      + `符号保持率 ${pctInt(t.oob)}（${t.oobN} 格里多少格的正负号没翻）。`
      + (t.oob < 55
        ? '符号保持率接近抛硬币，说明单格赔率的绝对值不能外推，只能看它在 16 格里的相对高低。'
        : '符号保持率高于抛硬币，但只有 16 格参与统计，仍不足以当作信号。'));

    return h('div.an-card', {}, [
      h('div.an-card__head', {}, [h('h2.an-card__title', { text: '模型判读' })]),
      h('ol.an-read', {}, lines.map(x => h('li', { text: x }))),
    ]);
  }

  buildFoot(d) {
    const t = d.table;
    // 日期单独裹一层 nowrap：不加的话「2026-10-28」会断在连字符处，尾巴掉到下一行
    const nb = text => h('span.an-nb', { text });
    return h('div.an-foot', {}, [
      h('p', {}, [
        `基准样本 ${t.n} 个交易日（`,
        nb(d.meta.from), ' 至 ', nb(d.meta.to),
        '，构建于 ', nb(d.meta.builtAt), '）。',
      ]),
      h('p', {
        text: '赔率是历史条件分布的描述，不是预测。A 股 20 日维度上这套划分的排序能力很弱，'
          + '把体检指标一起摆出来是为了看清边界，而不是给一个看起来精确的数字。',
      }),
    ]);
  }
}

const codeOf = key => ({ '1-1': 'C1', '1-0': 'C2', '0-1': 'C3', '0-0': 'C4' }[key] || '');
