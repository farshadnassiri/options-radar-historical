// موقعیت‌های «مشابه» برای مقایسه روی نمودار بازده (قلم الف-۱ بک‌لاگ).
//
// تعریف «مشابه» عمداً همین یک شرط ساده نگه داشته شده: هم‌نماد بودن. جهت،
// سررسید و استراتژی فیلتر نمی‌شوند — کاربر خودش با تیک زدن دقیق‌تر می‌کند؛
// تعریف سخت‌گیرانه‌تر فقط گزینه‌های واقعاً جالب (مثلاً یک تقویمی در برابر
// یک اسپرد ساده) را از دید پنهان می‌کرد.

export const MAX_COMPARE = 4;
const LIST_LIMIT = 10;

/** ردیف‌های هم‌نماد با ردیف انتخاب‌شده، به‌جز خودش — سقف برای فهرست تیک. */
export function sameUnderlyingCandidates(rows, picked) {
  if (!picked) return [];
  return rows.filter((r) => r.underlying === picked.underlying && r.id !== picked.id).slice(0, LIST_LIMIT);
}

function fullCompareText(r) {
  return r.strategy ? `${r.strategy} — ${r.legsText}` : r.legsText;
}

/** برچسب کوتاه یک ردیف برای legend نمودار — پای‌های کامل جا نمی‌شوند. */
export function compareLabel(r) {
  const t = fullCompareText(r);
  return t.length > 22 ? `${t.slice(0, 21)}…` : t;
}

/** متن کامل بریده‌نشده، برای tooltip روی برچسب کوتاه‌شده. */
export function compareFullLabel(r) {
  return fullCompareText(r);
}
