// ————————————————————————————————————————————————————————————————
// تنظیمات — تک منبع حقیقت
//
// هر عددی که در محاسبه اثر دارد اینجاست و در هیچ فایل دیگری سخت‌کد نمی‌شود.
// فرم تب تنظیمات از همین فهرست ساخته می‌شود، پس افزودن یک کلید اینجا
// خودبه‌خود یک کنترل در رابط کاربری می‌سازد.
//
// group : گروه‌بندی در تب تنظیمات
// kind  : num | pct | bool | pick | text
// scope : server = حلقه دریافت داده | client = محاسبه و نمایش | both
// ————————————————————————————————————————————————————————————————

export const SCHEMA = [
  // ——— منبع داده ———
  { key: 'baseUrl', group: 'data', kind: 'text', scope: 'server',
    def: 'https://cdn.tsetmc.com/api', label: 'آدرس پایه داده' },
  { key: 'watchIntervalSec', group: 'data', kind: 'num', scope: 'server',
    def: 5, min: 2, max: 120, step: 1, unit: 'ثانیه',
    label: 'فاصله دریافت دیده‌بان',
    hint: 'یک درخواست، کل بازار اختیار. ستون فقرات همه تب‌ها.' },
  { key: 'ttlWatchSec', group: 'data', kind: 'num', scope: 'server',
    def: 4, min: 1, max: 60, step: 1, unit: 'ثانیه', label: 'عمر کش دیده‌بان' },
  { key: 'ttlBookSec', group: 'data', kind: 'num', scope: 'server',
    def: 3, min: 1, max: 60, step: 1, unit: 'ثانیه', label: 'عمر کش دفتر سفارش' },
  { key: 'ttlInfoSec', group: 'data', kind: 'num', scope: 'server',
    def: 3, min: 1, max: 60, step: 1, unit: 'ثانیه', label: 'عمر کش قیمت جاری' },
  { key: 'ttlDailySec', group: 'data', kind: 'num', scope: 'server',
    def: 900, min: 60, max: 86400, step: 60, unit: 'ثانیه', label: 'عمر کش داده روزانه' },
  { key: 'ttlMetaSec', group: 'data', kind: 'num', scope: 'server',
    def: 3600, min: 60, max: 86400, step: 60, unit: 'ثانیه', label: 'عمر کش مشخصات قرارداد' },

  // ——— سهمیه و فشار روی سرور بازار ———
  { key: 'ratePerSec', group: 'quota', kind: 'num', scope: 'server',
    def: 12, min: 1, max: 60, step: 1, unit: 'درخواست در ثانیه',
    label: 'سقف نرخ درخواست',
    hint: 'سهمیه فقط در سرور محلی اعمال می‌شود، پس چند تب هم‌زمان بازار را نمی‌کوبند.' },
  { key: 'burst', group: 'quota', kind: 'num', scope: 'server',
    def: 20, min: 1, max: 120, step: 1, unit: 'درخواست', label: 'ظرفیت انفجاری' },
  { key: 'concurrency', group: 'quota', kind: 'num', scope: 'server',
    def: 6, min: 1, max: 24, step: 1, unit: 'هم‌زمان', label: 'سقف درخواست هم‌زمان' },
  { key: 'retries', group: 'quota', kind: 'num', scope: 'server',
    def: 2, min: 0, max: 5, step: 1, unit: 'بار', label: 'تلاش مجدد' },
  { key: 'timeoutMs', group: 'quota', kind: 'num', scope: 'server',
    def: 9000, min: 1000, max: 30000, step: 500, unit: 'میلی‌ثانیه', label: 'مهلت هر درخواست' },
  { key: 'maxDepthSymbols', group: 'quota', kind: 'num', scope: 'client',
    def: 24, min: 2, max: 200, step: 1, unit: 'نماد',
    label: 'سقف نماد با عمق کامل',
    hint: 'مرحله دو غربال. عمق پنج سطحی فقط برای همین تعداد کاندیدای برتر گرفته می‌شود.' },
  { key: 'maxCacheEntries', group: 'quota', kind: 'num', scope: 'server',
    def: 2000, min: 50, max: 50000, step: 50, unit: 'ورودی',
    label: 'سقف کش سرور',
    hint: 'کلید کش یک URL بالادست است. بدون سقف، نشست طولانی روی بازار پر از نماد حافظه را بی‌رویه پر می‌کند.' },

  // ——— ساعات بازار ———
  { key: 'gateMarketHours', group: 'hours', kind: 'bool', scope: 'server',
    def: true, label: 'توقف خودکار بیرون از بازار' },
  { key: 'openHHMM', group: 'hours', kind: 'text', scope: 'server',
    def: '09:00', label: 'شروع بازار (تهران)' },
  { key: 'closeHHMM', group: 'hours', kind: 'text', scope: 'server',
    def: '12:30', label: 'پایان بازار (تهران)' },
  { key: 'tradeDays', group: 'hours', kind: 'text', scope: 'server',
    def: 'Sat,Sun,Mon,Tue,Wed', label: 'روزهای معاملاتی' },

  // ——— کارمزد ———
  { key: 'feeBuyStock', group: 'fees', kind: 'pct', scope: 'client',
    def: 0.003712, min: 0, max: 0.05, step: 0.000001, label: 'کارمزد خرید سهم' },
  { key: 'feeSellStock', group: 'fees', kind: 'pct', scope: 'client',
    def: 0.008800, min: 0, max: 0.05, step: 0.000001,
    label: 'کارمزد فروش سهم', hint: 'شامل مالیات فروشنده.' },
  { key: 'feeOption', group: 'fees', kind: 'pct', scope: 'client',
    def: 0.001030, min: 0, max: 0.05, step: 0.000001,
    label: 'کارمزد معامله اختیار، هر سمت',
    hint: 'با پنل کارگزاری خودت تطبیق بده. این عدد در استراتژی چندپا چند بار پرداخت می‌شود.' },
  { key: 'feeExercise', group: 'fees', kind: 'pct', scope: 'client',
    def: 0.000500, min: 0, max: 0.05, step: 0.000001, label: 'کارمزد اعمال' },

  // ——— وجه تضمین ———
  { key: 'marginA', group: 'margin', kind: 'num', scope: 'client',
    def: 0.20, min: 0, max: 1, step: 0.01, label: 'ضریب A' },
  { key: 'marginB', group: 'margin', kind: 'num', scope: 'client',
    def: 0.10, min: 0, max: 1, step: 0.01, label: 'ضریب B' },
  { key: 'marginC', group: 'margin', kind: 'num', scope: 'client',
    def: 10000, min: 1, max: 1000000, step: 1000, unit: 'ریال', label: 'واحد گردکردن C' },
  { key: 'marginMaint', group: 'margin', kind: 'num', scope: 'client',
    def: 0.70, min: 0, max: 1, step: 0.01, label: 'ضریب نگهداشت' },
  { key: 'capitalMode', group: 'margin', kind: 'pick', scope: 'client',
    def: 'NET', options: [['NET', 'خالص — وجه تضمین منهای بستانکار'], ['GROSS', 'ناخالص — کل وجه تضمین']],
    label: 'مبنای سرمایه در موقعیت فروش' },
  { key: 'creditSpreadMargin', group: 'margin', kind: 'pick', scope: 'client',
    def: 'FULL',
    options: [
      ['FULL', 'الف — کامل روی پای فروش، بدون تخفیف'],
      ['LESS_WIDTH', 'ب — کامل منهای فاصله قیمت اعمال'],
      ['WIDTH', 'ج — فقط فاصله قیمت اعمال'],
    ],
    label: 'وجه تضمین اسپرد بستانکار',
    hint: 'اسپرد بدهکار وجه تضمین ندارد. برای بستانکار، مقدارش با تابلو تأیید نشده؛ الف محافظه‌کارانه‌ترین است.' },

  // ——— مبنای قیمت و اجرا ———
  { key: 'priceBasis', group: 'exec', kind: 'pick', scope: 'client',
    def: 'BOOK',
    options: [
      ['BOOK', 'دفتر سفارش — قابل اجرا'],
      ['LAST', 'آخرین معامله — مرجع'],
      ['CLOSE', 'قیمت پایانی — مرجع'],
      ['LOW', 'کمترین قیمت روز — ناهم‌زمان'],
      ['HIGH', 'بیشترین قیمت روز — ناهم‌زمان'],
    ],
    label: 'مبنای پیش‌فرض قیمت',
    hint: 'کمترین و بیشترین، تجمعی کل روز هستند و لحظه وقوعشان معلوم نیست؛ ترکیبشان سناریوی هم‌زمان نمی‌سازد.' },
  { key: 'execMode', group: 'exec', kind: 'pick', scope: 'client',
    def: 'AGGRESSIVE',
    options: [
      ['AGGRESSIVE', 'تهاجمی — عبور از کل اسپرد'],
      ['MID', 'میانه — نصف اسپرد، بدون تضمین اجرا'],
      ['CONSERVATIVE', 'محافظه‌کار — یک پله بدتر از مظنه'],
    ],
    label: 'حالت اجرا' },
  { key: 'qtyDefault', group: 'exec', kind: 'num', scope: 'client',
    def: 1, min: 1, max: 10000, step: 1, unit: 'قرارداد',
    label: 'حجم پیش‌فرض من',
    hint: 'مبنای دفتر سفارش بدون حجم بی‌معناست؛ قیمت اجرا با پیمایش پنج سطح برای همین حجم حساب می‌شود.' },
  { key: 'capitalAvailable', group: 'exec', kind: 'num', scope: 'client',
    def: 1000000000, min: 0, max: 1e13, step: 10000000, unit: 'ریال', label: 'سرمایه در دسترس' },
  { key: 'maxSlipPct', group: 'exec', kind: 'num', scope: 'client',
    def: 12, min: 0, max: 100, step: 0.5, unit: 'درصد', label: 'سقف افت مظنه قابل تحمل' },
  { key: 'staleSec', group: 'exec', kind: 'num', scope: 'client',
    def: 900, min: 30, max: 7200, step: 30, unit: 'ثانیه', label: 'آستانه کهنگی مظنه' },
  { key: 'showUnexecutable', group: 'exec', kind: 'bool', scope: 'client',
    def: false, label: 'نمایش ردیف‌های غیرقابل اجرا',
    hint: 'ترکیب‌های بی‌مظنه را با مبنای پایانی و برچسب خاکستری برمی‌گرداند، فقط برای مطالعه.' },

  // ——— غربال مشترک ———
  { key: 'minDays', group: 'screen', kind: 'num', scope: 'client',
    def: 1, min: 0, max: 400, step: 1, unit: 'روز', label: 'حداقل روز تا سررسید' },
  { key: 'maxDays', group: 'screen', kind: 'num', scope: 'client',
    def: 120, min: 1, max: 400, step: 1, unit: 'روز', label: 'حداکثر روز تا سررسید' },
  { key: 'minBid', group: 'screen', kind: 'num', scope: 'client',
    def: 1, min: 0, max: 1e7, step: 1, unit: 'ریال', label: 'حداقل قیمت تقاضا' },
  { key: 'minBidQty', group: 'screen', kind: 'num', scope: 'client',
    def: 1, min: 0, max: 1e6, step: 1, unit: 'قرارداد', label: 'حداقل حجم مظنه' },
  { key: 'minOpenInt', group: 'screen', kind: 'num', scope: 'client',
    def: 0, min: 0, max: 1e7, step: 10, unit: 'موقعیت', label: 'حداقل موقعیت باز' },
  { key: 'minLegVol', group: 'screen', kind: 'num', scope: 'client',
    def: 0, min: 0, max: 1e7, step: 10, unit: 'قرارداد', label: 'حداقل حجم معاملات هر پا',
    hint: 'حجم امروز آن قرارداد، نه حجم مظنه فعلی. رد کردن قراردادی که کسی امروز رویش معامله نکرده.' },
  { key: 'minLegValue', group: 'screen', kind: 'num', scope: 'client',
    def: 0, min: 0, max: 1e13, step: 1000000, unit: 'ریال', label: 'حداقل ارزش معاملات هر پا' },
  { key: 'minUaLiquidity', group: 'screen', kind: 'num', scope: 'client',
    def: 0, min: 0, max: 1e14, step: 10000000, unit: 'ریال', label: 'حداقل نقدشوندگی زنجیره پایه',
    hint: 'مجموع ارزش معاملات امروز کل زنجیره اختیار همان پایه، نه فقط یک قرارداد. رد کردن پایه‌ای که کل زنجیره‌اش امروز خوابیده.' },
  { key: 'maxSpreadPct', group: 'screen', kind: 'num', scope: 'client',
    def: 100, min: 0, max: 1000, step: 1, unit: 'درصد', label: 'سقف اسپرد' },
  { key: 'minReturnPct', group: 'screen', kind: 'num', scope: 'client',
    def: 0, min: -100, max: 1000, step: 0.5, unit: 'درصد', label: 'حداقل بازده دوره' },

  // ——— مهار ترکیب‌سازی ———
  { key: 'comboWindowPct', group: 'combo', kind: 'num', scope: 'client',
    def: 25, min: 2, max: 100, step: 1, unit: 'درصد',
    label: 'پنجره قیمت اعمال حول پایه',
    hint: 'قیمت اعمال دورتر از این فاصله، در ترکیب‌سازی وارد نمی‌شود. مهار اصلی انفجار ترکیب.' },
  { key: 'maxCombosPerExpiry', group: 'combo', kind: 'num', scope: 'client',
    def: 400, min: 10, max: 20000, step: 10, unit: 'ترکیب',
    label: 'سقف ترکیب هر سررسید' },
  { key: 'maxRows', group: 'combo', kind: 'num', scope: 'client',
    def: 4000, min: 100, max: 100000, step: 100, unit: 'ردیف',
    label: 'سقف ردیف ارزیابی‌شده',
    hint: 'مرحله یک غربال. بعد از رتبه‌بندی، فقط کاندیداهای برتر عمق کامل می‌گیرند.' },
  { key: 'wingsEqualWidth', group: 'combo', kind: 'bool', scope: 'client',
    def: true, label: 'باترفلای و کندور فقط با بال مساوی',
    hint: 'خاموش کردنش تعداد ترکیب را چند برابر می‌کند.' },
  { key: 'greeksInScan', group: 'combo', kind: 'bool', scope: 'client',
    def: false, label: 'یونانی در مرحله یک',
    hint: 'استخراج تلاطم ضمنی برای هر پا گران است. خاموش بماند؛ یونانی‌ها در مرحله دو برای کاندیداهای برتر حساب می‌شوند.' },
  { key: 'rankBy', group: 'combo', kind: 'pick', scope: 'client',
    def: 'retMonthPct',
    options: [
      ['retMonthPct', 'بازده ماهانه'],
      ['retMaxPct', 'بازده دوره'],
      ['retStaticPct', 'بازده ایستا'],
      ['popPct', 'احتمال سود'],
      ['maxProfit', 'بیشترین سود'],
      ['thetaToCapitalPct', 'تتا به سرمایه'],
    ],
    label: 'مبنای رتبه‌بندی' },

  // ——— تلاطم و احتمال ———
  { key: 'rFree', group: 'vol', kind: 'num', scope: 'client',
    def: 0.30, min: 0, max: 1.5, step: 0.005, label: 'نرخ بدون ریسک سالانه',
    hint: 'روی همه یونانی‌ها و قیمت نظری اثر دارد. عدد پیش‌فرض سلیقه‌ای است، تأییدش کن.' },
  { key: 'divYield', group: 'vol', kind: 'num', scope: 'client',
    def: 0.00, min: 0, max: 1, step: 0.005, label: 'بازده نقدی سالانه پایه' },
  { key: 'volSource', group: 'vol', kind: 'pick', scope: 'client',
    def: 'IV', options: [['IV', 'تلاطم ضمنی'], ['HIST', 'تلاطم تاریخی'], ['MANUAL', 'دستی']],
    label: 'منبع تلاطم' },
  { key: 'ivBasis', group: 'vol', kind: 'pick', scope: 'client',
    def: 'CLOSE', options: [['CLOSE', 'قیمت پایانی'], ['LAST', 'آخرین معامله'], ['BID', 'قیمت تقاضا']],
    label: 'مبنای استخراج تلاطم ضمنی' },
  { key: 'volManual', group: 'vol', kind: 'num', scope: 'client',
    def: 0.60, min: 0.01, max: 5, step: 0.01, label: 'تلاطم دستی سالانه' },
  { key: 'ivLo', group: 'vol', kind: 'num', scope: 'client',
    def: 0.01, min: 0.001, max: 1, step: 0.01, label: 'کف جست‌وجوی تلاطم' },
  { key: 'ivHi', group: 'vol', kind: 'num', scope: 'client',
    def: 5.00, min: 0.5, max: 20, step: 0.5, label: 'سقف جست‌وجوی تلاطم' },
  { key: 'volDays', group: 'vol', kind: 'num', scope: 'client',
    def: 120, min: 30, max: 500, step: 10, unit: 'روز', label: 'طول تاریخچه تلاطم' },
  { key: 'tradingDaysYr', group: 'vol', kind: 'num', scope: 'client',
    def: 240, min: 200, max: 260, step: 1, unit: 'روز', label: 'روز معاملاتی در سال' },
  { key: 'shockPct', group: 'vol', kind: 'num', scope: 'client',
    def: 10, min: 1, max: 60, step: 1, unit: 'درصد', label: 'شوک سناریو' },

  // ——— نمایش ———
  { key: 'theme', group: 'view', kind: 'pick', scope: 'client',
    def: 'ledger', options: [['ledger', 'دفتر — روشن'], ['board', 'تابلو — تیره']], label: 'پوسته' },
  { key: 'persianDigits', group: 'view', kind: 'bool', scope: 'client',
    def: false, label: 'ارقام فارسی' },
  { key: 'topN', group: 'view', kind: 'num', scope: 'client',
    def: 200, min: 10, max: 5000, step: 10, unit: 'ردیف', label: 'سقف ردیف جدول' },
];

