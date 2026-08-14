// آزمون صحت‌سنجی موتور.
//
// قاعده کار: تا این آزمون‌ها پاس نشوند، هیچ استراتژی تازه‌ای اضافه نمی‌شود.
// هر کدام یک ادعای مستقل را می‌سنجد و هیچ‌کدام به شبکه نیاز ندارد.
//
// اجرا:  node tests/run.mjs

import path from 'node:path';
import { bsPrice, bsGreeks, impliedVol, probBelow, probAbove, histVol, npdf, d1d2, ncdf, ninv, priceQuantile } from '../core/bs.mjs';
import { grossCash, entryFees, analyzePayoff, signedQty } from '../core/payoff.mjs';
import { analyzeMixed } from '../core/mixed.mjs';
import {
  initialMargin, requiredMargin, minMargin, verifyMargin, impliedUnderlying,
  coverage, strategyMargin, capitalBase, DEFAULT_PARAMS,
} from '../core/margin.mjs';
import { walkBook, resolvePrice, maxSize, bookCapacity } from '../core/exec.mjs';
import { evaluate, profitRegions, probOfProfit, breakevenMetrics } from '../core/evaluate.mjs';
import { CATALOG, buildLegs, byId } from '../strategies/catalog.mjs';
import { defaults } from '../core/settings.mjs';
import { buildChain, underlyingList, chainStats } from '../core/chain.mjs';
import { scan as scanFn, scanAll, generateCombos, unexecutableReason } from '../core/scan.mjs';
import { markToMarket, rollAnalysis } from '../core/positions.mjs';
import { timeMachine } from '../core/timemachine.mjs';
import { jalaliToGregorian, gregorianToJalali, parseJalali, todayJalali } from '../core/jalali.mjs';
import { validIns, parseInsList, safeStaticPath, readBody, BodyTooLarge } from '../server/guard.mjs';
import { evictOldest } from '../server/cache.mjs';
import { watchBackoffSec } from '../server/backoff.mjs';
import { fmt as uiFmt, axisNum, toEnDigits, faAgo, faClock, humanizeUpstreamError, coverageInfo, kpiTone, signTone, pageTitle, normFa } from '../ui/fmt.mjs';
import { moveColumn, insertColumn, changedIds } from '../ui/table.mjs';
import { sameUnderlyingCandidates, compareLabel, compareFullLabel, MAX_COMPARE } from '../ui/compare.mjs';
import {
  historyPrice, normalizeHistoryDate, historyDateLabel, historyDayName,
  replayHistory, summarizeReplay, basisMatrix, entrySensitivity, generateHistoricalCombos,
  historyMarketMetrics, optimizeExitPolicy,
} from '../core/history.mjs';

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(['✔', name, detail]); }
  else { fail += 1; results.push(['✘', name, detail]); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
function group(t) { results.push(['—', t, '']); }

// ═══════════════════════════ ۱. موتور بلک-شولز ═══════════════════════════
group('۱. بلک-شولز و یونانی');
{
  const S = 10000, K = 11000, T = 0.25, r = 0.30, q = 0.05, sig = 0.65;
  const c = bsPrice('call', S, K, T, r, q, sig);
  const p = bsPrice('put', S, K, T, r, q, sig);
  check('برابری خرید و فروش', near(c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-8),
    `اختلاف ${(c - p - (S * Math.exp(-q * T) - K * Math.exp(-r * T))).toExponential(2)}`);

  for (const kind of ['call', 'put']) {
    const g = bsGreeks(kind, S, K, T, r, q, sig);
    const h = S * 1e-4;
    const dNum = (bsPrice(kind, S + h, K, T, r, q, sig) - bsPrice(kind, S - h, K, T, r, q, sig)) / (2 * h);
    const gNum = (bsPrice(kind, S + h, K, T, r, q, sig) - 2 * bsPrice(kind, S, K, T, r, q, sig)
      + bsPrice(kind, S - h, K, T, r, q, sig)) / (h * h);
    const vNum = (bsPrice(kind, S, K, T, r, q, sig + 0.005) - bsPrice(kind, S, K, T, r, q, sig - 0.005)) / 1;
    const ht = 1e-5;
    const tNum = -((bsPrice(kind, S, K, T + ht, r, q, sig) - bsPrice(kind, S, K, T - ht, r, q, sig)) / (2 * ht)) / 365;
    const rNum = (bsPrice(kind, S, K, T, r + 0.005, q, sig) - bsPrice(kind, S, K, T, r - 0.005, q, sig)) / 1;
    check(`دلتا ${kind}`, near(g.delta, dNum, 1e-4), `${g.delta.toFixed(6)} ~ ${dNum.toFixed(6)}`);
    check(`گاما ${kind}`, near(g.gamma, gNum, 1e-3));
    check(`وگا ${kind}`, near(g.vega, vNum, 1e-3));
    check(`تتا ${kind}`, near(g.theta, tNum, 1e-4), `${g.theta.toFixed(3)} ~ ${tNum.toFixed(3)}`);
    check(`رو ${kind}`, near(g.rho, rNum, 1e-3));
  }

  for (const kind of ['call', 'put']) {
    const mkt = bsPrice(kind, S, K, T, r, q, 0.87);
    const iv = impliedVol(kind, mkt, S, K, T, r, q, { lo: 0.01, hi: 5 });
    check(`رفت و برگشت تلاطم ضمنی ${kind}`, near(iv, 0.87, 1e-4), `${iv.toFixed(6)}`);
  }
  check('تلاطم ضمنی زیر ارزش ذاتی → نامعلوم', !Number.isFinite(impliedVol('call', 1, 20000, 10000, 0.5, 0.3, 0, {})));

  const closes = Array.from({ length: 60 }, (_, i) => 1000 * Math.exp(0.01 * Math.sin(i)));
  check('تلاطم تاریخی عدد متناهی می‌دهد', Number.isFinite(histVol(closes, 240)));

  // معکوس نرمال استاندارد (برای صدک قیمت — قلم الف-۱، تصویر آینده)
  check('ninv(۰٫۵) صفر است', near(ninv(0.5), 0, 1e-9), ninv(0.5));
  for (const x of [-2.5, -1, -0.3, 0.7, 1.8, 3]) {
    check(`رفت و برگشت ninv(ncdf(${x}))`, near(ninv(ncdf(x)), x, 1e-6), ninv(ncdf(x)));
  }
  check('ninv بیرون از (۰،۱) نامعلوم می‌دهد', !Number.isFinite(ninv(0)) && !Number.isFinite(ninv(1)) && !Number.isFinite(ninv(-0.1)));

  // صدک قیمت: عکس probBelow است
  {
    const S2 = 100000, T2 = 30 / 365, sig2 = 0.5;
    for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const L = priceQuantile(S2, p, T2, sig2);
      check(`صدک ${p * 100}٪ با probBelow سازگار است`, near(probBelow(S2, L, T2, sig2), p, 1e-6),
        `${probBelow(S2, L, T2, sig2)} ~ ${p}`);
    }
    const L05 = priceQuantile(S2, 0.5, T2, sig2);
    check('میانه توزیع لگاریتم-نرمال زیر قیمت پایه است (روند صفر یعنی میانگین نه میانه)',
      L05 < S2, L05);
    const levels = [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => priceQuantile(S2, p, T2, sig2));
    check('صدک‌ها یکنوا صعودی‌اند', levels.every((v, i) => i === 0 || v > levels[i - 1]), levels.join(' , '));
  }
}

