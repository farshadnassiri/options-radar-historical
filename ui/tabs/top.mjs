// تب برترین موقعیت‌ها — فاز ۷ (قلم الف-۳ بک‌لاگ).
//
// هر تب استراتژی فقط خودش را می‌بیند. این تب همه کاتالوگ را یک‌جا غربال
// می‌کند و رتبه‌بندی مشترک (همان s.rankBy که هر تب تنها روی خودش می‌زند)
// را روی کل نتیجه اعمال می‌کند — یک نگاه، نه سی‌ویک تب جدا.
//
// فقط مرحله یک است، بدون عمق دفتر سفارش: عمق برای سی‌ویک استراتژی یک‌جا
// یعنی سی‌ویک درخواست دفتر سفارش پیاپی، هزینه‌ای که یک نمای کلی اولیه
// توجیه نمی‌کند. برای عدد اجرایی، همان ردیف را در تب خودش دوباره اسکن کن.

import { COLUMNS } from '/core/evaluate.mjs';
import { analyzePayoff } from '/core/payoff.mjs';
import { analyzeMixed, isSingleExpiry } from '/core/mixed.mjs';
import { makeTable, funnelBar, changedIds } from '/ui/table.mjs';
import { fmt, coverageInfo, signTone } from '/ui/fmt.mjs';
import { makePicker } from '/ui/picker.mjs';
import { mountPayoff, payoffAt } from '/ui/chart.mjs';
import { sameUnderlyingCandidates, compareLabel, compareFullLabel, MAX_COMPARE } from '/ui/compare.mjs';
import { runScanAll, onChain, pushRows, chainState } from '/ui/scanner.mjs';

const DEFAULT_COLS = ['strategy', 'underlying', 'legsText', 'days', 'netCash', 'capital',
  'retMaxPct', 'retMonthPct', 'popPct', 'maxProfit', 'maxLoss', 'warn'];

