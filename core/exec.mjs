// لایه اجرا — قیمت واقعی، هزینه واقعی، حجم واقعی.
//
// این فایل جواب سه بند از خواسته‌های پروژه است:
//   محدودیت دفتر سفارش و هزینه مضاعف هر استراتژی
//   محدودیت حجم در محاسبه هر استراتژی
//   بررسی هر استراتژی بر مبنای آخرین، پایانی، کمترین و بیشترین قیمت
//
// قاعده‌ای که همه‌جا رعایت می‌شود: مبنای دفتر سفارش تنها مبنایی است که
// ادعای اجرا دارد. بقیه مبناها مرجع‌اند و کمترین و بیشترین قیمت روز اصلاً
// هم‌زمان نیستند، چون تجمعی کل روز هستند و لحظه وقوعشان معلوم نیست.

import { num, ok, EPS } from './num.mjs';
import { signedQty } from './payoff.mjs';

/**
 * پیمایش دفتر سفارش: قیمت میانگین اجرای واقعی برای حجم مشخص.
 *
 *   side = 'buy'   سطوح عرضه مصرف می‌شود
 *   side = 'sell'  سطوح تقاضا مصرف می‌شود
 *
 * skipLevels برای حالت محافظه‌کار است: فرض می‌کنیم سطح اول تا زمان رسیدن
 * سفارش تو برداشته شده.
 */
export function walkBook(book, qty, side, skipLevels = 0) {
  const empty = { vwap: 0, top: 0, filled: 0, short: num(qty), levels: 0, slipPct: NaN, full: false };
  if (!Array.isArray(book) || !book.length || !(qty > 0)) return empty;

  const rows = book.slice(skipLevels);
  let rem = num(qty), cost = 0, used = 0, top = 0;
  for (const r of rows) {
    const p = side === 'buy' ? num(r.ask) : num(r.bid);
    const q = side === 'buy' ? num(r.askQty) : num(r.bidQty);
    if (!(p > 0) || !(q > 0)) continue;
    if (top === 0) top = p;
    const take = Math.min(rem, q);
    cost += take * p;
    rem -= take;
    used += 1;
    if (rem <= 1e-9) break;
  }
  const filled = num(qty) - rem;
  if (!(filled > 0)) return empty;
  const vwap = cost / filled;
  return {
    vwap, top, filled, short: Math.max(rem, 0), levels: used,
    // برای خرید مثبت یعنی گران‌تر، برای فروش منفی یعنی ارزان‌تر. هر دو به ضرر تو.
    slipPct: top > 0 ? ((vwap - top) / top) * 100 : NaN,
    full: rem <= 1e-9,
  };
}

/**
 * ظرفیت دفتر سفارش: کل حجم قابل اجرا در سطوحی که از سطح اول بیش از حد
 * دور نشده‌اند. این با «حجم پرشده» یکی نیست — حجم پرشده هرگز از حجم درخواستی
 * تو بیشتر نمی‌شود، پس نمی‌تواند مبنای «سقف قرارداد» باشد.
 */
export function bookCapacity(book, side, skipLevels = 0, maxSlipPct = Infinity) {
  if (!Array.isArray(book) || !book.length) return 0;
  const rows = book.slice(skipLevels);
  let top = 0, total = 0;
  for (const r of rows) {
    const p = side === 'buy' ? num(r.ask) : num(r.bid);
    const q = side === 'buy' ? num(r.askQty) : num(r.bidQty);
    if (!(p > 0) || !(q > 0)) continue;
    if (top === 0) top = p;
    const slip = Math.abs((p - top) / top) * 100;
    if (slip > maxSlipPct) break;
    total += q;
  }
  return total;
}

export function midOf(q) {
  const b = num(q.bid), a = num(q.ask);
  return b > 0 && a > 0 ? (b + a) / 2 : b > 0 ? b : a;
}

export function spreadPct(q) {
  const b = num(q.bid), a = num(q.ask);
  return b > 0 && a > 0 ? ((a - b) / b) * 100 : NaN;
}

/**
 * قیمت اجرای یک پا.
 *
 * quote: { bid, bidQty, ask, askQty, last, close, low, high, book:[{bid,bidQty,ask,askQty}] }
 * خروجی همیشه می‌گوید عددش از کجا آمده و آیا ادعای اجرا دارد یا نه.
 */
