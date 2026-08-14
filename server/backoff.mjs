// عقب‌نشینی نمایی حلقه دیده‌بان.
//
// watchLoop قبلاً روی خطای پیاپی عقب‌نشینی نداشت: اگر بالادست قطع بود،
// حلقه هر watchIntervalSec دوباره می‌کوبید — با ratePerSec و concurrency
// محلی تصادمی نمی‌سازد، ولی بی‌فایده بالادست را می‌زند تا وقتی برگردد.
//
// خالص و بی‌نیاز از سرور آزمون می‌شود: فاصله عادی و شمار شکست پیاپی را
// می‌گیرد، فاصله بعدی را می‌دهد.

export function watchBackoffSec(intervalSec, consecutiveFails, capSec = 300) {
  if (consecutiveFails <= 0) return intervalSec;
  return Math.min(capSec, intervalSec * 2 ** consecutiveFails);
}
