/** 数字与文本格式化 */

const nf = (v, d) => {
  if (v == null || Number.isNaN(v)) return '--';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
};

/** 价格 */
export function fmtPrice(v, digits = 2) {
  if (!Number.isFinite(v) || v === 0) return '--';
  return nf(v, digits);
}

/** 涨跌幅（带符号） */
export function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

/** 涨跌额（带符号） */
export function fmtChange(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}`;
}

/** 大数字：亿 / 万 */
export function fmtBig(v, digits = 2) {
  if (!Number.isFinite(v) || v === 0) return '--';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(digits)}万`;
  return `${sign}${abs.toFixed(0)}`;
}

/** 带符号的大数字（资金流用） */
export function fmtSignedBig(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return '0';
  const s = v > 0 ? '+' : '';
  return s + fmtBig(v, digits);
}

/** 成交量：手 → 万手 / 亿手 */
export function fmtVolume(v, digits = 2) {
  if (!Number.isFinite(v) || v === 0) return '--';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(digits)}万`;
  return v.toFixed(0);
}

/** 涨跌方向 class */
export function dirClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'text-flat';
  return v > 0 ? 'text-up' : 'text-down';
}

/** 涨跌方向 → pill class */
export function pillClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'pill--flat';
  return v > 0 ? 'pill--up' : 'pill--down';
}

/** CSS 变量里的涨跌色，供 Canvas 使用 */
export function themeColor(name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 缓存一份当前主题色，主题切换后重新取 */
export function readPalette() {
  return {
    up: themeColor('--up', '#F5475F'),
    down: themeColor('--down', '#22C55E'),
    flat: themeColor('--flat', '#8B93A1'),
    text: themeColor('--text', '#E8EBF0'),
    text2: themeColor('--text-2', '#8B93A1'),
    grid: themeColor('--chart-grid', 'rgba(255,255,255,.06)'),
    axis: themeColor('--chart-axis', '#5A6272'),
    ma5: themeColor('--chart-ma5', '#F0B90B'),
    ma10: themeColor('--chart-ma10', '#3B82F6'),
    ma20: themeColor('--chart-ma20', '#A855F7'),
    bg: themeColor('--bg', '#0B0E14'),
    accent: themeColor('--accent', '#3B82F6'),
  };
}

/** 把 #RRGGBB 转 rgba */
export function withAlpha(hex, alpha) {
  if (!hex) return `rgba(255,255,255,${alpha})`;
  const h = hex.replace('#', '');
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 日期 → MM-DD */
export function shortDate(dateStr) {
  if (!dateStr) return '';
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) return `${m[2]}-${m[3]}`;
  return dateStr;
}

/** 分时时间 0930 → 09:30 */
export function fmtMinuteTime(t) {
  const s = String(t || '');
  if (s.length === 4) return `${s.slice(0, 2)}:${s.slice(2)}`;
  return s;
}
