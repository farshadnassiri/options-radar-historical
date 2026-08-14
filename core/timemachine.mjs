// ماشین زمان — شبیه‌سازی، نه بازسازی.
//
// قیمت واقعی گذشته اختیار نداریم؛ دیده‌بان تاریخچه ذخیره نمی‌کند و فقط
// قیمت پایانی تاریخی پایه از /api/daily در دسترس است (همان چیزی که برای
// تلاطم تاریخی هم گرفته می‌شود). پس این ماژول با بلک-شولز و همان تلاطم
// امروز، ارزش همان ترکیب را در هر روز گذشته دوباره می‌سازد — شبیه‌سازی
// است، نه قیمت واقعی که آن روز روی تابلو بود. هر جای رابط که از این
// خروجی استفاده می‌کند باید همین برچسب صداقت را نشان بدهد.

import { num, ok } from './num.mjs';
import { bsPrice } from './bs.mjs';

/**
 * ارزش کل ترکیب در یک لحظه، از دید دارنده (خرید مثبت، فروش منفی).
 * علامت این عدد یعنی: نقد دریافتی هنگام ورود = −ارزش(ورود)، و سود و
 * زیان نگه‌داری تا لحظه t = ارزش(t) − ارزش(ورود). این رابطه برای خرید و
 * فروش هر دو یکسان درست است، پس نیازی به شاخه زدن جدا نیست.
 */
function portfolioValue(legs, S, T, r, q, sigma) {
  let v = 0;
  for (const l of legs) {
    const size = num(l.size, 1000);
    const qty = num(l.ratio, 1) * (l.side === 'sell' ? -1 : 1);
    const px = l.kind === 'underlying' ? S : bsPrice(l.kind, S, num(l.strike), T, r, q, sigma);
    if (!ok(px)) return NaN;
    v += qty * px * size;
  }
  return v;
}

/**
 * ردیف به ردیف closes (قدیم به جدید، آخرین ردیف = امروز)، ارزش ترکیب و
 * سود/زیان نسبت به ورود در قدیمی‌ترین روز را برمی‌گرداند.
 *
 * closes    [{date, close}], صعودی به تاریخ
 * daysToday  روز باقیمانده تا سررسید، امروز (آخرین ردیف closes)
 * sigma      تلاطم فرضی، برای کل بازه ثابت (فرض ساده‌سازی؛ نظر پ-۴ بک‌لاگ)
 */
export function timeMachine(legs, closes, { daysToday, sigma, rFree = 0, divYield = 0 }) {
  const n = closes.length;
  if (!n || !ok(daysToday) || !ok(sigma) || sigma <= 0) return [];

  const rows = closes.map((row, i) => {
    const daysAgo = n - 1 - i; // امروز = صفر
    const daysLeft = Math.max(0, daysToday + daysAgo);
    const T = Math.max(daysLeft, 0.5) / 365; // نصف روز، تا سررسید خودش صفر نشود
    const S = num(row.close);
    const value = S > 0 ? portfolioValue(legs, S, T, rFree, divYield, sigma) : NaN;
    return { date: row.date, daysAgo, S, daysLeft, value };
  });

  const entryValue = rows.length ? rows[0].value : NaN;
  return rows.map((r) => ({ ...r, pnl: ok(r.value) && ok(entryValue) ? r.value - entryValue : NaN }));
}
