// موتور بازده در سررسید — هسته مشترک همه استراتژی‌ها.
//
// حرف اصلی معماری: هیچ استراتژی محاسبه‌گر جدا ندارد. هر استراتژی فقط
// مجموعه‌ای از «پا» است و همه معیارها از همین فایل بیرون می‌آید.
//
// هر پا:
//   { kind: 'call' | 'put' | 'underlying', side: 'buy' | 'sell',
//     ratio, strike, price, size }
//
//   price  قیمت اجرای هر سهم — از دفتر سفارش، پایانی، آخرین یا کمترین و بیشترین
//   size   اندازه قرارداد. برای پای سهم پایه، تعداد سهم.
//   ratio  نسبت پا در استراتژی. باترفلای می‌شود ۱ و ۲ و ۱.
//
// تابع بازده تکه‌ای-خطی است و شکستگی‌هایش فقط سر قیمت‌های اعمال است.
// روی هر بازه، سود و زیان دقیقاً به شکل a*S + b است. پس سربه‌سری ریشه دقیق
// همان بازه است و بیشترین سود و زیان از مقدار نقاط شکست و شیب دو انتها
// بیرون می‌آید. هیچ‌جا نمونه‌برداری نمی‌کنیم.
//
// کارمزد تسویه هم اینجا لحاظ می‌شود، چون به قیمت پایه وابسته است:
//   کارمزد اعمال روی پاهایی که در سررسید در سود هستند
//   کارمزد فروش سهمِ باقی‌مانده پس از تحویل — سهمی که با اعمال بیرون رفته
//   کارمزد بازار نمی‌دهد، فقط کارمزد اعمال
// همین تفکیک است که در کاوردکال، «بازده اعمال‌شده» و «بازده ایستا» را
// از هم جدا می‌کند.

import { num, ok, EPS } from './num.mjs';

const NO_FEES = { buyStock: 0, sellStock: 0, option: 0, exercise: 0 };

/** مقدار عددی علامت‌دار هر پا. مثبت یعنی خرید. */
export function signedQty(leg) {
  const s = leg.side === 'sell' ? -1 : 1;
  return s * num(leg.ratio, 1) * num(leg.size, 1);
}

/** جریان نقد ورود هر پا. خرید منفی است چون پول می‌دهی. */
export function legCashflow(leg) {
  return -signedQty(leg) * num(leg.price, 0);
}

/** ارزش هر پا در سررسید، به ازای قیمت پایه. */
export function legValueAtExpiry(leg, S) {
  const q = signedQty(leg);
  switch (leg.kind) {
    case 'underlying': return q * S;
    case 'call': return q * Math.max(0, S - num(leg.strike));
    case 'put': return q * Math.max(0, num(leg.strike) - S);
    default: return 0;
  }
}

/** جریان نقد خالص ورود، بدون کارمزد. مثبت یعنی بستانکار. */
export function grossCash(legs) {
  let c = 0;
  for (const l of legs) c += legCashflow(l);
  return c;
}

/** کارمزد ورود هر پا. همیشه هزینه است، پس عدد مثبت برمی‌گردد. */
export function entryFees(legs, fees = NO_FEES) {
  let f = 0;
  for (const l of legs) {
    const notional = Math.abs(signedQty(l)) * num(l.price, 0);
    if (l.kind === 'underlying') f += notional * (l.side === 'buy' ? num(fees.buyStock) : num(fees.sellStock));
    else f += notional * num(fees.option);
  }
  return f;
}

