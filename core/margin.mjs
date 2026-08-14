// موتور وجه تضمین.
//
// مبنای مقرراتی: ضوابط وجه تضمین قرارداد اختیار معامله سهام در بورس تهران و
// فرابورس. این بخش با شش مشاهده تابلوی کارگزاری تثبیت شده است:
//
//   مقدار در زیان بودن قرارداد  کال = max(0, K - S)   پوت = max(0, S - K)
//   base   = max( A*S - OTM , B*S ) * اندازه قرارداد
//   IM     = گردکردن base به بالا، به مضرب C          ← تنها جای گردکردن
//   RM     = IM + قیمت پایانی اختیار * اندازه قرارداد  ← گرد نمی‌شود
//   MM     = ضریب نگهداشت * RM
//
// چهار نکته‌ای که تابلو تثبیت کرد:
//   ۱. گردکردن فقط روی وجه تضمین اولیه است
//   ۲. C برابر ۱۰٫۰۰۰ ریال است، نه ۱۰۰٫۰۰۰
//   ۳. گردکردن استاندارد به بالا است، نه «همیشه یک واحد اضافه»
//   ۴. جزء B بر قیمت پایانی دارایی پایه بنا شده، نه قیمت اعمال
//
// ——— قاعده چندپا ———
// بستانکار خالص  → وجه تضمین گرفته می‌شود
// بدهکار خالص    → وجه تضمین گرفته نمی‌شود
//
// ملاک، بستانکاری است نه جهت استراتژی. این دو یکی نیستند: اسپرد پوت صعودی
// بستانکار است و اسپرد پوت نزولی بدهکار، هر دو صعودی و نزولی بودنشان
// برخلاف انتظار در قاعده وجه تضمین بی‌اثر است.

import { num, ok, ceilTo, nearly, EPS } from './num.mjs';
import { grossCash, signedQty } from './payoff.mjs';

export const DEFAULT_PARAMS = { A: 0.20, B: 0.10, C: 10000, maint: 0.70 };

export function otmAmount(S, K, kind) {
  return kind === 'call' ? Math.max(0, K - S) : Math.max(0, S - K);
}

/** پایه وجه تضمین و اینکه کدام جزء مقید کرده است. */
export function marginBase(S, K, size, kind, p = DEFAULT_PARAMS) {
  const legA = (p.A * S - otmAmount(S, K, kind)) * size;
  const legB = p.B * S * size;
  return { base: Math.max(legA, legB), legA, legB, binding: legA >= legB ? 'A' : 'B' };
}

export function initialMargin(S, K, size, kind, p = DEFAULT_PARAMS) {
  return ceilTo(marginBase(S, K, size, kind, p).base, p.C);
}

export function requiredMargin(S, K, size, kind, optClose, p = DEFAULT_PARAMS) {
  return initialMargin(S, K, size, kind, p) + num(optClose) * size;
}

export function minMargin(rm, p = DEFAULT_PARAMS) {
  return p.maint * rm;
}

/**
 * قیمت تقریبی پایه که در آن حساب کال مارجین می‌شود.
 * فرض: قیمت پایانی اختیار در سناریو دست‌کم برابر ارزش ذاتی همان قیمت است.
 * پس عدد خروجی کف است نه سقف، چون ارزش زمانی لحاظ نشده.
 * وجه تضمین لازم در S یکنواست، پس تنصیف جواب می‌دهد و پیمایش لازم نیست.
 */
export function marginCallPrice(S, K, size, kind, optClose, equity, p = DEFAULT_PARAMS) {
  if (!(equity > 0)) return NaN;
  const need = (s) => {
    const intr = kind === 'call' ? Math.max(0, s - K) : Math.max(0, K - s);
    return minMargin(requiredMargin(s, K, size, kind, Math.max(num(optClose), intr), p), p);
  };
  const dir = kind === 'call' ? 1 : -1;
  let lo = S;
  let hi = kind === 'call' ? S * 3 : S * 0.02;
  if (need(hi) <= equity) return NaN;              // حتی در انتها هم کال مارجین نمی‌شود
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) > equity) hi = mid; else lo = mid;
  }
  return dir === 1 ? hi : hi;
}