// ═══════════════════════════ ۲. موتور بازده ═══════════════════════════
group('۲. بازده در سررسید — بدون کارمزد');
{
  const size = 1000;
  const mk = (kind, side, strike, price, ratio = 1) => ({ kind, side, strike, price, ratio, size });

  // کاوردکال: سهم ۱۰۰۰، فروش کال ۱۱۰۰ به ۵۰
  {
    const legs = [{ kind: 'underlying', side: 'buy', price: 1000, ratio: 1, size }, mk('call', 'sell', 1100, 50)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('کاوردکال سربه‌سری ۹۵۰', near(an.breakevens[0], 950), `${an.breakevens}`);
    check('کاوردکال بیشترین سود ۱۵۰٫۰۰۰', near(an.maxProfit, 150000));
    check('کاوردکال بیشترین زیان ۹۵۰٫۰۰۰', near(an.maxLoss, 950000));
    check('کاوردکال سود محدود', !an.unlimitedProfit);
  }

  // اسپرد صعودی کال: خرید ۱۰۰ به ۱۲، فروش ۱۲۰ به ۵
  {
    const legs = [mk('call', 'buy', 100, 12), mk('call', 'sell', 120, 5)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('اسپرد صعودی بدهکار ۷٫۰۰۰', near(grossCash(legs), -7000));
    check('اسپرد صعودی سربه‌سری ۱۰۷', near(an.breakevens[0], 107), `${an.breakevens}`);
    check('اسپرد صعودی بیشترین سود ۱۳٫۰۰۰', near(an.maxProfit, 13000));
    check('اسپرد صعودی بیشترین زیان ۷٫۰۰۰', near(an.maxLoss, 7000));
  }

  // کندور آهنی: خرید پوت ۸۰ به ۱، فروش پوت ۹۰ به ۳، فروش کال ۱۱۰ به ۳، خرید کال ۱۲۰ به ۱
  {
    const legs = [mk('put', 'buy', 80, 1), mk('put', 'sell', 90, 3), mk('call', 'sell', 110, 3), mk('call', 'buy', 120, 1)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('کندور آهنی بستانکار ۴٫۰۰۰', near(grossCash(legs), 4000));
    check('کندور آهنی دو سربه‌سری ۸۶ و ۱۱۴',
      an.breakevens.length === 2 && near(an.breakevens[0], 86) && near(an.breakevens[1], 114), `${an.breakevens}`);
    check('کندور آهنی بیشترین سود ۴٫۰۰۰', near(an.maxProfit, 4000));
    check('کندور آهنی بیشترین زیان ۶٫۰۰۰', near(an.maxLoss, 6000));
  }

  // باترفلای کال خرید: ۹۰ به ۱۲، دو تا ۱۰۰ به ۶، ۱۱۰ به ۲
  {
    const legs = [mk('call', 'buy', 90, 12), mk('call', 'sell', 100, 6, 2), mk('call', 'buy', 110, 2)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('باترفلای بدهکار ۲٫۰۰۰', near(grossCash(legs), -2000));
    check('باترفلای بیشترین سود ۸٫۰۰۰ سر ۱۰۰', near(an.maxProfit, 8000) && near(an.atMaxProfit, 100));
    check('باترفلای دو سربه‌سری ۹۲ و ۱۰۸',
      an.breakevens.length === 2 && near(an.breakevens[0], 92) && near(an.breakevens[1], 108), `${an.breakevens}`);
    check('باترفلای بیشترین زیان ۲٫۰۰۰', near(an.maxLoss, 2000));
  }

  // استرادل فروش: زیان دو طرف نامحدود
  {
    const legs = [mk('call', 'sell', 100, 8), mk('put', 'sell', 100, 7)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('استرادل فروش زیان نامحدود', an.unlimitedLoss);
    check('استرادل فروش سربه‌سری ۸۵ و ۱۱۵',
      near(an.breakevens[0], 85) && near(an.breakevens[1], 115), `${an.breakevens}`);
    check('استرادل فروش بیشترین سود ۱۵٫۰۰۰', near(an.maxProfit, 15000));
  }

  // نسبت‌اسپرد کال: خرید ۱۰۰، فروش دو تا ۱۱۰ → سود نامحدود ندارد، زیان نامحدود دارد
  {
    const legs = [mk('call', 'buy', 100, 10), mk('call', 'sell', 110, 5, 2)];
    const an = analyzePayoff(legs, grossCash(legs));
    check('نسبت‌اسپرد زیان نامحدود', an.unlimitedLoss);
    check('نسبت‌اسپرد شیب راست منفی', an.slopeRight < 0);
  }
}

group('۳. بازده در سررسید — با کارمزد تسویه');
{
  const size = 1000;
  const fees = { buyStock: 0.003712, sellStock: 0.0088, option: 0.00103, exercise: 0.0005 };
  const legs = [
    { kind: 'underlying', side: 'buy', price: 1000, ratio: 1, size },
    { kind: 'call', side: 'sell', strike: 1100, price: 50, ratio: 1, size },
  ];
  const net = grossCash(legs) - entryFees(legs, fees);
  const an = analyzePayoff(legs, net, { fees });

  // سناریوی اعمال: سهم در قیمت اعمال تحویل می‌رود، پس فقط کارمزد اعمال
  const called = an.at(1200);
  const expectCalled = 1100 * size - 1100 * size * fees.exercise
    - 1000 * size * (1 + fees.buyStock) + 50 * size * (1 - fees.option);
  check('سناریوی اعمال — فقط کارمزد اعمال', near(called, expectCalled, 1e-9),
    `${Math.round(called).toLocaleString()} ~ ${Math.round(expectCalled).toLocaleString()}`);

  // سناریوی ایستا: سهم می‌ماند و برای نقد کردن، کارمزد فروش بازار می‌دهد
  const stat = an.at(1050);
  const expectStat = 1050 * size * (1 - fees.sellStock)
    - 1000 * size * (1 + fees.buyStock) + 50 * size * (1 - fees.option);
  check('سناریوی ایستا — کارمزد فروش بازار', near(stat, expectStat, 1e-9),
    `${Math.round(stat).toLocaleString()} ~ ${Math.round(expectStat).toLocaleString()}`);
  check('کارمزد، سربه‌سری را بالا می‌برد', an.breakevens[0] > 950, `${an.breakevens[0].toFixed(2)}`);
}

// ═══════════════════════════ ۴. وجه تضمین در برابر تابلو ═══════════════════════════
group('۴. وجه تضمین — شش مشاهده تابلو');
{
  const BOARD = [
    { name: 'ضهرم5034', ua: 'اهرم', snap: 'A', kind: 'call', K: 50000, size: 1000, prem: 1098, im: 4270000, rm: 5368000 },
    { name: 'ضهرم5033', ua: 'اهرم', snap: 'A', kind: 'call', K: 46000, size: 1000, prem: 1901, im: 5200000, rm: 7061000 },
    { name: 'ضخود5052', ua: 'خودرو', snap: 'A', kind: 'call', K: 500, size: 1000, prem: 41, im: 110000, rm: 151000 },
    { name: 'ضفزر505', ua: 'فزر', snap: 'A', kind: 'call', K: 140000, size: 1000, prem: 22876, im: 32290000, rm: 55166000 },
    { name: 'ضهرم6046', ua: 'اهرم', snap: 'B', kind: 'call', K: 46000, size: 1000, prem: 3980, im: 4320000, rm: 8300000 },
    { name: 'ضفزر505', ua: 'فزر', snap: 'B', kind: 'call', K: 140000, size: 1000, prem: 22049, im: 31390000, rm: 53439000 },
  ];

  let idOk = 0;
  const ranges = {};
  for (const b of BOARD) {
    const identity = b.im + b.prem * b.size;
    const ok = Math.abs(identity - b.rm) / b.rm <= 5e-3;
    if (ok) idOk += 1;
    else results.push(['!', `اتحاد RM در ${b.name} برقرار نیست`,
      `محاسبه ${identity.toLocaleString()} در برابر تابلو ${b.rm.toLocaleString()}`]);

    const inv = impliedUnderlying({ K: b.K, size: b.size, kind: b.kind, imRef: b.im });
    check(`بازتولید IM تابلو — ${b.name} ${b.snap}`, inv.ok,
      inv.ok ? `S سازگار ${Math.round(inv.lo).toLocaleString()} تا ${Math.round(inv.hi).toLocaleString()} | جزء ${inv.binding}` : 'هیچ S سازگاری نیست');
    if (inv.ok) {
      const k = `${b.ua}|${b.snap}`;
      ranges[k] = ranges[k] || [];
      ranges[k].push([inv.lo, inv.hi, b.name]);
    }
  }
  check('اتحاد RM = IM + پریمیوم × اندازه، در ۵ مشاهده از ۶', idOk === 5, `${idOk} از ۶`);

  // قراردادهای یک پایه در یک برداشت باید بازه S مشترک داشته باشند
  for (const [k, list] of Object.entries(ranges)) {
    if (list.length < 2) continue;
    const lo = Math.max(...list.map((x) => x[0]));
    const hi = Math.min(...list.map((x) => x[1]));
    check(`بازه S مشترک — ${k}`, lo <= hi,
      lo <= hi ? `${Math.round(lo).toLocaleString()} تا ${Math.round(hi).toLocaleString()}` : 'ناسازگار');
  }

  // تطبیق مستقیم با قیمت پایه معلوم
  const v = verifyMargin({ S: 156950, K: 140000, size: 1000, kind: 'call', optClose: 22049, imRef: 31390000, rmRef: 53439000 });
  check('تطبیق کامل ضفزر با S معلوم', v.imOk && v.rmOk && v.identityOk,
    `IM ${Math.round(v.im).toLocaleString()} | RM ${Math.round(v.rm).toLocaleString()} | جزء ${v.binding}`);

  check('گردکردن فقط روی وجه تضمین اولیه است',
    initialMargin(156950, 140000, 1000, 'call') % DEFAULT_PARAMS.C === 0
    && requiredMargin(156950, 140000, 1000, 'call', 22049) % DEFAULT_PARAMS.C !== 0);
  check('حداقل وجه تضمین ۷۰ درصد لازم است', near(minMargin(1000000), 700000));
  check('وجه تضمین در قیمت پایه یکنواست',
    initialMargin(100000, 50000, 1000, 'call') <= initialMargin(120000, 50000, 1000, 'call'));
}

// ═══════════════════════════ ۵. پوشش و قاعده بستانکار ═══════════════════════════
group('۵. پوشش موقعیت و قاعده بستانکار در برابر بدهکار');
{
  const size = 1000, S = 100;
  const mk = (kind, side, strike, price, ratio = 1, days = 30) => ({ kind, side, strike, price, ratio, size, days });
  const M = (legs) => strategyMargin(legs, { S, closes: {}, creditMode: 'FULL' });

  // چهار اسپرد عمودی: جهت و بستانکاری یکی نیستند
  const bullCall = [mk('call', 'buy', 100, 12), mk('call', 'sell', 120, 5)];
  const bearCall = [mk('call', 'sell', 100, 12), mk('call', 'buy', 120, 5)];
  const bullPut = [mk('put', 'buy', 80, 2), mk('put', 'sell', 100, 9)];
  const bearPut = [mk('put', 'sell', 80, 2), mk('put', 'buy', 100, 9)];

  check('اسپرد صعودی کال بدهکار است → وجه تضمین صفر', !M(bullCall).isCredit && M(bullCall).margin === 0);
  check('اسپرد نزولی کال بستانکار است → وجه تضمین دارد', M(bearCall).isCredit && M(bearCall).margin > 0);
  check('اسپرد صعودی پوت بستانکار است → وجه تضمین دارد، هرچند صعودی',
    M(bullPut).isCredit && M(bullPut).margin > 0);
  check('اسپرد نزولی پوت بدهکار است → وجه تضمین صفر، هرچند نزولی',
    !M(bearPut).isCredit && M(bearPut).margin === 0);

  // پوشش کامل در برابر ناقص
  check('اسپرد نزولی کال، پوشش کامل', coverage(bearCall).state === 'full');
  const ratio = [mk('call', 'buy', 100, 10), mk('call', 'sell', 110, 5, 2)];
  check('نسبت‌اسپرد، پوشش ناقص', coverage(ratio).state === 'partial', `نسبت لخت ${coverage(ratio).nakedRatio}`);
  check('نسبت‌اسپرد بدهکار هم وجه تضمین می‌گیرد، چون بخشی لخت است',
    M(ratio).margin > 0, `وجه تضمین ${Math.round(M(ratio).margin).toLocaleString()}`);

  // کاوردکال: پوشش با سهم پایه، وجه تضمین نقدی صفر
  const cc = [{ kind: 'underlying', side: 'buy', price: 100, ratio: 1, size }, mk('call', 'sell', 110, 5)];
  check('کاوردکال، وجه تضمین نقدی ندارد', M(cc).margin === 0 && coverage(cc).state === 'full');

  // پوشش با سررسید نزدیک‌تر معتبر نیست
  const badCal = [mk('call', 'buy', 100, 5, 1, 10), mk('call', 'sell', 100, 8, 1, 60)];
  check('پای محافظ با سررسید نزدیک‌تر، پوشش نیست', coverage(badCal).state === 'naked');

  // تقویمی درست: خرید دور، فروش نزدیک
  const cal = [mk('call', 'sell', 100, 5, 1, 20), mk('call', 'buy', 100, 9, 1, 80)];
  check('تقویمی، پوشش کامل', coverage(cal).state === 'full');
  check('تقویمی بدهکار → وجه تضمین صفر، ولی تضمین شرطی مثبت',
    M(cal).margin === 0 && M(cal).conditionalMargin > 0,
    `شرطی ${Math.round(M(cal).conditionalMargin).toLocaleString()}`);

  // سه حالت مقدار وجه تضمین بستانکار
  const full = strategyMargin(bearCall, { S, closes: {}, creditMode: 'FULL' }).margin;
  const less = strategyMargin(bearCall, { S, closes: {}, creditMode: 'LESS_WIDTH' }).margin;
  const width = strategyMargin(bearCall, { S, closes: {}, creditMode: 'WIDTH' }).margin;
  check('سه حالت وجه تضمین بستانکار، سه عدد متفاوت',
    full > less && less >= 0 && width > 0,
    `الف ${Math.round(full).toLocaleString()} | ب ${Math.round(less).toLocaleString()} | ج ${Math.round(width).toLocaleString()}`);
}

group('۶. مخرج بازده');
{
  const size = 1000;
  const debit = capitalBase({ legs: [{ kind: 'call' }], netCash: -7000, marginNet: 0, maxLoss: 7000 });
  check('بدهکار → مخرج، بدهکار خالص', debit.kind === 'DEBIT' && debit.value === 7000);

  const credit = capitalBase({ legs: [{ kind: 'call' }], netCash: 4000, marginNet: 2000, maxLoss: 6000 });
  check('بستانکار → مخرج، بیشینه وجه تضمین و بیشترین زیان', credit.value === 6000, credit.label);

  const credit2 = capitalBase({ legs: [{ kind: 'call' }], netCash: 4000, marginNet: 9000, maxLoss: 6000 });
  check('اگر وجه تضمین بزرگ‌تر باشد، همان مخرج است', credit2.value === 9000, credit2.label);

  const stock = capitalBase({ legs: [{ kind: 'underlying' }], netCash: -950000, marginNet: 0, maxLoss: 950000 });
  check('دارای سهم → مخرج، بهای سهم منهای پریمیوم', stock.kind === 'STOCK_NET' && stock.value === 950000);
}

// ═══════════════════════════ ۷. لایه اجرا ═══════════════════════════
group('۷. دفتر سفارش و حجم');
{
  const book = [
    { level: 1, bid: 100, bidQty: 5, ask: 105, askQty: 4 },
    { level: 2, bid: 98, bidQty: 10, ask: 107, askQty: 10 },
    { level: 3, bid: 95, bidQty: 20, ask: 110, askQty: 20 },
  ];
  const w1 = walkBook(book, 5, 'sell');
  check('فروش ۵ در سطح اول جا می‌شود', w1.full && w1.vwap === 100 && w1.levels === 1);

  const w2 = walkBook(book, 12, 'sell');
  check('فروش ۱۲ باید دو سطح مصرف کند', w2.levels === 2 && near(w2.vwap, (5 * 100 + 7 * 98) / 12, 1e-9),
    `میانگین ${w2.vwap.toFixed(2)}`);
  check('افت مظنه در فروش عمیق منفی است', w2.slipPct < 0, `${w2.slipPct.toFixed(2)}٪`);

  const w3 = walkBook(book, 100, 'buy');
  check('حجم بزرگ‌تر از عمق، کمبود را گزارش می‌کند', !w3.full && w3.short === 66, `کمبود ${w3.short}`);

  const cons = walkBook(book, 4, 'buy', 1);
  check('حالت محافظه‌کار سطح اول را نادیده می‌گیرد', cons.vwap === 107);

  check('ظرفیت دفتر، مستقل از حجم درخواستی است',
    bookCapacity(book, 'sell') === 35 && bookCapacity(book, 'buy') === 34,
    `فروش ${bookCapacity(book, 'sell')} | خرید ${bookCapacity(book, 'buy')}`);
  check('سقف افت مظنه، سطوح دور را کنار می‌گذارد',
    bookCapacity(book, 'sell', 0, 3) === 15, `${bookCapacity(book, 'sell', 0, 3)}`);
  const rp = resolvePrice({ bid: 100, ask: 105, book }, 'sell', { basis: 'BOOK', qty: 2 });
  check('سقف قرارداد از ظرفیت می‌آید نه از حجم پرشده',
    rp.filled === 2 && rp.capacity === 35, `پرشده ${rp.filled} | ظرفیت ${rp.capacity}`);

  const q = { bid: 100, bidQty: 5, ask: 105, askQty: 4, last: 102, close: 101, low: 96, high: 108, book };
  check('مبنای دفتر، ادعای اجرا دارد', resolvePrice(q, 'sell', { basis: 'BOOK', qty: 5 }).executable);
  check('مبنای پایانی، ادعای اجرا ندارد', !resolvePrice(q, 'sell', { basis: 'CLOSE', qty: 5 }).executable);
  check('کمترین قیمت روز، ناهم‌زمان علامت می‌خورد',
    resolvePrice(q, 'sell', { basis: 'LOW', qty: 5 }).simultaneous === false);
  check('میانه مظنه، ادعای اجرا ندارد',
    resolvePrice(q, 'sell', { basis: 'BOOK', execMode: 'MID', qty: 5 }).price === 102.5
    && !resolvePrice(q, 'sell', { basis: 'BOOK', execMode: 'MID', qty: 5 }).executable);
  check('بی‌مظنه، قیمت صفر و کیفیت هیچ',
    resolvePrice({ bid: 0, ask: 0, book: [] }, 'sell', { basis: 'BOOK', qty: 1 }).quality === 'none');
}

// ═══════════════════════════ ۸. احتمال سود ═══════════════════════════
group('۸. احتمال سود از بازه‌های سود');
{
  const size = 1000;
  const mk = (kind, side, strike, price, ratio = 1) => ({ kind, side, strike, price, ratio, size });

  const condor = [mk('put', 'buy', 80, 1), mk('put', 'sell', 90, 3), mk('call', 'sell', 110, 3), mk('call', 'buy', 120, 1)];
  const an = analyzePayoff(condor, grossCash(condor));
  const reg = profitRegions(an);
  check('کندور یک بازه سود دارد', reg.length === 1 && near(reg[0][0], 86) && near(reg[0][1], 114),
    reg.map((r) => `${r[0].toFixed(1)}..${r[1].toFixed(1)}`).join(' , '));
  const p = probOfProfit(an, 100, 30 / 365, 0.5);
  check('احتمال سود کندور بین صفر و صد', p > 0 && p < 100, `${p.toFixed(1)}٪`);

  const strad = [mk('call', 'buy', 100, 8), mk('put', 'buy', 100, 7)];
  const anS = analyzePayoff(strad, grossCash(strad));
  const regS = profitRegions(anS);
  check('استرادل خرید دو بازه سود دارد، دو طرف', regS.length === 2, `${regS.length}`);
  check('احتمال سود استرادل معنی‌دار است',
    probOfProfit(anS, 100, 30 / 365, 0.8) > 0, `${probOfProfit(anS, 100, 30 / 365, 0.8).toFixed(1)}٪`);
}

// ═══════════════════════════ ۹. ارزیاب ردیف ═══════════════════════════
group('۹. ارزیاب ردیف، سرتاسری');
{
  const s = defaults();
  const size = 1000;
  const mkQuote = (bid, ask, extra = {}) => ({
    bid, bidQty: 50, ask, askQty: 50, last: (bid + ask) / 2, close: (bid + ask) / 2,
    low: bid * 0.9, high: ask * 1.1, state: 'A', staleSec: 10,
    book: [
      { level: 1, bid, bidQty: 5, ask, askQty: 5 },
      { level: 2, bid: bid * 0.98, bidQty: 40, ask: ask * 1.02, askQty: 40 },
    ],
    ...extra,
  });

  // کاوردکال کامل با داده مصنوعی
  const def = byId('covered-call');
  const legs = buildLegs(def, { strikes: [110000], size, days: [30] });
  const quotes = [mkQuote(99000, 100000), mkQuote(4800, 5200)];
  const row = evaluate({
    legs, quotes,
    ctx: { S: 100000, Sclose: 100000, days: 30, size, qty: 3, settings: s, def, underlying: 'نمونه', sigmaHist: 0.6 },
  });

  check('ردیف ساخته شد و اجراپذیر است', row.executable && row.quality === 'exact', row.qualityLabel);
  check('کاوردکال بدهکار خالص است', !row.isCredit && row.netCash < 0);
  check('مخرج سرمایه، بهای سهم منهای پریمیوم', row.capitalKind === 'STOCK_NET', row.capitalLabel);
  check('کاوردکال وجه تضمین نقدی ندارد', row.margin === 0);
  check('بازده دوره مثبت و متناهی', Number.isFinite(row.retMaxPct) && row.retMaxPct > 0, `${row.retMaxPct.toFixed(2)}٪`);
  check('بازده ماهانه با نسبت روز مقیاس می‌خورد', near(row.retMonthPct, row.retMaxPct * 30 / 30, 1e-9));
  check('یونانی‌ها کامل محاسبه شدند', !row.greeksIncomplete && Number.isFinite(row.delta));
  check('دلتای کاوردکال بین صفر و اندازه قرارداد', row.delta > 0 && row.delta < size, `${row.delta.toFixed(1)}`);
  check('احتمال سود محاسبه شد', Number.isFinite(row.popPct), `${row.popPct.toFixed(1)}٪`);
  check('هزینه اجرا تفکیک شده و مثبت است',
    row.execCost > 0 && row.costCommission > 0 && row.costRows.length === 2,
    `کارمزد ${Math.round(row.costCommission).toLocaleString()} | عبور ${Math.round(row.costCrossing).toLocaleString()}`);
  check('سقف حجم و قید مقیدکننده معلوم است', row.maxQty >= 0 && !!row.binding, `${row.maxQty} — ${row.binding}`);
  check('عمق ناکافی برای حجم ۳، در هشدارها دیده می‌شود',
    row.warn.includes('عمق ناکافی') || row.maxQty < 3, row.warn.join(' , ') || 'بی‌هشدار');

  // اسپرد بستانکار: قاعده وجه تضمین و ریسک لنگ‌زدن
  const bc = byId('bear-call-spread');
  const legs2 = buildLegs(bc, { strikes: [100000, 110000], size, days: [30] });
  const row2 = evaluate({
    legs: legs2, quotes: [mkQuote(8000, 8400), mkQuote(3000, 3400)],
    ctx: { S: 100000, Sclose: 100000, days: 30, size, qty: 1, settings: s, def: bc, underlying: 'نمونه', sigmaHist: 0.6 },
  });
  check('اسپرد نزولی کال بستانکار است', row2.isCredit, `نقد خالص ${Math.round(row2.netCash).toLocaleString()}`);
  check('بستانکار → وجه تضمین مثبت', row2.margin > 0);
  check('مخرج بستانکار، بیشینه تضمین و بیشترین زیان',
    row2.capitalKind === 'CREDIT' && row2.capital >= row2.maxLoss - 1, row2.capitalLabel);
  check('ریسک لنگ‌زدن علامت خورد', row2.leggingRisk);
  check('نسبت تضمین به زیان گزارش شد', Number.isFinite(row2.marginToMaxLoss), `${row2.marginToMaxLoss.toFixed(2)}`);
  check('چهار قلم هزینه جدا گزارش شد',
    ['costCommission', 'costCrossing', 'costSlippage', 'costFunding'].every((k) => Number.isFinite(row2[k])));

  // مبنای ناهم‌زمان باید هشدار بدهد
  const row3 = evaluate({
    legs: legs2, quotes: [mkQuote(8000, 8400), mkQuote(3000, 3400)],
    ctx: { S: 100000, Sclose: 100000, days: 30, size, qty: 1, def: bc, underlying: 'نمونه', sigmaHist: 0.6,
      settings: { ...s, priceBasis: 'HIGH' } },
  });
  check('مبنای بیشترین قیمت روز، هشدار ناهم‌زمانی می‌دهد', row3.warn.includes('قیمت ناهم‌زمان'));
  check('مبنای مرجع، اجراناپذیر علامت می‌خورد', !row3.executable || row3.quality !== 'exact');

  // «اگر همین حالا بگیرم و ببندم چه می‌شود؟» و «اگر با آخرین/پایانی تسویه
  // کنم؟» (خواسته الف-۱، سؤال‌های ۴ و ۵) — بدون کارمزد، عدد دقیق قابل
  // پیش‌بینی است: فروش تهاجمی روی bid پر می‌شود، بستن فوری روی ask.
  const s0 = { ...s, feeOption: 0, feeBuyStock: 0, feeSellStock: 0, feeExercise: 0 };
  const sp = byId('naked-put');
  const legsSp = buildLegs(sp, { strikes: [95000], size, days: [30] });
  const qSp = [mkQuote(8000, 8400, { last: 8300, close: 8100 })];
  const rowSp = evaluate({
    legs: legsSp, quotes: qSp,
    ctx: { S: 100000, Sclose: 100000, days: 30, size, qty: 1, settings: s0, def: sp, underlying: 'نمونه', sigmaHist: 0.6 },
  });
  check('بستن فوری بدون کارمزد، دقیقاً هزینه اسپرد (bid منهای ask)',
    near(rowSp.instantClosePnl, (8000 - 8400) * size, 1e-6), rowSp.instantClosePnl);
  check('تسویه با آخرین معامله، دقیقاً bid منهای last',
    near(rowSp.settleLastPnl, (8000 - 8300) * size, 1e-6), rowSp.settleLastPnl);
  check('تسویه با قیمت پایانی، دقیقاً bid منهای close',
    near(rowSp.settleClosePnl, (8000 - 8100) * size, 1e-6), rowSp.settleClosePnl);

  // با کارمزد واقعی، بستن فوری همیشه از تسویه با آخرین/پایانی بدتر است —
  // چون اسپرد کامل را دو بار (ورود و خروج) می‌پردازی، آن‌ها فقط یک‌بار
  const rowSpFee = evaluate({
    legs: legsSp, quotes: qSp,
    ctx: { S: 100000, Sclose: 100000, days: 30, size, qty: 1, settings: s, def: sp, underlying: 'نمونه', sigmaHist: 0.6 },
  });
  check('بستن فوری همیشه هزینه اسپرد کامل را می‌پردازد، بدتر از تسویه مرجع',
    rowSpFee.instantClosePnl < rowSpFee.settleLastPnl && rowSpFee.instantClosePnl < rowSpFee.settleClosePnl,
    `فوری ${Math.round(rowSpFee.instantClosePnl)} | آخرین ${Math.round(rowSpFee.settleLastPnl)} | پایانی ${Math.round(rowSpFee.settleClosePnl)}`);
}

group('۱۰. فهرست استراتژی‌ها');
{
  check('فهرست پر است', CATALOG.length >= 25, `${CATALOG.length} استراتژی`);
  check('شناسه‌ها یکتا هستند', new Set(CATALOG.map((d) => d.id)).size === CATALOG.length);
  const bad = CATALOG.filter((d) => {
    const maxSlot = Math.max(...d.legs.filter((l) => l.kind !== 'underlying').map((l) => l.slot), 0);
    return maxSlot !== d.strikes;
  });
  check('تعداد قیمت اعمال هر الگو با پاهایش می‌خواند', bad.length === 0, bad.map((d) => d.id).join(', '));
  const infeasible = CATALOG.filter((d) => !d.feasible);
  check('استراتژی‌های نیازمند فروش سهم، برچسب دارند',
    infeasible.length > 0 && infeasible.every((d) => !!d.infeasibleWhy),
    infeasible.map((d) => d.name).join(' , '));
  for (const d of CATALOG.filter((x) => x.feasible)) {
    const legs = buildLegs(d, {
      strikes: [80000, 90000, 100000, 110000].slice(0, d.strikes),
      size: 1000, days: [30, 60],
      prices: {},
    });
    const okLegs = legs.every((l) => l.kind === 'underlying' || Number.isFinite(l.strike));
    if (!okLegs) check(`ساخت پاها — ${d.name}`, false, 'قیمت اعمال ناقص');
  }
  check('ساخت پاها برای همه الگوهای شدنی', true);
}

group('۱۱. عبور همه استراتژی‌ها از موتور — همان مسیر تب موتور');
{
  const s = defaults();
  const size = 1000, spot = 100000;
  const strikesAll = [90000, 95000, 100000, 105000];
  let broke = [];
  let unbounded = [];

  for (const def of CATALOG) {
    const strikes = strikesAll.slice(0, def.strikes);
    const legs = buildLegs(def, { strikes, size, days: [30, 90] });
    const quotes = legs.map((l) => {
      const intr = l.kind === 'underlying' ? spot
        : (l.kind === 'call' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot));
      const p = Math.round(l.kind === 'underlying' ? spot : intr + spot * 0.03);
      const half = Math.max(1, p * 0.02);
      return {
        bid: p - half, bidQty: 1e6, ask: p + half, askQty: 1e6,
        last: p, close: p, low: p * 0.9, high: p * 1.1, state: 'A', staleSec: 0,
        book: [{ level: 1, bid: p - half, bidQty: 1e6, ask: p + half, askQty: 1e6 }],
      };
    });
    try {
      const row = evaluate({
        legs, quotes,
        ctx: { S: spot, Sclose: spot, days: 30, size, qty: 1, settings: s, def, underlying: 'نمونه', sigmaHist: 0.6 },
      });
      const finite = ['netCash', 'capital', 'execCost', 'margin', 'conditionalMargin']
        .every((k) => Number.isFinite(row[k]));
      const beSane = row.breakevens.every((b) => b > 0 && Number.isFinite(b));
      if (!finite || !beSane) broke.push(def.id);
      if (row.unlimitedLoss) unbounded.push(def.name);
      // قاعده مرکزی باید در همه‌جا برقرار باشد
      if (!row.isCredit && row.margin > 0 && row.coverage === 'full') broke.push(`${def.id} — بدهکار با وجه تضمین`);
    } catch (e) {
      broke.push(`${def.id} → ${e.message}`);
    }
  }
  check('همه ۳۱ استراتژی بدون خطا ارزیابی شدند و اعداد متناهی دادند',
    broke.length === 0, broke.join(' | '));
  check('استراتژی‌های زیان‌نامحدود شناسایی شدند', unbounded.length > 0, unbounded.join(' , '));
}

group('۱۲. زنجیره و ترکیب‌سازی');
{
  // دو رکورد دیده‌بان مصنوعی، شکل واقعی پاسخ بازار
  const mkRow = (strike, days, cBid, pBid, ua = '1', uaName = 'نمونه') => ({
    uaInsCode: ua, lval30_UA: uaName, pDrCotVal_UA: 100000, pClosing_UA: 100000, priceYesterday_UA: 99000,
    insCode_C: `c${strike}_${days}`, lVal18AFC_C: `ض${strike}`, insCode_P: `p${strike}_${days}`, lVal18AFC_P: `ط${strike}`,
    strikePrice: strike, contractSize: 1000, remainedDay: days, endDate: 20260101,
    pMeDem_C: cBid, qTitMeDem_C: 100, pMeOf_C: cBid * 1.05, qTitMeOf_C: 100,
    pDrCotVal_C: cBid, pClosing_C: cBid, oP_C: 500, qTotTran5J_C: 1000,
    pMeDem_P: pBid, qTitMeDem_P: 100, pMeOf_P: pBid * 1.05, qTitMeOf_P: 100,
    pDrCotVal_P: pBid, pClosing_P: pBid, oP_P: 400, qTotTran5J_P: 800,
  });

  const rows = [];
  for (const k of [90000, 95000, 100000, 105000, 110000]) {
    rows.push(mkRow(k, 30, Math.max(200, 100000 - k + 4000), Math.max(200, k - 100000 + 4000)));
    rows.push(mkRow(k, 90, Math.max(300, 100000 - k + 7000), Math.max(300, k - 100000 + 7000)));
  }
  rows.push({
    ...mkRow(100000, 30, 0, 0, '2', 'بی‌مظنه'),
    pMeDem_C: 0, pMeOf_C: 0, pMeDem_P: 0, pMeOf_P: 0,
    pDrCotVal_C: 4200, pClosing_C: 4200, pDrCotVal_P: 4100, pClosing_P: 4100,
  });

  const chain = buildChain(rows);
  check('زنجیره دو نماد پایه ساخت', chain.size === 2, `${chain.size}`);
  const ua = chain.get('1');
  check('دو سررسید و پنج قیمت اعمال', ua.expiryList.length === 2 && ua.expiryList[0].strikeList.length === 5);
  check('سررسیدها صعودی مرتب شدند', ua.expiryList[0].days < ua.expiryList[1].days);
  const list = underlyingList(chain);
  check('فهرست انتخابی نماد، با شمارش قرارداد', list.length === 2 && list[0].contracts > 0,
    list.map((u) => `${u.name}:${u.contracts}`).join(' , '));
  const st = chainStats(chain);
  check('آمار زنجیره: قرارداد و دارای مظنه', st.contracts === 22 && st.quoted === 20,
    `قرارداد ${st.contracts} | مظنه ${st.quoted}`);

  const s2 = { ...defaults(), comboWindowPct: 25, wingsEqualWidth: true, greeksInScan: false };

  // کاوردکال: یک ترکیب به ازای هر قیمت اعمال هر سررسید
  const cc = scanFn({ def: byId('covered-call'), chain, uaKeys: ['1'], settings: s2 });
  check('کاوردکال ترکیب ساخت', cc.rows.length > 0, `${cc.rows.length} ردیف در ${cc.ms}ms`);
  check('نوار تشخیص پر شد', cc.funnel.built > 0 && cc.funnel.kept === cc.rows.length,
    `ساخته ${cc.funnel.built} | مانده ${cc.funnel.kept}`);

  // اسپرد عمودی: دو قیمت اعمال از یک سررسید، هر دو در پنجره
  const bcs = scanFn({ def: byId('bull-call-spread'), chain, uaKeys: ['1'], settings: s2 });
  check('اسپرد عمودی، هر ترکیب دو قیمت اعمال متفاوت دارد',
    bcs.rows.length > 0 && bcs.rows.every((r) => r.strikeSet.length === 2 && r.strikeSet[0] < r.strikeSet[1]),
    `${bcs.rows.length} ردیف`);

  // باترفلای با بال مساوی: ۹۰-۱۰۰-۱۱۰ می‌ماند، ۹۰-۹۵-۱۰۵ می‌افتد
  const bf = scanFn({ def: byId('long-call-butterfly'), chain, uaKeys: ['1'], settings: s2 });
  const widths = bf.rows.map((r) => [r.strikeSet[1] - r.strikeSet[0], r.strikeSet[2] - r.strikeSet[1]]);
  check('بال مساوی رعایت شد', widths.every(([a, b]) => Math.abs(a - b) < 1), `${bf.rows.length} ردیف`);
  const bfOff = scanFn({ def: byId('long-call-butterfly'), chain, uaKeys: ['1'], settings: { ...s2, wingsEqualWidth: false } });
  check('خاموش کردن بال مساوی، ترکیب را بیشتر می‌کند', bfOff.rows.length > bf.rows.length,
    `${bf.rows.length} → ${bfOff.rows.length}`);

  // تقویمی: باید دو سررسید متفاوت داشته باشد و پای دور، دورتر باشد
  const cal = scanFn({ def: byId('calendar-call'), chain, uaKeys: ['1'], settings: s2 });
  check('تقویمی دو سررسید متفاوت دارد',
    cal.rows.length > 0 && cal.rows.every((r) => r.expiryDays.length === 2 && r.expiryDays[0] < r.expiryDays[1]),
    `${cal.rows.length} ردیف`);
  check('تقویمی، پوشش کامل و بدون وجه تضمین', cal.rows.every((r) => r.margin === 0 && r.coverage === 'full'));

  // نماد بی‌مظنه هیچ ردیفی نمی‌دهد و در نوار تشخیص شمرده می‌شود
  const dead = scanFn({ def: byId('covered-call'), chain, uaKeys: ['2'], settings: s2 });
  check('نماد بی‌مظنه، صفر ردیف و شمارش در نوار تشخیص',
    dead.rows.length === 0 && dead.funnel.noQuote > 0, `بی‌مظنه ${dead.funnel.noQuote}`);
  const shown = scanFn({ def: byId('covered-call'), chain, uaKeys: ['2'], settings: { ...s2, showUnexecutable: true } });
  check('با روشن کردن نمایش غیرقابل اجرا، ردیف برمی‌گردد و برچسب می‌خورد',
    shown.rows.length > 0 && shown.rows.every((r) => !r.executable), `${shown.rows.length} ردیف`);

  // پنجره قیمت اعمال، مهار اصلی است
  const wide = scanFn({ def: byId('iron-condor'), chain, uaKeys: ['1'], settings: { ...s2, comboWindowPct: 30 } });
  const narrow = scanFn({ def: byId('iron-condor'), chain, uaKeys: ['1'], settings: { ...s2, comboWindowPct: 6 } });
  check('پنجره باریک‌تر، ترکیب کمتر', narrow.funnel.built < wide.funnel.built,
    `${wide.funnel.built} → ${narrow.funnel.built}`);
  check('سقف ترکیب هر سررسید اعمال می‌شود',
    scanFn({ def: byId('iron-condor'), chain, uaKeys: ['1'], settings: { ...s2, maxCombosPerExpiry: 2 } }).funnel.built <= 6);

  // رتبه‌بندی
  const ranked = scanFn({ def: byId('covered-call'), chain, uaKeys: ['1'], settings: { ...s2, rankBy: 'retMonthPct' } });
  const rr = ranked.rows.map((r) => r.retMonthPct).filter(Number.isFinite);
  check('ردیف‌ها نزولی مرتب شدند', rr.every((v, i) => i === 0 || rr[i - 1] >= v));
}

group('۱۳. موقعیت واقعی و تحلیل رول');
{
  const size = 1000;
  const fees = { buyStock: 0.003712, sellStock: 0.0088, option: 0.00103, exercise: 0.0005 };
  const q = (bid, ask) => ({ bid, bidQty: 1000, ask, askQty: 1000, last: (bid + ask) / 2, close: (bid + ask) / 2 });

  // کاوردکال اجراشده: سهم ۱۰۰٫۰۰۰ خریدی، کال ۱۱۰٫۰۰۰ به ۵٫۰۰۰ فروختی
  const pos = {
    id: 'p1', qty: 2, entryDate: todayJalali(), uaIns: '1',
    legs: [
      { kind: 'underlying', side: 'buy', ratio: 1, size, price: 100000 },
      { kind: 'call', side: 'sell', ratio: 1, size, strike: 110000, price: 5000, days: 30 },
    ],
  };

  // پایه بالا رفته و کال گران‌تر شده
  const mtm = markToMarket(pos, [q(104000, 105000), q(7000, 7400)], { fees, spot: 104500, spotClose: 104500 });
  check('ارزش‌گذاری لحظه‌ای عدد متناهی می‌دهد', Number.isFinite(mtm.pnl), `${Math.round(mtm.pnl).toLocaleString()}`);
  check('سود کل، ضربدر تعداد قرارداد', Math.abs(mtm.pnlTotal - mtm.pnl * 2) < 1e-6);
  check('تفکیک پا: سهم در سود، کال در زیان',
    mtm.perLeg[0].pnl > 0 && mtm.perLeg[1].pnl < 0,
    `سهم ${Math.round(mtm.perLeg[0].pnl).toLocaleString()} | کال ${Math.round(mtm.perLeg[1].pnl).toLocaleString()}`);
  check('پریمیوم دریافتی، سود تحقق‌یافته شمرده نمی‌شود', mtm.pnl < 4000 * size,
    'بدهی کال به قیمت روز لحاظ شده');
  check('اگر تا سررسید نگه داری، سود در قیمت فعلی', Number.isFinite(mtm.ifHeld.atSpot));
  check('روز نگه‌داری از تاریخ شمسی خوانده شد', mtm.daysHeld === 0, `${mtm.daysHeld}`);

  // رول: کال ۱۱۰ را ببند، کال ۱۲۰ سررسید دورتر بفروش
  const roll = rollAnalysis({
    pos, quotes: [q(104000, 105000), q(7000, 7400)],
    closeIdx: 1,
    newLeg: { kind: 'call', side: 'sell', ratio: 1, size, strike: 120000, days: 90 },
    newQuote: q(6000, 6400),
    opt: { fees, spot: 104500 },
  });
  check('هزینه بستن، از عرضه گرفته شد', roll.closePrice === 7400 && roll.closeCash < 0,
    `${Math.round(roll.closeCash).toLocaleString()}`);
  check('بستانکار پای تازه، از تقاضا گرفته شد', roll.newPrice === 6000 && roll.newCash > 0);
  check('موقعیت جدید سقف سود بالاتری دارد', roll.nextMaxProfit > roll.curMaxProfit,
    `${Math.round(roll.curMaxProfit).toLocaleString()} → ${Math.round(roll.nextMaxProfit).toLocaleString()}`);
  check('سربه‌سری موقعیت جدید بالاتر است، چون هزینه بستن پرداخت شد',
    roll.nextBreakevens[0] > roll.curBreakevens[0],
    `${roll.curBreakevens[0].toFixed(0)} → ${roll.nextBreakevens[0].toFixed(0)}`);
  check('تفاضل در قیمت پایین منفی و در قیمت بالا (فراتر از مرز تصمیم) مثبت است',
    roll.diff(90000) < 0 && roll.diff(200000) > 0,
    `${Math.round(roll.diff(90000)).toLocaleString()} در برابر ${Math.round(roll.diff(200000)).toLocaleString()}`);
  check('مرز تصمیم پیدا شد', roll.crossings.length >= 1,
    roll.crossings.map((x) => Math.round(x).toLocaleString()).join(' , '));
  check('جمع‌بندی بر مبنای قیمت فعلی داده شد', !!roll.verdict, roll.verdict);

  // ——— رول چند-سررسیدی: پای تازه سررسید دیگری دارد (قلم الف-۵ بک‌لاگ) ———
  // ۱۱۰/۳۰روزه بسته می‌شود، ۱۲۰/۹۰روزه جای آن می‌نشیند — پس موقعیت پس از رول
  // دیگر تک‌سررسیدی نیست. analyzePayoff دیگر معنا ندارد (هر پا سررسید خودش
  // را می‌خواهد)، پس مسیر analyzeMixed با افق مشترک «امروز» باید فعال شود.
  check('رول چند-سررسیدی، approx=true را علامت می‌زند', roll.approx === true);
  check('یادداشت رول چند-سررسیدی، تقریبی‌بودن را می‌گوید', roll.note.includes('تقریبی'));

  // هویت جبری: diff همین رول باید دقیقاً از تفاضل دو analyzeMixed مستقل،
  // با همان افق و همان netCash های برگشتی، به دست بیاید — نه یک تقریب دیگر.
  const mixOpt13 = { fees, spot: 104500, horizonDays: 0 };
  const curCheck13 = analyzeMixed(pos.legs, roll.curNet, mixOpt13);
  const nextCheck13 = analyzeMixed(roll.nextLegs, roll.nextNet, mixOpt13);
  const identityAt = 115000;
  check('diff رول چند-سررسیدی دقیقاً از دو analyzeMixed مستقل می‌آید (هویت جبری)',
    near(roll.diff(identityAt), nextCheck13.at(identityAt) - curCheck13.at(identityAt), 1e-9),
    `${roll.diff(identityAt)} ~ ${nextCheck13.at(identityAt) - curCheck13.at(identityAt)}`);

  // رول هم‌سررسید (اکثریت رول‌های واقعی — فقط قیمت اعمال عوض می‌شود، نه
  // سررسید) باید دست‌نخورده از همان موتور دقیق تکه‌ای-خطی قبلی بماند —
  // approx ست نمی‌شود، جبر دقیق است نه تقریب بلک-شولز.
  const rollSameExpiry = rollAnalysis({
    pos, quotes: [q(104000, 105000), q(7000, 7400)],
    closeIdx: 1,
    newLeg: { kind: 'call', side: 'sell', ratio: 1, size, strike: 120000, days: 30 },
    newQuote: q(6000, 6400),
    opt: { fees, spot: 104500 },
  });
  check('رول هم‌سررسید هنوز از موتور دقیق تکه‌ای-خطی می‌آید، نه تقریبی',
    !rollSameExpiry.approx);
}

group('۱۴. تاریخ شمسی');
{
  const [gy, gm, gd] = jalaliToGregorian(1404, 5, 21);
  check('۱۴۰۴/۰۵/۲۱ برابر ۲۰۲۵-۰۸-۱۲ است', gy === 2025 && gm === 8 && gd === 12, `${gy}-${gm}-${gd}`);
  const [jy, jm, jd] = gregorianToJalali(2025, 8, 12);
  check('رفت و برگشت تاریخ', jy === 1404 && jm === 5 && jd === 21, `${jy}/${jm}/${jd}`);
  check('تاریخ بد، null می‌دهد', parseJalali('چیز بی‌ربط') === null);
  check('امروز به شمسی، قالب درست دارد', /^\d{4}\/\d{2}\/\d{2}$/.test(todayJalali()), todayJalali());
}

group('۱۵. قرارداد پیام‌رسانی ریسه اسکن');
{
  // ریسه را در نود سوار می‌کنیم، با یک self ساختگی. اینطور پروتکل پیام‌ها
  // بدون مرورگر آزمون می‌شود و خطای کلون‌شدن داده هم بیرون می‌آید.
  const out = [];
  globalThis.self = { onmessage: null, postMessage: (m) => out.push(m) };
  await import('../worker/scan-worker.mjs');
  const send = (m) => globalThis.self.onmessage({ data: m });

  const mkRow = (strike, days, cBid, pBid) => ({
    uaInsCode: '1', lval30_UA: 'نمونه', pDrCotVal_UA: 100000, pClosing_UA: 100000,
    insCode_C: `c${strike}_${days}`, insCode_P: `p${strike}_${days}`,
    strikePrice: strike, contractSize: 1000, remainedDay: days,
    pMeDem_C: cBid, qTitMeDem_C: 100, pMeOf_C: cBid * 1.05, qTitMeOf_C: 100,
    pDrCotVal_C: cBid, pClosing_C: cBid, oP_C: 500, qTotTran5J_C: 10,
    pMeDem_P: pBid, qTitMeDem_P: 100, pMeOf_P: pBid * 1.05, qTitMeOf_P: 100,
    pDrCotVal_P: pBid, pClosing_P: pBid, oP_P: 400, qTotTran5J_P: 10,
  });
  const rows = [];
  for (const k of [90000, 95000, 100000, 105000, 110000]) {
    rows.push(mkRow(k, 30, Math.max(300, 104000 - k), Math.max(300, k - 96000)));
    rows.push(mkRow(k, 90, Math.max(500, 107000 - k), Math.max(500, k - 93000)));
  }
  const st = defaults();

  send({ type: 'rows', id: 1, full: true, rows, at: Date.now() });
  const ch = out.find((m) => m.type === 'chain');
  check('ریسه زنجیره ساخت و فهرست نماد داد', !!ch && ch.list.length === 1 && ch.stats.contracts === 20,
    `${ch?.list.length} نماد | ${ch?.stats.contracts} قرارداد`);

  send({ type: 'scan', id: 2, defId: 'covered-call', uaKeys: ['1'], settings: st, qty: 1 });
  const sc = out.find((m) => m.type === 'scan');
  check('ریسه اسکن کرد و نوار تشخیص برگشت', sc.rows.length > 0 && sc.funnel.built > 0,
    `${sc.rows.length} ردیف در ${sc.ms}ms`);
  check('ردیف بین ریسه و نخ اصلی کلون می‌شود',
    (() => { try { structuredClone(sc.rows[0]); return true; } catch { return false; } })(),
    'شیء تابع‌دار در ردیف نمانده');
  check('ردیف، پاهای قیمت‌خورده را برای رسم نمودار همراه دارد',
    Array.isArray(sc.rows[0].__legs) && sc.rows[0].__legs.length === 2);

  // مرحله دو: عمق واقعی می‌نشیند و یونانی روشن می‌شود
  const target = sc.rows[0];
  const optIns = target.legIns[0];
  send({ type: 'overlay', id: 3, data: {
    1: { book: [{ level: 1, bid: 99000, bidQty: 50000, ask: 100000, askQty: 50000 },
                { level: 2, bid: 98500, bidQty: 90000, ask: 100500, askQty: 90000 }] },
    [optIns]: { book: [{ level: 1, bid: 4000, bidQty: 3, ask: 4200, askQty: 3 },
                       { level: 2, bid: 3900, bidQty: 400, ask: 4400, askQty: 400 }] },
  } });
  check('پوشش عمق پذیرفته شد', out.some((m) => m.type === 'overlay-ok'));

  send({ type: 'scan', id: 4, defId: 'covered-call', uaKeys: ['1'], settings: st, qty: 5, onlyIds: [target.id] });
  const sc2 = out.filter((m) => m.type === 'scan')[1];
  const r2 = sc2.rows[0];
  check('مرحله دو فقط همان ردیف را برمی‌گرداند', sc2.rows.length === 1 && r2.id === target.id);
  check('با عمق واقعی، افت مظنه محاسبه شد', Number.isFinite(r2.legPrices[1].slipPct),
    `${r2.legPrices[1].slipPct.toFixed(2)}٪`);
  check('در مرحله دو یونانی روشن می‌شود', Number.isFinite(r2.delta) && !r2.greeksIncomplete,
    `دلتا ${r2.delta.toFixed(1)}`);
  check('در مرحله یک یونانی خاموش است', !Number.isFinite(target.delta), 'صرفه‌جویی در تلاطم ضمنی');
  check('هشدار عمق پایه نامعلوم، پس از نشستن عمق برداشته شد',
    !r2.warn.includes('عمق پایه نامعلوم'), r2.warn.join(' , ') || 'بی‌هشدار');

  send({ type: 'chain-detail', id: 5, uaIns: '1' });
  const cd = out.find((m) => m.type === 'chain-detail');
  check('جزئیات زنجیره برای تب دیده‌بان', cd.ua.expiries.length === 2 && cd.ua.expiries[0].strikes.length === 5);

  send({ type: 'scan', id: 6, defId: 'ناشناخته', uaKeys: ['1'], settings: st });
  check('استراتژی ناشناخته، خطای تمیز می‌دهد',
    out.filter((m) => m.type === 'scan').some((m) => m.error));
  delete globalThis.self;
}

group('۱۶. موتور چند-سررسیدی — کرانداری');
{
  // این گروه یک باگ واقعی را قفل می‌کند: شیب انتهایی از لبه پنجره رسم خوانده
  // می‌شد. در دو برابر قیمت پایه، پای زنده هنوز ارزش زمانی دارد و شیب ظاهری
  // صفر نیست، پس هر تقویمی «زیان نامحدود» می‌گرفت. چون مخرج بازده بیشترین
  // زیان است، بازده هر ردیف تقویمی صفر می‌شد و کل تب از رتبه‌بندی می‌افتاد.
  const spot = 100000, size = 1000;
  const leg = (side, K, price, days, ratio = 1) =>
    ({ kind: 'call', side, ratio, strike: K, price, size, days, sigma: 0.6 });
  const cash = (ls) => ls.reduce((c, l) => c - signedQty(l) * l.price, 0);
  const run = (ls) => analyzeMixed(ls, cash(ls), { spot, rFree: 0.3, sigma: 0.6 });

  // تقویمی خرید: فروش نزدیک، خرید دور، یک قیمت اعمال
  const cal = [leg('sell', 100000, 3000, 20), leg('buy', 100000, 5000, 80)];
  const a = run(cal);
  check('تقویمی خرید، زیان کراندار است', !a.unlimitedLoss && Number.isFinite(a.maxLoss));
  check('بیشترین زیان تقویمی، دقیقاً بدهکار خالص است',
    near(a.maxLoss, 2_000_000, 1e-6), `${Math.round(a.maxLoss).toLocaleString()}`);
  check('شیب مجانبی تقویمی عملاً صفر است', Math.abs(a.slopeRight) < 1e-3,
    a.slopeRight.toExponential(2));
  check('سود تقویمی هم کراندار است', !a.unlimitedProfit && Number.isFinite(a.maxProfit),
    `${Math.round(a.maxProfit).toLocaleString()}`);

  // مورب بدهکار: اعمال‌های متفاوت، باز هم کراندار و زیانش بدهکار خالص
  const diag = [leg('sell', 110000, 1500, 20), leg('buy', 95000, 8000, 80)];
  const b = run(diag);
  check('مورب بدهکار، زیان کراندار و برابر بدهکار خالص',
    !b.unlimitedLoss && near(b.maxLoss, 6_500_000, 1e-6),
    `${Math.round(b.maxLoss).toLocaleString()}`);

  // نسبت تقویمی: یک پای لخت می‌ماند، پس زیان واقعاً نامحدود است
  const ratioCal = [leg('sell', 100000, 3000, 20, 2), leg('buy', 100000, 5000, 80)];
  const c = run(ratioCal);
  check('نسبت تقویمی، زیان واقعاً نامحدود شناسایی شد',
    c.unlimitedLoss && c.maxLoss === Infinity);
  check('شیب مجانبی نسبت تقویمی، اندازه پای لخت است',
    near(c.slopeRight, -size, 1e-6), `${c.slopeRight.toFixed(1)} در برابر ${-size}`);

  // آستانه باید با اندازه موقعیت مقیاس بخورد، نه عدد مطلق
  const big = [leg('sell', 100000, 3000, 20), leg('buy', 100000, 5000, 80)]
    .map((l) => ({ ...l, size: 1_000_000 }));
  check('تقویمی بزرگ هم کراندار می‌ماند — آستانه مقیاس‌پذیر است',
    !analyzeMixed(big, cash(big), { spot, rFree: 0.3, sigma: 0.6 }).unlimitedLoss);

  // ارزش در قیمت پایه نزدیک صفر: هر دو کال بی‌ارزش، پس همان بدهکار خالص
  check('ارزش در قیمت پایه صفر، بدهکار خالص است', near(a.atZero, -2_000_000, 1e-6),
    `${Math.round(a.atZero).toLocaleString()}`);
}

group('۱۷. سنجه‌های سربه‌سری');
{
  const S = 100000;
  // یک سربه‌سری بالای پایه: پایه باید ۵٪ بالا برود
  const up = breakevenMetrics([105000], S);
  check('فاصله تا سربه‌سری بالاتر، مثبت است', near(up.beDistPct, 5, 1e-9), `${up.beDistPct}٪`);
  check('نزدیک‌ترین سربه‌سری، همان تک نقطه است', up.beNear === 105000);

  // یک سربه‌سری زیر پایه: علامت منفی است، ولی حاشیه امن بدون علامت
  const dn = breakevenMetrics([92000], S);
  check('فاصله تا سربه‌سری پایین‌تر، منفی است', near(dn.beDistPct, -8, 1e-9), `${dn.beDistPct}٪`);
  check('حاشیه امن بدون علامت است', near(dn.beRoomPct, 8, 1e-9));

  // استرادل: دو سربه‌سری. نزدیک‌ترین انتخاب می‌شود، نه اولی.
  const strad = breakevenMetrics([94000, 108000], S);
  check('از دو سربه‌سری، نزدیک‌ترین به پایه انتخاب شد', strad.beNear === 94000,
    `${strad.beNear} در برابر ${strad.beHigh}`);
  check('پایین و بالا درست تفکیک شدند', strad.beLow === 94000 && strad.beHigh === 108000);
  check('پهنای سربه‌سری، درصد قیمت پایه است', near(strad.beWidthPct, 14, 1e-9), `${strad.beWidthPct}٪`);
  check('شمار سربه‌سری', strad.beCount === 2);

  // ترتیب ورودی نباید اثر بگذارد
  const rev = breakevenMetrics([108000, 94000], S);
  check('ترتیب ورودی اثر ندارد', rev.beNear === strad.beNear && rev.beLow === strad.beLow);

  // بدون سربه‌سری یا بدون قیمت پایه، عدد ساختگی ساخته نمی‌شود
  const none = breakevenMetrics([], S);
  check('بی‌سربه‌سری، همه سنجه‌ها نامعتبرند',
    !Number.isFinite(none.beNear) && !Number.isFinite(none.beDistPct) && none.beCount === 0);
  check('قیمت پایه نامعتبر، سنجه نمی‌سازد', !Number.isFinite(breakevenMetrics([100], 0).beNear));

  // تک سربه‌سری پهنا ندارد
  check('تک سربه‌سری پهنا ندارد', !Number.isFinite(up.beWidthPct));
  // مقدار بی‌معنی در فهرست، دور ریخته می‌شود
  const dirty = breakevenMetrics([NaN, -5, 0, 103000], S);
  check('سربه‌سری بی‌معنی کنار گذاشته شد', dirty.beCount === 1 && dirty.beNear === 103000);
}

group('۱۹. نوار تشخیص، علت واقعی افتادن را می‌گوید');
{
  // این گروه یک باگ گزارش‌شده کاربر را قفل می‌کند: تب خالی بود و نوار تشخیص
  // می‌گفت «عمق ناکافی»، در حالی که علت واقعی این بود که مبنای قیمت روی
  // «پایانی» بود — مبنایی که طبق طراحی هرگز ادعای اجرا ندارد. کاربر هیچ راهی
  // نداشت این را بفهمد.
  const mkRow = (strike, days, cBid, pBid, qty = 100) => ({
    uaInsCode: '1', lval30_UA: 'نمونه', pDrCotVal_UA: 100000, pClosing_UA: 100000, priceYesterday_UA: 99000,
    insCode_C: `c${strike}_${days}`, lVal18AFC_C: `ض${strike}`, insCode_P: `p${strike}_${days}`, lVal18AFC_P: `ط${strike}`,
    strikePrice: strike, contractSize: 1000, remainedDay: days, endDate: 20260101,
    pMeDem_C: cBid, qTitMeDem_C: qty, pMeOf_C: Math.round(cBid * 1.05), qTitMeOf_C: qty,
    pDrCotVal_C: cBid, pClosing_C: cBid, oP_C: 500, qTotTran5J_C: 1000,
    pMeDem_P: pBid, qTitMeDem_P: qty, pMeOf_P: Math.round(pBid * 1.05), qTitMeOf_P: qty,
    pDrCotVal_P: pBid, pClosing_P: pBid, oP_P: 400, qTotTran5J_P: 800,
  });
  const market = (qty) => {
    const rows = [];
    for (const k of [90000, 95000, 100000, 105000, 110000]) {
      rows.push(mkRow(k, 30, Math.max(200, 100000 - k + 4000), Math.max(200, k - 100000 + 4000), qty));
      rows.push(mkRow(k, 90, Math.max(300, 100000 - k + 7000), Math.max(300, k - 100000 + 7000), qty));
    }
    return rows;
  };
  const runScan = (rows, over = {}) => {
    const s = { ...defaults(), ...over };
    return scanFn({ def: byId('bull-call-spread'), chain: buildChain(rows, s), uaKeys: ['1'], settings: s, qty: s.qtyDefault });
  };

  const base = runScan(market(100));
  check('با دفتر سفارش و مظنه سالم، ردیف می‌ماند', base.funnel.kept > 0, `${base.funnel.kept} ردیف`);
  check('و هیچ‌کدام در سطل مرجع یا عمق نمی‌افتد',
    base.funnel.refBasis === 0 && base.funnel.noDepth === 0);

  // ——— علت یک: مبنای قیمت مرجع ———
  for (const basis of ['CLOSE', 'LAST', 'LOW', 'HIGH']) {
    const r = runScan(market(100), { priceBasis: basis });
    check(`مبنای ${basis} در سطل «مبنای مرجع» می‌افتد، نه «عمق ناکافی»`,
      r.funnel.refBasis === r.funnel.built && r.funnel.noDepth === 0 && r.funnel.kept === 0,
      `مرجع ${r.funnel.refBasis} از ${r.funnel.built}`);
  }

  // با روشن کردن نمایش غیرقابل اجرا، همان ترکیب‌ها برمی‌گردند
  const shown = runScan(market(100), { priceBasis: 'CLOSE', showUnexecutable: true });
  check('با نمایش غیرقابل اجرا، ردیف‌های مبنای مرجع برمی‌گردند',
    shown.funnel.kept > 0 && shown.funnel.refBasis === 0, `${shown.funnel.kept} ردیف`);

  // ——— علت دو: قیمت هست ولی حجمی پشتش نیست ———
  const dry = runScan(market(0));
  check('حجم مظنه صفر، «بی‌مظنه» شمرده می‌شود نه «عمق ناکافی»',
    dry.funnel.noQuote === dry.funnel.built && dry.funnel.noDepth === 0 && dry.funnel.kept === 0,
    `بی‌مظنه ${dry.funnel.noQuote} از ${dry.funnel.built}`);

  // ——— علت سه: فیلتر خود کاربر ———
  const tight = runScan(market(100), { maxSpreadPct: 1 });
  check('سقف اسپرد تنگ، در سطل فیلتر تو می‌افتد',
    tight.funnel.filtered === tight.funnel.built && tight.funnel.kept === 0);

  // حالت میانه ادعای اجرا ندارد ولی ردیف را نمی‌اندازد — عمداً
  const mid = runScan(market(100), { execMode: 'MID' });
  check('حالت میانه ردیف را نمی‌اندازد', mid.funnel.kept > 0 && mid.funnel.refBasis === 0);

  // ——— علت، از کیفیت ماشین‌خوان می‌آید نه از متن برچسب ———
  check('علت مرجع، از کیفیت پا خوانده می‌شود',
    unexecutableReason({ legPrices: [{ quality: 'depth' }, { quality: 'reference' }] }) === 'refBasis');
  check('علت بی‌مظنه، از کیفیت پا خوانده می‌شود',
    unexecutableReason({ legPrices: [{ quality: 'none' }, { quality: 'depth' }] }) === 'noQuote');
  check('مرجع بر بی‌مظنه اولویت دارد، چون تنظیم کاربر است نه واقعیت بازار',
    unexecutableReason({ legPrices: [{ quality: 'none' }, { quality: 'reference' }] }) === 'refBasis');
  check('بی هیچ نشانه‌ای، عمق ناکافی می‌ماند',
    unexecutableReason({ legPrices: [{ quality: 'depth' }] }) === 'noDepth');
  check('ردیف بی‌پا، خطا نمی‌دهد', unexecutableReason({}) === 'noDepth');

  // کیفیت ماشین‌خوان باید واقعاً روی ردیف بنشیند، وگرنه علت همیشه noDepth است
  const one = runScan(market(100), { priceBasis: 'CLOSE', showUnexecutable: true });
  check('کیفیت هر پا روی ردیف ثبت می‌شود',
    one.rows[0].legPrices.every((l) => typeof l.quality === 'string'),
    one.rows[0].legPrices.map((l) => l.quality).join(' , '));
}

group('۱۸. نگهبان مرز سرور');
{
  const ROOT = path.resolve('C:/x/options-radar');
  const ok = (p) => safeStaticPath(ROOT, p);

  // ——— مسیر مجاز ———
  check('ریشه به صفحه اصلی می‌رود', ok('/') === path.join(ROOT, 'ui', 'index.html'), `${ok('/')}`);
  check('فایل معمولی زیر ریشه قبول است', ok('/ui/style.css') === path.join(ROOT, 'ui', 'style.css'));
  check('مسیر تودرتو قبول است', ok('/ui/tabs/engine.mjs') === path.join(ROOT, 'ui', 'tabs', 'engine.mjs'));

  // ——— همان باگی که این گروه برایش نوشته شد ———
  // مقایسه رشته‌ای startsWith، پوشه هم‌نام‌شروع کنار ریشه را رد نمی‌کرد
  check('پوشه هم‌نام‌شروع کنار ریشه رد می‌شود',
    ok('/../options-radar-private/secret.env') === null,
    `${ok('/../options-radar-private/secret.env')}`);

  // ——— عبور از ریشه ———
  check('بالا رفتن ساده رد می‌شود', ok('/../../etc/passwd') === null);
  check('بالا رفتن از میان مسیر رد می‌شود', ok('/ui/../../etc/passwd') === null);
  check('رمزگشایی درصدی هم گرفته می‌شود', ok('/%2e%2e%2f%2e%2e%2fetc%2fpasswd') === null,
    `${ok('/%2e%2e%2f%2e%2e%2fetc%2fpasswd')}`);
  check('رمزگشایی درصدی نیمه‌کاره رد می‌شود', ok('/%2e%2e/secret') === null);
  check('درصد خراب، خطا نمی‌دهد و رد می‌شود', ok('/%zz') === null);
  check('بایت صفر رد می‌شود', ok('/ui/style.css\0.png') === null);
  check('خود ریشه فایل نیست', ok('/..') === null);
  check('ورودی غیرمتنی رد می‌شود', safeStaticPath(ROOT, null) === null);

  // ——— کد ابزار ———
  check('کد رقمی قبول است', validIns('17914401791772679'));
  check('کد خالی رد می‌شود', !validIns(''));
  check('کد با عبور از مسیر رد می‌شود', !validIns('123/../GetSomethingElse'));
  check('کد با نقطه رد می‌شود', !validIns('12.3'));
  check('کد با حرف رد می‌شود', !validIns('12a3'));
  check('کد با فاصله رد می‌شود', !validIns(' 123'));
  check('کد بیش از حد بلند رد می‌شود', !validIns('9'.repeat(33)));
  check('عدد به‌جای رشته رد می‌شود', !validIns(123));

  // ——— فهرست کد ———
  const list = parseInsList(' 111 , 222,۳۳۳,../x,333,111 , ');
  check('فهرست کد: نامعتبر و تکراری دور ریخته شد',
    list.length === 3 && list.join(',') === '111,222,333', list.join(','));
  check('رقم فارسی، کد معتبر نیست', !parseInsList('۱۲۳').length);
  check('سقف تعداد اعمال می‌شود',
    parseInsList(Array.from({ length: 500 }, (_, i) => String(i + 1)).join(','), 200).length === 200);
  check('ورودی خالی، فهرست خالی می‌دهد', parseInsList(null).length === 0);

  // ——— سقف بدنه ———
  const streamOf = (...parts) => ({
    async *[Symbol.asyncIterator]() { for (const p of parts) yield Buffer.from(p); },
  });
  const read = async (stream, max) => {
    try { return { body: await readBody(stream, max) }; }
    catch (e) { return { err: e }; }
  };

  const small = await read(streamOf('{"a":', '1}'), 1000);
  check('بدنه کوچک، کامل و چسبیده خوانده می‌شود', small.body === '{"a":1}', small.body);

  const big = await read(streamOf('x'.repeat(50), 'y'.repeat(60)), 100);
  check('بدنه بزرگ‌تر از سقف، خطای BodyTooLarge می‌دهد',
    big.err instanceof BodyTooLarge && big.err.limit === 100, big.err?.name);

  // سقف باید حین دریافت بزند، نه بعد از جمع شدن همه‌چیز در حافظه
  let pulled = 0;
  const counted = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 1000; i++) { pulled += 1; yield Buffer.from('z'.repeat(100)); }
    },
  };
  await read(counted, 250);
  check('سقف حین دریافت می‌زند، نه بعدش', pulled === 3, `${pulled} تکه خوانده شد از ۱۰۰۰`);

  const exact = await read(streamOf('a'.repeat(100)), 100);
  check('بدنه دقیقاً هم‌اندازه سقف، قبول است', exact.body?.length === 100);
}

// ═══════ ۲۰. بازه سود موتور چند-سررسیدی از لبه پنجره بریده نمی‌شود ═══════
group('۲۰. بازه سود، بیرون پنجره رسم');
{
  // باگ: پنجره نمونه‌برداری [۰٫۳۵ , ۲٫۲] برابر قیمت پایه بود و بازه سود از
  // همان‌جا بریده می‌شد. هر ترکیب پوت‌دار که در سقوط شدید سود می‌داد، بازه
  // سودش «از ۳۵٪ قیمت پایه» گزارش می‌شد و احتمال سودش کم‌برآورد می‌شد.
  const legs = [
    { kind: 'put', side: 'buy', ratio: 1, strike: 1200, days: 30, size: 1000 },
    { kind: 'call', side: 'sell', ratio: 1, strike: 1400, days: 60, size: 1000 },
  ];
  const a = analyzeMixed(legs, -50000, { spot: 1000, sigma: 0.6 });

  check('بازه سود تا صفر می‌رسد، نه تا لبه پنجره', a.regions.length === 1 && a.regions[0][0] === 0,
        JSON.stringify(a.regions.map((r) => r.map((x) => Math.round(x)))));
  check('سود در قیمت‌های خیلی پایین واقعاً مثبت است', a.at(1) > 0 && a.at(300) > 0,
        `${Math.round(a.at(1))} و ${Math.round(a.at(300))}`);
  check('مرز بالای بازه دقیقاً سربه‌سری است',
        a.breakevens.length === 1 && near(a.regions[0][1], a.breakevens[0], 1e-9),
        `${a.regions[0][1]}`);
  check('در مرز، سود عملاً صفر است', Math.abs(a.at(a.breakevens[0])) < 1,
        `${a.at(a.breakevens[0])}`);

  // احتمال سود باید از حالت بریده بزرگ‌تر باشد. افق و تلاطم را جایی می‌گیریم
  // که دنباله پایین واقعاً وزن داشته باشد، وگرنه آزمون چیزی ثابت نمی‌کند:
  // در سی روز با تلاطم ۰٫۶، احتمال رسیدن به ۳۵٪ قیمت پایه عملاً صفر است و
  // هر دو عدد تا دو رقم اعشار یکی درمی‌آیند.
  const truncated = [[Math.max(1000 * 0.35, 1), a.regions[0][1]]];
  const full = probOfProfit(a, 1000, 1, 1.2);
  const cut = probOfProfit({ regions: truncated }, 1000, 1, 1.2);
  check('احتمال سود دیگر کم‌برآورد نمی‌شود', full - cut > 1,
        `${full.toFixed(2)}٪ در برابر ${cut.toFixed(2)}٪ — ${(full - cut).toFixed(2)} واحد بازیافت شد`);

  // پنجره رسم باید قیمت اعمال دور را هم بگیرد
  const far = analyzeMixed([
    { kind: 'call', side: 'buy', ratio: 1, strike: 5000, days: 30, size: 1000 },
    { kind: 'call', side: 'sell', ratio: 1, strike: 5000, days: 60, size: 1000 },
  ], -10000, { spot: 1000, sigma: 0.6 });
  const xs = far.points.map((p) => p.S);
  check('قیمت اعمال دور داخل پنجره رسم است', Math.max(...xs) >= 5000, `تا ${Math.round(Math.max(...xs))}`);

  // بدون سربه‌سری، یک بازه یکپارچه — و باید علامتش درست خوانده شود
  const allLoss = analyzeMixed([
    { kind: 'call', side: 'buy', ratio: 1, strike: 1000, days: 30, size: 1000 },
    { kind: 'call', side: 'sell', ratio: 1, strike: 1000, days: 60, size: 1000 },
  ], -300000, { spot: 1000, sigma: 0.6 });
  check('ترکیب همیشه‌زیان، هیچ بازه سودی ندارد', allLoss.regions.length === 0,
        JSON.stringify(allLoss.regions));

  // تقویمی خرید هنوز کراندار است — گروه ۱۶ نباید بشکند
  const cal = analyzeMixed([
    { kind: 'call', side: 'sell', ratio: 1, strike: 1000, days: 30, size: 1000 },
    { kind: 'call', side: 'buy', ratio: 1, strike: 1000, days: 60, size: 1000 },
  ], -200000, { spot: 1000, sigma: 0.6 });
  check('تقویمی خرید هنوز زیان کراندار دارد', cal.unlimitedLoss === false && Number.isFinite(cal.maxLoss),
        `${Math.round(cal.maxLoss)}`);
}

// ═══════════════════ ۲۱. عدد فارسی، یک‌جا و برگشت‌پذیر ═══════════════════
group('۲۱. قالب‌بندی عدد فارسی');
{
  check('رقم فارسی با جداکننده هزارگان', uiFmt.money(1234567) === '۱٬۲۳۴٬۵۶۷', uiFmt.money(1234567));
  check('منفی با نشانه ریاضی، نه خط تیره', uiFmt.money(-40500000) === '−۴۰٬۵۰۰٬۰۰۰', uiFmt.money(-40500000));
  check('بی‌نهایت نماد خودش را دارد', uiFmt.money(Infinity) === '∞' && uiFmt.money(-Infinity) === '−∞');
  check('ناعدد، خط تیره می‌شود', uiFmt.money(NaN) === '—' && uiFmt.int(undefined) === '—');
  check('اعشار با ممیز فارسی', uiFmt.pct(12.3456) === '۱۲٫۳۵', uiFmt.pct(12.3456));
  check('عدد کوچک، چهار رقم اعشار', uiFmt.num(0.0421) === '۰٫۰۴۲۱', uiFmt.num(0.0421));
  check('عدد بزرگ در num هم گروه‌بندی می‌شود', uiFmt.num(12345) === '۱۲٬۳۴۵', uiFmt.num(12345));
  check('فهرست عددی فارسی می‌شود', uiFmt.list([1000, 2500]) === '۱٬۰۰۰ , ۲٬۵۰۰', uiFmt.list([1000, 2500]));
  check('فهرست خالی، خط تیره', uiFmt.list([]) === '—');

  // منفی خیلی کوچک که به این دقت گرد به صفر می‌شود، نباید «−۰» چاپ کند —
  // به چشم انگار هنوز کمی زیان مانده، در حالی که عدد واقعی صفر است
  check('money(−۰٫۴) → صفر ساده، نه −۰', uiFmt.money(-0.4) === '۰', uiFmt.money(-0.4));
  check('pct(−۰٫۰۰۱) → صفر ساده، نه −۰٫۰۰', uiFmt.pct(-0.001) === '۰٫۰۰', uiFmt.pct(-0.001));
  check('int(−۰٫۲) → صفر ساده، نه −۰', uiFmt.int(-0.2) === '۰', uiFmt.int(-0.2));
  check('num منفی‌ای که واقعاً صفر نمی‌شود، همان منفی می‌ماند',
        uiFmt.num(-0.0001) === '−۰٫۰۰۰۱', uiFmt.num(-0.0001));
  check('منفی معمولی دست‌نخورده می‌ماند', uiFmt.money(-500) === '−۵۰۰' && uiFmt.pct(-1.5) === '−۱٫۵۰');

  // مرز گرد شدن num: شاخه‌بندی (گروه‌بندی‌شده ≥۱۰۰۰، ۴ رقم اعشار زیر ۱)
  // روی v خام تصمیم می‌گرفت؛ عددی که با گرد کردن از آستانه رد می‌شد شاخه
  // غلط را نگه می‌داشت. پ-۶ بک‌لاگ، دور سی‌ونهم.
  check('num که با گرد کردن به ۱۰۰۰ می‌رسد، جداکننده هزارگان می‌گیرد',
        uiFmt.num(999.996) === '۱٬۰۰۰', uiFmt.num(999.996));
  check('num منفی هم همان مرز را درست می‌گیرد',
        uiFmt.num(-999.996) === '−۱٬۰۰۰', uiFmt.num(-999.996));
  check('num که با گرد کردن از زیر ۱ به ۱ می‌رسد، دو رقم اعشار می‌گیرد نه چهار',
        uiFmt.num(0.99996) === '۱٫۰۰', uiFmt.num(0.99996));
  check('num دور از هر مرزی، دست‌نخورده می‌ماند',
        uiFmt.num(999.4) === '۹۹۹٫۴۰' && uiFmt.num(0.0421) === '۰٫۰۴۲۱');

  // هیچ رقم لاتینی نباید از قالب‌بند بیرون بیاید
  const latin = /[0-9]/;
  const samples = [uiFmt.money(-12345.6), uiFmt.pct(-0.5), uiFmt.num(999999), uiFmt.int(7),
                   axisNum(-40500000), axisNum(2.5e9), axisNum(45000), axisNum(120)];
  check('هیچ رقم لاتینی باقی نمی‌ماند', samples.every((s) => !latin.test(s)), samples.join(' | '));

  check('محور: میلیون و میلیارد و هزار', axisNum(2.5e9) === '۲٫۵ میلیارد' && axisNum(45000) === '۴۵ هزار',
        `${axisNum(2.5e9)} و ${axisNum(45000)}`);

  // مرز گرد شدن axisNum: همان دسته باگ دور ۳۹ (fmt.num)، این‌بار در واحد
  // محور نمودار — عددی که با گرد کردن از هزار به میلیون (یا میلیون به
  // میلیارد) رد می‌شود، باید واحد درست را نشان بدهد، نه واحد قبل از گرد شدن.
  check('axisNum که با گرد کردن از هزار به میلیون می‌رسد، واحد م می‌گیرد',
        axisNum(999960) === '۱٫۰ م', axisNum(999960));
  check('axisNum که با گرد کردن از میلیون به میلیارد می‌رسد، واحد میلیارد می‌گیرد',
        axisNum(999996000) === '۱٫۰ میلیارد', axisNum(999996000));
  check('axisNum منفی هم همان مرز را درست می‌گیرد',
        axisNum(-999960) === '−۱٫۰ م', axisNum(-999960));

  // ورودی کاربر ممکن است فارسی تایپ شود؛ باید بی‌کم‌وکاست برگردد
  check('تبدیل برگشتی، عدد قابل تجزیه می‌دهد', Number(toEnDigits('۱٬۲۳۴٫۵۶')) === 1234.56, toEnDigits('۱٬۲۳۴٫۵۶'));
  check('منفی فارسی هم برمی‌گردد', Number(toEnDigits('−۴۲')) === -42, toEnDigits('−۴۲'));
  check('رقم عربی هم پذیرفته می‌شود', Number(toEnDigits('٤٢')) === 42, toEnDigits('٤٢'));
  check('رفت و برگشت، عدد را عوض نمی‌کند',
        Number(toEnDigits(uiFmt.money(-9876543))) === -9876543, uiFmt.money(-9876543));

  // جست‌وجوی متنی (فهرست کناری تب‌ها، انتخابگر نماد): حروف عربی رایج در
  // داده رسمی (ي/ك) باید با معادل فارسی‌شان (ی/ک) یکی حساب شوند، وگرنه
  // کاربری که یکی از دو شکل را تایپ کند، نماد/تبی را که با شکل دیگر
  // نوشته شده پیدا نمی‌کند.
  check('ي عربی با ی فارسی یکی حساب می‌شود', normFa('علي') === normFa('علی'), `${normFa('علي')} vs ${normFa('علی')}`);
  check('ك عربی با ک فارسی یکی حساب می‌شود', normFa('كامل') === normFa('کامل'), `${normFa('كامل')} vs ${normFa('کامل')}`);
  check('نیم‌فاصله به فاصله ساده تبدیل می‌شود', normFa('می‌شود') === 'می شود', normFa('می‌شود'));
  check('فاصله اضافه دو طرف حذف می‌شود', normFa('  متن  ') === 'متن', `"${normFa('  متن  ')}"`);
  check('ورودی خالی/نامعتبر، رشته خالی می‌دهد', normFa(null) === '' && normFa(undefined) === '');

  check('فاصله زمانی خوانا و فارسی', faAgo(4000) === 'همین الان' && faAgo(125000) === '۲ دقیقه پیش',
        faAgo(125000));
  check('فاصله زمانی نامعتبر، خط تیره', faAgo(NaN) === '—' && faAgo(-5) === '—');
  check('ساعت با رقم فارسی و دو رقمی', faClock(new Date(2026, 7, 13, 9, 5, 3)) === '۰۹:۰۵:۰۳',
        faClock(new Date(2026, 7, 13, 9, 5, 3)));

  // برچسب حالت پوشش (خواسته ۵): چهار حالت خام core/margin.mjs باید فارسی
  // شوند و ریسک‌دار از کم‌ریسک با رنگ جدا شود، نه فقط با متن
  const latin2 = /[a-zA-Z]/;
  check('پوشش کامل، فارسی و کم‌ریسک', !latin2.test(coverageInfo('full').label) && coverageInfo('full').tone === 'gain');
  check('پوشش لخت، فارسی و ریسک‌دار', !latin2.test(coverageInfo('naked').label) && coverageInfo('naked').tone === 'loss');
  check('پوشش ناقص، فارسی و هشدار', !latin2.test(coverageInfo('partial').label) && coverageInfo('partial').tone === 'warn');
  check('بدون پای فروش، خنثی', !latin2.test(coverageInfo('none').label) && coverageInfo('none').tone === 'flat');
  check('حالت ناشناس، سقوط نمی‌کند و تن پیش‌فرض می‌دهد', coverageInfo('چیز-عجیب').tone === 'flat');

  // رنگ کارت KPI (تب موقعیت‌های من): «بازده روی سرمایه» همان علامت «سود و
  // زیان جاری» را دارد، پس باید همان رنگ را هم بگیرد — قبلاً فقط برچسبی که
  // شامل «سود» بود رنگ می‌گرفت و بازده بی‌رنگ می‌ماند، برخلاف مرز رنگی کارت
  // (style.css .kpi:has(.v.gain/.loss)) که برای همین قرار بود چشم را ببرد.
  check('کارت سود و زیان، سبز وقتی مثبت است', kpiTone('سود و زیان جاری', true) === 'gain');
  check('کارت سود و زیان، قرمز وقتی منفی است', kpiTone('سود و زیان جاری', false) === 'loss');
  check('کارت بازده روی سرمایه هم رنگ می‌گیرد، نه فقط برچسب سود', kpiTone('بازده روی سرمایه', false) === 'loss');
  check('کارت خنثی (سرمایه درگیر) بی‌رنگ می‌ماند', kpiTone('سرمایه درگیر', true) === '');
  check('کارت خنثی (موقعیت باز) بی‌رنگ می‌ماند', kpiTone('موقعیت باز', false) === '');

  // بدون موقعیت باز، «بازده روی سرمایه» نامعلوم است (تقسیم بر صفر سرمایه)
  // و باید بی‌رنگ بماند — قبلاً isGain=false (falsy از truthy نادرست) آن را
  // قرمز نشان می‌داد، انگار واقعاً زیان است. پ-۶ بک‌لاگ، دور سی‌وهفتم.
  check('isGain=null، حتی برای برچسب سود/بازده، بی‌رنگ می‌ماند',
        kpiTone('سود و زیان جاری', null) === '' && kpiTone('بازده روی سرمایه', null) === '');
  check('isGain=undefined هم همان رفتار null را دارد',
        kpiTone('بازده روی سرمایه', undefined) === '');

  // رنگ کارت KPI از روی علامت خودِ عدد (تب‌های استراتژی/برترین موقعیت‌ها):
  // «بهترین/میانه بازده ماهانه» قبلاً هیچ‌وقت رنگ نمی‌گرفت، حتی اگر بهترین
  // ردیف موجود هم زیان‌ده بود — دقیقاً همان چیزی که دور دهم می‌خواست از
  // اسکن سریع حذف کند.
  check('بازده مثبت، سبز', signTone(12.5) === 'gain');
  check('بازده منفی، قرمز', signTone(-3.2) === 'loss');
  check('صفر هم سبز حساب می‌شود (نه زیان)', signTone(0) === 'gain');
  check('بدون ردیف (NaN)، بی‌رنگ می‌ماند', signTone(NaN) === '');

  // پیام خام سرور (پ-۷ بک‌لاگ): «آخرین خطا» متن خام جاوااسکریپت بود، مثل
  // server/server.mjs:171 `${e.name}: ${e.message}` — کاربر فارسی‌زبان چیزی
  // از آن نمی‌فهمد. humanizeUpstreamError باید علت را فارسی و خوانا بگوید.
  const latin3 = /[a-zA-Z]/;
  check('خطای بی‌پاسخی، فارسی و بدون رقم/حرف لاتین',
        !latin3.test(humanizeUpstreamError('AbortError: The operation was aborted')),
        humanizeUpstreamError('AbortError: The operation was aborted'));
  check('خطای شبکه بالادست، فارسی', !latin3.test(humanizeUpstreamError('TypeError: fetch failed')),
        humanizeUpstreamError('TypeError: fetch failed'));
  check('خطای HTTP بالادست، کد را با رقم فارسی می‌گوید',
        humanizeUpstreamError('Error: HTTP 502').includes('۵۰۲'), humanizeUpstreamError('Error: HTTP 502'));
  check('جیسون خراب، فارسی', !latin3.test(humanizeUpstreamError('SyntaxError: Unexpected token')));
  check('بدون خطا، مقدار خالی می‌دهد', humanizeUpstreamError(null) === null && humanizeUpstreamError('') === null);
  check('خطای ناشناس هم سقوط نمی‌کند و فارسی می‌ماند',
        !latin3.test(humanizeUpstreamError('some odd unmapped message')));

  // عنوان تب مرورگر (پ-۶ بک‌لاگ، دور بیست‌ودوم): قبلاً عنوان همیشه ثابت بود
  // و با هیچ تبی عوض نمی‌شد؛ کاربری که چند تب مرورگر باز دارد نمی‌توانست
  // از روی نوار تب بفهمد کدام‌یک زنجیره اختیار است و کدام موقعیت‌های من.
  check('عنوان تب، نام تب را جلوی برند می‌آورد',
        pageTitle('دیده‌بان زنجیره اختیار') === 'دیده‌بان زنجیره اختیار — رصد استراتژی آپشن',
        pageTitle('دیده‌بان زنجیره اختیار'));
  check('بدون تب باز، فقط برند تنها می‌ماند', pageTitle('') === 'رصد استراتژی آپشن');
  check('بدون تب باز (undefined)، فقط برند تنها می‌ماند', pageTitle() === 'رصد استراتژی آپشن');
}

// ═══════════════ ۲۲. چیدمان ستون: جابه‌جایی و افزودن ═══════════════
group('۲۲. چیدمان ستون');
{
  const K = ['a', 'b', 'c', 'd'];
  const ORDER = ['a', 'b', 'c', 'd', 'e', 'f'];

  check('ستون به جای مقصد می‌نشیند، رو به جلو',
        moveColumn(K, 'a', 'c').join('') === 'bcad', moveColumn(K, 'a', 'c').join(''));
  check('و رو به عقب هم همان‌طور',
        moveColumn(K, 'd', 'b').join('') === 'adbc', moveColumn(K, 'd', 'b').join(''));
  check('جابه‌جایی با خودش، چیزی را عوض نمی‌کند', moveColumn(K, 'b', 'b').join('') === 'abcd');
  check('کلید ناموجود، فهرست را دست‌نخورده برمی‌گرداند',
        moveColumn(K, 'z', 'b').join('') === 'abcd' && moveColumn(K, 'b', 'z').join('') === 'abcd');
  check('ورودی دست‌کاری نمی‌شود', (moveColumn(K, 'a', 'd'), K.join('') === 'abcd'));
  check('طول همیشه حفظ می‌شود', moveColumn(K, 'a', 'd').length === 4);

  // افزودن، وقتی کاربر چیزی جابه‌جا نکرده: جای قراردادی
  check('ستون تازه سر جای قراردادی می‌نشیند',
        insertColumn(['a', 'c', 'e'], 'b', ORDER).join('') === 'abce',
        insertColumn(['a', 'c', 'e'], 'b', ORDER).join(''));
  check('ستونی که از همه بعدتر است، ته صف می‌رود',
        insertColumn(['a', 'b'], 'f', ORDER).join('') === 'abf');
  check('ستونی که از همه جلوتر است، سر صف می‌رود',
        insertColumn(['c', 'd'], 'a', ORDER).join('') === 'acd');

  // افزودن، وقتی چیدمان دستی شده: نباید به کار کاربر دست بزند
  const manual = ['d', 'a', 'c'];
  const after = insertColumn(manual, 'b', ORDER);
  check('چیدمان دستی با افزودن ستون خراب نمی‌شود',
        after.slice(0, 3).join('') === 'dac' && after[3] === 'b', after.join(''));
  check('ستون تکراری دوباره اضافه نمی‌شود',
        insertColumn(['a', 'b'], 'b', ORDER).join('') === 'ab');
  check('افزودن هم ورودی را دست‌کاری نمی‌کند',
        (insertColumn(manual, 'b', ORDER), manual.join('') === 'dac'));

  // رفت و برگشت: جابه‌جایی و برگرداندن، به همان نقطه اول می‌رسد
  const moved = moveColumn(K, 'a', 'c');
  check('جابه‌جایی برگشت‌پذیر است', moveColumn(moved, 'a', 'a').join('') === moved.join(''));

  // نشان «تغییر کرد» اسکن پیوسته (پ-۶ بک‌لاگ): rowClass از قبل r.__flash
  // را می‌خواند ولی هیچ‌جا نوشته نمی‌شد — changedIds همان نویسنده است.
  const prev = [{ id: 'x', v: 10 }, { id: 'y', v: 20 }, { id: 'z', v: 30 }];
  check('اولین اسکن (بدون prevRows)، چیزی فلش نمی‌گیرد',
        changedIds(null, prev, 'v').size === 0);
  const next = [{ id: 'x', v: 10 }, { id: 'y', v: 25 }, { id: 'z', v: 30 }, { id: 'w', v: 5 }];
  check('فقط ردیفی که مقدارش واقعاً عوض شده فلش می‌گیرد',
        [...changedIds(prev, next, 'v')].join('') === 'y');
  check('ردیف تازه (بدون سابقه در prevRows) فلش نمی‌گیرد',
        !changedIds(prev, next, 'v').has('w'));
  check('تغییر ناچیز کف شناوری، فلش نمی‌گیرد',
        changedIds([{ id: 'x', v: 10 }], [{ id: 'x', v: 10 + 1e-12 }], 'v').size === 0);
  check('کلید نامعتبر یا نبود، مجموعه خالی می‌دهد',
        changedIds(prev, next, null).size === 0 && changedIds(prev, next, undefined).size === 0);
  check('مقدار غیرعددی در هیچ سمتی، فلش نمی‌گیرد',
        changedIds([{ id: 'x', v: NaN }], [{ id: 'x', v: 10 }], 'v').size === 0);
}

// ═══════════════ ۲۳. کش سرور: سقف ورودی ═══════════════
group('۲۳. کش سرور، سقف ورودی');
{
  const fresh = () => new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);

  const under = fresh();
  evictOldest(under, 10);
  check('زیر سقف، دست‌نخورده می‌ماند', under.size === 5 && under.has('a'));

  const exact = fresh();
  evictOldest(exact, 5);
  check('دقیقاً هم‌اندازه سقف، چیزی حذف نمی‌شود', exact.size === 5);

  const over = fresh();
  evictOldest(over, 3);
  check('بالای سقف، قدیمی‌ترین‌ها حذف می‌شوند', over.size === 3,
        [...over.keys()].join(''));
  check('آنچه می‌ماند، تازه‌ترین‌هاست',
        !over.has('a') && !over.has('b') && over.has('c') && over.has('d') && over.has('e'));

  const toOne = fresh();
  evictOldest(toOne, 1);
  check('سقف یک، فقط تازه‌ترین می‌ماند', toOne.size === 1 && toOne.has('e'));

  const growing = new Map();
  for (let i = 0; i < 20; i++) { growing.set(`k${i}`, i); evictOldest(growing, 5); }
  check('افزودن پیاپی هرگز از سقف رد نمی‌شود', growing.size === 5);
  check('بعد از رشد پیاپی، فقط پنج‌تای آخر می‌ماند',
        growing.has('k19') && growing.has('k15') && !growing.has('k14'),
        [...growing.keys()].join(','));
}