export const GROUPS = {
  data:   { title: 'منبع داده و زمان دریافت', note: 'یک درخواست دیده‌بان، کل بازار اختیار را می‌دهد. عمق و وضعیت، فقط بر اساس تقاضا.' },
  quota:  { title: 'سهمیه درخواست', note: 'سهمیه در سرور محلی اعمال می‌شود، نه در مرورگر.' },
  hours:  { title: 'ساعات بازار', note: 'بیرون از بازار حلقه دریافت متوقف می‌شود و آخرین عکس لحظه‌ای در حافظه می‌ماند.' },
  fees:   { title: 'کارمزدها', note: 'در استراتژی چندپا، کارمزد هر پا جدا پرداخت می‌شود.' },
  margin: { title: 'وجه تضمین و سرمایه', note: 'بستانکار خالص وجه تضمین می‌گیرد، بدهکار خالص نمی‌گیرد.' },
  exec:   { title: 'مبنای قیمت و اجرا', note: 'مبنای دفتر سفارش، تنها مبنایی است که ادعای اجرا دارد.' },
  screen: { title: 'غربال مشترک', note: 'این فیلترها روی همه تب‌ها اعمال می‌شوند.' },
  combo: { title: 'ترکیب‌سازی', note: 'تعداد ترکیب با تعداد پا رشد انفجاری دارد. این اعداد مهارش می‌کنند.' },
  vol:    { title: 'تلاطم و احتمال', note: 'مدل لگاریتم-نرمال دامنه نوسان را نمی‌بیند و حرکت‌های بزرگ را بیش‌برآورد می‌کند.' },
  view:   { title: 'نمایش', note: '' },
};