/** قیمت‌های اعمال یکتا و مرتب. نقاط شکست تابع بازده. */
export function breakpoints(legs) {
  const set = new Set();
  for (const l of legs) {
    if (l.kind === 'call' || l.kind === 'put') {
      const K = num(l.strike);
      if (K > 0) set.add(K);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** آیا پا در قیمت داده‌شده در سود است. سر قیمت اعمال، بی‌ارزش شمرده می‌شود. */
export function isItm(leg, S) {
  if (leg.kind === 'call') return S > num(leg.strike) + EPS;
  if (leg.kind === 'put') return num(leg.strike) > S + EPS;
  return false;
}

/**
 * ضرایب خطی سود و زیان روی بازه‌ای که مجموعه «در سود»ها در آن ثابت است.
 * Sm نماینده همان بازه است. خروجی a و b به‌طوری که سود و زیان = a*S + b
 */
function affineOn(legs, Sm, netCash, fees) {
  let a = 0;
  let b = num(netCash, 0);
  let sharesAfter = 0;

  for (const l of legs) {
    const q = signedQty(l);
    if (l.kind === 'underlying') { a += q; sharesAfter += q; continue; }
    if (!isItm(l, Sm)) continue;

    const K = num(l.strike);
    if (l.kind === 'call') {
      a += q; b -= q * K;          // q*(S-K)
      // کال در سود: خریدار سهم می‌گیرد، فروشنده سهم می‌دهد. q خودش علامت را دارد.
      sharesAfter += q;
    } else {
      a -= q; b += q * K;          // q*(K-S)
      // پوت در سود: خریدار سهم می‌دهد، فروشنده سهم می‌گیرد
      sharesAfter -= q;
    }
    b -= Math.abs(q) * K * num(fees.exercise);
  }

  if (Math.abs(sharesAfter) > EPS) {
    const f = sharesAfter > 0 ? num(fees.sellStock) : num(fees.buyStock);
    a -= Math.abs(sharesAfter) * f;
  }
  return { a, b, sharesAfter };
}

/**
 * تحلیل کامل نمودار بازده.
 *
 * netCash جریان نقد ورود است، شامل کارمزد ورود. کارمزد تسویه اینجا اضافه
 * می‌شود، چون فقط اینجا معلوم است کدام پا در سود سررسید شده.
 *
 * خروجی:
 *   breakevens    همه نقاط سربه‌سری، نه فقط یکی. استرادل دو نقطه دارد.
 *   maxProfit     عدد، یا Infinity
 *   maxLoss       اندازه زیان به‌شکل عدد مثبت، یا Infinity
 *   segments      ضرایب هر بازه، برای رسم و اشکال‌زدایی
 *   nodes         نقاط شکست با مقدار سود و زیان، ورودی رسم نمودار
 */
export function analyzePayoff(legs, netCash, opt = {}) {
  const fees = opt.fees || NO_FEES;
  const ks = breakpoints(legs);
  const bounds = [0, ...ks, Infinity];

  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i];
    const hi = bounds[i + 1];
    const mid = Number.isFinite(hi) ? (lo + hi) / 2 : lo + Math.max(lo, 1);
    segments.push({ lo, hi, ...affineOn(legs, mid, netCash, fees) });
  }

  const segAt = (S) => segments.find((g) => S >= g.lo - EPS && (S < g.hi || !Number.isFinite(g.hi)));
  const at = (S) => { const g = segAt(S); return g ? g.a * S + g.b : NaN; };

  // ——— سربه‌سری: روی هر بازه تابع خطی است، پس ریشه دقیق است ———
  const bes = [];
  for (const g of segments) {
    if (Math.abs(g.a) < EPS) {
      if (Math.abs(g.a * g.lo + g.b) < EPS) bes.push(g.lo);
      continue;
    }
    const root = -g.b / g.a;
    const inSeg = root >= g.lo - 1e-6 && (Number.isFinite(g.hi) ? root <= g.hi + 1e-6 : true);
    if (inSeg && root > 0) bes.push(root);
  }
  const breakevens = [...new Set(bes.map((x) => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);

  // ——— بیشترین سود و زیان ———
  // نامزدها: دو سر هر بازه. سر بسته و سر باز جدا حساب می‌شوند، چون کارمزد
  // اعمال سر قیمت اعمال پرش دارد و مقدار «کمی بالاتر از K» با «خود K» یکی نیست.
  const nodes = [];
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  let atMaxProfit = NaN;
  let atMaxLoss = NaN;
  const consider = (S, v) => {
    if (!ok(v)) return;
    if (v > maxProfit) { maxProfit = v; atMaxProfit = S; }
    if (v < maxLoss) { maxLoss = v; atMaxLoss = S; }
  };
  for (const g of segments) {
    const y0 = g.a * g.lo + g.b;
    nodes.push({ S: g.lo, pnl: y0 });
    consider(g.lo, y0);
    if (Number.isFinite(g.hi)) consider(g.hi, g.a * g.hi + g.b);
  }

  const tail = segments[segments.length - 1];
  const head = segments[0];
  const unlimitedProfit = tail.a > EPS;
  const unlimitedLoss = tail.a < -EPS;
  if (unlimitedProfit) { maxProfit = Infinity; atMaxProfit = Infinity; }
  if (unlimitedLoss) { maxLoss = -Infinity; atMaxLoss = Infinity; }

  return {
    breakevens,
    maxProfit,
    maxLoss: maxLoss === -Infinity ? Infinity : -maxLoss, // اندازه زیان، مثبت
    maxLossSigned: maxLoss,
    atMaxProfit,
    atMaxLoss,
    atZero: at(0),
    nodes,
    segments,
    slopeLeft: head.a,
    slopeRight: tail.a,
    strikes: ks,
    unlimitedProfit,
    unlimitedLoss,
    at,
  };
}

/** سود و زیان کل موقعیت در سررسید، با احتساب کارمزد تسویه. */
export function pnlAtExpiry(legs, S, netCash, opt = {}) {
  const fees = opt.fees || NO_FEES;
  const { a, b } = affineOn(legs, S, netCash, fees);
  return a * S + b;
}

/** جمع یونانی‌های موقعیت. یونانی هر پا از بیرون می‌آید و اینجا فقط علامت و وزن می‌خورد. */
export function positionGreeks(legs, greeksByLeg) {
  const out = { delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0, deltaShares: 0 };
  let anyBad = false;
  legs.forEach((leg, i) => {
    const q = signedQty(leg);
    if (leg.kind === 'underlying') {
      out.delta += q;
      out.deltaShares += q;
      return;
    }
    const g = greeksByLeg[i];
    if (!g || !ok(g.delta)) { anyBad = true; return; }
    out.delta += q * g.delta;
    out.gamma += q * g.gamma;
    out.vega += q * g.vega;
    out.theta += q * g.theta;
    out.rho += q * g.rho;
    out.deltaShares += q * g.delta;
  });
  out.incomplete = anyBad;
  return out;
}

/** شبکه سناریو: سود و زیان روی بازه درصدی حرکت پایه. ورودی جدول سناریو. */
export function scenarioGrid(legs, netCash, S0, pctRange = 30, steps = 25, opt = {}) {
  const rows = [];
  for (let i = 0; i <= steps; i++) {
    const pct = -pctRange + (2 * pctRange * i) / steps;
    const S = S0 * (1 + pct / 100);
    rows.push({ pct, S, pnl: pnlAtExpiry(legs, S, netCash, opt) });
  }
  return rows;
}

/** نقاط رسم نمودار: هر شکستگی، به‌علاوه دو سر و درست بالای هر قیمت اعمال. */
export function chartPoints(legs, netCash, opt = {}) {
  const an = analyzePayoff(legs, netCash, opt);
  const ks = an.strikes;
  const pad = opt.padPct ?? 0.35;
  const lo = ks.length ? Math.max(0, ks[0] * (1 - pad)) : 0;
  const hi = ks.length ? ks[ks.length - 1] * (1 + pad) : 1;
  const xs = [lo, ...ks.filter((k) => k > lo && k < hi), hi];
  const pts = [];
  for (const x of [...new Set(xs)].sort((a, b) => a - b)) {
    pts.push({ S: x, pnl: an.at(x) });
    if (ks.includes(x)) {
      const xp = x + Math.max(x * 1e-6, 1e-6);
      pts.push({ S: xp, pnl: an.at(xp) });
    }
  }
  return { points: pts, analysis: an };
}
