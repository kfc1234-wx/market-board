/** 极简 hash 路由
 *  #/board | #/indices | #/nteam | #/search | #/settings | #/s/<id>
 *  用 hash 而非 history：静态托管零配置，刷新不会 404
 */

/**
 * 兜底白名单：调用方没传 tabs 时才用。
 *
 * 这里原本写死了一份，和 main.js 的 TAB_NAMES 各记一份——加「行情分析」
 * 时漏改这一处，路由就把 #/analysis 当成未知页回退到自选，页面永远进不去。
 * 改成由 createRouter 的第二个参数注入，清单只留一处。
 */
const FALLBACK_TABS = ['board', 'indices', 'bonds', 'nteam', 'hao', 'search', 'settings'];

export function createRouter(onChange, tabs = FALLBACK_TABS) {
  const parse = () => {
    const raw = (location.hash || '').replace(/^#/, '');
    const parts = raw.split('/').filter(Boolean);
    if (parts[0] === 's' && parts[1]) {
      return { name: 'detail', id: decodeURIComponent(parts[1]) };
    }
    const name = parts[0] || 'board';
    return { name: tabs.includes(name) ? name : 'board' };
  };

  let last = null;
  const fire = () => {
    const route = parse();
    last = route;
    onChange(route);
  };

  window.addEventListener('hashchange', fire);

  return {
    start: fire,
    current: () => last || parse(),
    go(path) {
      const target = '#' + path;
      if (location.hash === target) fire();
      else location.hash = target;
    },
    destroy() {
      window.removeEventListener('hashchange', fire);
    },
  };
}
