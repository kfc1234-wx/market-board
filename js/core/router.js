/** 极简 hash 路由
 *  #/board | #/indices | #/nteam | #/search | #/settings | #/s/<id>
 *  用 hash 而非 history：静态托管零配置，刷新不会 404
 */

const TABS = ['board', 'indices', 'bonds', 'nteam', 'hao', 'search', 'settings'];

export function createRouter(onChange) {
  const parse = () => {
    const raw = (location.hash || '').replace(/^#/, '');
    const parts = raw.split('/').filter(Boolean);
    if (parts[0] === 's' && parts[1]) {
      return { name: 'detail', id: decodeURIComponent(parts[1]) };
    }
    const name = parts[0] || 'board';
    return { name: TABS.includes(name) ? name : 'board' };
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