// ═══════════════ ۲۴. عقب‌نشینی حلقه دیده‌بان ═══════════════
group('۲۴. عقب‌نشینی حلقه دیده‌بان');
{
  check('بدون شکست، فاصله عادی', watchBackoffSec(5, 0) === 5);
  check('شکست منفی هم مثل صفر رفتار می‌کند', watchBackoffSec(5, -1) === 5);
  check('یک شکست، دو برابر', watchBackoffSec(5, 1) === 10);
  check('دو شکست، چهار برابر', watchBackoffSec(5, 2) === 20);
  check('رشد نمایی ادامه دارد', watchBackoffSec(5, 4) === 80);
  check('به سقف که رسید، فراتر نمی‌رود', watchBackoffSec(5, 10, 300) === 300,
        watchBackoffSec(5, 10, 300));
  check('سقف قابل تنظیم است', watchBackoffSec(5, 10, 60) === 60);
  check('فاصله عادی هم از سقف رد نمی‌شود', watchBackoffSec(500, 0, 300) === 500,
        'فاصله پایه دست کاربر است، سقف فقط رشد نمایی را می‌بندد');
}

// ═════════════════════ ۲۵. تلاطم ضمنی، نیوتن روی وگا ═════════════════════
group('۲۵. تلاطم ضمنی، نیوتن روی وگا');
{
  const r = 0.25, q = 0.03;
  const grid = [];
  for (const S of [5000, 20000, 100000]) {
    for (const m of [0.5, 0.8, 0.95, 1.0, 1.05, 1.2, 2.0]) { // نسبت اعمال به پایه
      for (const T of [0.02, 0.1, 0.5, 1.5]) {
        for (const sig of [0.08, 0.3, 0.65, 1.5, 2.8]) {
          grid.push({ S, K: S * m, T, sig });
        }
      }
    }
  }
  // در ناحیه خیلی در پول یا خیلی بی‌پول با سررسید کوتاه، وگا عملاً صفر
  // است: قیمت روی بازه وسیعی از تلاطم تقریباً ثابت می‌ماند، پس بازیابی
  // تلاطم از قیمت ذاتاً بدشرط است — چه با تنصیف صرف، چه با نیوتن. آن
  // مواردها اینجا کنار گذاشته می‌شوند؛ آزمون جدا زیر همان حالت را می‌سنجد.
  let worst = 0;
  for (const { S, K, T, sig } of grid) {
    for (const kind of ['call', 'put']) {
      const mkt = bsPrice(kind, S, K, T, r, q, sig);
      const [a] = d1d2(S, K, T, r, q, sig);
      const dq = Math.exp(-q * T);
      const vega = S * dq * npdf(a) * Math.sqrt(T);
      if (vega / Math.max(1, mkt) < 1e-3) continue; // ناحیه بدشرط، رد شود
      const iv = impliedVol(kind, mkt, S, K, T, r, q, { lo: 0.01, hi: 5 });
      if (!Number.isFinite(iv)) continue; // خارج از باند نظری، رفتار قبلی هم NaN بود
      worst = Math.max(worst, Math.abs(iv - sig));
    }
  }
  check('نیوتن+تنصیف روی کل شبکه هم‌تراز با تلاطم واقعی همگرا می‌شود',
    worst < 2e-3, `بیشترین اختلاف ${worst.toExponential(2)}`);

  // شبیه‌ترین حالت به رفتار قبلی: نیوتن خاموش، فقط تنصیف صرف.
  {
    const S = 20000, K = 24000, T = 0.3, sig = 0.55;
    const mkt = bsPrice('call', S, K, T, r, q, sig);
    const ivBisect = impliedVol('call', mkt, S, K, T, r, q, { newtonIters: 0 });
    const ivNewton = impliedVol('call', mkt, S, K, T, r, q, {});
    check('نیوتن خاموش هم به همان جواب می‌رسد', near(ivBisect, ivNewton, 1e-6),
      `${ivBisect.toFixed(6)} ~ ${ivNewton.toFixed(6)}`);
  }

  // وگای تقریباً صفر: عمیق در پول و نزدیک سررسید. بازیابی خودِ تلاطم اینجا
  // ذاتاً بدشرط است (قیمت روی بازه‌ای وسیع از سیگما تقریباً ثابت می‌ماند و
  // نیوتن، تنصیف صرف را به یک جواب دیگرِ همان بازه بی‌اعتبار می‌رساند) —
  // پس معیار درست بودن نزدیکی به sig یا به جواب تنصیف صرف نیست. معیار
  // خودِ قرارداد تابع است: جواب داخل کران بماند و قیمتش را واقعاً برگرداند.
  {
    const S = 20000, K = 500, T = 0.01, sig = 0.4; // کال عمیق در پول
    const mkt = bsPrice('call', S, K, T, r, q, sig);
    const iv = impliedVol('call', mkt, S, K, T, r, q, { lo: 0.01, hi: 5 });
    check('وگای نزدیک صفر، جواب داخل کران می‌ماند', iv >= 0.01 && iv <= 5);
    check('وگای نزدیک صفر، قیمت بازسازی‌شده با بازار می‌خواند',
      near(bsPrice('call', S, K, T, r, q, iv), mkt, 1e-3),
      `${bsPrice('call', S, K, T, r, q, iv).toFixed(3)} ~ ${mkt.toFixed(3)}`);
  }

  check('زیر کف نظری هنوز نامعلوم می‌دهد',
    !Number.isFinite(impliedVol('call', 1, 20000, 10000, 0.5, 0.3, 0, {})));
  check('بالای سقف نظری هنوز نامعلوم می‌دهد',
    !Number.isFinite(impliedVol('put', 25000, 20000, 10000, 0.5, 0.3, 0, { hi: 5 })));
}

