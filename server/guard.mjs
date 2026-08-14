// نگهبان مرز سرور — صحت‌سنجی هر چیزی که از بیرون می‌آید.
//
// سرور روی ۱۲۷٫۰٫۰٫۱ گوش می‌دهد، پس مهاجم شبکه ندارد. ولی «فقط محلی است»
// دلیل نمی‌شود ورودی صحت‌سنجی نشود: هر صفحه‌ای در همان مرورگر می‌تواند به
// این نقاط پایانی درخواست بدهد، و یک اشتباه در ساخت مسیر یعنی خواندن فایل
// بیرون از پوشه پروژه.
//
// این توابع خالص‌اند و بی‌نیاز از سرور آزمون می‌شوند. سرور فقط صدایشان
// می‌زند و به جواب اعتماد می‌کند.

import path from 'node:path';

/** کد ابزار تی‌اس‌ای‌تی‌ام‌سی فقط رقم است و طولش محدود. */
export function validIns(x) {
  return typeof x === 'string' && /^\d{1,32}$/.test(x);
}

/**
 * فهرست کد جداشده با ویرگول. هر چیزی که کد معتبر نیست دور ریخته می‌شود،
 * تکراری حذف می‌شود، و تعداد سقف می‌خورد.
 *
 * سقف اینجا نه برای امنیت که برای مهار است: هر کد یک درخواست بالادست است.
 */
export function parseInsList(raw, max = 200) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw ?? '').split(',')) {
    const code = part.trim();
    if (!validIns(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * مسیر امن زیر ریشه، یا null.
 *
 * نسخه قبلی با `file.startsWith(ROOT)` مرز می‌گرفت. آن مقایسه رشته‌ای است،
 * نه مقایسه مسیر، پس پوشه هم‌نام‌شروع کنار ریشه از آن رد می‌شد:
 *
 *   ریشه   /x/options-radar
 *   قبول   /x/options-radar-private/secret.env     ← همان پیشوند را دارد
 *
 * `path.relative` این را نمی‌گذارد: هر مسیری بیرون از ریشه، مسیر نسبی‌اش
 * با «..» شروع می‌شود.
 *
 * رمزگشایی درصدی هم لازم است، وگرنه %2e%2e%2f همان ../ است و از فیلتر
 * می‌گذرد چون نرمال‌سازی بعد از رمزگشایی انجام می‌شود نه قبلش.
 */
export function safeStaticPath(root, pathname, indexFile = '/ui/index.html') {
  if (typeof pathname !== 'string') return null;

  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;                 // بایت صفر، مسیر را در لایه‌های پایین می‌برد
  if (rel === '' || rel === '/') rel = indexFile;
  if (!rel.startsWith('/')) rel = `/${rel}`;

  const file = path.resolve(root, `.${rel}`);
  const inside = path.relative(root, file);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

export class BodyTooLarge extends Error {
  constructor(limit) {
    super(`بدنه درخواست از سقف ${limit} بایت گذشت`);
    this.name = 'BodyTooLarge';
    this.limit = limit;
  }
}

/**
 * بدنه درخواست با سقف.
 *
 * نسخه قبلی تا هر اندازه‌ای در حافظه جمع می‌کرد. یک درخواست تنها می‌توانست
 * حافظه را پر کند. سقف حین دریافت سنجیده می‌شود نه بعدش، وگرنه سقف کاری
 * نکرده است.
 */
export async function readBody(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new BodyTooLarge(maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