// ——————————————— اعتبارسنجی با تابلو ———————————————

/** اجزای محاسبه در برابر اعداد تابلو. */
export function verifyMargin({ S, K, size, kind, optClose, imRef, rmRef, params = DEFAULT_PARAMS, tol = 5e-3 }) {
  const mb = marginBase(S, K, size, kind, params);
  const im = initialMargin(S, K, size, kind, params);
  const rm = requiredMargin(S, K, size, kind, optClose, params);
  const rows = [
    ['مقدار در زیان بودن قرارداد', otmAmount(S, K, kind) * size],
    [`جزء A  (${params.A} × S − OTM)`, mb.legA],
    [`جزء B  (${params.B} × S)`, mb.legB],
    ['پایه انتخابی (بزرگ‌تر)', mb.base],
    [`گردشده به مضرب ${params.C}`, im],
    ['قیمت پایانی اختیار × اندازه', num(optClose) * size],
    ['وجه تضمین لازم', rm],
    ['حداقل وجه تضمین', minMargin(rm, params)],
  ];
  return {
    rows, im, rm, binding: mb.binding,
    imOk: imRef == null ? null : nearly(im, imRef, tol),
    rmOk: rmRef == null ? null : nearly(rm, rmRef, tol),
    identityOk: rmRef == null || imRef == null ? null : nearly(imRef + num(optClose) * size, rmRef, tol),
  };
}

/**
 * بازه قیمت پایانی پایه که وجه تضمین اولیه تابلو را بازتولید می‌کند.
 *
 * وجه تضمین اولیه در S یکنوا و ناکاهنده است — جزء A برای S زیر قیمت اعمال
 * برابر 1.2S−K و بالای آن 0.2S است، جزء B برابر 0.1S، و هر سه صعودی‌اند.
 * پس به‌جای پیمایش سه‌صد‌هزار نقطه‌ای، دو تنصیف کافی است.
 */
export function impliedUnderlying({ K, size, kind, imRef, params = DEFAULT_PARAMS, sMaxMult = 8 }) {
  const f = (s) => initialMargin(s, K, size, kind, params);
  const hiS = K * sMaxMult;
  if (f(hiS) < imRef || f(1e-6) > imRef) return { ok: false, lo: null, hi: null, binding: '' };

  // کوچک‌ترین S با f(S) >= imRef
  const firstAtLeast = (target) => {
    let lo = 0, hi = hiS;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) >= target) hi = mid; else lo = mid;
    }
    return hi;
  };
  const lo = firstAtLeast(imRef);
  const hi = firstAtLeast(imRef + params.C);       // اولین S که یک پله بالاتر می‌رود
  if (f(lo) !== imRef) return { ok: false, lo: null, hi: null, binding: '' };
  const mb = marginBase((lo + hi) / 2, K, size, kind, params);
  return { ok: true, lo, hi, binding: mb.binding };
}

// ——————————————— پوشش موقعیت چندپا ———————————————

/**
 * برای هر پای فروش، دنبال پای خریدِ محافظ می‌گردد.
 *
 * شرط اعتبار پوشش:
 *   هم‌نوع   کال با کال، پوت با پوت
 *   سررسید  سررسید پای خرید ≥ سررسید پای فروش
 *   نسبت    تعداد پای خرید ≥ تعداد پای فروش
 *
 * قیمت اعمال شرط پوشش نیست، اندازه زیان را تعیین می‌کند. هر کال خریداری‌شده،
 * زیان نامحدود یک کال فروخته‌شده را می‌بندد؛ اگر اعمالش بالاتر باشد زیان به
 * فاصله دو قیمت اعمال محدود می‌شود و اگر پایین‌تر باشد زیانی نمی‌ماند.
 *   فاصله موثر  کال = max(0, اعمال خرید − اعمال فروش)
 *               پوت = max(0, اعمال فروش − اعمال خرید)
 *
 * پای فروش کال با سهم پایه هم پوشش می‌گیرد — همان کاوردکال.
 * هر بخشی که پوشش نداشته باشد، لخت است و وجه تضمین کامل می‌گیرد،
 * حتی اگر کل ترکیب بدهکار باشد. نسبت‌اسپرد با فروش بیشتر، نمونه اصلی‌اش است.
 */