// ═════════════════ ۲۶. فیلترهای نقدشوندگی غربال (قلم الف-۲ بک‌لاگ) ═════════════════
group('۲۶. فیلترهای نقدشوندگی غربال');
{
  // یک رکورد دیده‌بان مصنوعی با کنترل کامل روی موقعیت باز، حجم و ارزش معاملات
  const mkRow2 = (strike, ua, oi, vol, value) => ({
    uaInsCode: ua, lval30_UA: `پایه${ua}`, pDrCotVal_UA: 100000, pClosing_UA: 100000, priceYesterday_UA: 99000,
    insCode_C: `c${strike}_${ua}`, lVal18AFC_C: `ض${strike}`, insCode_P: `p${strike}_${ua}`, lVal18AFC_P: `ط${strike}`,
    strikePrice: strike, contractSize: 1000, remainedDay: 30, endDate: 20260101,
    pMeDem_C: 3000, qTitMeDem_C: 50, pMeOf_C: 3150, qTitMeOf_C: 50,
    pDrCotVal_C: 3000, pClosing_C: 3000, oP_C: oi, qTotTran5J_C: vol, qTotCap_C: value,
    pMeDem_P: 3000, qTitMeDem_P: 50, pMeOf_P: 3150, qTitMeOf_P: 50,
    pDrCotVal_P: 3000, pClosing_P: 3000, oP_P: oi, qTotTran5J_P: vol, qTotCap_P: value,
  });

  // دو قیمت اعمال، یک نماد پایه؛ نقدشوندگی سرشناخته برای هر پا
  const rows2 = [
    mkRow2(95000, 'L', 500, 1000, 300000000),
    mkRow2(105000, 'L', 500, 1000, 300000000),
  ];
  const chainL = buildChain(rows2);
  const s0 = { ...defaults(), comboWindowPct: 25, wingsEqualWidth: true, greeksInScan: false };

  const base = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: s0 });
  check('پایه، بدون فیلتر نقدشوندگی، ردیف می‌دهد', base.rows.length > 0, `${base.rows.length} ردیف`);

  // موقعیت باز ۵۰۰ است؛ سقف بالاتر باید فروش کال بدون پوشش را بیندازد —
  // این همان فیلتری بود که با «missing = missing || false» هرگز اجرا نمی‌شد
  const byOi = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minOpenInt: 600 } });
  check('حداقل موقعیت باز واقعاً اعمال می‌شود (باگ قبلی: هیچ‌وقت اعمال نمی‌شد)',
    byOi.rows.length === 0, `${base.rows.length} → ${byOi.rows.length}`);
  const byOiOk = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minOpenInt: 400 } });
  check('حداقل موقعیت باز زیر واقعی، ردیف را نمی‌اندازد', byOiOk.rows.length === base.rows.length);

  // حجم مظنه فروش ۵۰ است؛ سقف بالاتر همان مسیر باگ‌دار را می‌سنجد
  const byBidQty = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minBidQty: 100 } });
  check('حداقل حجم مظنه هم روی همان مسیر واقعاً اعمال می‌شود', byBidQty.rows.length === 0);

  // حجم معاملات امروز هر پا ۱۰۰۰ است؛ فیلتر تازه
  const byVol = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minLegVol: 1500 } });
  check('حداقل حجم معاملات هر پا (فیلتر تازه) رعایت می‌شود', byVol.rows.length === 0);
  const byVolOk = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minLegVol: 500 } });
  check('حداقل حجم معاملات زیر واقعی، ردیف را نمی‌اندازد', byVolOk.rows.length === base.rows.length);

  // ارزش معاملات امروز هر پا ۳۰۰ میلیون ریال است؛ فیلتر تازه
  const byValue = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minLegValue: 400000000 } });
  check('حداقل ارزش معاملات هر پا (فیلتر تازه) رعایت می‌شود', byValue.rows.length === 0);
  const byValueOk = scanFn({ def: byId('naked-call'), chain: chainL, uaKeys: ['L'], settings: { ...s0, minLegValue: 100000000 } });
  check('حداقل ارزش معاملات زیر واقعی، ردیف را نمی‌اندازد', byValueOk.rows.length === base.rows.length);

  // نقدشوندگی زنجیره: مجموع ارزش کل زنجیره همین پایه = ۲ پا × ۲ سمت × ۳۰۰م = ۱٬۲۰۰٬۰۰۰٬۰۰۰
  const combos = generateCombos(byId('naked-call'), chainL.get('L'), { ...s0, minUaLiquidity: 1500000000 });
  check('نقدشوندگی زنجیره پایین‌تر از آستانه، کل پایه را حذف می‌کند (نه فقط یک پا)',
    combos.length === 0, `${combos.length} ترکیب`);
  const combosOk = generateCombos(byId('naked-call'), chainL.get('L'), { ...s0, minUaLiquidity: 1000000000 });
  check('نقدشوندگی زنجیره بالاتر از آستانه، دست‌نخورده می‌ماند', combosOk.length > 0, `${combosOk.length} ترکیب`);
}