export function defaults() {
  const o = {};
  for (const f of SCHEMA) o[f.key] = f.def;
  return o;
}

/** ورودی ناشناخته را دور می‌ریزد و اعداد را در کران خودشان می‌بندد. */
export function sanitize(input = {}) {
  const out = defaults();
  for (const f of SCHEMA) {
    if (!(f.key in input)) continue;
    let v = input[f.key];
    if (f.kind === 'bool') { out[f.key] = !!v; continue; }
    if (f.kind === 'num' || f.kind === 'pct') {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      if (f.min != null) v = Math.max(f.min, v);
      if (f.max != null) v = Math.min(f.max, v);
      out[f.key] = v;
      continue;
    }
    if (f.kind === 'pick') {
      if (f.options.some(([k]) => k === v)) out[f.key] = v;
      continue;
    }
    out[f.key] = String(v);
  }
  return out;
}

/** دسته کارمزد، جدا شده از تنظیمات تا موتورها به کل شیء وابسته نشوند. */
export function feesOf(s) {
  return {
    buyStock: s.feeBuyStock, sellStock: s.feeSellStock,
    option: s.feeOption, exercise: s.feeExercise,
  };
}

export function marginParamsOf(s) {
  return { A: s.marginA, B: s.marginB, C: s.marginC, maint: s.marginMaint };
}