/** فاصله موثر بین پای فروش و پای محافظ. همان بیشترین زیان هر واحد پوشش. */
export function effWidth(kind, kShort, kLong) {
  return kind === 'call' ? Math.max(0, kLong - kShort) : Math.max(0, kShort - kLong);
}

export function coverage(legs) {
  const shorts = [];
  const pool = legs
    .filter((l) => l.side === 'buy' && (l.kind === 'call' || l.kind === 'put'))
    .map((l) => ({ leg: l, left: num(l.ratio, 1) }));
  let shares = legs
    .filter((l) => l.kind === 'underlying' && l.side === 'buy')
    .reduce((s, l) => s + num(l.ratio, 1) * num(l.size, 1), 0);

  for (const s of legs.filter((l) => l.side === 'sell' && (l.kind === 'call' || l.kind === 'put'))) {
    let need = num(s.ratio, 1);
    const rec = { leg: s, covered: 0, naked: 0, by: [] };

    if (s.kind === 'call' && shares > 0) {
      const canCover = Math.min(need, shares / num(s.size, 1000));
      if (canCover > 0) {
        shares -= canCover * num(s.size, 1000);
        need -= canCover;
        rec.covered += canCover;
        rec.by.push({ what: 'underlying', ratio: canCover });
      }
    }

    const ok2 = (b) =>
      b.leg.kind === s.kind &&
      num(b.leg.days, num(s.days, 0)) >= num(s.days, 0) - EPS;

    // محافظی که کمترین فاصله موثر را بسازد، بهترین پوشش است
    const cands = pool.filter((b) => b.left > 0 && ok2(b)).sort((x, y) =>
      s.kind === 'call'
        ? num(x.leg.strike) - num(y.leg.strike)
        : num(y.leg.strike) - num(x.leg.strike)
    );
    for (const b of cands) {
      if (need <= EPS) break;
      const take = Math.min(need, b.left);
      b.left -= take;
      need -= take;
      rec.covered += take;
      rec.by.push({ what: 'option', strike: num(b.leg.strike), ratio: take });
    }
    rec.naked = Math.max(0, need);
    shorts.push(rec);
  }

  const nakedRatio = shorts.reduce((a, r) => a + r.naked, 0);
  const shortRatio = shorts.reduce((a, r) => a + num(r.leg.ratio, 1), 0);
  return {
    shorts,
    nakedRatio,
    state: shortRatio === 0 ? 'none' : nakedRatio <= EPS ? 'full' : nakedRatio >= shortRatio - EPS ? 'naked' : 'partial',
  };
}

/**
 * وجه تضمین کل استراتژی.
 *
 * ctx: { S, closes: {byLegIndex}, params, creditMode, includeCredit }
 *   S         قیمت پایانی دارایی پایه
 *   closes    قیمت پایانی هر پای اختیار، مبنای جزء دوم وجه تضمین لازم
 *   creditMode  FULL | LESS_WIDTH | WIDTH  ← مقدار وجه تضمین اسپرد بستانکار
 *
 * خروجی، به‌علاوه یک ستون شرطی: اگر پوشش از بین برود، چقدر وجه تضمین ناگهان
 * مطالبه می‌شود. آن عدد هشدار نقدینگی است، نه مخرج بازده.
 */