// ═══════ ۲۷. فهرست بازار — تلاطم ضمنی، نسبت پوت به کال، نزدیک‌ترین سررسید (قلم الف-۴ بک‌لاگ) ═══════
group('۲۷. فهرست بازار — تلاطم ضمنی، نسبت پوت به کال، نزدیک‌ترین سررسید');
{
  const spot = 100000, sigma = 0.5, rFree = 0.30;
  const atmPrice = bsPrice('call', spot, spot, 20 / 365, rFree, 0, sigma);

  const mkRow3 = (strike, days, closePx, oi = 100) => ({
    uaInsCode: 'M', lval30_UA: 'ماکت', pDrCotVal_UA: spot, pClosing_UA: spot, priceYesterday_UA: spot,
    insCode_C: `c${strike}_${days}`, lVal18AFC_C: `ض${strike}`, insCode_P: `p${strike}_${days}`, lVal18AFC_P: `ط${strike}`,
    strikePrice: strike, contractSize: 1000, remainedDay: days, endDate: 20260101,
    pMeDem_C: closePx * 0.98, qTitMeDem_C: 10, pMeOf_C: closePx * 1.02, qTitMeOf_C: 10,
    pDrCotVal_C: closePx, pClosing_C: closePx, oP_C: oi, qTotTran5J_C: 50,
    pMeDem_P: closePx * 0.98, qTitMeDem_P: 10, pMeOf_P: closePx * 1.02, qTitMeOf_P: 10,
    pDrCotVal_P: closePx, pClosing_P: closePx, oP_P: oi * 4, qTotTran5J_P: 50,
  });

  const rows3 = [
    mkRow3(100000, 20, atmPrice),      // نزدیک‌ترین پول، نزدیک‌ترین سررسید
    mkRow3(95000, 20, atmPrice * 1.3),
    mkRow3(100000, 60, atmPrice * 1.5), // سررسید دورتر
  ];
  const chain3 = buildChain(rows3);
  const list3 = underlyingList(chain3, { rFree, divYield: 0 });
  check('یک نماد در فهرست', list3.length === 1, `${list3.length}`);
  const u = list3[0];
  check('نزدیک‌ترین سررسید همان سررسید نزدیک‌تر است', u.nearestDays === 20, `${u.nearestDays}`);
  check('نسبت پوت به کال از موقعیت باز کل زنجیره حساب می‌شود',
    near(u.pcRatio, 4, 1e-9), `${u.pcRatio}`);
  check('تلاطم ضمنی نزدیک‌ترین پول، سیگمای واقعی مولد قیمت را بازمی‌گرداند',
    Number.isFinite(u.atmIv) && near(u.atmIv, sigma, 1e-3), `${u.atmIv}`);

  // پیش‌فرض بدون rFree/divYield هم باید کار کند — همان مسیری که ریسه اسکن می‌رود
  const listDef = underlyingList(chain3);
  check('بدون rFree/divYield هم تلاطم ضمنی عدد متناهی می‌دهد', Number.isFinite(listDef[0].atmIv));
}

