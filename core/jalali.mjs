// تبدیل تاریخ شمسی و میلادی، بدون وابستگی خارجی.
// همان الگوریتم استاندارد جلالی که در نوت‌بوک رهگیر استفاده شده بود.

export function jalaliToGregorian(jy, jm, jd) {
  jy = Number(jy) + 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + Number(jd);
  days += Number(jm) < 7 ? (Number(jm) - 1) * 31 : (Number(jm) - 7) * 30 + 186;

  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const md = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 13 && gd > md[gm]) gd -= md[gm++];
  return [gy, gm, gd];
}

export function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

/** «۱۴۰۴/۰۵/۱۲» یا «1404-5-12» → شیء تاریخ. ورودی بد، null می‌دهد. */
export function parseJalali(text) {
  const m = String(text || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const [gy, gm, gd] = jalaliToGregorian(+m[1], +m[2], +m[3]);
  const d = new Date(Date.UTC(gy, gm - 1, gd));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function todayJalali() {
  const now = new Date();
  const [jy, jm, jd] = gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

/** روز سپری‌شده از تاریخ شمسی تا امروز. */
export function daysSinceJalali(text) {
  const d = parseJalali(text);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
