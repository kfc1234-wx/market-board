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
        <p><strong>行情速览</strong> v1.12 · 一个纯前端的行情看板，无账号、无后台，自选与偏好只存在本机。</p>
        <p><strong>数据来源：</strong>腾讯行情（A股/港股/美股报价与分时）、新浪财经（ETF 资金流、外盘期货、离岸人民币）、CNBC（日经225 / 韩国KOSPI 报价，东方财富为备源）、东方财富（中美国债收益率）、腾讯 smartbox / 新浪 suggest（搜索）。均为公开接口。</p>
        <p><strong>口径说明：</strong>资金流中的「净流入」为主动买入额减主动卖出额，「主力净额」为特大单口径，由逐笔成交推断，不等同于 ETF 的真实申购赎回。</p>
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
