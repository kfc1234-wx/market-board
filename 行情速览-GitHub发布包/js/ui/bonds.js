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

const REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_TERM = '10';

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
        h('div.bhero__side', {}, [
          h('div.bhero__label', {}, [h('i.bdot.bdot--cn'), this.cnLabel]),
          this.heroCn,
          this.heroCnChg,
        ]),
        h('div.bhero__side.bhero__side--us', {}, [
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
      const row = h('div.brow', { dataset: { tenor: t.key } }, [
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

    return h('section.bcard', {}, [
      h('div.bcard__head', {}, [
        h('h2.bcard__title', { text: title }),
        h('span.bcard__tag' + (isCn ? '' : '.bcard__tag--us'), { text: tag }),
      ]),
      grid,
    ]);
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    this.active = true;
    this.load();
    this.schedule();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
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
    this.setStatus(`${shortDate(data.date)} · 日频`, false);
  }

  /* ---------------- 渲染 ---------------- */

  paint() {
    const d = this.data;
    if (!d) return;
    const { latest, prev } = d;

    // Hero：跟着当前期限走（否则会出现「10 年数字 + 2 年利差」的矛盾）
    const t = this.term;
    const cn = latest['cn' + t];
    const us = latest['us' + t];
    const cnBp = bp(cn, prev['cn' + t]);
    const usBp = bp(us, prev['us' + t]);

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
      this.heroSpreadNote.textContent = diff < 0 ? '中国低于美国' : '中国高于美国';
    } else {
      this.heroSpread.textContent = '--';
      this.heroSpreadNote.textContent = '';
    }

    // 分档
    for (const ten of TENORS) {
      this.setRow('cn' + ten.key, latest[ten.cn], bp(latest[ten.cn], prev[ten.cn]));
      this.setRow('us' + ten.key, latest[ten.us], bp(latest[ten.us], prev[ten.us]));
    }
    // 期限利差用接口自己给的值（与「10年−2年」直接相减可能因四舍五入差 0.1bp）
    this.setSpread('cn', latest.cnSpread);
    this.setSpread('us', latest.usSpread);

    this.listNote.textContent = '口径：中国为银行间国债到期收益率，美国为国债恒定到期收益率，'
      + `均为日频，最新一期 ${d.date}。收益率上行 = 债券价格下跌，红色即收益率走高。`
      + '中美利差 = 同一期限的中国收益率 − 美国收益率。'
      + '数据来自东方财富公开接口，仅供参考，不构成投资建议。';
  }

  setRow(key, val, change) {
    const node = this.nodes.get(key);
    if (!node) return;
    const ok = Number.isFinite(val) && val > 0;
    node.val.textContent = ok ? `${fmtYield(val)}%` : '--';
    node.val.className = 'brow__val ' + (ok ? dirText(change) : 'text-flat');
    if (node.chg) {
      node.chg.textContent = ok ? fmtBp(change) : '';
      node.chg.className = 'brow__chg ' + dirText(change);
    }
  }

  setSpread(key, v) {
    const node = this.nodes.get(key + 'spread');
    if (!node) return;
    const ok = Number.isFinite(v);
    // 接口给的是百分点，换成基点更好读
    node.val.textContent = ok ? `${(v * 100).toFixed(1)}bp` : '--';
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
  }

  destroy() {
    this.stop();
  }
}