// ═══════ ۲۸. غربال روی کل کاتالوگ — برترین موقعیت‌ها (قلم الف-۳ بک‌لاگ) ═══════
group('۲۸. غربال روی کل کاتالوگ — برترین موقعیت‌ها');
{
  const mkRow4 = (strike, days, cBid, pBid) => ({
    uaInsCode: '1', lval30_UA: 'نمونه', pDrCotVal_UA: 100000, pClosing_UA: 100000, priceYesterday_UA: 99000,
    insCode_C: `c${strike}_${days}`, lVal18AFC_C: `ض${strike}`, insCode_P: `p${strike}_${days}`, lVal18AFC_P: `ط${strike}`,
    strikePrice: strike, contractSize: 1000, remainedDay: days, endDate: 20260101,
    pMeDem_C: cBid, qTitMeDem_C: 100, pMeOf_C: cBid * 1.05, qTitMeOf_C: 100,
    pDrCotVal_C: cBid, pClosing_C: cBid, oP_C: 500, qTotTran5J_C: 1000,
    pMeDem_P: pBid, qTitMeDem_P: 100, pMeOf_P: pBid * 1.05, qTitMeOf_P: 100,
    pDrCotVal_P: pBid, pClosing_P: pBid, oP_P: 400, qTotTran5J_P: 800,
  });
  const rows4 = [];
  for (const k of [90000, 95000, 100000, 105000, 110000]) {
    rows4.push(mkRow4(k, 30, Math.max(200, 100000 - k + 4000), Math.max(200, k - 100000 + 4000)));
    rows4.push(mkRow4(k, 90, Math.max(300, 100000 - k + 7000), Math.max(300, k - 100000 + 7000)));
  }
  const chain4 = buildChain(rows4);
  const s4 = { ...defaults(), comboWindowPct: 25, wingsEqualWidth: true, greeksInScan: false };
  const feasible = CATALOG.filter((d) => d.feasible);

  const single = scanFn({ def: byId('naked-call'), chain: chain4, uaKeys: ['1'], settings: s4 });
  const all = scanAll({ defs: feasible, chain: chain4, uaKeys: ['1'], settings: s4, limit: 500 });

  check('نتیجه کل، ردیف‌های تک‌استراتژی را هم شامل می‌شود',
    single.rows.every((r) => all.rows.some((x) => x.id === r.id)), `تک ${single.rows.length} از کل ${all.rows.length}`);
  check('نتیجه بیش از یک استراتژی دارد',
    new Set(all.rows.map((r) => r.strategyId)).size > 1, `${new Set(all.rows.map((r) => r.strategyId)).size} استراتژی`);
  check('هر ردیف نام و شناسه استراتژی خودش را حمل می‌کند', all.rows.every((r) => r.strategy && r.strategyId));

  const capped = scanAll({ defs: feasible, chain: chain4, uaKeys: ['1'], settings: s4, limit: 5 });
  check('سقف limit واقعاً رعایت می‌شود', capped.rows.length === 5, `${capped.rows.length}`);
  check('کل تعداد پیش از برش هم گزارش می‌شود، و کمتر از خودِ برش نیست',
    capped.total >= capped.rows.length, `کل ${capped.total} ، برش ${capped.rows.length}`);

  const by = s4.rankBy;
  const vals = capped.rows.map((r) => r[by]).filter(Number.isFinite);
  check('رتبه‌بندی نزولی روی کل ادغام‌شده از چند استراتژی حفظ می‌شود',
    vals.length > 1 && vals.every((v, i) => i === 0 || vals[i - 1] >= v), vals.join(' , '));

  check('نوار تشخیص هم روی کل جمع می‌زند', all.funnel.built >= single.funnel.built,
    `کل ${all.funnel.built} ، تک ${single.funnel.built}`);
}

