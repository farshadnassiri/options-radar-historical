// ارزیاب ردیف — هر ترکیبی از پاها را به همان مجموعه ستون مشترک تبدیل می‌کند.
//
// هر تب، هر استراتژی، همین ستون‌ها را دارد. اسم و معنی و واحد در همه‌جا یکی
// است. این تنها راهی است که چیزی مبهم نماند.
//
// همه اعداد پولی «برای یک دست قرارداد» است. تعداد قرارداد فقط دو جا اثر
// می‌گذارد: قیمت اجرا از عمق دفتر سفارش، و سقف حجم.

import { num, ok, EPS } from './num.mjs';
import {
  grossCash, entryFees, analyzePayoff, positionGreeks, signedQty,
} from './payoff.mjs';
import { strategyMargin, capitalBase } from './margin.mjs';
import { closeValuation } from './positions.mjs';
import {
  priceLegs, executionCost, maxSize, rowQuality, leggingRisk, spreadPct, midOf,
} from './exec.mjs';
import { bsGreeks, impliedVol, probBelow } from './bs.mjs';
import { analyzeMixed, isSingleExpiry } from './mixed.mjs';

/** بازه‌هایی از قیمت پایه که در آن‌ها سود می‌کنی. مبنای احتمال سود. */
export function profitRegions(an) {
  // موتور چند-سررسیدی خودش بازه‌های سود را می‌دهد، چون تکه‌ای-خطی نیست
  if (an.regions) return an.regions;
  const out = [];
  for (const g of an.segments) {
    const lo = g.lo, hi = g.hi;
    const yLo = g.a * lo + g.b;
    if (Math.abs(g.a) < EPS) {
      if (yLo > 0) out.push([lo, hi]);
      continue;
    }
    const root = -g.b / g.a;
    const inside = root > lo && (Number.isFinite(hi) ? root < hi : true);
    if (!inside) { if (yLo > 0) out.push([lo, hi]); continue; }
    if (g.a > 0) out.push([root, hi]); else out.push([lo, root]);
  }
  // ادغام بازه‌های چسبیده
  const merged = [];
  for (const r of out.sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** احتمال سود، از توزیع لگاریتم-نرمال روی بازه‌های سود. */
export function probOfProfit(an, S, T, sigma) {
  if (!(S > 0) || !(T > 0) || !ok(sigma) || sigma <= 0) return NaN;
  let p = 0;
  for (const [lo, hi] of profitRegions(an)) {
    const pHi = Number.isFinite(hi) ? probBelow(S, hi, T, sigma) : 1;
    const pLo = lo <= 0 ? 0 : probBelow(S, lo, T, sigma);
    p += Math.max(0, pHi - pLo);
  }
  return Math.min(1, Math.max(0, p)) * 100;
}

/**
 * ارزیابی کامل یک ترکیب.
 *
 * ورودی:
 *   legs      پاها، بدون قیمت — قیمت از quotes و مبنای انتخابی می‌آید
 *   quotes    هم‌طول legs: { bid,bidQty,ask,askQty,last,close,low,high,book[],state,staleSec }
 *   ctx       { S, Sclose, days, size, qty, settings, sigmaHist, def }
 */
export function evaluate({ legs, quotes, ctx }) {
  const s = ctx.settings;
  const fees = {
    buyStock: s.feeBuyStock, sellStock: s.feeSellStock,
    option: s.feeOption, exercise: s.feeExercise,
  };
  const params = { A: s.marginA, B: s.marginB, C: s.marginC, maint: s.marginMaint };
  const S = num(ctx.S);
  const Sclose = num(ctx.Sclose, S);
  const days = Math.max(1, num(ctx.days, 1));
  const T = days / 365;
  const qty = Math.max(1, num(ctx.qty, s.qtyDefault));

  // ——— ۱. قیمت اجرا ———
  const priced = priceLegs(legs, quotes, {
    basis: s.priceBasis, execMode: s.execMode, qty,
    refFallback: !!s.showUnexecutable, maxSlipPct: s.maxSlipPct,
  });

  const quality = rowQuality(priced, { staleSec: s.staleSec });
  const executable = quality.level !== 'unexecutable';

  // ——— ۲. جریان نقد ———
  const gross = grossCash(priced);
  const entryFee = entryFees(priced, fees);
  const netCash = gross - entryFee;
  const isCredit = gross > EPS;

  // اگر همین حالا بگیرم و آفستش کنم چه می‌شود؟ / اگر با آخرین یا پایانی
  // تسویه کنم چه می‌شود؟ — سه مبنا روی همان مظنه‌های استفاده‌شده برای ورود.
  // مبنای دفتر سفارش ادعای اجرا دارد (bid/ask واقعی)؛ آخرین و پایانی فقط
  // مرجع‌اند، چون لحظه وقوعشان با لحظه این محاسبه هم‌زمان نیست.
  const quotesForClose = priced.map((l) => l.quote || {});
  const instantClosePnl = netCash + closeValuation(priced, quotesForClose, 'BOOK', fees).net;
  const settleLastPnl = netCash + closeValuation(priced, quotesForClose, 'LAST', fees).net;
  const settleClosePnl = netCash + closeValuation(priced, quotesForClose, 'CLOSE', fees).net;

  // ——— ۳. بازده در سررسید ———
  // اگر سررسید پاها یکی نباشد، موتور تکه‌ای-خطی جواب غلط می‌دهد: فروش و خرید
  // یک قیمت اعمال، ارزش ذاتی همدیگر را صفر می‌کنند و تقویمی بی‌سود درمی‌آید.
  const singleExpiry = isSingleExpiry(priced);
  const payoff = singleExpiry
    ? analyzePayoff(priced, netCash, { fees })
    : analyzeMixed(priced, netCash, {
      fees, rFree: s.rFree, divYield: s.divYield, spot: Sclose,
      sigma: ok(ctx.sigmaHist) ? ctx.sigmaHist : s.volManual,
    });

  // ——— ۴. وجه تضمین ———
  const closes = {};
  priced.forEach((l, i) => { closes[i] = num(l.quote?.close, num(l.price)); });
  const margin = strategyMargin(priced, {
    S: Sclose, closes, params, creditMode: s.creditSpreadMargin, capitalMode: s.capitalMode,
  });

  // ——— ۵. سرمایه درگیر و بازده ———
  const capital = capitalBase({
    legs: priced, netCash, marginNet: margin.marginNet, maxLoss: payoff.maxLoss,
  });
  const cap = capital.value;

  const staticPnl = payoff.at(S);                       // اگر پایه ثابت بماند
  const bestPnl = payoff.maxProfit;
  const retMax = cap > 0 && ok(bestPnl) ? (bestPnl / cap) * 100 : NaN;
  const retStatic = cap > 0 && ok(staticPnl) ? (staticPnl / cap) * 100 : NaN;
  const ann = (r) => (ok(r) ? (r * 365) / days : NaN);
  const annComp = (r) => {
    if (!ok(r)) return NaN;
    const v = ((1 + r / 100) ** (365 / days) - 1) * 100;
    return Number.isFinite(v) ? Math.min(v, 1e6) : NaN;
  };

  // ——— ۶. یونانی‌ها ———
  const r = s.rFree, q = s.divYield;
  // در مرحله یک غربال، استخراج تلاطم ضمنی برای هر پا گران است و کنار گذاشته
  // می‌شود. مرحله دو برای کاندیداهای برتر روشنش می‌کند.
  const wantGreeks = ctx.greeks !== false;
  const greeksByLeg = priced.map((l) => {
    if (l.kind === 'underlying' || !wantGreeks) return null;
    const pIv = { CLOSE: l.quote?.close, LAST: l.quote?.last, BID: l.quote?.bid }[s.ivBasis] ?? l.quote?.close;
    const Tl = Math.max(1, num(l.days, days)) / 365;
    let sig = NaN;
    if (s.volSource === 'MANUAL') sig = s.volManual;
    else if (s.volSource === 'HIST') sig = num(ctx.sigmaHist, NaN);
    else sig = impliedVol(l.kind, num(pIv), Sclose, num(l.strike), Tl, r, q, { lo: s.ivLo, hi: s.ivHi });
    if (!ok(sig) || sig <= 0) sig = ok(ctx.sigmaHist) ? ctx.sigmaHist : NaN;
    l.sigma = sig;
    if (!ok(sig)) return null;
    return bsGreeks(l.kind, Sclose, num(l.strike), Tl, r, q, sig);
  });
  const greeks = wantGreeks
    ? positionGreeks(priced, greeksByLeg)
    : { delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN, deltaShares: NaN, incomplete: true };

  const sigmaUse = s.volSource === 'MANUAL' ? s.volManual
    : ok(ctx.sigmaHist) ? ctx.sigmaHist
    : priced.map((l) => l.sigma).find(ok);

  // ——— ۷. احتمال ———
  const pop = probOfProfit(payoff, S, T, sigmaUse);

  // ——— ۸. هزینه اجرا ———
  const cost = executionCost(priced, {
    fees, marginNet: margin.marginNet, rFree: r, days,
  });

  // ——— ۹. سقف حجم ———
  const size = maxSize(priced, {
    capitalPerContract: cap,
    capitalAvailable: s.capitalAvailable,
  });

  // ——— ۱۰. ریسک لنگ‌زدن ———
  const legging = leggingRisk(priced);

  const warn = [...quality.flags];
  if (days < 7) warn.push('سررسید نزدیک');
  if (!Number.isFinite(payoff.maxLoss)) warn.push('زیان نامحدود');
  if (margin.coverage === 'partial') warn.push('پوشش ناقص');
  if (priced.some((l) => l.exec?.simultaneous === false)) warn.push('قیمت ناهم‌زمان');
  if (priced.some((l) => num(l.exec?.slipPct) > s.maxSlipPct)) warn.push('افت مظنه بالا');
  if (!singleExpiry) warn.push('چند سررسید — بازده تقریبی');

  return {
    // هویت
    strategy: ctx.def?.name || 'ترکیب دستی',
    strategyId: ctx.def?.id || 'custom',
    underlying: ctx.underlying || '',
    days, qty, legCount: priced.length,
    strikes: payoff.strikes,
    legsText: priced.map((l) => `${l.side === 'sell' ? '−' : '+'}${num(l.ratio, 1)} ${l.kind === 'underlying' ? 'سهم' : (l.kind === 'call' ? 'کال' : 'پوت') + ' ' + num(l.strike)}`).join('  '),

    // قیمت
    S, Sclose,
    priceBasis: s.priceBasis, execMode: s.execMode,
    legPrices: priced.map((l) => ({
      key: l.key || `${l.kind}${l.strike ?? ''}`, side: l.side, kind: l.kind, strike: num(l.strike),
      // کیفیت ماشین‌خوان، جدا از برچسب فارسی. نوار تشخیص باید بتواند بگوید
      // ردیف چرا افتاد، و «منبع» متن است نه مقدار قابل شاخه زدن.
      price: num(l.price), source: l.exec?.source, quality: l.exec?.quality,
      slipPct: num(l.exec?.slipPct),
      filled: num(l.exec?.filled), short: num(l.exec?.short), levels: num(l.exec?.levels),
      spreadPct: spreadPct(l.quote || {}), mid: midOf(l.quote || {}), sigma: l.sigma,
    })),

    // جریان نقد
    grossCash: gross, entryFee, netCash, isCredit,
    cashLabel: isCredit ? 'بستانکار' : 'بدهکار',
    instantClosePnl, settleLastPnl, settleClosePnl,

    // سود و زیان
    breakevens: payoff.breakevens,
    ...breakevenMetrics(payoff.breakevens, S),
    singleExpiry, payoffApprox: !!payoff.approx, horizonDays: payoff.horizonDays ?? days,
    maxProfit: payoff.maxProfit, maxLoss: payoff.maxLoss,
    unlimitedProfit: payoff.unlimitedProfit, unlimitedLoss: payoff.unlimitedLoss,
    staticPnl,

    // سرمایه
    capital: cap, capitalKind: capital.kind, capitalLabel: capital.label,
    margin: margin.margin, marginNet: margin.marginNet,
    conditionalMargin: margin.conditionalMargin,
    marginToMaxLoss: Number.isFinite(payoff.maxLoss) && payoff.maxLoss > 0
      ? margin.margin / payoff.maxLoss : NaN,
    coverage: margin.coverage, marginNote: margin.note,

    // بازده
    retMaxPct: retMax, retStaticPct: retStatic,
    retMonthPct: ok(retMax) ? (retMax * 30) / days : NaN,
    retAnnPct: ann(retMax), retAnnCompPct: annComp(retMax),
    shortDte: days < 7,

    // احتمال و یونانی
    popPct: pop, sigmaUse,
    delta: greeks.delta, gamma: greeks.gamma, vega: greeks.vega,
    theta: greeks.theta, rho: greeks.rho, deltaShares: greeks.deltaShares,
    greeksIncomplete: greeks.incomplete,
    thetaToCapitalPct: cap > 0 && ok(greeks.theta) ? (greeks.theta / cap) * 100 : NaN,

    // اجرا
    execCost: cost.total, costCommission: cost.commission, costCrossing: cost.crossing,
    costSlippage: cost.slippage, costFunding: cost.funding, costRows: cost.rows,
    maxQty: size.max, binding: size.binding, sizeLimits: size.limits,
    leggingRisk: legging.exists, leggingUnlimited: legging.unlimitedIfNaked,

    // سلامت
    quality: quality.level, qualityLabel: quality.label, executable,
    warn: [...new Set(warn)],

    // برای نمودار — پاهای قیمت‌خورده، بدون شیء تابع‌دار
    payoff,
    __legs: priced.map((l) => ({
      kind: l.kind, side: l.side, ratio: num(l.ratio, 1), strike: num(l.strike),
      size: num(l.size, 1000), price: num(l.price), days: l.days,
    })),
  };
}

/**
 * قرارداد ستونی مشترک. جدول هر تب از همین ساخته می‌شود، پس اسم و واحد
 * در همه تب‌ها یکی است.
 *   fmt : money | pct | num | int | text | list
 *   heat: نام طیف رنگی، اگر ستون کمی و قابل مقایسه باشد
 */
/**
 * سنجه‌های سربه‌سری نسبت به قیمت پایه فعلی.
 *
 * «سربه‌سری ۹۶٬۲۲۳» به‌تنهایی چیزی نمی‌گوید تا وقتی ندانی پایه کجاست. آنچه
 * قابل مقایسه است، فاصله نسبی است: پایه چند درصد باید حرکت کند تا به
 * نزدیک‌ترین سربه‌سری برسد.
 *
 *   beNear      نزدیک‌ترین سربه‌سری به قیمت پایه
 *   beDistPct   فاصله علامت‌دار تا آن، درصد قیمت پایه.
 *               مثبت یعنی سربه‌سری بالای پایه است و پایه باید بالا برود.
 *   beRoomPct   اندازه همان فاصله، بدون علامت — ستون مرتب‌سازی «حاشیه امن»
 *   beLow       پایین‌ترین سربه‌سری ، beHigh  بالاترین
 *   beWidthPct  فاصله دو سر، درصد قیمت پایه. برای استرادل و کندور معنی دارد.
 */
export function breakevenMetrics(bes, S) {
  const list = (Array.isArray(bes) ? bes : []).filter((b) => ok(b) && b > 0);
  if (!list.length || !(S > 0)) {
    return { beNear: NaN, beDistPct: NaN, beRoomPct: NaN, beLow: NaN, beHigh: NaN, beWidthPct: NaN, beCount: list.length };
  }
  let near = list[0];
  for (const b of list) if (Math.abs(b - S) < Math.abs(near - S)) near = b;
  const lo = Math.min(...list);
  const hi = Math.max(...list);
  return {
    beNear: near,
    beDistPct: ((near - S) / S) * 100,
    beRoomPct: (Math.abs(near - S) / S) * 100,
    beLow: lo,
    beHigh: hi,
    beWidthPct: list.length > 1 ? ((hi - lo) / S) * 100 : NaN,
    beCount: list.length,
  };
}

export const COLUMNS = [
  { key: 'strategy', label: 'استراتژی', fmt: 'text', group: 'هویت', pin: true },
  { key: 'underlying', label: 'پایه', fmt: 'text', group: 'هویت', pin: true },
  { key: 'legsText', label: 'پاها', fmt: 'text', group: 'هویت', pin: true },
  { key: 'days', label: 'روز', fmt: 'int', group: 'هویت' },
  { key: 'cashLabel', label: 'جهت نقدی', fmt: 'text', group: 'جریان نقد' },
  { key: 'grossCash', label: 'نقد ناخالص', fmt: 'money', group: 'جریان نقد' },
  { key: 'entryFee', label: 'کارمزد ورود', fmt: 'money', group: 'جریان نقد' },
  { key: 'netCash', label: 'نقد خالص', fmt: 'money', group: 'جریان نقد' },
  { key: 'instantClosePnl', label: 'سود/زیان بستن فوری — دفتر سفارش', fmt: 'money', group: 'جریان نقد', heat: 'gain' },
  { key: 'settleLastPnl', label: 'سود/زیان اگر تسویه با آخرین معامله', fmt: 'money', group: 'جریان نقد' },
  { key: 'settleClosePnl', label: 'سود/زیان اگر تسویه با قیمت پایانی', fmt: 'money', group: 'جریان نقد' },
  { key: 'S', label: 'قیمت پایه', fmt: 'money', group: 'سود و زیان' },
  { key: 'breakevens', label: 'سربه‌سری', fmt: 'list', group: 'سود و زیان' },
  { key: 'beNear', label: 'نزدیک‌ترین سربه‌سری', fmt: 'money', group: 'سود و زیان' },
  { key: 'beDistPct', label: 'فاصله تا سربه‌سری ٪', fmt: 'pct', group: 'سود و زیان' },
  { key: 'beRoomPct', label: 'حاشیه امن ٪', fmt: 'pct', group: 'سود و زیان', heat: 'prob' },
  { key: 'beLow', label: 'سربه‌سری پایین', fmt: 'money', group: 'سود و زیان' },
  { key: 'beHigh', label: 'سربه‌سری بالا', fmt: 'money', group: 'سود و زیان' },
  { key: 'beWidthPct', label: 'پهنای سربه‌سری ٪', fmt: 'pct', group: 'سود و زیان' },
  { key: 'maxProfit', label: 'بیشترین سود', fmt: 'money', group: 'سود و زیان', heat: 'gain' },
  { key: 'maxLoss', label: 'بیشترین زیان', fmt: 'money', group: 'سود و زیان', heat: 'loss' },
  { key: 'staticPnl', label: 'سود اگر پایه ثابت بماند', fmt: 'money', group: 'سود و زیان' },
  { key: 'capital', label: 'سرمایه درگیر', fmt: 'money', group: 'سرمایه' },
  { key: 'capitalLabel', label: 'مبنای سرمایه', fmt: 'text', group: 'سرمایه' },
  { key: 'margin', label: 'وجه تضمین', fmt: 'money', group: 'سرمایه' },
  { key: 'marginToMaxLoss', label: 'تضمین به زیان', fmt: 'num', group: 'سرمایه' },
  { key: 'conditionalMargin', label: 'تضمین شرطی', fmt: 'money', group: 'سرمایه' },
  { key: 'retMaxPct', label: 'بازده دوره ٪', fmt: 'pct', group: 'بازده', heat: 'gain' },
  { key: 'retStaticPct', label: 'بازده ایستا ٪', fmt: 'pct', group: 'بازده' },
  { key: 'retMonthPct', label: 'بازده ماهانه ٪', fmt: 'pct', group: 'بازده', heat: 'gain' },
  { key: 'retAnnPct', label: 'بازده سالانه ٪', fmt: 'pct', group: 'بازده' },
  { key: 'retAnnCompPct', label: 'سالانه مرکب ٪', fmt: 'pct', group: 'بازده' },
  { key: 'popPct', label: 'احتمال سود ٪', fmt: 'pct', group: 'احتمال', heat: 'prob' },
  { key: 'delta', label: 'دلتا', fmt: 'num', group: 'یونانی' },
  { key: 'gamma', label: 'گاما', fmt: 'num', group: 'یونانی' },
  { key: 'vega', label: 'وگا', fmt: 'money', group: 'یونانی' },
  { key: 'theta', label: 'تتا روزانه', fmt: 'money', group: 'یونانی' },
  { key: 'thetaToCapitalPct', label: 'تتا به سرمایه ٪', fmt: 'pct', group: 'یونانی', heat: 'gain' },
  { key: 'sigmaUse', label: 'تلاطم مبنا', fmt: 'num', group: 'یونانی' },
  { key: 'execCost', label: 'هزینه اجرا', fmt: 'money', group: 'اجرا', heat: 'loss' },
  { key: 'costCommission', label: 'کارمزد', fmt: 'money', group: 'اجرا' },
  { key: 'costCrossing', label: 'عبور از اسپرد', fmt: 'money', group: 'اجرا' },
  { key: 'costSlippage', label: 'افت مظنه', fmt: 'money', group: 'اجرا' },
  { key: 'costFunding', label: 'هزینه فرصت تضمین', fmt: 'money', group: 'اجرا' },
  { key: 'maxQty', label: 'سقف قرارداد', fmt: 'int', group: 'اجرا' },
  { key: 'binding', label: 'قید مقیدکننده', fmt: 'text', group: 'اجرا' },
  { key: 'qualityLabel', label: 'کیفیت داده', fmt: 'text', group: 'سلامت' },
  { key: 'warn', label: 'هشدار', fmt: 'list', group: 'سلامت' },
];