export function strategyMargin(legs, ctx = {}) {
  const p = ctx.params || DEFAULT_PARAMS;
  const S = num(ctx.S);
  const closes = ctx.closes || {};
  const mode = ctx.creditMode || 'FULL';
  const cov = coverage(legs);
  const cash = grossCash(legs);
  const isCredit = cash > EPS;

  const perLeg = [];
  let total = 0;
  let conditional = 0;

  legs.forEach((l, i) => {
    if (l.side !== 'sell' || l.kind === 'underlying') return;
    const size = num(l.size, 1000);
    const kind = l.kind;
    const close = num(closes[i], num(l.price, 0));
    const rmOne = requiredMargin(S, num(l.strike), size, kind, close, p);
    const rec = cov.shorts.find((r) => r.leg === l) || { covered: 0, naked: num(l.ratio, 1), by: [] };

    // بخش لخت: همیشه وجه تضمین کامل، حتی در ترکیب بدهکار
    let due = rmOne * rec.naked;

    // بخش پوشش‌دار
    if (rec.covered > EPS) {
      const byOpt = rec.by.filter((b) => b.what === 'option');
      if (isCredit && byOpt.length) {
        const width = byOpt.reduce((w, b) => w + effWidth(kind, num(l.strike), b.strike) * b.ratio, 0) * size;
        if (mode === 'FULL') due += rmOne * rec.covered;
        else if (mode === 'LESS_WIDTH') due += Math.max(0, rmOne * rec.covered - width);
        else due += width;
      }
      // پوشش با سهم پایه — کاوردکال — وجه تضمین نقدی ندارد
      // ترکیب بدهکار با پوشش اختیار — وجه تضمین ندارد
    }

    // اگر پای محافظ از بین برود، همین پا کامل مطالبه می‌شود
    conditional += rmOne * num(l.ratio, 1);

    total += due;
    perLeg.push({
      index: i, strike: num(l.strike), kind, size,
      initial: initialMargin(S, num(l.strike), size, kind, p),
      required: rmOne,
      minimum: minMargin(rmOne, p),
      covered: rec.covered, naked: rec.naked, due,
    });
  });

  const credit = Math.max(0, cash);
  return {
    isCredit,
    grossCash: cash,
    coverage: cov.state,
    nakedRatio: cov.nakedRatio,
    margin: total,
    marginNet: ctx.capitalMode === 'GROSS' ? total : Math.max(0, total - credit),
    conditionalMargin: conditional,          // اگر پوشش از بین برود
    creditMode: mode,
    perLeg,
    note: !isCredit
      ? 'بدهکار خالص — وجه تضمین گرفته نمی‌شود'
      : mode === 'FULL'
        ? 'بستانکار خالص — مبنای الف، تأییدنشده با تابلو'
        : 'بستانکار خالص — مبنای انتخابی تو، تأییدنشده با تابلو',
  };
}

/**
 * مخرج بازده. تعریف قفل‌شده:
 *   بدهکار    بدهکار خالص پرداختی، شامل کارمزد ورود
 *   بستانکار  بیشینه( سرمایه بلوکه‌شده ، بیشترین زیان ممکن )
 *   دارای سهم پایه  بهای تمام‌شده سهم منهای پریمیوم دریافتی
 *
 * دلیل آن «بیشینه»: وجه تضمین و بیشترین زیان دو عدد مستقل‌اند و هیچ‌کدام
 * همیشه بزرگ‌تر نیست. اگر وجه تضمین کمتر باشد، مابه‌التفاوت را خودت باید
 * کنار بگذاری وگرنه در سررسید نقدینگی نداری.
 */
export function capitalBase({ legs, netCash, marginNet, maxLoss }) {
  const hasStock = legs.some((l) => l.kind === 'underlying');
  if (hasStock) {
    // پول واقعی که از جیب رفته: بهای سهم منهای پریمیوم
    return { value: Math.max(0, -netCash), kind: 'STOCK_NET', label: 'بهای سهم منهای پریمیوم' };
  }
  if (netCash < -EPS) {
    return { value: -netCash, kind: 'DEBIT', label: 'بدهکار خالص پرداختی' };
  }
  const ml = Number.isFinite(maxLoss) ? maxLoss : Infinity;
  const value = Math.max(num(marginNet, 0), Number.isFinite(ml) ? ml : num(marginNet, 0));
  return {
    value,
    kind: 'CREDIT',
    label: Number.isFinite(ml) && ml >= num(marginNet, 0)
      ? 'بیشترین زیان ممکن'
      : 'وجه تضمین بلوکه‌شده',
  };
}
