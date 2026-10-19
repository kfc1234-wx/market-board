/** 数据源自检：一键确认各条链路是否可用 */

import { h, clear } from '../util/dom.js';
import { PRESET, getSymbol } from '../data/symbols.js';
import { fetchQuotes, fetchMinute, fetchKline } from '../data/sources/tencent.js';
import { fetchGoldMinute } from '../data/sources/sinaGold.js';
import { fetchFxQuoteAndMinute } from '../data/sources/sinaFx.js';
import { fetchCnbcGlobal } from '../data/sources/cnbcGlobal.js';
import { fetchFlow } from '../data/sources/sinaFlow.js';
import { getItems } from '../core/store.js';

const time = async fn => {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t0), value };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: e };
  }
};

function row(ok, label, detail, ms) {
  return { ok, label, detail, ms };
}

/**
 * 依次检查各数据链路
 * @returns {Promise<Array<{ok:number,label:string,detail:string,ms:number}>>}
 */
export async function runSelfTest() {
  const out = [];
  // 只有腾讯源的品种能一次性批量取；日韩指数 / 美元指数 / 汇率走独立适配器，另有专项检查。
  // hf_NQ 是有意排除的：腾讯没有纳指期货的 code，报价靠新浪分时推导。
  const allIds = PRESET.filter(s => !s.src && s.id !== 'hf_NQ').map(s => s.id);

  // 1) 批量报价
  {
    const r = await time(() => fetchQuotes(allIds));
    if (r.error) out.push(row(0, '腾讯·报价', `失败：${r.error.message || r.error}`, r.ms));
    else {
      const got = Object.values(r.value).filter(q => q && q.valid).length;
      const sample = Object.values(r.value).find(q => q && q.valid);
      out.push(row(got === allIds.length ? 1 : 0, '腾讯·报价',
        `${got}/${allIds.length} 可用` + (sample ? ` · ${sample.name} ${sample.price}` : ''), r.ms));
    }
  }

  // 2) A股 ETF 分时
  {
    const sym = getSymbol('sh588000');
    const r = await time(() => fetchMinute(sym));
    out.push(r.error
      ? row(0, '腾讯·分时(A股)', `失败：${r.error.message || r.error}`, r.ms)
      : row(1, '腾讯·分时(A股)', `${r.value.points.length} 个点`, r.ms));
  }

  // 3) 美股指数分时（专用端点）——开盘不足半小时时点数自然很少，20 点即算通
  {
    const sym = getSymbol('usNDX');
    const r = await time(() => fetchMinute(sym));
    const n = r.value?.points?.length || 0;
    out.push(r.error
      ? row(0, '腾讯·分时(美指)', `失败：${r.error.message || r.error}`, r.ms)
      : row(n > 20 ? 1 : 0, '腾讯·分时(美指)', `${n} 个点`, r.ms));
  }

  // 4) 美股指数 K 线（专用端点）
  {
    const sym = getSymbol('usNDX');
    const r = await time(() => fetchKline(sym, 'day', 60));
    const n = r.value?.length || 0;
    out.push(r.error
      ? row(0, '腾讯·K线(美指)', `失败：${r.error.message || r.error}`, r.ms)
      : row(n > 10 ? 1 : 0, '腾讯·K线(美指)', `${n} 根日K`, r.ms));
  }

  // 5) 现货黄金分时（新浪 JSONP）
  {
    const r = await time(() => fetchGoldMinute('XAU'));
    const n = r.value?.points?.length || 0;
    out.push(r.error
      ? row(0, '新浪·黄金分时', `失败：${r.error.message || r.error}`, r.ms)
      : row(n > 100 ? 1 : 0, '新浪·黄金分时', `${n} 个点`, r.ms));
  }

  // 6) 人民币账户黄金（新浪外汇 JSONP + 盎司→克折算）
  {
    const r = await time(() => fetchFxQuoteAndMinute('fx_sxaucny', { divide: 31.1034768 }));
    const p = r.value?.quote?.price || 0;
    out.push(r.error
      ? row(0, '新浪·人民币账户金', `失败：${r.error.message || r.error}`, r.ms)
      : row(p > 100 ? 1 : 0, '新浪·人民币账户金', `${p.toFixed(2)} 元/克`, r.ms));
  }

  // 7) 美元指数（CNBC）
  {
    const r = await time(() => fetchCnbcGlobal([{ id: 'usDXY', cnbc: '.DXY', timeFromLast: true }]));
    const q = r.value?.usDXY;
    out.push(r.error
      ? row(0, 'CNBC·美元指数', `失败：${r.error.message || r.error}`, r.ms)
      : row(q && q.price > 0 ? 1 : 0, 'CNBC·美元指数',
        q ? `${q.price} · ${q.time}` : '无数据', r.ms));
  }

  // 8) ETF 资金流
  const etfs = getItems().filter(it => it.kind === 'etf').map(it => it.id);
  const probe = etfs.length ? etfs : ['sh510300'];
  for (const id of probe.slice(0, 4)) {
    const r = await time(() => fetchFlow(id, 5));
    if (r.error) {
      out.push(row(0, `新浪·资金流 ${id.slice(2)}`, `失败：${r.error.message || r.error}`, r.ms));
    } else {
      const last = r.value[r.value.length - 1];
      const yi = (last.net / 1e8).toFixed(2);
      // 这里的 yi 是「当日」净流入，括号里只说明取到了多少天，避免被读成 5 日累计
      out.push(row(1, `新浪·资金流 ${id.slice(2)}`, `${last.date} 当日净流入 ${yi} 亿 · 取到 ${r.value.length} 日`, r.ms));
    }
  }

  return out;
}

/** 结果面板 */
export function showSelfTestPanel(results) {
  const mask = h('div.mask');
  const sheet = h('div.sheet.sheet--tall');
  const close = () => {
    sheet.classList.add('is-out');
    mask.classList.add('is-out');
    setTimeout(() => { mask.remove(); sheet.remove(); }, 200);
  };

  sheet.appendChild(h('div.sheet__title', { text: '数据源自检' }));

  const panel = h('div.selftest');
  for (const r of results) {
    panel.appendChild(h('div.selftest__row', {}, [
      h('span.selftest__tag', { text: r.ok === 1 ? 'OK' : r.ok === -1 ? 'SKIP' : 'FAIL', dataset: { ok: String(r.ok) } }),
      h('span.selftest__body', { text: `${r.label} — ${r.detail}` }),
      h('span.selftest__ms', { text: `${r.ms}ms` }),
    ]));
  }
  sheet.appendChild(panel);

  sheet.appendChild(h('button.sheet__item.sheet__item--cancel', {
    type: 'button', text: '关闭', onclick: close,
  }));

  mask.addEventListener('click', close);
  document.body.appendChild(mask);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    mask.classList.add('is-in');
    sheet.classList.add('is-in');
  });
}
