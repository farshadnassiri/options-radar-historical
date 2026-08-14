// تب استراتژی — یکی برای همه.
//
// هر تب استراتژی از همین فایل ساخته می‌شود و تفاوتشان فقط شناسه الگو است.
// این نتیجه مستقیم آن تصمیم معماری است: چون هیچ استراتژی محاسبه‌گر جدا ندارد،
// هیچ تبی هم رابط جدا لازم ندارد.
//
// ساختار هر صفحه:
//   انتخاب نماد ، کنترل‌ها ، شاخص‌های کلیدی ، نوار تشخیص ،
//   جدول مرتب‌شدنی ، پانل جزئیات ردیف

import { byId } from '/strategies/catalog.mjs';
import { COLUMNS } from '/core/evaluate.mjs';
import { analyzePayoff, scenarioGrid } from '/core/payoff.mjs';
import { analyzeMixed, isSingleExpiry } from '/core/mixed.mjs';
import { timeMachine } from '/core/timemachine.mjs';
import { priceQuantile } from '/core/bs.mjs';
import { gregorianToJalali } from '/core/jalali.mjs';
import { makeTable, funnelBar, changedIds } from '/ui/table.mjs';
import { fmt, faNum, faDigits, coverageInfo, signTone } from '/ui/fmt.mjs';
import { makePicker } from '/ui/picker.mjs';
import { mountPayoff, payoffAt } from '/ui/chart.mjs';
import { sameUnderlyingCandidates, compareLabel, compareFullLabel, MAX_COMPARE } from '/ui/compare.mjs';
import { runScan, onChain, pushRows, chainState } from '/ui/scanner.mjs';

/** dEven عددی (مثلاً ۲۰۲۶۰۱۰۱) به تاریخ شمسی خوانا. */
function jalaliFromDEven(dEven) {
  const s2 = String(dEven);
  if (s2.length !== 8) return faDigits(s2);
  const gy = +s2.slice(0, 4), gm = +s2.slice(4, 6), gd = +s2.slice(6, 8);
  const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
  return faDigits(`${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`);
}

const VIEWS = {
  خلاصه: ['underlying', 'legsText', 'days', 'cashLabel', 'netCash', 'breakevens', 'maxProfit',
    'maxLoss', 'capital', 'retMaxPct', 'retMonthPct', 'popPct', 'execCost', 'maxQty', 'binding',
    'qualityLabel', 'warn'],
  سرمایه: ['underlying', 'legsText', 'days', 'capital', 'capitalLabel', 'margin', 'marginToMaxLoss',
    'conditionalMargin', 'netCash', 'maxLoss', 'retMaxPct', 'retAnnPct', 'warn'],
  یونانی: ['underlying', 'legsText', 'days', 'delta', 'gamma', 'vega', 'theta',
    'thetaToCapitalPct', 'sigmaUse', 'popPct', 'capital', 'warn'],
  اجرا: ['underlying', 'legsText', 'days', 'execCost', 'costCommission', 'costCrossing',
    'costSlippage', 'costFunding', 'maxQty', 'binding', 'qualityLabel', 'warn'],
  همه: COLUMNS.map((c) => c.key),
};

