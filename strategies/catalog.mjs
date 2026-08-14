// فهرست استراتژی‌ها — اعلانی، نه برنامه‌نویسی‌شده.
//
// هر استراتژی فقط یک الگوی پا است. هیچ‌کدام محاسبه‌گر اختصاصی ندارد؛
// همه از موتور payoff و margin و exec عبور می‌کنند. افزودن یک استراتژی
// تازه یعنی افزودن یک ردیف به این فهرست.
//
// slot: شماره قیمت اعمال، از کوچک به بزرگ. باترفلای یعنی k1 < k2 < k3.
// exp:  شماره سررسید. صفر یعنی نزدیک، یک یعنی دور. فقط تقویمی و مورب
//       بیش از یک سررسید دارند.
//
// feasible: در تابلوی ایران فروش سهم به‌سادگی ممکن نیست. استراتژی‌هایی که
// به فروش پایه نیاز دارند حذف نمی‌شوند، برچسب می‌خورند — دیدنشان بهتر از
// نبودنشان است.

export const GROUPS = {
  income:   'کسب درآمد',
  vertical: 'اسپرد عمودی',
  calendar: 'اسپرد تقویمی',
  vol:      'تلاطم',
  wing:     'باترفلای و کندور',
  ratio:    'نسبت و بک‌اسپرد',
  hedge:    'پوشش ریسک',
  arb:      'آربیتراژ و همبستگی',
};

const L = (kind, side, slot = 1, ratio = 1, exp = 0) => ({ kind, side, slot, ratio, exp });

