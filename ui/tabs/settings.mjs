// تب تنظیمات.
//
// فرم از SCHEMA ساخته می‌شود، نه دستی. پس اگر عددی به موتور اضافه شد و
// اینجا کنترلی ندارد، یعنی در SCHEMA ثبت نشده — و همین، جلوی سخت‌کد شدن
// اعداد در کد را می‌گیرد.

import { SCHEMA, GROUPS, defaults } from '/core/settings.mjs';

const SCOPE_LABEL = { server: 'سرور', client: 'مرورگر', both: 'هر دو' };

export async function mount(root, { state, api }) {
  // اگر فایل تنظیمات از نسخه قبلی مانده و کلید تازه‌ای نداشته باشد، پیش‌فرض
  // همان کلید می‌نشیند. سرور هم همین کار را می‌کند؛ این لایه دوم است.
  const s = { ...defaults(), ...state.settings };

  root.innerHTML = `
    <div class="page-head">
      <h2>تنظیمات</h2>
      <p>هر عددی که در محاسبه اثر دارد اینجاست و در هیچ جای کد سخت‌کد نشده.
         تنظیمات سرور روی حلقه دریافت داده اثر می‌گذارد، تنظیمات مرورگر روی محاسبه و نمایش.</p>
    </div>
    <nav class="settings-nav" id="settings-nav"></nav>
    <div id="groups"></div>
    <div class="bar card" style="position:sticky;bottom:12px">
      <button class="btn" id="save">ذخیره تنظیمات</button>
      <button class="btn sec" id="reset">بازگشت به پیش‌فرض</button>
      <button class="btn sec" id="clear-cache">خالی کردن کش سرور</button>
      <span class="sp"></span>
      <span id="msg" class="saved" role="status" aria-live="polite"></span>
    </div>`;

  const holder = root.querySelector('#groups');
  const nav = root.querySelector('#settings-nav');
  const inputs = new Map();
  const navByCard = new Map();

  for (const [key, meta] of Object.entries(GROUPS)) {
    const fields = SCHEMA.filter((f) => f.group === key);
    if (!fields.length) continue;
    const scopes = [...new Set(fields.map((f) => f.scope))];
    const card = document.createElement('section');
    card.className = 'card settings-card';
    card.id = `grp-${key}`;
    card.innerHTML = `
      <h3>${meta.title}<span class="scope">${scopes.map((x) => SCOPE_LABEL[x]).join(' + ')}</span></h3>
      ${meta.note ? `<p class="note">${meta.note}</p>` : ''}
      <div class="grid"></div>`;
    const grid = card.querySelector('.grid');

    const navBtn = document.createElement('button');
    navBtn.type = 'button';
    navBtn.className = 'chip';
    navBtn.textContent = meta.title;
    navBtn.setAttribute('aria-pressed', 'false');
    navBtn.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    nav.appendChild(navBtn);
    navByCard.set(card, navBtn);

    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = f.kind === 'bool' ? 'field row' : 'field';
      const id = `f-${f.key}`;
      let control;

      if (f.kind === 'bool') {
        control = `<input type="checkbox" id="${id}" ${s[f.key] ? 'checked' : ''}>
                   <label for="${id}">${f.label}</label>`;
      } else if (f.kind === 'pick') {
        control = `<label for="${id}">${f.label}</label>
          <select id="${id}">${f.options.map(([v, t]) =>
            `<option value="${v}" ${s[f.key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
      } else if (f.kind === 'text') {
        control = `<label for="${id}">${f.label}</label>
                   <input type="text" id="${id}" value="${s[f.key] ?? ''}">`;
      } else {
        // اسلایدر و دکمه گام به‌جای فیلد خام (خواسته پ-۵): min/max/step از
        // قبل در SCHEMA آماده است، همان دادهٔ لازم برای input[type=range].
        // فیلد عددی هم می‌ماند چون برای مقدار دقیق (مثل کارمزد با شش رقم
        // اعشار) اسلایدر به‌تنهایی کافی نیست.
        const unit = f.unit ? `<span class="unit">${f.unit}</span>` : '';
        const bounded = f.min != null && f.max != null;
        control = `<label for="${id}">${f.label} ${unit}</label>
          <div class="num-ctl">
            <button type="button" class="step-btn" data-dir="-1" tabindex="-1" aria-label="کم کردن یک گام">−</button>
            <input type="number" id="${id}" value="${s[f.key]}"
              ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
              step="${f.step ?? 'any'}">
            <button type="button" class="step-btn" data-dir="1" tabindex="-1" aria-label="زیاد کردن یک گام">+</button>
          </div>
          ${bounded ? `<input type="range" class="num-range" id="${id}-r" tabindex="-1"
              min="${f.min}" max="${f.max}" step="${f.step ?? (f.max - f.min) / 100}" value="${s[f.key]}">` : ''}`;
      }

      wrap.innerHTML = control + (f.hint ? `<span class="hint">${f.hint}</span>` : '');
      grid.appendChild(wrap);
      const node = wrap.querySelector(`#${id}`);
      const rangeNode = wrap.querySelector(`#${id}-r`);
      inputs.set(f.key, { field: f, node, rangeNode });

      if (f.kind === 'num' || f.kind === 'pct') {
        const clamp = (v) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
        node.addEventListener('input', () => {
          const v = Number(node.value);
          if (rangeNode && Number.isFinite(v)) rangeNode.value = clamp(v);
        });
        rangeNode?.addEventListener('input', () => { node.value = rangeNode.value; });
        for (const btn of wrap.querySelectorAll('.step-btn')) {
          btn.addEventListener('click', () => {
            const step = f.step || 1;
            const cur = Number(node.value) || 0;
            const next = clamp(cur + Number(btn.dataset.dir) * step);
            node.value = next;
            if (rangeNode) rangeNode.value = next;
          });
        }
      }
    }
    holder.appendChild(card);
  }

  // نوار پرش، پیشِ‌رو: چیپ کارتی که زیر نوار ایستاده روشن می‌ماند، تا در
  // فهرست بلند تنظیمات معلوم باشد الان کجای صفحه‌ای — بی‌آنکه کلیک لازم باشد.
  const cardsArr = [...navByCard.keys()];
  const setActive = (card) => {
    for (const [c, btn] of navByCard) btn.setAttribute('aria-pressed', String(c === card));
  };
  // کارت آخر («نمایش») کوتاه‌تر از نوار مشاهده است و ممکن است هیچ‌وقت
  // داخلش نیفتد؛ رسیدن واقعی به ته صفحه خودش باید چیپ آخر را روشن کند —
  // این بررسی هم در رویداد اسکرول اجرا می‌شود هم داخل خودِ IntersectionObserver،
  // چون ترتیب اجرای آن دو تضمینی نیست و هرکدام دیرتر برسد باید همین را بگوید.
  const atBottom = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  // پیش از اولین اسکرول هنوز هیچ کارتی وارد نوار مشاهده نشده، پس کارت اول
  // پیش‌فرض روشن می‌ماند.
  setActive(cardsArr[0]);
  const spy = new IntersectionObserver((entries) => {
    if (atBottom()) { setActive(cardsArr[cardsArr.length - 1]); return; }
    for (const en of entries) if (en.isIntersecting) setActive(en.target);
  }, { rootMargin: '-112px 0px -70% 0px', threshold: 0 });
  for (const card of cardsArr) spy.observe(card);
  const onScroll = () => { if (atBottom()) setActive(cardsArr[cardsArr.length - 1]); };
  window.addEventListener('scroll', onScroll, { passive: true });

  const read = () => {
    const out = {};
    for (const [key, { field, node }] of inputs) {
      out[key] = field.kind === 'bool' ? node.checked
        : field.kind === 'num' || field.kind === 'pct' ? Number(node.value)
        : node.value;
    }
    return out;
  };

  const write = (next) => {
    for (const [key, { field, node, rangeNode }] of inputs) {
      if (field.kind === 'bool') node.checked = !!next[key];
      else node.value = next[key];
      if (rangeNode) rangeNode.value = next[key];
    }
  };

  const msg = root.querySelector('#msg');
  let flashTimer = null;
  const flash = (t, bad = false) => {
    msg.textContent = t;
    msg.style.color = bad ? 'var(--loss)' : 'var(--gain)';
    // اگر پیام قبلی هنوز پاک نشده، تایمرش هم لغو شود — وگرنه تایمر پیام
    // کهنه‌تر این پیام تازه‌تر را زودتر از موعد پاک می‌کرد (مثلاً «بازگشت
    // به پیش‌فرض» سریع پشت‌سرِ «ذخیره تنظیمات»).
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { msg.textContent = ''; }, 2600);
  };

  const saveBtn = root.querySelector('#save');
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    try {
      const saved = await api.putSettings(read());
      write(saved);
      flash('ذخیره شد. حلقه دریافت داده از همین حالا با اعداد تازه کار می‌کند.');
    } catch (e) {
      flash(`ذخیره نشد: ${e.message}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  root.querySelector('#reset').addEventListener('click', () => {
    write(defaults());
    flash('پیش‌فرض‌ها بازگشت. برای اعمال، ذخیره را بزن.');
  });

  const clearCacheBtn = root.querySelector('#clear-cache');
  clearCacheBtn.addEventListener('click', async () => {
    if (clearCacheBtn.disabled) return;
    clearCacheBtn.disabled = true;
    try {
      const r = await fetch('/api/cache', { method: 'DELETE' });
      if (!r.ok) throw new Error('خالی نشد');
      flash('کش سرور خالی شد. درخواست بعدی از بازار می‌آید.');
    } catch (e) {
      flash(`خالی نشد: ${e.message}`, true);
    } finally {
      clearCacheBtn.disabled = false;
    }
  });

  return () => { spy.disconnect(); window.removeEventListener('scroll', onScroll); clearTimeout(flashTimer); };
}
