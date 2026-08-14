// ساخت زنجیره اختیار از عکس لحظه‌ای دیده‌بان.
//
// دیده‌بان با یک درخواست کل بازار را می‌دهد و هر رکوردش یک کال و یک پوت با
// قیمت اعمال و سررسید مشترک است. کل غربال مرحله یک روی همین می‌نشیند و
// هیچ درخواست اضافه‌ای نمی‌خورد.
//
//   پایه → سررسید → قیمت اعمال → { کال , پوت }
//
// مظنه‌ای که اینجا ساخته می‌شود فقط سطح اول دارد. عمق پنج سطحی و کمترین و
// بیشترین قیمت روز، مرحله دو است و فقط برای کاندیداهای برتر گرفته می‌شود.

import { num } from './num.mjs';
import { impliedVol } from './bs.mjs';

const n = (x) => num(x, 0);

/** نزدیک‌ترین قیمت اعمال به قیمت پایه، در یک سررسید. */
function nearestStrike(ex, spot) {
  let best = null, bestDiff = Infinity;
  for (const row of ex.strikeList) {
    const diff = Math.abs(row.strike - spot);
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best;
}

/**
 * تلاطم ضمنی نزدیک‌ترین قیمت اعمال، نزدیک‌ترین سررسید — یک نگاه کلی برای
 * فهرست نمادها، نه ورودی محاسبه اجرایی. قیمت پایانی مبناست چون بیرون از
 * ساعت بازار هم موجود است؛ تقاضا/عرضه نیست چون آن‌ها فقط داخل بازار زنده‌اند.
 */
function atmIv(ua, rFree, divYield) {
  const spot = ua.last || ua.close;
  const ex = ua.expiryList[0];
  if (!(spot > 0) || !ex || !(ex.days > 0)) return NaN;
  const row = nearestStrike(ex, spot);
  if (!row) return NaN;
  const T = ex.days / 365;
  for (const q of [row.call, row.put]) {
    const mkt = q.close || q.last;
    if (mkt > 0) {
      const iv = impliedVol(q.kind, mkt, spot, row.strike, T, rFree, divYield, {});
      if (Number.isFinite(iv)) return iv;
    }
  }
  return NaN;
}

/** نسبت موقعیت باز پوت به کال، روی کل زنجیره — سنجه سنتی احساس بازار. */
function pcOpenInterestRatio(ua) {
  let callOi = 0, putOi = 0;
  for (const ex of ua.expiryList) {
    for (const row of ex.strikeList) { callOi += row.call.oi; putOi += row.put.oi; }
  }
  return callOi > 0 ? putOi / callOi : NaN;
}

// سنتینل «عمق نامعلوم». متناهی است چون num هر مقدار نامتناهی را صفر می‌کند،
// و به‌اندازه‌ای بزرگ که هیچ‌وقت قید مقیدکننده نشود.
export const UNKNOWN_DEPTH = 1e12;

/** مظنه یک سمت قرارداد، از رکورد دیده‌بان. */
function sideQuote(r, sfx) {
  const ins = String(r[`insCode_${sfx}`] ?? '');
  const rawName = String(r[`lVal18AFC_${sfx}`] ?? '').trim();
  const bid = n(r[`pMeDem_${sfx}`]);
  const ask = n(r[`pMeOf_${sfx}`]);
  const last = n(r[`pDrCotVal_${sfx}`]);
  const close = n(r[`pClosing_${sfx}`]) || last || bid;
  return {
    ins,
    name: rawName && rawName !== ins ? rawName : `قرارداد ${sfx === 'C' ? 'اختیار خرید' : 'اختیار فروش'}`,
    kind: sfx === 'C' ? 'call' : 'put',
    bid, bidQty: n(r[`qTitMeDem_${sfx}`]),
    ask, askQty: n(r[`qTitMeOf_${sfx}`]),
    last, close,
    low: 0, high: 0,               // مرحله دو پر می‌کند
    oi: n(r[`oP_${sfx}`]), oiYday: n(r[`yesterdayOP_${sfx}`]),
    vol: n(r[`qTotTran5J_${sfx}`]), trades: n(r[`zTotTran_${sfx}`]),
    value: n(r[`qTotCap_${sfx}`]),
    book: null, state: 'A', staleSec: 0,
    depth: false,                  // آیا عمق کامل گرفته شده
  };
}

/**
 * زنجیره کامل. کلید هر پایه، کد نماد پایه است تا با تغییر نام نماد نشکند.
 */
export function buildChain(rows) {
  const byUa = new Map();

  for (const r of rows || []) {
    const uaIns = String(r.uaInsCode ?? '');
    if (!uaIns) continue;
    const strike = n(r.strikePrice);
    const days = Math.round(n(r.remainedDay));
    if (!(strike > 0)) continue;

    let ua = byUa.get(uaIns);
    if (!ua) {
      const rawUaName = String(r.lval30_UA ?? '').trim();
      ua = {
        ins: uaIns,
        name: rawUaName && rawUaName !== uaIns ? rawUaName : 'دارایی پایه بدون نام',
        last: n(r.pDrCotVal_UA), close: n(r.pClosing_UA), yday: n(r.priceYesterday_UA),
        vol: n(r.qTotTran5J_UA), trades: n(r.zTotTran_UA), value: n(r.qTotCap_UA),
        low: 0, high: 0, book: null, state: 'A', staleSec: 0, depth: false,
        expiries: new Map(),
        contracts: 0,
      };
      byUa.set(uaIns, ua);
    }
    ua.last = ua.last || n(r.pDrCotVal_UA);
    ua.close = ua.close || n(r.pClosing_UA);
    ua.vol = ua.vol || n(r.qTotTran5J_UA);
    ua.trades = ua.trades || n(r.zTotTran_UA);
    ua.value = ua.value || n(r.qTotCap_UA);

    let ex = ua.expiries.get(days);
    if (!ex) {
      ex = { days, endDate: n(r.endDate), strikes: new Map() };
      ua.expiries.set(days, ex);
    }

    ex.strikes.set(strike, {
      strike,
      size: n(r.contractSize) || 1000,
      call: sideQuote(r, 'C'),
      put: sideQuote(r, 'P'),
    });
    ua.contracts += 2;
  }

  // مرتب‌سازی: سررسید صعودی، قیمت اعمال صعودی
  for (const ua of byUa.values()) {
    ua.expiryList = [...ua.expiries.values()].sort((a, b) => a.days - b.days);
    for (const ex of ua.expiryList) {
      ex.strikeList = [...ex.strikes.values()].sort((a, b) => a.strike - b.strike);
    }
  }
  return byUa;
}

/**
 * فهرست نماد پایه برای منوی انتخابی — انتخابی، نه تایپی. همان فهرست، تب
 * دیده‌بان زنجیره را هم پر می‌کند، پس نمای بازار (تلاطم ضمنی، نسبت پوت به
 * کال، نزدیک‌ترین سررسید) هم همین‌جاست، نه در یک تابع یا تب جدا.
 *
 * `opt.rFree`/`opt.divYield` برای تلاطم ضمنی؛ چون این فهرست جدا از تنظیمات
 * کاربر ساخته می‌شود (در ریسه اسکن، مستقل از هر تب)، اگر داده نشود پیش‌فرض
 * معقول همان پیش‌فرض `core/settings.mjs` است — عددی نمایشی، نه اجرایی.
 */
export function underlyingList(chain, opt = {}) {
  const rFree = Number.isFinite(opt.rFree) ? opt.rFree : 0.30;
  const divYield = Number.isFinite(opt.divYield) ? opt.divYield : 0;
  return [...chain.values()]
    .map((u) => ({
      ins: u.ins, name: u.name, last: u.last || u.close,
      contracts: u.contracts,
      expiries: u.expiryList.length,
      nearestDays: u.expiryList[0]?.days ?? null,
      volume: u.expiryList.reduce((a, ex) => a
        + ex.strikeList.reduce((b, s) => b + s.call.vol + s.put.vol, 0), 0),
      oi: u.expiryList.reduce((a, ex) => a
        + ex.strikeList.reduce((b, s) => b + s.call.oi + s.put.oi, 0), 0),
      quoted: u.expiryList.reduce((a, ex) => a
        + ex.strikeList.reduce((b, s) => b + (s.call.bid > 0 ? 1 : 0) + (s.put.bid > 0 ? 1 : 0), 0), 0),
      pcRatio: pcOpenInterestRatio(u),
      atmIv: atmIv(u, rFree, divYield),
    }))
    .sort((a, b) => b.volume - a.volume || b.contracts - a.contracts);
}

/** مظنه پایه، به شکل همان قرارداد مظنه اختیار، تا موتور یک مسیر داشته باشد. */
export function underlyingQuote(ua) {
  const p = ua.last || ua.close;
  // دیده‌بان اختیار، دفتر سفارش نماد پایه را نمی‌دهد. پس در مرحله یک، عمق
  // پایه «نامعلوم» است نه «صفر». اگر صفر بگیریم هر ترکیب دارای سهم می‌افتد.
  // مرحله دو دفتر واقعی را می‌نشاند و همین ردیف‌ها دوباره حساب می‌شوند.
  const unknown = !ua.book?.length;
  return {
    ins: ua.ins, name: ua.name, kind: 'underlying',
    bid: ua.book?.length ? ua.book[0].bid : p,
    bidQty: ua.book?.length ? ua.book[0].bidQty : UNKNOWN_DEPTH,
    ask: ua.book?.length ? ua.book[0].ask : p,
    askQty: ua.book?.length ? ua.book[0].askQty : UNKNOWN_DEPTH,
    assumedDepth: unknown,
    last: ua.last, close: ua.close, low: ua.low, high: ua.high,
    book: ua.book, state: ua.state, staleSec: ua.staleSec, depth: !!ua.depth,
    oi: 0, vol: 0,
  };
}

/** آمار کل بازار اختیار، برای نوار شاخص تب دیده‌بان. */
export function chainStats(chain) {
  let contracts = 0, quoted = 0, vol = 0, oi = 0, value = 0, expiries = new Set();
  for (const ua of chain.values()) {
    for (const ex of ua.expiryList) {
      expiries.add(ex.days);
      for (const s of ex.strikeList) {
        for (const q of [s.call, s.put]) {
          contracts += 1;
          if (q.bid > 0 || q.ask > 0) quoted += 1;
          vol += q.vol; oi += q.oi; value += q.value;
        }
      }
    }
  }
  return { underlyings: chain.size, contracts, quoted, vol, oi, value, expiries: expiries.size };
}