// ═══════════════ ۲۹. ماشین زمان — شبیه‌سازی بلک-شولز روی تاریخچه ═══════════════
group('۲۹. ماشین زمان');
{
  const K = 100000;
  const size = 1000;
  const legLongCall = [{ kind: 'call', side: 'buy', ratio: 1, strike: K, size }];
  const flatCloses = Array.from({ length: 10 }, (_, i) => ({ date: 20260100 + i, close: K }));

  const r0 = timeMachine(legLongCall, flatCloses, { daysToday: 30, sigma: 0.5 });
  check('روز ورود (اولین ردیف)، سود و زیان دقیقاً صفر', r0[0].pnl === 0, r0[0].pnl);
  check('طول خروجی برابر طول ورودی', r0.length === flatCloses.length, r0.length);

  // بدون تغییر قیمت پایه، فقط گذر زمان: کال خرید با تلاطم مثبت باید کمی
  // ارزش زمانی از دست بدهد (تتای منفی) چون داریم به سررسید نزدیک می‌شویم
  check('در پول بدون حرکت پایه، گذر زمان روی کال خرید یعنی زیان (تتای منفی)',
    r0[r0.length - 1].pnl < 0, r0[r0.length - 1].pnl);

  // T باید یکنوا کاهشی باشد، چون هر ردیف بعدی به امروز نزدیک‌تر است
  check('روز باقیمانده تا سررسید یکنوا کاهشی است',
    r0.every((r, i) => i === 0 || r.daysLeft <= r0[i - 1].daysLeft), r0.map((r) => r.daysLeft).join(' , '));

  // صعود شدید پایه در آخرین روز باید سود قابل توجه بدهد، و دقیقاً برابر
  // تفاضل bsPrice همان روز با bsPrice روز ورود (هویت جبری، نه فقط علامت)
  const bumped = [...flatCloses];
  bumped[bumped.length - 1] = { ...bumped[bumped.length - 1], close: K * 1.3 };
  const r1 = timeMachine(legLongCall, bumped, { daysToday: 30, sigma: 0.5 });
  const last = r1[r1.length - 1];
  const entryPx = bsPrice('call', K, K, (30 + bumped.length - 1) / 365, 0, 0, 0.5);
  const lastPx = bsPrice('call', K * 1.3, K, Math.max(30, 0.5) / 365, 0, 0, 0.5);
  check('صعود ۳۰٪ پایه، سود قابل‌توجه می‌دهد', last.pnl > 0, last.pnl);
  check('سود دقیقاً برابر تفاضل قیمت بلک-شولز دو روز است (هویت جبری)',
    near(last.pnl, (lastPx - entryPx) * size, 1e-6), `${last.pnl} ~ ${(lastPx - entryPx) * size}`);

  // فروش، علامت برعکس همان خرید — از یک تابع واحد می‌آید، نه شاخه جدا
  const legShort = [{ kind: 'call', side: 'sell', ratio: 1, strike: K, size }];
  const r2 = timeMachine(legShort, bumped, { daysToday: 30, sigma: 0.5 });
  check('فروش همان کال، دقیقاً علامت برعکس خرید',
    near(r2[r2.length - 1].pnl, -last.pnl, 1e-6), r2[r2.length - 1].pnl);

  // ورودی نامعتبر سقوط نمی‌کند
  check('بدون تاریخچه، فهرست خالی برمی‌گرداند', timeMachine(legLongCall, [], { daysToday: 30, sigma: 0.5 }).length === 0);
  check('تلاطم نامعتبر، فهرست خالی برمی‌گرداند',
    timeMachine(legLongCall, flatCloses, { daysToday: 30, sigma: 0 }).length === 0);
}