export const CATALOG = [
  // ——— کسب درآمد ———
  { id: 'covered-call', name: 'کاوردکال', group: 'income', dir: 'صعودی ملایم',
    legs: [L('underlying', 'buy'), L('call', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 4,
    note: 'سهم پایه، پوشش موقعیت فروش کال است؛ وجه تضمین نقدی ندارد.' },

  { id: 'cash-secured-put', name: 'فروش پوت با پشتوانه نقد', group: 'income', dir: 'صعودی ملایم',
    legs: [L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 4,
    note: 'سرمایه درگیر، بیشینه وجه تضمین و ارزش تعهد خرید است.' },

  { id: 'naked-call', name: 'فروش کال بدون پوشش', group: 'income', dir: 'نزولی',
    legs: [L('call', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 4, risk: 'زیان نامحدود',
    note: 'زیان نامحدود. وجه تضمین کامل و کال مارجین جدی است.' },

  { id: 'naked-put', name: 'فروش پوت بدون پوشش', group: 'income', dir: 'صعودی',
    legs: [L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 4, risk: 'زیان بزرگ',
    note: 'بیشترین زیان تا صفر شدن پایه.' },

  // ——— اسپرد عمودی ———
  { id: 'bull-call-spread', name: 'اسپرد صعودی کال', group: 'vertical', dir: 'صعودی',
    legs: [L('call', 'buy', 1), L('call', 'sell', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 5, expect: 'debit' },

  { id: 'bear-call-spread', name: 'اسپرد نزولی کال', group: 'vertical', dir: 'نزولی',
    legs: [L('call', 'sell', 1), L('call', 'buy', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 5, expect: 'credit' },

  { id: 'bull-put-spread', name: 'اسپرد صعودی پوت', group: 'vertical', dir: 'صعودی',
    legs: [L('put', 'buy', 1), L('put', 'sell', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 5, expect: 'credit',
    note: 'صعودی است ولی بستانکار؛ پس وجه تضمین می‌گیرد. جهت و بستانکاری یکی نیستند.' },

  { id: 'bear-put-spread', name: 'اسپرد نزولی پوت', group: 'vertical', dir: 'نزولی',
    legs: [L('put', 'sell', 1), L('put', 'buy', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 5, expect: 'debit',
    note: 'نزولی است ولی بدهکار؛ پس وجه تضمین نمی‌گیرد.' },

  // ——— تقویمی ———
  { id: 'calendar-call', name: 'تقویمی کال', group: 'calendar', dir: 'خنثی',
    legs: [L('call', 'sell', 1, 1, 0), L('call', 'buy', 1, 1, 1)],
    strikes: 1, expiries: 2, feasible: true, phase: 5, expect: 'debit',
    note: 'پس از سررسید پای نزدیک، پای دور تنها می‌ماند. وجه تضمین شرطی مهم است.' },

  { id: 'calendar-put', name: 'تقویمی پوت', group: 'calendar', dir: 'خنثی',
    legs: [L('put', 'sell', 1, 1, 0), L('put', 'buy', 1, 1, 1)],
    strikes: 1, expiries: 2, feasible: true, phase: 5, expect: 'debit' },

  { id: 'diagonal-call', name: 'مورب کال', group: 'calendar', dir: 'صعودی ملایم',
    legs: [L('call', 'sell', 2, 1, 0), L('call', 'buy', 1, 1, 1)],
    strikes: 2, expiries: 2, feasible: true, phase: 6, expect: 'debit' },

  // ——— تلاطم ———
  { id: 'long-straddle', name: 'استرادل خرید', group: 'vol', dir: 'تلاطم بالا',
    legs: [L('call', 'buy', 1), L('put', 'buy', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  { id: 'short-straddle', name: 'استرادل فروش', group: 'vol', dir: 'تلاطم پایین',
    legs: [L('call', 'sell', 1), L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 6, expect: 'credit', risk: 'زیان نامحدود' },

  { id: 'long-strangle', name: 'استرانگل خرید', group: 'vol', dir: 'تلاطم بالا',
    legs: [L('put', 'buy', 1), L('call', 'buy', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  { id: 'short-strangle', name: 'استرانگل فروش', group: 'vol', dir: 'تلاطم پایین',
    legs: [L('put', 'sell', 1), L('call', 'sell', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6, expect: 'credit', risk: 'زیان نامحدود' },

  // ——— باترفلای و کندور ———
  { id: 'long-call-butterfly', name: 'باترفلای کال خرید', group: 'wing', dir: 'خنثی',
    legs: [L('call', 'buy', 1), L('call', 'sell', 2, 2), L('call', 'buy', 3)],
    strikes: 3, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  { id: 'short-call-butterfly', name: 'باترفلای کال فروش', group: 'wing', dir: 'تلاطم بالا',
    legs: [L('call', 'sell', 1), L('call', 'buy', 2, 2), L('call', 'sell', 3)],
    strikes: 3, expiries: 1, feasible: true, phase: 6, expect: 'credit' },

  { id: 'long-put-butterfly', name: 'باترفلای پوت خرید', group: 'wing', dir: 'خنثی',
    legs: [L('put', 'buy', 1), L('put', 'sell', 2, 2), L('put', 'buy', 3)],
    strikes: 3, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  { id: 'iron-butterfly', name: 'باترفلای آهنی', group: 'wing', dir: 'خنثی',
    legs: [L('put', 'buy', 1), L('put', 'sell', 2), L('call', 'sell', 2), L('call', 'buy', 3)],
    strikes: 3, expiries: 1, feasible: true, phase: 6, expect: 'credit',
    note: 'چهار پا یعنی چهار بار کارمزد و چهار بار عبور از اسپرد.' },

  { id: 'iron-condor', name: 'کندور آهنی', group: 'wing', dir: 'خنثی',
    legs: [L('put', 'buy', 1), L('put', 'sell', 2), L('call', 'sell', 3), L('call', 'buy', 4)],
    strikes: 4, expiries: 1, feasible: true, phase: 6, expect: 'credit',
    note: 'در بازار ایران معمولاً یکی از چهار پا مظنه ندارد و کل ترکیب می‌افتد.' },

  { id: 'long-call-condor', name: 'کندور کال خرید', group: 'wing', dir: 'خنثی',
    legs: [L('call', 'buy', 1), L('call', 'sell', 2), L('call', 'sell', 3), L('call', 'buy', 4)],
    strikes: 4, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  // ——— نسبت ———
  { id: 'call-ratio-spread', name: 'نسبت‌اسپرد کال', group: 'ratio', dir: 'صعودی ملایم',
    legs: [L('call', 'buy', 1), L('call', 'sell', 2, 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6, risk: 'زیان نامحدود',
    note: 'فروش بیشتر از خرید؛ بخشی از موقعیت لخت است و وجه تضمین کامل می‌گیرد.' },

  { id: 'put-ratio-spread', name: 'نسبت‌اسپرد پوت', group: 'ratio', dir: 'نزولی ملایم',
    legs: [L('put', 'buy', 2), L('put', 'sell', 1, 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6, risk: 'زیان بزرگ' },

  { id: 'call-backspread', name: 'بک‌اسپرد کال', group: 'ratio', dir: 'صعودی تند',
    legs: [L('call', 'sell', 1), L('call', 'buy', 2, 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6 },

  // ——— پوشش ریسک ———
  { id: 'protective-put', name: 'پوت محافظ', group: 'hedge', dir: 'صعودی با بیمه',
    legs: [L('underlying', 'buy'), L('put', 'buy', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 6, expect: 'debit' },

  { id: 'collar', name: 'کولار', group: 'hedge', dir: 'محافظه‌کارانه',
    legs: [L('underlying', 'buy'), L('put', 'buy', 1), L('call', 'sell', 2)],
    strikes: 2, expiries: 1, feasible: true, phase: 6,
    note: 'سود و زیان هر دو محدود. مناسب قفل کردن سود سهمی که داری.' },

  // ——— آربیتراژ ———
  { id: 'synthetic-long', name: 'سهم مصنوعی خرید', group: 'arb', dir: 'صعودی',
    legs: [L('call', 'buy', 1), L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 7,
    note: 'اگر ارزان‌تر از خود سهم تمام شود، جای خرید سهم می‌نشیند.' },

  { id: 'box', name: 'جعبه‌اسپرد', group: 'arb', dir: 'بی‌جهت',
    legs: [L('call', 'buy', 1), L('call', 'sell', 2), L('put', 'buy', 2), L('put', 'sell', 1)],
    strikes: 2, expiries: 1, feasible: true, phase: 7,
    note: 'بازده قطعی؛ فقط اگر بستانکار خالص از فاصله قیمت اعمال بیشتر باشد. چهار کارمزد آن را معمولاً می‌خورد.' },

  { id: 'conversion', name: 'تبدیل', group: 'arb', dir: 'بی‌جهت',
    legs: [L('underlying', 'buy'), L('call', 'sell', 1), L('put', 'buy', 1)],
    strikes: 1, expiries: 1, feasible: true, phase: 7 },

  { id: 'reversal', name: 'برگردان', group: 'arb', dir: 'بی‌جهت',
    legs: [L('underlying', 'sell'), L('call', 'buy', 1), L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: false, phase: 7,
    infeasibleWhy: 'به فروش سهم پایه نیاز دارد؛ در تابلو به‌سادگی ممکن نیست.' },

  { id: 'covered-put', name: 'کاورد پوت', group: 'income', dir: 'نزولی',
    legs: [L('underlying', 'sell'), L('put', 'sell', 1)],
    strikes: 1, expiries: 1, feasible: false, phase: 7,
    infeasibleWhy: 'به فروش سهم پایه نیاز دارد؛ در تابلو به‌سادگی ممکن نیست.' },
];

export const byId = (id) => CATALOG.find((s) => s.id === id);

/**
 * ساخت پاهای واقعی از الگو.
 *
 * strikes: آرایه قیمت اعمال، از کوچک به بزرگ. طولش باید با def.strikes بخواند.
 * quotesBySlot: قیمت و سررسید هر پا، به‌ازای کلید `${kind}${slot}@${exp}`
 * size: اندازه قرارداد
 */
export function buildLegs(def, { strikes, size = 1000, days = [], prices = {} }) {
  return def.legs.map((t) => {
    const K = t.kind === 'underlying' ? undefined : strikes[t.slot - 1];
    const key = t.kind === 'underlying' ? 'underlying' : `${t.kind}${t.slot}@${t.exp}`;
    return {
      kind: t.kind, side: t.side, ratio: t.ratio,
      strike: K,
      size: t.kind === 'underlying' ? size : size,
      days: t.kind === 'underlying' ? undefined : (days[t.exp] ?? days[0] ?? 0),
      price: prices[key] ?? 0,
      slot: t.slot, exp: t.exp, key,
    };
  });
}

/** کلیدهای قیمتی که یک استراتژی لازم دارد — برای پر کردن فرم و برای غربال. */
export function priceKeys(def) {
  return def.legs.map((t) => (t.kind === 'underlying' ? 'underlying' : `${t.kind}${t.slot}@${t.exp}`));
}
