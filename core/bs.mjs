// موتور بلک-شولز-مرتون.
//
// قراردادهای اختیار سهام در بازار سرمایه ایران اروپایی هستند و اعمال فقط
// در سررسید ممکن است، پس این مدل مدل درست است نه تقریب یک مدل آمریکایی.
//
// قرارداد واحدها در خروجی — هر جا تغییرش بدهی، ستون‌های جدول هم باید عوض شود:
//   delta  تغییر قیمت اختیار به ازای یک ریال تغییر پایه
//   gamma  تغییر دلتا به ازای یک ریال تغییر پایه
//   vega   تغییر قیمت اختیار به ازای یک درصد تغییر تلاطم
//   theta  تغییر قیمت اختیار به ازای یک روز تقویمی
//   rho    تغییر قیمت اختیار به ازای یک درصد تغییر نرخ بهره
//
// زمان بر حسب سال تقویمی است و تلاطم سالانه با ریشه روزهای معاملاتی
// سالانه می‌شود. این دو با هم سازگارند و نباید یکی را عوض کرد.

import { num, ok, clamp } from './num.mjs';

const SQRT2PI = Math.sqrt(2 * Math.PI);
const SQRT2 = Math.sqrt(2);

export function npdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/** تابع خطا، تقریب آبراموویتز و استیگان. خطای نسبی زیر 1.5e-7 است. */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const y =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return s * (1 - y);
}

export function ncdf(x) {
  return 0.5 * (1 + erf(x / SQRT2));
}

/** ارزش ذاتی هر سهم. */
export function intrinsic(kind, S, K) {
  return kind === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
}

export function d1d2(S, K, T, r, q, sigma) {
  const sd = sigma * Math.sqrt(T);
  const a = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sd;
  return [a, a - sd];
}

/** قیمت نظری اختیار اروپایی با بازده نقدی پیوسته. */
export function bsPrice(kind, S, K, T, r, q, sigma) {
  if (!(S > 0) || !(K > 0)) return NaN;
  if (!(T > 0) || !(sigma > 0)) return intrinsic(kind, S, K);
  const [a, b] = d1d2(S, K, T, r, q, sigma);
  const dq = Math.exp(-q * T);
  const dr = Math.exp(-r * T);
  return kind === 'call'
    ? S * dq * ncdf(a) - K * dr * ncdf(b)
    : K * dr * ncdf(-b) - S * dq * ncdf(-a);
}

const NAN_GREEKS = {
  price: NaN, delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN,
  d1: NaN, d2: NaN, probItm: NaN,
};

/** یونانی‌های هر سهم، از دید خریدار. برای فروشنده علامت‌ها برعکس می‌شود. */
export function bsGreeks(kind, S, K, T, r, q, sigma) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return { ...NAN_GREEKS };
  const sqT = Math.sqrt(T);
  const sd = sigma * sqT;
  const [a, b] = d1d2(S, K, T, r, q, sigma);
  const dq = Math.exp(-q * T);
  const dr = Math.exp(-r * T);
  const pdf = npdf(a);

  const gamma = (dq * pdf) / (S * sd);
  const vega = (S * dq * pdf * sqT) / 100;

  let delta, thetaYear, rho, probItm;
  if (kind === 'call') {
    delta = dq * ncdf(a);
    thetaYear =
      (-S * dq * pdf * sigma) / (2 * sqT) + q * S * dq * ncdf(a) - r * K * dr * ncdf(b);
    rho = (K * T * dr * ncdf(b)) / 100;
    probItm = ncdf(b);
  } else {
    delta = -dq * ncdf(-a);
    thetaYear =
      (-S * dq * pdf * sigma) / (2 * sqT) - q * S * dq * ncdf(-a) + r * K * dr * ncdf(-b);
    rho = (-K * T * dr * ncdf(-b)) / 100;
    probItm = ncdf(-b);
  }

  return {
    price: bsPrice(kind, S, K, T, r, q, sigma),
    delta, gamma, vega,
    theta: thetaYear / 365,
    rho, d1: a, d2: b, probItm,
  };
}

/**
 * تلاطم ضمنی با نیوتن روی وگا، و تنصیف به‌عنوان تور ایمنی.
 * اگر قیمت بازار زیر کف نظری یا بالای سقف نظری باشد عدد بی‌معنی نمی‌سازد و
 * مقدار نامعتبر برمی‌گرداند. ستون جدول در این حالت خط تیره نشان می‌دهد.
 *
 * هر گام نیوتن داخل کران [lo,hi] تنصیف نگه داشته می‌شود (رویه rtsafe): اگر
 * گام از کران بیرون بزند یا وگا نزدیک صفر باشد، همان‌جا به تنصیف صرف سوییچ
 * می‌شود. نتیجه با تنصیف خالص یکسان است، فقط با فراخوانی بسیار کمتر از
 * bsPrice چون نیوتن معمولاً در چند گام همگرا می‌شود.
 */
