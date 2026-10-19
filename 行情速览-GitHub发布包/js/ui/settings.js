/** 设置页 */

import { h, clear } from '../util/dom.js';
import { getPrefs, setPref, applyTheme, getItems, canPersist } from '../core/store.js';
import { invalidate } from '../data/quotes.js';
import { toast } from './toast.js';
import { runSelfTest, showSelfTestPanel } from '../dev/selftest.js';

const THEMES = [
  { value: 'auto', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

export function initSettings({ body, onThemeChange }) {
  const render = () => {
    clear(body);
    const prefs = getPrefs();

    // ---- 外观 ----
    body.appendChild(h('div.sec-title', { text: '外观' }));

    const seg = h('div.segmented');
    for (const t of THEMES) {
      seg.appendChild(h('button', {
        type: 'button',
        text: t.label,
        class: prefs.theme === t.value ? 'is-active' : '',
        onclick: () => {
          setPref('theme', t.value);
          applyTheme();
          onThemeChange?.();
          render();
        },
      }));
    }

    body.appendChild(h('div.setgroup', {}, [
      h('div.setrow', {}, [
        h('span.setrow__label', { text: '主题' }),
        seg,
      ]),
    ]));

    // ---- 数据 ----
    body.appendChild(h('div.sec-title', { text: '数据' }));

    body.appendChild(h('div.setgroup', {}, [
      h('div.setrow', {
        onclick: () => {
          invalidate();
          toast('缓存已清空，返回看板会自动刷新');
        },
      }, [
        h('span.setrow__label', { text: '清空行情缓存' }),
        h('span.setrow__value.is-link', { text: '清空' }),
      ]),

      h('div.setrow', {
        onclick: async () => {
          toast('正在检测数据源…');
          const results = await runSelfTest();
          showSelfTestPanel(results);
        },
      }, [
        h('span.setrow__label', { text: '数据源自检' }),
        h('span.setrow__value.is-link', { text: '运行' }),
      ]),

      h('div.setrow', {}, [
        h('span.setrow__label', { text: '自选数量' }),
        h('span.setrow__value', { text: `${getItems().length} / 50` }),
      ]),

      h('div.setrow', {}, [
        h('span.setrow__label', { text: '本地存储' }),
        h('span.setrow__value', { text: canPersist() ? '正常' : '不可用（隐私模式）' }),
      ]),
    ]));

    // ---- 关于 ----
    body.appendChild(h('div.sec-title', { text: '关于' }));

    body.appendChild(h('div.about', {
      html: `
        <p><strong>行情速览</strong> v1.21 · 一个纯前端的行情看板，无账号、无后台，自选与偏好只存在本机。</p>
        <p><strong>数据来源：</strong>腾讯行情（A股/港股/美股报价与分时、现货黄金 / 布伦特原油 / 标普500期货）、新浪财经（外盘期货分时与日K、ETF 资金流、离岸人民币、人民币账户黄金）、CNBC（日经225 / 韩国KOSPI / 美元指数，feargreedchart 与东方财富为备源）、东方财富（中美国债收益率，美国为 T+1 发布）、腾讯 smartbox / 新浪 suggest（搜索）。均为公开接口。</p>
        <p><strong>现货与期货：</strong>纳斯达克100 / 标普500 是<strong>现货指数</strong>，只在美股常规时段（美东 09:30–16:00）计算，收盘后不再产生新点位；「纳指100期货 / 标普500期货」是 CME 连续合约，几乎 24 小时交易，点位含升贴水，通常比现货高或低几十到几百点，两者不能混为一谈。布伦特原油为 ICE 连续合约报价。</p>
        <p><strong>黄金口径：</strong>「现货黄金」为伦敦金 XAU/USD（美元/盎司）；「人民币账户黄金」为银行账户金口径（元/克），由新浪的黄金盎司兑人民币报价按 1 金衡盎司 = 31.1034768 克折算，<strong>不含银行买卖点差</strong>，与手机银行报价通常相差 0.5~1 元/克。</p>
        <p><strong>口径说明：</strong>资金流中的「净流入」为主动买入额减主动卖出额，「主力净额」为特大单口径，由逐笔成交推断，不等同于 ETF 的真实申购赎回。国家队页的「资金量汇总」取当日实时值，随报价每 15 秒刷新；历史曲线与 5/10/20 日累计仍为日频数据。</p>
        <p><strong>盘口：</strong>详情页的五档与量能始终对应「此刻」，拖动 K 线光标回看历史时不会隐藏，只会在标题旁点亮「实时」标，避免把当下的挂单误读成历史那一刻的。</p>
        <p><strong>免责声明：</strong>行情数据可能延迟或中断，全部内容仅供研究参考，<strong>不构成任何投资建议</strong>。据此操作，风险自担。</p>
        <p>红涨绿跌配色遵循中国市场习惯。行情接口非授权商用接口，如遇不可用请稍后重试。</p>
      `,
    }));

    // ---- 安装引导 ----
    body.appendChild(h('div.sec-title', { text: '安装到手机' }));
    body.appendChild(h('div.about', {
      html: `
        <p><strong>Android：</strong>用 Chrome 打开本页，点右上角菜单 →「安装应用」或「添加到主屏幕」。</p>
        <p><strong>iOS：</strong>用 Safari 打开本页，点底部「分享」→ 向下找到「添加到主屏幕」→ 添加。</p>
        <p>添加后会像原生 App 一样全屏启动，没有地址栏。</p>
      `,
    }));
  };

  render();
  return { render };
}