export function resolvePrice(quote, side, opt = {}) {
  const basis = opt.basis || 'BOOK';
  const mode = opt.execMode || 'AGGRESSIVE';
  const qty = num(opt.qty, 1);
  const q = quote || {};

  const ref = (v, label, simultaneous = true) => ({
    price: num(v), source: label, quality: 'reference', executable: false,
    simultaneous, filled: 0, short: qty, levels: 0, slipPct: NaN, top: num(v), full: false,
  });

  if (basis === 'LAST') return ref(q.last, 'آخرین معامله');
  if (basis === 'CLOSE') return ref(q.close, 'قیمت پایانی');
  if (basis === 'LOW') return ref(q.low, 'کمترین قیمت روز', false);
  if (basis === 'HIGH') return ref(q.high, 'بیشترین قیمت روز', false);

  // ——— مبنای دفتر سفارش ———
  if (mode === 'MID') {
    const m = midOf(q);
    return {
      price: m, source: 'میانه مظنه', quality: 'level1', executable: false, simultaneous: true,
      filled: 0, short: qty, levels: 0, slipPct: NaN, top: m, full: false,
    };
  }

  const skip = mode === 'CONSERVATIVE' ? 1 : 0;
  const book = Array.isArray(q.book) && q.book.length
    ? q.book
    : [{ bid: num(q.bid), bidQty: num(q.bidQty), ask: num(q.ask), askQty: num(q.askQty) }];
  const hasDepth = Array.isArray(q.book) && q.book.length > 1;
  const w = walkBook(book, qty, side, skip);
  const capacity = bookCapacity(book, side, skip, num(opt.maxSlipPct, Infinity));

  if (!(w.vwap > 0)) {
    // در حالت مطالعه، به قیمت پایانی برمی‌گردیم تا ردیف عدد معنی‌دار داشته
    // باشد؛ ولی ادعای اجرا ندارد و برچسبش همین را می‌گوید.
    const ref = num(q.close) || num(q.last);
    if (opt.refFallback && ref > 0) {
      return {
        price: ref, source: 'قیمت پایانی — بی‌مظنه', quality: 'reference',
        executable: false, simultaneous: true,
        filled: 0, short: qty, levels: 0, slipPct: NaN, top: ref, full: false,
      };
    }
    return {
      price: 0, source: 'بی‌مظنه', quality: 'none', executable: false, simultaneous: true,
      filled: 0, short: qty, levels: 0, slipPct: NaN, top: 0, full: false,
    };
  }
  return {
    price: w.vwap,
    source: q.assumedDepth ? 'قیمت مرجع پایه، عمق نامعلوم' : hasDepth ? (skip ? 'عمق کامل، یک پله بدتر' : 'عمق کامل') : 'سطح اول',
    quality: q.assumedDepth ? 'level1' : hasDepth ? 'depth' : 'level1',
    assumedDepth: !!q.assumedDepth,
    executable: true, simultaneous: true,
    filled: w.filled, short: w.short, levels: w.levels, slipPct: w.slipPct,
    top: w.top, full: w.full, capacity,
  };
}

/**
 * قیمت هر پا را حل می‌کند و پاهای قیمت‌خورده را برمی‌گرداند.
 * quotes آرایه‌ای هم‌طول legs است.
 */
export function priceLegs(legs, quotes, opt = {}) {
  const qty = num(opt.qty, 1);
  const out = [];
  legs.forEach((l, i) => {
    const q = quotes[i] || {};
    // پای سهم پایه بر حسب سهم است، نه قرارداد
    const need = l.kind === 'underlying'
      ? qty * num(l.ratio, 1) * num(l.size, 1000)
      : qty * num(l.ratio, 1);
    const r = resolvePrice(q, l.side, { ...opt, qty: need, refFallback: !!opt.refFallback });
    out.push({ ...l, price: r.price, exec: r, quote: q, need });
  });
  return out;
}

/**
 * سقف حجم قابل اجرا، و ستونی که می‌گوید کدام قید مقید کرده است.
 * بدون این ستون، عدد سقف حجم برای کاربر بی‌معناست.
 */
export function maxSize(pricedLegs, opt = {}) {
  const limits = [];
  for (const l of pricedLegs) {
    const per = l.kind === 'underlying'
      ? num(l.ratio, 1) * num(l.size, 1000)
      : num(l.ratio, 1);
    const label = l.kind === 'underlying'
      ? 'عمق سهم پایه'
      : `عمق ${l.side === 'sell' ? 'تقاضای' : 'عرضه'} ${l.kind === 'call' ? 'کال' : 'پوت'} ${num(l.strike)}`;
    // پایی که عمقش نامعلوم است، قید نمی‌شود ولی در فهرست دیده می‌شود
    if (l.exec?.assumedDepth) { limits.push({ what: label, max: null, note: 'نامعلوم' }); continue; }
    // ظرفیت دفتر، نه حجم پرشده. حجم پرشده سقف درخواستی تو را نمی‌شکند.
    const capUnits = num(l.exec?.capacity, num(l.exec?.filled));
    const cap = per > 0 ? Math.floor(capUnits / per) : 0;
    limits.push({ what: label, max: cap });
  }

  const capitalPer = num(opt.capitalPerContract);
  if (capitalPer > 0 && num(opt.capitalAvailable) > 0) {
    limits.push({ what: 'سرمایه در دسترس', max: Math.floor(num(opt.capitalAvailable) / capitalPer) });
  }
  if (num(opt.openInterestLimit) > 0) {
    limits.push({ what: 'موقعیت باز', max: Math.floor(num(opt.openInterestLimit)) });
  }

  const valid = limits.filter((x) => x.max != null && Number.isFinite(x.max));
  if (!valid.length) return { max: 0, binding: 'بی‌مظنه', limits };
  const min = valid.reduce((a, b) => (b.max < a.max ? b : a), valid[0]);
  return { max: Math.max(0, min.max), binding: min.what, limits };
}