export function impliedVol(kind, mktPrice, S, K, T, r, q, opt = {}) {
  let lo = num(opt.lo, 0.01);
  let hi = num(opt.hi, 5.0);
  const tol = num(opt.tol, 1e-6);
  const iters = num(opt.iters, 120);
  const newtonIters = num(opt.newtonIters, 15);
  if (!(mktPrice > 0 && S > 0 && K > 0 && T > 0)) return NaN;

  const f = (s) => bsPrice(kind, S, K, T, r, q, s) - mktPrice;
  const fLo = f(lo);
  const fHi = f(hi);
  if (!ok(fLo) || !ok(fHi)) return NaN;
  if (fLo > 0) return NaN; // زیر کف نظری، ارزش ذاتی نقض شده
  if (fHi < 0) return NaN; // بالای سقف نظری

  const absTol = tol * Math.max(1, mktPrice);
  const sqT = Math.sqrt(T);
  const dq = Math.exp(-q * T);
  let s = clamp(0.2, lo, hi);
  for (let i = 0; i < newtonIters; i++) {
    const diff = f(s);
    if (Math.abs(diff) < absTol) return s;
    if (diff < 0) lo = s;
    else hi = s;
    const [a] = d1d2(S, K, T, r, q, s);
    const vega = S * dq * npdf(a) * sqT;
    const next = s - diff / vega;
    if (!(vega > 1e-10) || !(next > lo) || !(next < hi)) break; // وگا مسطح یا گام بیرون از کران
    s = next;
  }

  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (Math.abs(fm) < absTol) return mid;
    if (fm < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * احتمال اینکه قیمت پایه در سررسید از یک آستانه عبور کند، لگاریتم-نرمال با روند صفر.
 *
 * هشدار مدل که باید در رابط کاربری هم دیده شود: دامنه نوسان روزانه،
 * توقف نماد و پرش‌های بازار ایران در این مدل نیست. برای حرکت‌های بزرگ
 * در سررسیدهای کوتاه، این عدد احتمال را بیش‌برآورد می‌کند.
 */
export function probAbove(S, level, T, sigmaAnn) {
  if (!(S > 0 && level > 0 && T > 0) || !ok(sigmaAnn) || sigmaAnn <= 0) return NaN;
  const sd = sigmaAnn * Math.sqrt(T);
  const z = (Math.log(level / S) + 0.5 * sd * sd) / sd;
  return ncdf(-z);
}

export function probBelow(S, level, T, sigmaAnn) {
  const p = probAbove(S, level, T, sigmaAnn);
  return ok(p) ? 1 - p : NaN;
}

/** معکوس تابع توزیع نرمال استاندارد. تقریب اکلام؛ دقت کافی برای صدک قیمت. */
export function ninv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * صدک قیمت پایه در سررسید — معکوس probBelow، همان مدل لگاریتم-نرمال با
 * روند صفر. یعنی probBelow(S, priceQuantile(S,p,T,sigma), T, sigma) === p.
 */
export function priceQuantile(S, p, T, sigmaAnn) {
  if (!(S > 0 && T > 0) || !ok(sigmaAnn) || sigmaAnn <= 0 || !(p > 0 && p < 1)) return NaN;
  const sd = sigmaAnn * Math.sqrt(T);
  const z = ninv(p);
  return S * Math.exp(z * sd - 0.5 * sd * sd);
}

/** تلاطم سالانه از بازده لگاریتمی قیمت پایانی. پرش‌های تعدیل‌نشده حذف می‌شوند. */
export function histVol(closes, tradingDaysYear = 240) {
  const p = closes.map((x) => num(x)).filter((x) => x > 0);
  if (p.length < 22) return NaN;
  const rr = [];
  for (let i = 1; i < p.length; i++) {
    const v = Math.log(p[i] / p[i - 1]);
    if (Math.abs(v) < 0.5) rr.push(v);
  }
  if (rr.length < 21) return NaN;
  const m = rr.reduce((a, b) => a + b, 0) / rr.length;
  const v = rr.reduce((a, b) => a + (b - m) ** 2, 0) / (rr.length - 1);
  return Math.sqrt(v) * Math.sqrt(tradingDaysYear);
}

export { clamp };