// ═══ ۳۰. افق ارزش‌گذاری قابل‌بازنویسی — منحنی «امروز» کنار «سررسید» ═══
group('۳۰. افق ارزش‌گذاری قابل‌بازنویسی');
{
  // پیش‌فرض دست‌نخورده: بدون horizonDays، همان رفتار قبلی (افق = نزدیک‌ترین
  // سررسید) — این تضمین می‌کند اضافه‌کردن پارامتر تازه هیچ استفاده قبلی را
  // نمی‌شکند.
  const legs20 = [
    { kind: 'put', side: 'buy', ratio: 1, strike: 1200, days: 30, size: 1000 },
    { kind: 'call', side: 'sell', ratio: 1, strike: 1400, days: 60, size: 1000 },
  ];
  const withoutOverride = analyzeMixed(legs20, -50000, { spot: 1000, sigma: 0.6 });
  const explicitDefault = analyzeMixed(legs20, -50000, { spot: 1000, sigma: 0.6, horizonDays: 30 });
  check('بدون horizonDays همان افق پیش‌فرض (نزدیک‌ترین سررسید) است',
    near(withoutOverride.at(1300), explicitDefault.at(1300), 1e-9),
    `${withoutOverride.at(1300)} ~ ${explicitDefault.at(1300)}`);

  // یک کال تک‌پا، horizonDays=0 یعنی «امروز»: هیچ پایی سررسید نشده، پس
  // سود و زیان دقیقاً برابر قیمت بلک-شولز است، نه ارزش ذاتی تکه‌ای-خطی —
  // هویت جبری، نه فقط علامت.
  const K = 1000, size = 1000, sigma = 0.5, days = 30, r = 0.3, q = 0;
  const premium = bsPrice('call', 1000, K, days / 365, r, q, sigma);
  const legCall = [{ kind: 'call', side: 'buy', ratio: 1, strike: K, days, size }];
  const today = analyzeMixed(legCall, -premium * size, { spot: 1000, sigma, rFree: r, divYield: q, horizonDays: 0 });
  const S2 = 1050;
  const expectedToday = (bsPrice('call', S2, K, days / 365, r, q, sigma) - premium) * size;
  check('منحنی امروز دقیقاً از قیمت بلک-شولز می‌آید (هویت جبری)',
    near(today.at(S2), expectedToday, 1e-6), `${today.at(S2)} ~ ${expectedToday}`);

  // درست همان ترکیب، امروز و سررسید باید در نقطه اعمال فرق کنند — چون
  // امروز هنوز ارزش زمانی دارد، سررسید فقط ارزش ذاتی. اگر یکی بودند یعنی
  // پارامتر افق اصلاً اثر نکرده.
  const expiry = analyzeMixed(legCall, -premium * size, { spot: 1000, sigma, rFree: r, divYield: q, horizonDays: days });
  check('امروز با سررسید در نقطه اعمال متفاوت است — ارزش زمانی هنوز هست',
    Math.abs(today.at(K) - expiry.at(K)) > size * 1,
    `امروز ${Math.round(today.at(K))} ، سررسید ${Math.round(expiry.at(K))}`);
}

// ═══ ۳۱. مقایسه با موقعیت‌های دیگر هم‌نماد (قلم الف-۱ بک‌لاگ) ═══
group('۳۱. مقایسه با موقعیت‌های دیگر هم‌نماد روی نمودار بازده');
{
  // ——— انتخاب نامزد: فقط هم‌نماد، به‌جز ردیف خودش، سقف ده‌تا ———
  const rows31 = [
    { id: 'a', underlying: 'خودرو', legsText: 'خرید کال ۱۰۰۰', strategy: 'اسپرد' },
    { id: 'b', underlying: 'خودرو', legsText: 'فروش پوت ۹۰۰', strategy: 'کاورد' },
    { id: 'c', underlying: 'فولاد', legsText: 'خرید کال ۲۰۰۰', strategy: 'اسپرد' },
  ];
  const cands31 = sameUnderlyingCandidates(rows31, rows31[0]);
  check('فقط هم‌نمادها می‌آیند، به‌جز خود ردیف',
    cands31.length === 1 && cands31[0].id === 'b', cands31.map((c) => c.id).join(','));
  check('بدون ردیف انتخاب‌شده، فهرست خالی است', sameUnderlyingCandidates(rows31, null).length === 0);

  const many31 = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, underlying: 'خودرو', legsText: `ترکیب ${i}` }));
  check('فهرست نامزدها سقف ده‌تا دارد', sameUnderlyingCandidates([rows31[0], ...many31], rows31[0]).length === 10);

  // ——— برچسب کوتاه ———
  check('برچسب کوتاه دست‌نخورده می‌ماند', compareLabel({ legsText: 'کوتاه' }) === 'کوتاه');
  const longLabel = compareLabel({ strategy: 'استراتژی خیلی طولانی', legsText: 'خرید کال ۱۰۰۰۰ و فروش کال ۲۰۰۰۰ و بازهم بیشتر' });
  check('برچسب بلند با سه‌نقطه بریده می‌شود', longLabel.length === 22 && longLabel.endsWith('…'), longLabel);
  check('سقف مقایسه هم‌زمان ۴ است', MAX_COMPARE === 4);

  // ——— برچسب کامل، برای tooltip روی legend نمودار (دور ۱۸ پ-۶) ———
  const rowLong31 = { strategy: 'استراتژی خیلی طولانی', legsText: 'خرید کال ۱۰۰۰۰ و فروش کال ۲۰۰۰۰ و بازهم بیشتر' };
  check('برچسب کامل هرگز بریده نمی‌شود',
    compareFullLabel(rowLong31) === 'استراتژی خیلی طولانی — خرید کال ۱۰۰۰۰ و فروش کال ۲۰۰۰۰ و بازهم بیشتر');
  check('برچسب کامل با شروع برچسب کوتاه یکی است',
    compareFullLabel(rowLong31).startsWith(compareLabel(rowLong31).slice(0, -1)));
  const rowShort31 = { legsText: 'کوتاه' };
  check('برچسب کوتاه و کامل برای متن کوتاه یکسانند', compareFullLabel(rowShort31) === compareLabel(rowShort31));

  // منحنی و legend مقایسه‌ای خودشان در chart.mjs رسم می‌شوند (وارد کردن مطلق
  // `/core/...` دارد، پس در Node قابل import نیست) — رسم واقعی با Playwright
  // در پنل جزئیات تب استراتژی/برترین موقعیت‌ها تأیید می‌شود، نه اینجا.
}

// ═══ ۳۲. بازپخش تاریخی — ورود مستقل، آفست روزانه، داده گمشده ═══
group('۳۲. بازپخش تاریخی استراتژی');
{
  const base32 = [
    { date: 20260801, close: 100, last: 101, low: 98, high: 103 },
    { date: 20260802, close: 110, last: 111, low: 105, high: 113 },
    { date: 20260803, close: 105, last: 106, low: 102, high: 109 },
  ];
  const call32 = [
    { date: 20260801, close: 10, last: 11, low: 9, high: 12 },
    { date: 20260802, close: 7, last: 6, low: 5, high: 8 },
  ];
  const put32 = [
    { date: 20260801, close: 8, last: 9, low: 7, high: 10 },
    { date: 20260802, close: 5, last: 4, low: 3, high: 6 },
    { date: 20260803, close: 4, last: 3, low: 2, high: 5 },
  ];
  const legs32 = [
    { ins: '11', name: 'پوت', kind: 'put', side: 'sell', ratio: 1, size: 1000, strike: 90, expiry: 20260820 },
    { ins: '12', name: 'کال', kind: 'call', side: 'sell', ratio: 1, size: 1000, strike: 110, expiry: 20260820 },
  ];
  const args32 = {
    legs: legs32, baseIns: '1', startDate: 20260801, endDate: 20260803,
    entryBasis: 'CLOSE', exitBasis: 'LAST', units: 1,
    seriesByIns: { 1: base32, 11: put32, 12: call32 },
    fees: { buyStock: 0, sellStock: 0, option: 0, exercise: 0 },
    settings: defaults(),
  };
  const replay32 = replayHistory(args32);
  check('بازپخش تاریخی با قیمت ورود پایانی ساخته می‌شود', replay32.ok && replay32.priced[0].price === 8 && replay32.priced[1].price === 10);
  check('پرداختی، دریافتی و خالص ورود جدا گزارش می‌شوند', replay32.entry.cashPaid === 0 && replay32.entry.cashReceived === 18000 && replay32.entry.netCash === 18000);
  check('آفست روز دوم با آخرین، سود ناخالص درست می‌دهد', replay32.rows[1].grossPnl === 8000, replay32.rows[1].grossPnl);
  check('تغییر روزانه پایه محاسبه می‌شود', near(replay32.rows[1].baseDailyPct, 10, 1e-9), replay32.rows[1].baseDailyPct);
  check('تغییر تجمعی پایه از روز ورود محاسبه می‌شود', near(replay32.rows[2].baseCumulativePct, 5, 1e-9), replay32.rows[2].baseCumulativePct);
  check('نبود قیمت یک پا، ردیف را فاقد داده می‌کند', replay32.rows[2].status === 'missing' && replay32.rows[2].missingLegs[0] === 1);

  const manual32 = replayHistory({ ...args32, manualEntry: { 0: 5, 1: 20 } });
  check('قیمت دستی هر پا مستقل و بیرون دامنه پذیرفته می‌شود', manual32.priced[0].price === 5 && manual32.priced[1].price === 20);
  check('قیمت دستی در سود آفست اثر می‌گذارد', manual32.rows[1].netPnl === 15000, manual32.rows[1].netPnl);

  check('قیمت تاریخی صفر، داده معتبر ساخته نمی‌شود', Number.isNaN(historyPrice({ close: 0 }, 'CLOSE')));
  check('قیمت دستی صفر پذیرفته می‌شود', historyPrice(null, 'MANUAL', 0) === 0);
  check('تاریخ شمسی سررسید به میلادی نرمال می‌شود', normalizeHistoryDate(14050529) === 20260820, normalizeHistoryDate(14050529));
  check('برچسب تاریخ، شمسی است', historyDateLabel(20260801) === '1405/05/10', historyDateLabel(20260801));
  check('نام روز همراه تاریخ موجود است', historyDayName(20260801) === 'شنبه', historyDayName(20260801));

  const summary32 = summarizeReplay(replay32.rows, replay32.entry);
  check('خلاصه روز معتبر و فاقد داده را جدا می‌شمارد', summary32.validDays === 2 && summary32.missingDays === 1);
  check('تعداد و درصد آفست مثبت و منفی جداست', summary32.positiveDays === 1 && summary32.negativeDays === 1 && near(summary32.positivePct, 50));
  check('میانگین، میانه و پراکندگی بازده ساخته می‌شود', Number.isFinite(summary32.meanReturn) && Number.isFinite(summary32.medianReturn) && Number.isFinite(summary32.returnStdDev));
  check('خلاصه، سرمایه و جریان نقدی ورود را نگه می‌دارد', Number.isFinite(summary32.capital) && summary32.cashPaid === 0 && summary32.cashReceived === 18000 && summary32.netCash === 18000);
  check('بازده پایه در نتیجه جدول اصلی موجود است', near(summary32.last.baseCumulativePct, 10, 1e-9));
  check('اثر روزانه هر پا محاسبه می‌شود', Number.isFinite(replay32.rows[1].perLeg[0].pnlDelta));
  check('وجه تضمین کل و هر پای فروش در روز موجود است', Number.isFinite(replay32.rows[1].marginNet) && replay32.rows[1].marginPerLeg.length === 2);
  check('ماتریس مبنای ورود و خروج هر شانزده حالت را دارد', basisMatrix(args32).length === 16);
  check('حساسیت ورود برای هر پا و پنج شوک ساخته می‌شود', entrySensitivity(args32).length === 10);

  const units32 = replayHistory({ ...args32, units: 3 });
  check('تعداد واحد استراتژی، سود را خطی مقیاس می‌کند', units32.rows[1].netPnl === replay32.rows[1].netPnl * 3);

  const expiryBase32 = [
    ...base32,
    { date: 20260820, close: 108, last: 108, low: 107, high: 109 },
    { date: 20260821, close: 109, last: 109, low: 108, high: 110 },
  ];
  const expiryCall32 = [...call32, { date: 20260820, close: 1, last: 1, low: 1, high: 1 }, { date: 20260821, close: 2, last: 2, low: 2, high: 2 }];
  const expiryPut32 = [...put32, { date: 20260820, close: 1, last: 1, low: 1, high: 1 }, { date: 20260821, close: 2, last: 2, low: 2, high: 2 }];
  const stopped32 = replayHistory({ ...args32, endDate: 20260821, seriesByIns: { 1: expiryBase32, 11: expiryPut32, 12: expiryCall32 } });
  check('بازپخش در اولین سررسید متوقف می‌شود', stopped32.endDate === 20260820 && stopped32.rows.at(-1).date === 20260820);

  const ua32 = {
    ins: '1', name: 'پایه', close: 100, last: 101,
    expiryList: [{
      days: 19, endDate: 20260820,
      strikeList: [
        { strike: 90, size: 1000, call: { ins: '21', name: 'کال ۹۰' }, put: { ins: '11', name: 'پوت ۹۰' } },
        { strike: 110, size: 1000, call: { ins: '12', name: 'کال ۱۱۰' }, put: { ins: '22', name: 'پوت ۱۱۰' } },
      ],
    }],
  };
  const autoSeries32 = {
    1: base32,
    11: put32,
    12: call32,
    21: call32.map((r) => ({ ...r, close: r.close + 1 })),
    22: put32.map((r) => ({ ...r, close: r.close + 1 })),
  };
  const generated32 = generateHistoricalCombos({
    def: byId('short-strangle'), ua: ua32, seriesByIns: autoSeries32,
    startDate: 20260801, entryBasis: 'CLOSE', settings: defaults(), filtered: false,
  });
  check('حالت خودکار، تمام ترکیب ساختاری استراتژی انتخابی را می‌سازد', generated32.combos.length === 1, generated32.combos.length);
  check('ترکیب خودکار، پوت پایین و کال بالا را درست می‌چیند', generated32.combos[0].legs[0].ins === '11' && generated32.combos[0].legs[1].ins === '12');

  const officialMarket32 = historyMarketMetrics({ close: 100, vol: 20, trades: 4, value: 5000 });
  const estimatedMarket32 = historyMarketMetrics({ close: 100, vol: 20, trades: 4 });
  check('ارزش رسمی روزانه بر برآورد اولویت دارد', officialMarket32.value === 5000 && !officialMarket32.valueEstimated);
  check('نبود ارزش رسمی با حجم × پایانی برآورد و علامت می‌خورد', estimatedMarket32.value === 2000 && estimatedMarket32.valueEstimated);

  const liquidSeries32 = {
    1: base32.map((r, i) => ({ ...r, vol: i === 1 ? 10 : 1000, trades: 5, value: i === 1 ? 1000 : 100000 })),
    11: put32.map((r, i) => ({ ...r, vol: i === 1 ? 2 : 100, trades: 3, value: i === 1 ? 20 : 10000 })),
    12: call32.map((r) => ({ ...r, vol: 100, trades: 3, value: 10000 })),
  };
  const liquidReplay32 = replayHistory({ ...args32, seriesByIns: liquidSeries32,
    liquidity: { minBaseVolume: 100, minBaseValue: 10000, minLegVolume: 10, minLegValue: 1000 } });
  check('فیلتر نقدشوندگی روز ضعیف را از آمار معتبر حذف می‌کند', liquidReplay32.ok && liquidReplay32.rows[1].status === 'liquidity' && liquidReplay32.summary.liquidityDays === 1);
  const blockedEntry32 = replayHistory({ ...args32, seriesByIns: liquidSeries32,
    liquidity: { minBaseVolume: 2000 } });
  check('حداقل حجم پایه در خود روز ورود اعمال می‌شود', !blockedEntry32.ok && blockedEntry32.liquidityError);

  const optimized32 = optimizeExitPolicy(args32, { targets: [1, 5], holdingDays: [1, 2] });
  check('بهینه‌ساز، بهترین خروج مشاهده‌شده و قاعده خروج می‌سازد', optimized32.bestObserved?.date === 20260802 && optimized32.bestPolicy?.samples >= 1);
}

// ═══════════════════════════ گزارش ═══════════════════════════
const W = 62;
console.log('\n' + '═'.repeat(W));
console.log('  آزمون موتور — فاز ۲');
console.log('═'.repeat(W));
for (const [mark, name, detail] of results) {
  if (mark === '—') { console.log('\n' + name); continue; }
  const pad = name.length > 46 ? name.slice(0, 46) : name.padEnd(46, ' ');
  console.log(` ${mark} ${pad} ${detail}`);
}
console.log('\n' + '─'.repeat(W));
console.log(`  قبول ${pass}   رد ${fail}`);
console.log('─'.repeat(W) + '\n');
process.exit(fail ? 1 : 0);
