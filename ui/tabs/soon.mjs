// تب‌هایی که هنوز ساخته نشده‌اند.
//
// عمداً خالی نیستند: هر تب می‌گوید در کدام فاز می‌آید، الگوی پاهایش چیست،
// و چه چیزی از موتور برایش آماده است. اینطور فهرست تب‌ها همان نقشه کار است.

import { byId } from '/strategies/catalog.mjs';
import { faDigits } from '/ui/fmt.mjs';

const READY = [
  'موتور بازده در سررسید — سربه‌سری و بیشترین سود و زیان',
  'موتور وجه تضمین — تأییدشده با شش مشاهده تابلو',
  'قاعده پوشش و بستانکار در برابر بدهکار',
  'پیمایش دفتر سفارش و سقف حجم',
  'تفکیک هزینه اجرا',
  'یونانی‌ها و تلاطم ضمنی و احتمال سود',
];

export async function mount(root, { tab }) {
  const def = tab.def || byId(tab.id);
  const legs = def
    ? faDigits(def.legs.map((l) => `${l.side === 'sell' ? '−' : '+'}${l.ratio} ${
        l.kind === 'underlying' ? 'سهم پایه' : `${l.kind === 'call' ? 'کال' : 'پوت'} K${l.slot}`
      }${l.exp ? ' سررسید دور' : ''}`).join('   '))
    : null;

  root.innerHTML = `
    <div class="page-head">
      <h2>${tab.title}</h2>
      <p>این تب در فاز ${faDigits(tab.phase)} ساخته می‌شود. موتورش آماده است؛ چیزی که مانده اتصال به داده و جدول است.</p>
    </div>

    ${def ? `<div class="card">
      <h3>الگوی پاها</h3>
      <p class="note">${def.feasible ? (def.note || def.dir) : `اجرا در تابلو ممکن نیست: ${def.infeasibleWhy}`}</p>
      <dl class="kv">
        <dt>پاها</dt><dd>${legs}</dd>
        <dt>قیمت اعمال</dt><dd>${faDigits(def.strikes)}</dd>
        <dt>سررسید</dt><dd>${faDigits(def.expiries)}</dd>
        <dt>جهت</dt><dd>${def.dir}</dd>
        <dt>جریان نقد معمول</dt><dd>${def.expect === 'credit' ? 'بستانکار — وجه تضمین دارد' : def.expect === 'debit' ? 'بدهکار — وجه تضمین ندارد' : 'بستگی به قیمت‌ها دارد'}</dd>
        ${def.risk ? `<dt>ریسک</dt><dd>${def.risk}</dd>` : ''}
      </dl>
      <p class="note" style="margin-top:12px">همین حالا می‌توانی این استراتژی را در تب «موتور و نمودار بازده» با قیمت دستی ببینی.</p>
    </div>` : ''}

    <div class="card">
      <h3>از موتور آماده است</h3>
      <ul style="margin:6px 0 0;padding-inline-start:18px;color:var(--ink-2)">
        ${READY.map((x) => `<li>${x}</li>`).join('')}
      </ul>
    </div>

    <div class="card">
      <h3>برای این تب مانده</h3>
      <ul style="margin:6px 0 0;padding-inline-start:18px;color:var(--ink-2)">
        <li>ترکیب‌سازی داخل هر پایه و هر سررسید، در ریسه جدا</li>
        <li>انتخاب نماد پایه، انتخابی نه تایپی</li>
        <li>جدول مجازی‌سازی‌شده با مرتب‌سازی روی هر ستون</li>
        <li>نوار تشخیص: چند ترکیب ساخته شد، چند تا به‌دلیل نبود مظنه افتاد</li>
        <li>پانل جزئیات ردیف: نمودار بازده، عمق هر پا، جدول سناریو</li>
      </ul>
    </div>`;
  return () => {};
}
