// ابزارهای عددی مشترک.
// همه ماژول‌های هسته فقط از این توابع برای پاک‌سازی ورودی استفاده می‌کنند،
// تا رفتار با مقدار خالی و متن و بی‌نهایت در کل سیستم یکسان باشد.

export const EPS = 1e-9;

/** عدد امن. هر چیزی که عدد متناهی نباشد، مقدار پیش‌فرض برمی‌گردد. */
export function num(x, d = 0) {
  const v = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(v) ? v : d;
}

/** آیا مقدار، عدد متناهی است. */
export function ok(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** گرد کردن به بالا به مضرب واحد.
 *  تحمل خطای شناور دارد تا عددی که دقیقاً روی مضرب نشسته یک پله بالا نپرد. */
export function ceilTo(x, unit) {
  if (!ok(unit) || unit <= 0) return x;
  return Math.ceil(x / unit - 1e-9) * unit;
}

export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

/** مقایسه با تحمل نسبی. برای تطبیق محاسبه با اعداد تابلو. */
export function nearly(a, b, tol = 5e-3) {
  const d = Math.abs(a - b);
  const s = Math.max(Math.abs(a), Math.abs(b), 1);
  return d / s <= tol;
}

/** جمع امن. */
export function sum(arr) {
  let s = 0;
  for (const v of arr) s += num(v);
  return s;
}