/**
 * تفکیک کامل هزینه اجرا.
 *
 * هر قلم جدا نمایش داده می‌شود، نه در یک عدد پنهان — چون در بازار ایران
 * بیشتر اسپردها روی کاغذ سودده و در اجرا زیان‌ده هستند و کاربر باید ببیند
 * پول کجا می‌رود.
 */
export function executionCost(pricedLegs, opt = {}) {
  const fees = opt.fees || { buyStock: 0, sellStock: 0, option: 0, exercise: 0 };
  const rows = [];
  let commission = 0, crossing = 0, slippage = 0;

  for (const l of pricedLegs) {
    const units = Math.abs(signedQty(l));            // تعداد سهم درگیر این پا، برای یک دست قرارداد
    const notional = units * num(l.price);
    const fee = l.kind === 'underlying'
      ? notional * (l.side === 'buy' ? num(fees.buyStock) : num(fees.sellStock))
      : notional * num(fees.option);
    commission += fee;

    const mid = midOf(l.quote || {});
    let cross = 0;
    if (mid > 0 && num(l.price) > 0 && l.exec?.executable) {
      cross = (l.side === 'buy' ? num(l.price) - mid : mid - num(l.price)) * units;
      if (cross < 0) cross = 0;                      // بهتر از میانه، هزینه نیست
      crossing += cross;
    }
    let slip = 0;
    if (l.exec?.top > 0 && l.exec?.executable) {
      slip = Math.abs(num(l.exec.vwap ?? l.price) - num(l.exec.top)) * units;
      slippage += slip;
    }
    rows.push({
      leg: `${l.side === 'sell' ? 'فروش' : 'خرید'} ${l.kind === 'underlying' ? 'سهم' : (l.kind === 'call' ? 'کال' : 'پوت') + ' ' + num(l.strike)}`,
      units, price: num(l.price), commission: fee, crossing: cross, slippage: slip,
      quality: l.exec?.source || '-',
    });
  }

  // هزینه فرصت وجه تضمین
  const days = num(opt.days, 0);
  const funding = num(opt.marginNet) * num(opt.rFree) * (days / 365);

  return {
    rows,
    commission, crossing, slippage, funding,
    total: commission + crossing + slippage + funding,
    legCount: pricedLegs.length,
    note: pricedLegs.length > 1
      ? 'سفارش ترکیبی در تابلو وجود ندارد؛ هر پا جدا اجرا می‌شود و کارمزد و اسپرد خودش را می‌دهد.'
      : '',
  };
}

/**
 * ریسک لنگ‌زدن: اگر فقط پای فروش پر شود و پای خرید نه، چه می‌ماند.
 * خروجی، زیرمجموعه پاهای فروش است تا لایه وجه تضمین رویش حساب کند.
 */
export function leggingRisk(legs) {
  const shortOnly = legs.filter((l) => l.side === 'sell');
  const hasNakedCall = shortOnly.some((l) => l.kind === 'call') && !legs.some((l) => l.kind === 'underlying' && l.side === 'buy');
  return {
    legs: shortOnly,
    exists: legs.length > 1 && shortOnly.length > 0 && shortOnly.length < legs.length,
    unlimitedIfNaked: hasNakedCall,
  };
}

/** کیفیت داده هر ردیف — تا معلوم باشد عدد از مرحله یک غربال آمده یا مرحله دو. */
export function rowQuality(pricedLegs, opt = {}) {
  const staleSec = num(opt.staleSec, 900);
  const anyNone = pricedLegs.some((l) => l.exec?.quality === 'none' || l.exec?.quality === 'reference');
  const assumed = pricedLegs.some((l) => l.exec?.assumedDepth);
  const allDepth = pricedLegs.every((l) => l.exec?.quality === 'depth' && !l.exec?.assumedDepth);
  const shortFill = pricedLegs.some((l) => num(l.exec?.short) > EPS);
  const stale = pricedLegs.some((l) => num(l.quote?.staleSec) > staleSec);
  const halted = pricedLegs.some((l) => l.quote?.state && !String(l.quote.state).toUpperCase().startsWith('A'));
  const flags = [];
  if (anyNone) flags.push('بی‌مظنه');
  if (shortFill) flags.push('عمق ناکافی');
  if (stale) flags.push('مظنه کهنه');
  if (halted) flags.push('نماد مجاز نیست');
  if (assumed) flags.push('عمق پایه نامعلوم');
  return {
    level: anyNone ? 'unexecutable' : allDepth ? 'exact' : 'approx',
    label: anyNone ? 'غیرقابل اجرا' : allDepth ? 'دقیق برای حجم تو' : 'تقریبی، سطح اول',
    assumed,
    flags,
  };
}
