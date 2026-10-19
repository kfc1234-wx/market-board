/**
 * 交易时段
 *
 * 原则：
 *  - 报价里的时间是「交易所当地墙钟」，一律原样展示，不做二次时区转换
 *  - 判断开闭市用 Intl 按目标时区取分钟数，绝不 new Date().toLocaleString()
 *  - 无免费节假日表，用「行情时间落后 > 10 分钟 → 视为休市/延迟」的启发式
 */

const SESS = {
  CN: { tz: 'Asia/Shanghai', seg: [[570, 690], [780, 900]] },     // 09:30-11:30, 13:00-15:00
  HK: { tz: 'Asia/Hong_Kong', seg: [[570, 720], [780, 960]] },    // 09:30-12:00, 13:00-16:00
  US: { tz: 'America/New_York', seg: [[570, 960]],                 // 09:30-16:00
        pre: [240, 570], post: [960, 1200] },
  CME: { tz: 'America/New_York', around: true },                   // 近 24h，日切 17:00 休 1h
  JP: { tz: 'Asia/Tokyo', seg: [[540, 690], [750, 900]] },         // 09:00-11:30, 12:30-15:00
  KR: { tz: 'Asia/Seoul', seg: [[540, 930]] },                     // 09:00-15:30
  FX: { tz: 'Asia/Shanghai', fx: true },                           // 外汇近 24×5
  // 贵金属（现货黄金 / 人民币账户金）：报价时间是北京时间，周一至周五近乎连续
  PM: { tz: 'Asia/Shanghai', fx: true },
};

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 取某时区此刻的「墙钟」信息 */
export function wallClock(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());

  const get = t => parts.find(p => p.type === t)?.value || '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    weekday: WD[get('weekday')] ?? 0,
    minutes: hour * 60 + minute,
  };
}

/** 该时区相对 UTC 的偏移（分钟） */
function tzOffsetMinutes(tz, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const g = t => Number(p.find(x => x.type === t)?.value || 0);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return (asUTC - at.getTime()) / 60000;
}

/**
 * 解析行情时间字符串（交易所当地墙钟）
 * 支持：20261016161447 / 2026/10/16 18:31:15 / 2026-10-16 16:42:09
 */
export function parseQuoteTime(str) {
  if (!str) return null;
  const s = String(str).trim();

  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  }
  m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  }
  return null;
}

/** 行情时间距今多少分钟（负数表示未来） */
export function quoteAgeMinutes(timeStr, market) {
  const t = parseQuoteTime(timeStr);
  if (!t) return null;
  const tz = SESS[market]?.tz || 'Asia/Shanghai';
  const offset = tzOffsetMinutes(tz);
  const utcMs = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - offset * 60000;
  return (Date.now() - utcMs) / 60000;
}

/**
 * 市场状态
 * @param {'CN'|'HK'|'US'|'CME'} market
 * @returns {'open'|'pre'|'post'|'break'|'closed'}
 */
export function marketState(market) {
  const cfg = SESS[market];
  if (!cfg) return 'closed';

  const { weekday, minutes } = wallClock(cfg.tz);

  // 外汇：周一 00:00 到周六 00:00 连续交易（周末休市，节假日忽略）
  if (cfg.fx) {
    return weekday >= 1 && weekday <= 5 ? 'open' : 'closed';
  }

  if (cfg.around) {
    // CME 电子盘：周日 18:00 开，周五 17:00 收，每日 17:00-18:00 休
    if (weekday === 6) return 'closed';
    if (weekday === 0) return minutes >= 1080 ? 'open' : 'closed';
    if (minutes >= 1020 && minutes < 1080) return 'break';
    return 'open';
  }

  if (weekday === 0 || weekday === 6) return 'closed';

  for (const [a, b] of cfg.seg) {
    if (minutes >= a && minutes < b) return 'open';
  }

  if (cfg.pre && minutes >= cfg.pre[0] && minutes < cfg.pre[1]) return 'pre';
  if (cfg.post && minutes >= cfg.post[0] && minutes < cfg.post[1]) return 'post';
  if (cfg.seg.length > 1 && minutes > cfg.seg[0][1] && minutes < cfg.seg[1][0]) return 'break';
  return 'closed';
}

const STATE_TEXT = {
  open: '盘中',
  pre: '盘前',
  post: '盘后',
  break: '午间休市',
  closed: '已收盘',
};

export function stateText(state) {
  return STATE_TEXT[state] || '—';
}

/**
 * 综合判断某标的的实际状态。
 * 时段上「应该开盘」但行情时间落后太多 → 说明休市或数据延迟，降级为 closed。
 * @param {any} quote 报价对象（含 time / market）
 * @param {string} market
 */
export function effectiveState(quote, market) {
  const base = marketState(market);
  if (base !== 'open' && base !== 'pre' && base !== 'post') return base;
  if (!quote || !quote.time) return base;

  const age = quoteAgeMinutes(quote.time, market);
  // 超过 10 分钟没更新，按已收盘处理（节假日、临时休市的稳妥判断）
  if (age != null && age > 10) return 'closed';
  return base;
}

/** 是否任一市场在盘中 */
export function anyMarketOpen(markets) {
  for (const m of markets) {
    const st = marketState(m);
    if (st === 'open' || st === 'pre' || st === 'post') return true;
  }
  return false;
}

/** 把行情时间格式化成「10-16 16:14」这种展示用短串 */
export function shortTime(str) {
  const t = parseQuoteTime(str);
  if (!t) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(t.mo)}-${p(t.d)} ${p(t.h)}:${p(t.mi)}`;
}