export async function mount(root, { state, api }) {
  const s = () => state.settings;
  let rows = [];
  let picked = null;
  let busy = false;
  let hasScanned = false;
  const NOT_SCANNED_MSG = 'هنوز اسکن نزدی — نماد را انتخاب کن و دکمه اسکن را بزن.';
  // آخرین اسکن تمام‌شده — پایه مقایسه برای نشان «تغییر کرد»ی اسکن پیوسته بعدی
  let lastFullRows = null;
  let flashTimer = null;

  root.innerHTML = `
    <div class="page-head">
      <h2>برترین موقعیت‌ها</h2>
      <p>غربال روی کل کاتالوگ، رتبه‌بندی‌شده با همان معیار مشترک هر تب استراتژی. فقط مرحله یک —
         تقریبی، بدون عمق دفتر سفارش. برای عدد اجرایی، همان ردیف را در تب خودش دوباره اسکن کن.</p>
    </div>

    <div class="split">
      <section class="card">
        <h3>نماد پایه</h3>
        <p class="note">انتخابی، نه تایپی. همین انتخاب در همه تب‌های استراتژی هم به کار می‌رود.</p>
        <div id="pick"></div>
      </section>
      <section class="card">
        <h3>کنترل اسکن</h3>
        <p class="note">مبنای رتبه‌بندی از تنظیمات می‌آید — همان معیاری که هر تب استراتژی تنها روی خودش می‌زند.</p>
        <div class="bar" style="margin-top:12px">
          <button class="btn" id="run">اسکن</button>
          <label class="field row" style="margin:0"><input type="checkbox" id="auto"> <label for="auto">اسکن پیوسته</label></label>
          <span class="sp"></span>
          <span id="status" class="picker-sum" role="status" aria-live="polite"></span>
        </div>
      </section>
    </div>

    <div class="kpis" id="kpis"></div>
    <section class="card">
      <h3>نوار تشخیص</h3>
      <p class="note">جمع روی همه استراتژی‌های شدنی.</p>
      <div id="funnel"></div>
    </section>

    <div id="table"></div>

    <section class="card" id="detail-card" style="margin-top:16px;display:none">
      <h3 id="detail-title">جزئیات ردیف</h3>
      <div class="detail" id="detail"></div>
    </section>`;

  const picker = makePicker(root.querySelector('#pick'), {
    onChange: () => { setStatus(); if (auto.checked) run(); },
  });
  if (chainState.list.length) picker.setList(chainState.list);
  const offChain = onChain((cs) => picker.setList(cs.list));

  const auto = root.querySelector('#auto');
  const setStatus = (t) => { root.querySelector('#status').textContent = t || ''; };

  const cols = DEFAULT_COLS.map((k) => COLUMNS.find((c) => c.key === k)).filter(Boolean);
  const table = makeTable(root.querySelector('#table'), cols, {
    sortKey: s().rankBy, onPick: showDetail,
    all: COLUMNS, storeKey: 'top:default',
  });
  table.setEmptyMessage(NOT_SCANNED_MSG);

  function drawKpis() {
    const ok = rows.filter((r) => Number.isFinite(r.retMonthPct));
    const best = ok[0];
    const items = [
      ['ردیف برتر', fmt.int(rows.length), '', ''],
      ['استراتژی‌های حاضر', fmt.int(new Set(rows.map((r) => r.strategyId)).size), 'از کل کاتالوگ', ''],
      ['بهترین بازده ماهانه', best ? `${fmt.pct(best.retMonthPct)}٪` : '—', best ? `${best.strategy} — ${best.underlying}` : '', best ? signTone(best.retMonthPct) : ''],
      ['زیان نامحدود', fmt.int(rows.filter((r) => r.unlimitedLoss).length), 'ردیف — ریسک‌دار', ''],
    ];
    root.querySelector('#kpis').innerHTML = items.map(([k, v, sub, c]) => `
      <div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`).join('');
  }

  // ——— پانل جزئیات — همان الگوی تب استراتژی، فقط بدون کنترل اسکن جداگانه ———
  let chart = null;
  let chartRange = null;
  let compareIds = new Set();
  function showDetail(r) {
    const sameRow = picked && picked.id === r.id;
    if (chart) chartRange = chart.view();
    if (!sameRow) compareIds = new Set();
    picked = r;
    const card = root.querySelector('#detail-card');
    card.style.display = '';
    root.querySelector('#detail-title').textContent = `${r.strategy} — ${r.underlying} — ${r.legsText}`;

    const fees = { buyStock: s().feeBuyStock, sellStock: s().feeSellStock, option: s().feeOption, exercise: s().feeExercise };
    const single = isSingleExpiry(r.__legs);
    const candidates = sameUnderlyingCandidates(rows, r);
    compareIds = new Set([...compareIds].filter((id) => candidates.some((c) => c.id === id)));
    const chartOpt = {
      fees, spot: r.S, width: 720, height: 260,
      sigma: r.sigmaUse, rFree: s().rFree, divYield: s().divYield,
      ...(sameRow && chartRange ? { initRange: chartRange } : {}),
    };
    const an = single
      ? analyzePayoff(r.__legs, r.netCash, { fees })
      : analyzeMixed(r.__legs, r.netCash, { fees, spot: r.S, sigma: r.sigmaUse, rFree: s().rFree, divYield: s().divYield });

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
      </div>
      <div>
        <dl class="kv">
          <dt>استراتژی</dt><dd>${r.strategy}</dd>
          <dt>جهت نقدی</dt><dd>${r.cashLabel}</dd>
          <dt>نقد خالص</dt><dd>${fmt.money(r.netCash)}</dd>
          <dt>اگر همین حالا ببندی — دفتر سفارش</dt>
          <dd style="color:${r.instantClosePnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.instantClosePnl)}</dd>
          <dt>اگر با آخرین معامله تسویه کنی <span class="unit">مرجع</span></dt>
          <dd style="color:${r.settleLastPnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.settleLastPnl)}</dd>
          <dt>اگر با قیمت پایانی تسویه کنی <span class="unit">مرجع</span></dt>
          <dd style="color:${r.settleClosePnl >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(r.settleClosePnl)}</dd>
          <dt>سرمایه درگیر</dt><dd>${fmt.money(r.capital)}</dd>
          <dt>وجه تضمین</dt><dd>${fmt.money(r.margin)}</dd>
          <dt>پوشش</dt><dd><span class="tag ${coverageInfo(r.coverage).tone}">${coverageInfo(r.coverage).label}</span></dd>
          <dt>سقف زیان</dt><dd><span class="tag ${r.unlimitedLoss ? 'loss' : 'gain'}">${r.unlimitedLoss ? 'نامحدود — ریسک‌دار' : 'محدود'}</span></dd>
          <dt>بازده دوره</dt><dd>${fmt.pct(r.retMaxPct)}٪</dd>
          <dt>بازده ماهانه</dt><dd>${fmt.pct(r.retMonthPct)}٪</dd>
          <dt>احتمال سود</dt><dd>${fmt.pct(r.popPct)}٪</dd>
          <dt>کیفیت داده</dt><dd>${r.qualityLabel}</dd>
        </dl>
        <p class="note" style="margin-top:10px">این ردیف فقط مرحله یک است. برای عمق دفتر سفارش و عدد اجرایی،
          تب «${r.strategy}» را باز کن و دوباره اسکن بزن.</p>
      </div>`;

    // ——— مقایسه با موقعیت‌های دیگر هم‌نماد (قلم الف-۱ بک‌لاگ) ———
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
    mountChart();
  }

  // ——— اجرا ———
  const runBtn = root.querySelector('#run');
  async function run() {
    if (busy) return;
    const keys = picker.selected();
    if (!keys.length) { setStatus('نمادی انتخاب نشده'); return; }
    busy = true;
    runBtn.disabled = true;
    runBtn.textContent = 'در حال اسکن…';
    setStatus('در حال غربال کل کاتالوگ…');
    if (!hasScanned) { hasScanned = true; table.setEmptyMessage(null); }
    table.setLoading(true);
    try {
      const res = await runScanAll({ uaKeys: keys, settings: s(), qty: s().qtyDefault, limit: s().topN });
      if (res.error) { setStatus(`خطا: ${res.error}`); table.setLoading(false); return; }
      rows = res.rows;
      // اسکن پیوسته: ردیفی که مبنای رتبه‌بندی‌اش نسبت به آخرین اسکن
      // تمام‌شده عوض شده، فلش می‌گیرد.
      const changed = changedIds(lastFullRows, rows, s().rankBy);
      for (const r of rows) r.__flash = changed.has(r.id);
      funnelBar(root.querySelector('#funnel'), res.funnel);
      table.set(rows);
      drawKpis();
      setStatus(`${fmt.int(res.ms)} میلی‌ثانیه — از ${fmt.int(res.total)} ردیف کل، ${fmt.int(rows.length)} نمایش.`);
      lastFullRows = rows;
      clearTimeout(flashTimer);
      if (changed.size) {
        const flashedRows = rows;
        flashTimer = setTimeout(() => {
          for (const r of flashedRows) r.__flash = false;
          table.redraw();
        }, 1700);
      }
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.textContent = 'اسکن';
    }
  }

  runBtn.addEventListener('click', run);
  let timer = null;
  auto.addEventListener('change', () => {
    clearInterval(timer);
    if (auto.checked) { run(); timer = setInterval(run, Math.max(10, s().watchIntervalSec * 3) * 1000); }
  });

  const offWatch = api.subscribeWatch((w) => pushRows(w, !w.changed));
  setStatus();
  return () => { offWatch(); offChain(); clearInterval(timer); clearTimeout(flashTimer); chart?.destroy(); };
}