export async function mount(root, { tab, state, api }) {
  const def = tab.def || byId(tab.id);
  // کنترل‌های محلی این تب (priceBasis، rankBy، ...) روی state.settings
  // مشترک نمی‌نشینند — آن شیء همان چیزی است که تب تنظیمات با آن فرم
  // می‌سازد و بقیه تب‌ها (برترین موقعیت‌ها، رول، موقعیت‌های من) هم زنده
  // می‌خوانندش؛ تغییر اینجا بدون این لایه، بی‌صدا روی همه‌شان اثر می‌گذاشت.
  const overrides = {};
  const s = () => ({ ...state.settings, ...overrides });
  let rows = [];
  let picked = null;
  let view = 'خلاصه';
  let busy = false;
  let hasScanned = false;
  const NOT_SCANNED_MSG = 'هنوز اسکن نزدی — نماد را انتخاب کن و دکمه اسکن را بزن.';
  let qty = s().qtyDefault;
  // آخرین اسکن دومرحله‌ای تمام‌شده — پایه مقایسه برای نشان «تغییر کرد»ی
  // اسکن پیوسته بعدی. اولین اسکن هر نشست null می‌ماند، پس چیزی فلش نمی‌زند.
  let lastFullRows = null;
  let flashTimer = null;

  root.innerHTML = `
    <div class="page-head">
      <h2>${def.name}</h2>
      <p>${def.feasible
        ? `${def.dir}${def.note ? ' — ' + def.note : ''}`
        : `<span class="tag warn">اجرا در تابلو ممکن نیست</span> ${def.infeasibleWhy}`}</p>
    </div>

    <div class="split">
      <section class="card">
        <h3>نماد پایه</h3>
        <p class="note">انتخابی، نه تایپی. جست‌وجو فقط فهرست را کوتاه می‌کند.</p>
        <div id="pick"></div>
      </section>

      <section class="card">
        <h3>کنترل اسکن</h3>
        <p class="note">حجم، مبنای قیمت و حالت اجرا مستقیم روی قیمت اجرای هر پا اثر می‌گذارند.</p>
        <div class="grid" id="ctrl"></div>
        <div class="bar" style="margin-top:12px">
          <button class="btn" id="run">اسکن</button>
          <label class="field row" style="margin:0"><input type="checkbox" id="auto"> <label for="auto">اسکن پیوسته</label></label>
          <span class="sp"></span>
          <span id="status" class="picker-sum" role="status" aria-live="polite"></span>
        </div>
        <div class="scan-progress" id="progress" style="display:none"><div class="scan-progress-fill" id="progress-fill"></div></div>
      </section>
    </div>

    <div class="kpis" id="kpis"></div>
    <section class="card">
      <h3>نوار تشخیص</h3>
      <p class="note">ترکیب‌هایی که افتادند، اینجا شمرده می‌شوند. خالی بودن جدول در بازار ایران خطای برنامه نیست، واقعیت نقدشوندگی است.</p>
      <div id="funnel"></div>
    </section>

    <div class="bar" style="margin-bottom:8px">
      <span class="picker-sum">نمای ستون‌ها:</span>
      <div class="chips" id="views"></div>
    </div>
    <div id="table"></div>

    <section class="card" id="detail-card" style="margin-top:16px;display:none">
      <h3 id="detail-title">جزئیات ردیف</h3>
      <div class="detail" id="detail"></div>
      <div id="tm-wrap" style="margin-top:16px"></div>
    </section>`;

  // ——— انتخابگر ———
  const picker = makePicker(root.querySelector('#pick'), {
    onChange: () => { setStatus(); if (auto.checked) run(); },
  });
  if (chainState.list.length) picker.setList(chainState.list);
  const offChain = onChain((cs) => picker.setList(cs.list));

  // ——— کنترل‌ها ———
  const ctrl = root.querySelector('#ctrl');
  const ctrlDefs = [
    ['qty', 'حجم من (قرارداد)', 'num'],
    ['priceBasis', 'مبنای قیمت', 'pick'],
    ['execMode', 'حالت اجرا', 'pick'],
    ['rankBy', 'مبنای رتبه‌بندی', 'pick'],
    ['minDays', 'روز از', 'num'],
    ['maxDays', 'روز تا', 'num'],
    ['comboWindowPct', 'پنجره قیمت اعمال ٪', 'num'],
    ['minReturnPct', 'حداقل بازده دوره ٪', 'num'],
    ['showUnexecutable', 'نمایش غیرقابل اجرا', 'bool'],
  ];
  const { SCHEMA } = await import('/core/settings.mjs');
  for (const [key, label, kind] of ctrlDefs) {
    const f = SCHEMA.find((x) => x.key === key);
    const w = document.createElement('div');
    w.className = kind === 'bool' ? 'field row' : 'field';
    const val = key === 'qty' ? qty : (s()[key] ?? f.def);
    if (kind === 'bool') {
      w.innerHTML = `<input type="checkbox" id="c-${key}" ${val ? 'checked' : ''}><label for="c-${key}">${label}</label>`;
    } else if (kind === 'pick') {
      w.innerHTML = `<label for="c-${key}">${label}</label><select id="c-${key}">${
        f.options.map(([v, t]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    } else {
      w.innerHTML = `<label for="c-${key}">${label}</label><input type="number" id="c-${key}" value="${val}">`;
    }
    ctrl.appendChild(w);
    const node = w.querySelector(`#c-${key}`);
    node.addEventListener('change', () => {
      const v = kind === 'bool' ? node.checked : kind === 'num' ? Number(node.value) : node.value;
      if (key === 'qty') qty = Math.max(1, v);
      else overrides[key] = v;
      if (auto.checked) run(); else setStatus('تنظیم عوض شد — اسکن را بزن.');
    });
  }

  const auto = root.querySelector('#auto');
  const statusEl = root.querySelector('#status');
  const setStatus = (t) => {
    statusEl.textContent = t || (picker.count()
      ? `${fmt.int(picker.count())} نماد انتخاب شده${rows.length ? ` — ${fmt.int(rows.length)} ردیف` : ''}`
      : 'نمادی انتخاب نشده');
  };

  // ——— نماها ———
  const viewsHost = root.querySelector('#views');
  for (const name of Object.keys(VIEWS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.setAttribute('aria-pressed', name === view ? 'true' : 'false');
    b.addEventListener('click', () => {
      view = name;
      for (const x of viewsHost.children) x.setAttribute('aria-pressed', x.textContent === name ? 'true' : 'false');
      buildTable();
    });
    viewsHost.appendChild(b);
  }

  // ——— جدول ———
  let table = null;
  function buildTable() {
    const cols = VIEWS[view].map((k) => COLUMNS.find((c) => c.key === k)).filter(Boolean);
    table = makeTable(root.querySelector('#table'), cols, {
      sortKey: s().rankBy, onPick: showDetail,
      // نما نقطه شروع است، نه قفس: هر ستون دیگری از قرارداد ستونی مشترک را
      // می‌شود اضافه یا کم کرد، و انتخاب هر استراتژی و هر نما جدا می‌ماند.
      all: COLUMNS, storeKey: `${def.id}:${view}`,
    });
    table.set(rows);
    if (!hasScanned) table.setEmptyMessage(NOT_SCANNED_MSG);
  }
  buildTable();

  // ——— شاخص‌های کلیدی ———
  function drawKpis() {
    const ok = rows.filter((r) => Number.isFinite(r.retMonthPct));
    const best = ok[0];
    const med = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : NaN);
    const medMonth = med(ok.map((r) => r.retMonthPct));
    const items = [
      ['ردیف قابل اجرا', fmt.int(rows.filter((r) => r.executable).length), `از ${fmt.int(rows.length)}`, ''],
      ['بهترین بازده ماهانه', best ? `${fmt.pct(best.retMonthPct)}٪` : '—', best?.underlying || '', best ? signTone(best.retMonthPct) : ''],
      ['میانه بازده ماهانه', `${fmt.pct(medMonth)}٪`, '', signTone(medMonth)],
      ['میانه احتمال سود', `${fmt.pct(med(rows.map((r) => r.popPct).filter(Number.isFinite)))}٪`, '', ''],
      ['میانه هزینه اجرا', fmt.money(med(rows.map((r) => r.execCost).filter(Number.isFinite))), `${fmt.int(def.legs.length)} پا`, ''],
      ['زیان نامحدود', fmt.int(rows.filter((r) => r.unlimitedLoss).length), 'ردیف', ''],
      ['عمق کامل', fmt.int(rows.filter((r) => r.quality === 'exact').length), 'ردیف مرحله دو', ''],
      ['بستانکار', fmt.int(rows.filter((r) => r.isCredit).length), 'ردیف', ''],
    ];
    root.querySelector('#kpis').innerHTML = items.map(([k, v, sub, c]) => `
      <div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`).join('');
  }

  // ——— پانل جزئیات ———
  let chart = null;
  let chartRange = null; // بازه زوم/پن چارت، برای نگه داشتن روی رفرش پیوسته همان ردیف
  let compareIds = new Set(); // موقعیت‌های مقایسه‌ای تیک‌خورده، برای همین ردیف انتخاب‌شده
  function showDetail(r) {
    const sameRow = picked && picked.id === r.id;
    if (chart) chartRange = chart.view();
    if (!sameRow) compareIds = new Set();
    picked = r;
    const card = root.querySelector('#detail-card');
    card.style.display = '';
    root.querySelector('#detail-title').textContent = `${r.underlying} — ${r.legsText}`;

    const fees = { buyStock: s().feeBuyStock, sellStock: s().feeSellStock, option: s().feeOption, exercise: s().feeExercise };
    const single = isSingleExpiry(r.__legs);
    const candidates = sameUnderlyingCandidates(rows, r);
    const chartOpt = {
      fees, spot: r.S, width: 720, height: 260,
      sigma: r.sigmaUse, rFree: s().rFree, divYield: s().divYield,
      ...(sameRow && chartRange ? { initRange: chartRange } : {}),
    };
    const an = single
      ? analyzePayoff(r.__legs, r.netCash, { fees })
      : analyzeMixed(r.__legs, r.netCash, { fees, spot: r.S, sigma: r.sigmaUse, rFree: s().rFree, divYield: s().divYield });
    const grid = Array.from({ length: 11 }, (_, i) => {
      const pct = -s().shockPct * 2 + (i * s().shockPct * 4) / 10;
      const S2 = r.S * (1 + pct / 100);
      return { pct, S: S2, pnl: an.at(S2) };
    });

    const legRows = r.legPrices.map((l) => `
      <tr>
        <td>${l.side === 'sell' ? 'فروش' : 'خرید'} ${l.kind === 'underlying' ? 'سهم' : (l.kind === 'call' ? 'کال' : 'پوت')}</td>
        <td class="n">${l.strike ? fmt.money(l.strike) : '—'}</td>
        <td class="n">${fmt.money(l.price)}</td>
        <td class="n">${fmt.money(l.mid)}</td>
        <td class="n">${Number.isFinite(l.spreadPct) ? faNum(l.spreadPct.toFixed(1)) : '—'}</td>
        <td class="n">${Number.isFinite(l.slipPct) ? faNum(l.slipPct.toFixed(2)) : '—'}</td>
        <td class="n">${fmt.int(l.filled)}</td>
        <td class="n">${fmt.int(l.short)}</td>
        <td>${l.source || '—'}</td>
      </tr>`).join('');

    const costRows = r.costRows.map((c) => `
      <tr><td>${c.leg}</td><td class="n">${fmt.money(c.commission)}</td>
      <td class="n">${fmt.money(c.crossing)}</td><td class="n">${fmt.money(c.slippage)}</td></tr>`).join('');

    const limitRows = r.sizeLimits.map((l) => `
      <tr><td>${l.what}</td><td class="n">${fmt.int(l.max)}</td>
      <td>${l.what === r.binding ? '<span class="tag warn">مقیدکننده</span>' : ''}</td></tr>`).join('');

    const scenRows = grid.map((g) => `
      <tr><td class="n">${faNum(g.pct.toFixed(0))}٪</td><td class="n">${fmt.money(g.S)}</td>
      <td class="n" style="color:${g.pnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(g.pnl)}</td></tr>`).join('');

    // تصویر آینده — ریسک و ریوارد بر اساس صدک‌های محتمل قیمت پایه (قلم
    // الف-۱، سؤال ۳). همان مدل لگاریتم-نرمال با روند صفر که popPct هم
    // از آن می‌آید؛ مسیر واقعی قیمت نیست، توزیع آماری است.
    const horizonT = (r.horizonDays ?? r.days) / 365;
    const riskRows = [5, 25, 50, 75, 95].map((pct) => {
      const level = priceQuantile(r.S, pct / 100, horizonT, r.sigmaUse);
      return { pct, level, pnl: Number.isFinite(level) ? an.at(level) : NaN };
    }).filter((x) => Number.isFinite(x.level));
    const riskTableRows = riskRows.map((x) => `
      <tr><td class="n">${faNum(x.pct)}٪</td><td class="n">${fmt.money(x.level)}</td>
      <td class="n" style="color:${x.pnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(x.pnl)}</td></tr>`).join('');

    root.querySelector('#detail').innerHTML = `
      <div>
        <div id="chart"></div>
        <div class="legend">
          ${an.approx ? `<span style="color:var(--warn)">${an.note}</span>` : ''}
          <span>سربه‌سری: ${an.breakevens.map((b) => fmt.money(b)).join(' , ') || '—'}</span>
          <span>بیشترین سود: ${fmt.money(an.maxProfit)}</span>
          <span>بیشترین زیان: <b style="color:${Number.isFinite(an.maxLoss) ? 'inherit' : 'var(--loss)'}">${fmt.money(an.maxLoss)}</b></span>
        </div>
        <div id="cmp-picker"></div>
        <h4 style="margin:14px 0 4px;font-size:12px">قیمت و عمق هر پا</h4>
        <table class="mini">
          <thead><tr><th>پا</th><th>اعمال</th><th>قیمت اجرا</th><th>میانه</th><th>اسپرد ٪</th><th>افت ٪</th><th>پرشده</th><th>کمبود</th><th>منبع</th></tr></thead>
          <tbody>${legRows}</tbody>
        </table>
      </div>
      <div>
        <dl class="kv">
          <dt>جهت نقدی</dt><dd>${r.cashLabel}</dd>
          <dt>نقد خالص</dt><dd>${fmt.money(r.netCash)}</dd>
          <dt>اگر همین حالا ببندی — دفتر سفارش</dt>
          <dd style="color:${r.instantClosePnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.instantClosePnl)}</dd>
          <dt>اگر با آخرین معامله تسویه کنی <span class="unit">مرجع</span></dt>
          <dd style="color:${r.settleLastPnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.settleLastPnl)}</dd>
          <dt>اگر با قیمت پایانی تسویه کنی <span class="unit">مرجع</span></dt>
          <dd style="color:${r.settleClosePnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.settleClosePnl)}</dd>
          <dt>سرمایه درگیر</dt><dd>${fmt.money(r.capital)}</dd>
          <dt>مبنای سرمایه</dt><dd>${r.capitalLabel}</dd>
          <dt>وجه تضمین</dt><dd>${fmt.money(r.margin)}</dd>
          <dt>تضمین شرطی</dt><dd>${fmt.money(r.conditionalMargin)}</dd>
          <dt>پوشش</dt><dd><span class="tag ${coverageInfo(r.coverage).tone}">${coverageInfo(r.coverage).label}</span></dd>
          <dt>سقف زیان</dt><dd><span class="tag ${r.unlimitedLoss ? 'loss' : 'gain'}">${r.unlimitedLoss ? 'نامحدود — ریسک‌دار' : 'محدود'}</span></dd>
          <dt>بازده دوره</dt><dd>${fmt.pct(r.retMaxPct)}٪</dd>
          <dt>بازده ماهانه</dt><dd>${fmt.pct(r.retMonthPct)}٪</dd>
          <dt>احتمال سود</dt><dd>${fmt.pct(r.popPct)}٪</dd>
          <dt>دلتا</dt><dd>${fmt.num(r.delta)}</dd>
          <dt>تتا روزانه</dt><dd>${fmt.money(r.theta)}</dd>
          <dt>تلاطم مبنا</dt><dd>${fmt.num(r.sigmaUse)}</dd>
          <dt>کیفیت داده</dt><dd>${r.qualityLabel}</dd>
        </dl>
        <p class="note" style="margin:10px 0 2px">${r.marginNote}</p>
        ${r.leggingRisk ? `<p class="note" style="color:var(--warn)">ریسک لنگ‌زدن: سفارش ترکیبی در تابلو نیست. اگر پای فروش پر شود و پای خرید نه، وجه تضمین ${fmt.money(r.conditionalMargin)} همان لحظه مطالبه می‌شود${r.leggingUnlimited ? ' و موقعیت باقی‌مانده زیان نامحدود دارد' : ''}.</p>` : ''}

        <h4 style="margin:14px 0 4px;font-size:12px">تفکیک هزینه اجرا — جمع ${fmt.money(r.execCost)}</h4>
        <table class="mini">
          <thead><tr><th>پا</th><th>کارمزد</th><th>عبور از اسپرد</th><th>افت مظنه</th></tr></thead>
          <tbody>${costRows}
            <tr><td>هزینه فرصت وجه تضمین</td><td class="n" colspan="3">${fmt.money(r.costFunding)}</td></tr></tbody>
        </table>

        <h4 style="margin:14px 0 4px;font-size:12px">سقف حجم — مقید به ${r.binding}</h4>
        <table class="mini"><tbody>${limitRows}</tbody></table>

        <h4 style="margin:14px 0 4px;font-size:12px">سناریو در سررسید</h4>
        <table class="mini">
          <thead><tr><th>تغییر پایه</th><th>قیمت پایه</th><th>سود و زیان</th></tr></thead>
          <tbody>${scenRows}</tbody>
        </table>

        ${riskTableRows ? `
        <h4 style="margin:14px 0 4px;font-size:12px">تصویر آینده — ریسک و ریوارد احتمالاتی</h4>
        <p class="note" style="color:var(--warn)">توزیع لگاریتم-نرمال با روند صفر — همان مدلی که «احتمال سود» از آن
          می‌آید. مسیر واقعی قیمت نیست: دامنه نوسان روزانه، توقف نماد، و پرش‌های بازار ایران این مدل را نمی‌بیند.</p>
        <table class="mini">
          <thead><tr><th>احتمال زیر این قیمت ماندن</th><th>قیمت پایه</th><th>سود و زیان</th></tr></thead>
          <tbody>${riskTableRows}</tbody>
        </table>` : ''}
      </div>`;

    // ——— مقایسه با موقعیت‌های دیگر هم‌نماد (قلم الف-۱ بک‌لاگ) ———
    // «مشابه» یعنی فقط هم‌نماد؛ محدودتر کردنش گزینه‌های جالب را پنهان می‌کرد.
    // منحنی مقایسه‌ای فقط از payoffAt می‌آید، نه رسم کامل — روی مقیاس همین
    // نمودار سوار می‌شود، نه نمودار جدا.
    compareIds = new Set([...compareIds].filter((id) => candidates.some((c) => c.id === id)));
    function mountChart() {
      const compare = candidates
        .filter((c) => compareIds.has(c.id))
        .slice(0, MAX_COMPARE)
        .map((c) => ({
          at: payoffAt(c.__legs, c.netCash, { fees, spot: c.S, sigma: c.sigmaUse, rFree: s().rFree, divYield: s().divYield }),
          label: compareLabel(c),
          full: compareFullLabel(c),
        }));
      chart?.destroy();
      chart = mountPayoff(root.querySelector('#chart'), r.__legs, r.netCash, { ...chartOpt, compare });
    }
    function renderCmpPicker() {
      const box = root.querySelector('#cmp-picker');
      if (!candidates.length) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <p class="note" style="margin:10px 0 4px">مقایسه با موقعیت‌های دیگر همین نماد — حداکثر ${fmt.int(MAX_COMPARE)} هم‌زمان</p>
        <div class="cmp-list">
          ${candidates.map((c) => {
            const checked = compareIds.has(c.id);
            const disabled = !checked && compareIds.size >= MAX_COMPARE;
            return `<label class="cmp-row">
              <input type="checkbox" data-id="${c.id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
              <span>${c.strategy ? `${c.strategy} — ` : ''}${c.legsText}</span>
            </label>`;
          }).join('')}
        </div>`;
      box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        cb.addEventListener('change', (e) => {
          if (e.target.checked) compareIds.add(e.target.dataset.id); else compareIds.delete(e.target.dataset.id);
          renderCmpPicker();
          mountChart();
        });
      });
    }
    renderCmpPicker();
    // نمودار بعد از نشستن قالب سوار می‌شود، چون به اندازه واقعی قاب نیاز دارد
    mountChart();

    // ——— ماشین زمان (قلم پ-۴ بک‌لاگ) ———
    const tmWrap = root.querySelector('#tm-wrap');
    tmWrap.innerHTML = `<button class="ghost" type="button" id="tm-btn">ماشین زمان — اگر همین ترکیب را چند روز پیش می‌گرفتم</button>
      <div id="tm-out"></div>`;
    tmWrap.querySelector('#tm-btn').addEventListener('click', (e) => runTimeMachine(r, tmWrap.querySelector('#tm-out'), e.currentTarget));
  }

  async function runTimeMachine(r, out, btn) {
    if (!r.uaIns) { out.innerHTML = '<p class="note">نماد پایه این ردیف شناخته نشد.</p>'; return; }
    if (!(r.sigmaUse > 0)) { out.innerHTML = '<p class="note">تلاطم مبنا نامعتبر است؛ شبیه‌سازی ممکن نیست.</p>'; return; }
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'در حال محاسبه…';
    out.innerHTML = '<p class="note">در حال دریافت تاریخچه قیمت پایه…</p>';
    try {
      let res;
      try {
        res = await (await fetch(`/api/daily?ins=${r.uaIns}&n=${s().volDays}`)).json();
      } catch (e) {
        out.innerHTML = `<p class="note" style="color:var(--loss)">دریافت تاریخچه ناموفق: ${e.message}</p>`;
        return;
      }
      if (res.error) {
        out.innerHTML = `<p class="note" style="color:var(--loss)">دریافت تاریخچه ناموفق: ${res.error}</p>`;
        return;
      }
      const closes = (res.rows || []).filter((x) => x.close > 0);
      if (closes.length < 2) { out.innerHTML = '<p class="note">تاریخچه کافی برای این نماد نیست.</p>'; return; }

      const tm = timeMachine(r.__legs, closes, {
        daysToday: r.days, sigma: r.sigmaUse, rFree: s().rFree, divYield: s().divYield,
      });
      const rows2 = tm.map((x) => `
        <tr><td>${jalaliFromDEven(x.date)}</td><td class="n">${fmt.money(x.S)}</td>
          <td class="n">${fmt.int(x.daysLeft)}</td>
          <td class="n" style="color:${x.pnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(x.pnl)}</td></tr>`).join('');
      out.innerHTML = `
        <p class="note" style="color:var(--warn)">شبیه‌سازی بلک-شولز با تلاطم امروز (${fmt.num(r.sigmaUse)})
          روی قیمت پایانی تاریخی پایه — نه قیمت واقعی اختیار در آن روز. دیده‌بان تاریخچه مظنه ذخیره نمی‌کند،
          پس این عدد راهنماست، ادعای اجرا ندارد.</p>
        <table class="mini">
          <thead><tr><th>تاریخ</th><th>قیمت پایه آن‌روز</th><th>روز تا سررسید آن‌روز</th><th>سود/زیان شبیه‌سازی‌شده</th></tr></thead>
          <tbody>${rows2}</tbody>
        </table>`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ——— اجرای اسکن ———
  let timer = null;
  const runBtn = root.querySelector('#run');
  const progressWrap = root.querySelector('#progress');
  const progressFill = root.querySelector('#progress-fill');
  const setProgress = (pct) => {
    if (pct == null) { progressWrap.style.display = 'none'; return; }
    progressWrap.style.display = '';
    progressFill.style.width = `${pct}%`;
  };
  async function run() {
    if (busy) return;
    const keys = picker.selected();
    if (!keys.length) { setStatus('نمادی انتخاب نشده'); return; }
    busy = true;
    runBtn.disabled = true;
    runBtn.textContent = 'در حال اسکن…';
    setStatus('مرحله یک — غربال روی سطح اول…');
    setProgress(5);
    if (!hasScanned) { hasScanned = true; table.setEmptyMessage(null); }
    table.setLoading(true);
    try {
      await runScan({
        defId: def.id, uaKeys: keys, settings: s(), qty,
        onStage: (stage, res) => {
          if (res.error) { setStatus(`خطا: ${res.error}`); setProgress(null); table.setLoading(false); return; }
          if (stage === 'one') {
            rows = res.rows;
            funnelBar(root.querySelector('#funnel'), res.funnel);
            table.set(rows);
            drawKpis();
            setStatus(`مرحله یک در ${fmt.int(res.ms)} میلی‌ثانیه — ${fmt.int(res.total)} ردیف، ${fmt.int(rows.length)} نمایش. مرحله دو…`);
            setProgress(50);
          } else {
            const byId2 = new Map(res.rows.map((r) => [r.id, r]));
            rows = rows.map((r) => byId2.get(r.id) || r);
            // اسکن پیوسته: ردیفی که مبنای رتبه‌بندی‌اش نسبت به آخرین اسکن
            // تمام‌شده عوض شده، فلش می‌گیرد — همان قرارداد نیمه‌کاره
            // rowClass در table.mjs، حالا با چیزی که واقعاً می‌نویسدش.
            const changed = changedIds(lastFullRows, rows, s().rankBy);
            for (const r of rows) r.__flash = changed.has(r.id);
            // افت مظنه رتبه‌ها را زیر و رو می‌کند، پس دوباره مرتب می‌شود
            table.set(rows);
            table.sortBy(s().rankBy);
            drawKpis();
            if (picked) { const f = byId2.get(picked.id); if (f) showDetail(f); }
            setStatus(`مرحله دو کامل — عمق ${fmt.int(res.asked || 0)} نماد گرفته شد. ${fmt.int(rows.length)} ردیف.`);
            setProgress(100);
            lastFullRows = rows;
            clearTimeout(flashTimer);
            if (changed.size) {
              // rows را جدا می‌گیریم، نه از بستار — اگر تیک بعدی زودتر از
              // ۱۷۰۰ میلی‌ثانیه برسد، rows بیرونی عوض شده ولی این آرایه
              // همان فهرستی می‌ماند که واقعاً فلش گرفت.
              const flashedRows = rows;
              flashTimer = setTimeout(() => {
                for (const r of flashedRows) r.__flash = false;
                table.redraw();
              }, 1700);
            }
          }
        },
      });
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.textContent = 'اسکن';
      if (progressWrap.style.display !== 'none') setProgress(100);
      setTimeout(() => setProgress(null), 400);
    }
  }

  runBtn.addEventListener('click', run);
  auto.addEventListener('change', () => {
    clearInterval(timer);
    if (auto.checked) { run(); timer = setInterval(run, Math.max(10, s().watchIntervalSec * 3) * 1000); }
  });

  // اشتراک عکس لحظه‌ای فقط تا وقتی این تب باز است
  const offWatch = api.subscribeWatch((w) => {
    pushRows(w, !w.changed);
  });

  setStatus();
  return () => { offWatch(); offChain(); clearInterval(timer); clearTimeout(flashTimer); chart?.destroy(); };
}
