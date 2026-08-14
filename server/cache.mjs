// کش سرور، بدون سقف، بی‌نهایت رشد می‌کند — هیچ ورودی‌ای جز با
// DELETE /api/cache دستی حذف نمی‌شود. یک نشست طولانی روی بازار پر از نماد
// یعنی هزاران کلید URL که هرگز آزاد نمی‌شوند.
//
// خالص و بی‌نیاز از سرور آزمون می‌شود: نقشه و سقف را می‌گیرد، قدیمی‌ترین
// ورودی‌ها را به ترتیب درج حذف می‌کند تا اندازه از سقف پایین بیاید.

export function evictOldest(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}
