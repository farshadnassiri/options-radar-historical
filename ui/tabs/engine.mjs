// تب موتور — کاوشگر بازده.
//
// این تب پیش از وصل شدن به بازار، ثابت می‌کند موتور مشترک کار می‌کند: هر
// استراتژی از فهرست را انتخاب کن، قیمت‌ها را دستی بگذار، و همان چیزی را
// ببین که تب‌های واقعی از فاز سه به بعد نشان می‌دهند.
//
// نمودار از نقاط شکست دقیق کشیده می‌شود، نه از نمونه‌برداری. جدول زیر آن،
// ضریب خطی هر بازه را نشان می‌دهد؛ همان چیزی که سربه‌سری و بیشترین سود از
// آن بیرون می‌آید.

import { fmt, faNum, faDigits, signTone } from '/ui/fmt.mjs';
import { CATALOG, byId, buildLegs } from '/strategies/catalog.mjs';
import { grossCash, entryFees, analyzePayoff, chartPoints } from '/core/payoff.mjs';
import { mountPayoff } from '/ui/chart.mjs';
import { evaluate, profitRegions } from '/core/evaluate.mjs';

export async function mount(root, { state }) {
  const S0 = 100000;
  const size = 1000;
  let defId = 'covered-call';
  let spot = S0;
  let days = 30;

  root.innerHTML = `
    <div class="page-head">
      <h2>موتور و نمودار بازده</h2>
      <p>هیچ استراتژی محاسبه‌گر جدا ندارد. همه از یک موتور عبور می‌کنند و همین‌جا قابل بازرسی‌اند.
         قیمت‌ها را دستی بگذار تا رفتار موتور را ببینی؛ از فاز سه، همین قیمت‌ها از دفتر سفارش می‌آید.</p>
    </div>

    <div class="card">
      <h3>استراتژی</h3>
      <p class="note">۳۱ الگو در فهرست است. الگوهایی که به فروش سهم نیاز دارند برچسب دارند و انتخاب‌شان بازده را نشان می‌دهد ولی در تابلو اجرا نمی‌شوند.</p>
      <div class="chips" id="picker"></div>
    </div>

    <div class="card">
      <h3>ورودی‌ها</h3>
      <div class="grid" id="inputs"></div>
    </div>

    <div class="kpis" id="kpis"></div>

    <div class="card">
      <h3 id="chart-title">بازده در سررسید</h3>
      <p class="note" id="chart-note"></p>
      <div id="chart"></div>
      <div class="legend">
        <span>خط پیوسته: سود و زیان در سررسید</span>
        <span>خط‌چین بنفش: قیمت اعمال</span>
        <span>دایره: سربه‌سری</span>
        <span>خط نارنجی: قیمت پایه فعلی</span>
      </div>
    </div>

    <div class="card">
      <h3>دفتر بازه‌ها</h3>
      <p class="note">روی هر بازه، سود و زیان دقیقاً a×S + b است. سربه‌سری ریشه همین خط است، پس عدد دقیق است نه تقریبی.</p>
      <div class="scroll"><table class="data" id="segs"></table></div>
    </div>

    <div class="card">
      <h3>ردیف کامل، همان‌طور که در جدول تب‌ها می‌آید</h3>
      <p class="note">قرارداد ستونی مشترک: هر تب، هر استراتژی، همین ستون‌ها. اسم و معنی و واحد در همه‌جا یکی است.</p>
      <div class="scroll" style="max-height:none"><table class="data" id="row"></table></div>
    </div>`;

  // ——— انتخابگر استراتژی ———
  const picker = root.querySelector('#picker');
  for (const d of CATALOG) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = d.feasible ? d.name : `${d.name} ⃰`;
    b.title = d.feasible ? (d.note || d.dir) : d.infeasibleWhy;
    b.addEventListener('click', () => { defId = d.id; render(true); });
    picker.appendChild(b);
  }

  const inputsHost = root.querySelector('#inputs');
  let priceState = {};

  function inputsFor(def) {
    // قیمت اعمال پیشنهادی، حول قیمت پایه
    const step = Math.round(spot * 0.1 / 1000) * 1000 || 1000;
    const base = Math.round((spot - ((def.strikes - 1) / 2) * step) / 1000) * 1000;
    const strikes = Array.from({ length: def.strikes }, (_, i) => base + i * step);
    return strikes;
  }

  let strikes = inputsFor(byId(defId));

  function buildInputs(def) {
    strikes = strikes.length === def.strikes ? strikes : inputsFor(def);
    const legs = buildLegs(def, { strikes, size, days: [days, days * 2] });

    inputsHost.innerHTML = '';
    const add = (label, value, onChange, hint = '') => {
      const w = document.createElement('div');
      w.className = 'field';
      w.innerHTML = `<label>${label}</label><input type="number" value="${value}">${hint ? `<span class="hint">${hint}</span>` : ''}`;
      w.querySelector('input').addEventListener('change', (e) => { onChange(Number(e.target.value)); render(false); });
      inputsHost.appendChild(w);
    };

    add('قیمت پایه', spot, (v) => { spot = v; strikes = inputsFor(def); }, 'مبنای وجه تضمین و یونانی‌ها');
    add('روز تا سررسید', days, (v) => { days = Math.max(1, v); });

    strikes.forEach((k, i) => add(`قیمت اعمال ${faDigits(i + 1)}`, k, (v) => { strikes[i] = v; strikes.sort((a, b) => a - b); }));

    for (const l of legs) {
      const key = l.key;
      if (priceState[key] == null) {
        // قیمت شروع منطقی: ارزش ذاتی به‌علاوه کمی ارزش زمانی
        priceState[key] = l.kind === 'underlying' ? spot
          : Math.round(Math.max(spot * 0.02,
              (l.kind === 'call' ? Math.max(0, spot - l.strike) : Math.max(0, l.strike - spot)) + spot * 0.02));
      }
      const name = l.kind === 'underlying' ? 'سهم پایه'
        : `${l.kind === 'call' ? 'کال' : 'پوت'} ${fmt.int(l.strike)}${l.exp ? ' — سررسید دور' : ''}`;
      add(`قیمت ${name} (${l.side === 'sell' ? 'فروش' : 'خرید'})`, priceState[key], (v) => { priceState[key] = v; });
    }
    return legs;
  }

  // ——— نمودار ———
  // نمودار همان مؤلفه مشترک تب‌های دیگر است، پس زوم و خط راهنما را رایگان
  // می‌گیرد و یک نسخه دوم از منطق رسم نگه داشته نمی‌شود.
  let chart = null;
  function drawChart(legs, net, fees, spotPx) {
    chart?.destroy();
    chart = mountPayoff(root.querySelector('#chart'), legs, net, {
      fees, spot: spotPx, width: 900, height: 320, padPct: 0.4,
      sigma: 0.6, rFree: state.settings.rFree, divYield: state.settings.divYield,
    });
  }

  // ——— جدول‌ها ———
  function drawSegments(an) {
    const rows = an.segments.map((g, i) => `
      <tr>
        <td class="n">${faDigits(i + 1)}</td>
        <td class="n">${fmt.money(g.lo)}</td>
        <td class="n">${Number.isFinite(g.hi) ? fmt.money(g.hi) : '∞'}</td>
        <td class="n">${faNum(g.a.toFixed(2))}</td>
        <td class="n">${fmt.money(g.b)}</td>
        <td class="n">${fmt.money(g.a * g.lo + g.b)}</td>
        <td class="n">${faNum(g.sharesAfter.toFixed(0))}</td>
        <td>${Math.abs(g.a) < 1e-9 ? '<span class="tag flat">صاف</span>'
          : g.a > 0 ? '<span class="tag gain">صعودی</span>' : '<span class="tag loss">نزولی</span>'}</td>
      </tr>`).join('');
    root.querySelector('#segs').innerHTML = `
      <thead><tr>
        <th>بازه</th><th>از قیمت</th><th>تا قیمت</th><th>شیب a</th><th>عرض از مبدأ b</th>
        <th>سود در ابتدای بازه</th><th>سهم پس از تسویه</th><th>جهت</th>
      </tr></thead><tbody>${rows}</tbody>`;
  }

  function drawRow(row) {
    const groupsOrder = ['هویت', 'جریان نقد', 'سود و زیان', 'سرمایه', 'بازده', 'احتمال', 'یونانی', 'اجرا', 'سلامت'];
    const cells = {
      'هویت': [['استراتژی', row.strategy], ['پاها', faDigits(row.legsText)], ['روز', fmt.int(row.days)],
        ['قیمت پایه', fmt.money(row.S)], ['مبنای قیمت', row.priceBasis], ['حالت اجرا', row.execMode]],
      'جریان نقد': [['جهت', row.cashLabel], ['نقد ناخالص', fmt.money(row.grossCash)],
        ['کارمزد ورود', fmt.money(row.entryFee)], ['نقد خالص', fmt.money(row.netCash)],
        ['بستن فوری — دفتر سفارش', fmt.money(row.instantClosePnl)],
        ['اگر با آخرین معامله تسویه', fmt.money(row.settleLastPnl)],
        ['اگر با قیمت پایانی تسویه', fmt.money(row.settleClosePnl)]],
      'سود و زیان': [['سربه‌سری', row.breakevens.map((b) => fmt.money(b)).join('  ,  ') || '—'],
        ['بیشترین سود', fmt.money(row.maxProfit)], ['بیشترین زیان', fmt.money(row.maxLoss)],
        ['سود اگر پایه ثابت بماند', fmt.money(row.staticPnl)]],
      'سرمایه': [['سرمایه درگیر', fmt.money(row.capital)], ['مبنای سرمایه', row.capitalLabel],
        ['وجه تضمین', fmt.money(row.margin)], ['تضمین به زیان', fmt.num(row.marginToMaxLoss)],
        ['تضمین شرطی', fmt.money(row.conditionalMargin)], ['پوشش', row.coverage],
        ['یادداشت تضمین', row.marginNote]],
      'بازده': [['بازده دوره ٪', fmt.pct(row.retMaxPct)], ['بازده ایستا ٪', fmt.pct(row.retStaticPct)],
        ['بازده ماهانه ٪', fmt.pct(row.retMonthPct)], ['بازده سالانه ٪', fmt.pct(row.retAnnPct)],
        ['سالانه مرکب ٪', fmt.pct(row.retAnnCompPct)]],
      'احتمال': [['احتمال سود ٪', fmt.pct(row.popPct)], ['تلاطم مبنا', fmt.num(row.sigmaUse)]],
      'یونانی': [['دلتا', fmt.num(row.delta)], ['گاما', fmt.num(row.gamma)], ['وگا', fmt.money(row.vega)],
        ['تتا روزانه', fmt.money(row.theta)], ['تتا به سرمایه ٪', fmt.pct(row.thetaToCapitalPct)]],
      'اجرا': [['هزینه اجرا', fmt.money(row.execCost)], ['کارمزد', fmt.money(row.costCommission)],
        ['عبور از اسپرد', fmt.money(row.costCrossing)], ['افت مظنه', fmt.money(row.costSlippage)],
        ['هزینه فرصت تضمین', fmt.money(row.costFunding)], ['سقف قرارداد', fmt.int(row.maxQty)],
        ['قید مقیدکننده', row.binding], ['ریسک لنگ‌زدن', row.leggingRisk ? 'دارد' : 'ندارد']],
      'سلامت': [['کیفیت داده', row.qualityLabel],
        ['هشدار', row.warn.length ? row.warn.join('  ,  ') : 'بی‌هشدار']],
    };
    let html = '<tbody>';
    for (const g of groupsOrder) {
      html += `<tr><th colspan="2" style="background:var(--panel-2);color:var(--accent)">${g}</th></tr>`;
      for (const [k, v] of cells[g]) {
        const isNum = typeof v === 'string' && /^[\d,.\-∞ ]+$/.test(v);
        html += `<tr><td style="color:var(--muted)">${k}</td><td class="${isNum ? 'n' : ''}">${v}</td></tr>`;
      }
    }
    root.querySelector('#row').innerHTML = html + '</tbody>';
  }

  function drawKpis(row, an) {
    const items = [
      ['نقد خالص', fmt.money(row.netCash), row.isCredit ? 'بستانکار' : 'بدهکار', row.isCredit ? 'gain' : 'loss'],
      ['بیشترین سود', fmt.money(row.maxProfit), row.unlimitedProfit ? 'نامحدود' : 'محدود', 'gain'],
      ['بیشترین زیان', fmt.money(row.maxLoss), row.unlimitedLoss ? 'نامحدود' : 'محدود', 'loss'],
      ['سرمایه درگیر', fmt.money(row.capital), row.capitalLabel, ''],
      ['بازده دوره', `${fmt.pct(row.retMaxPct)}٪`, `${faDigits(row.days)} روز`, signTone(row.retMaxPct)],
      ['احتمال سود', `${fmt.pct(row.popPct)}٪`, 'لگاریتم-نرمال، بدون دامنه', ''],
      ['هزینه اجرا', fmt.money(row.execCost), `${faDigits(row.legCount)} پا`, 'loss'],
      ['وجه تضمین', fmt.money(row.margin), row.isCredit ? 'بستانکار' : 'بدهکار — صفر', ''],
    ];
    root.querySelector('#kpis').innerHTML = items.map(([k, v, s, c]) => `
      <div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`).join('');
  }

  // ——— رندر ———
  function render(rebuild) {
    const def = byId(defId);
    for (const b of picker.children) b.setAttribute('aria-pressed', b.textContent.startsWith(def.name) ? 'true' : 'false');
    if (rebuild) priceState = {};
    const legs = buildInputs(def);
    for (const l of legs) l.price = priceState[l.key] ?? 0;

    const s = state.settings;
    const fees = { buyStock: s.feeBuyStock, sellStock: s.feeSellStock, option: s.feeOption, exercise: s.feeExercise };
    const net = grossCash(legs) - entryFees(legs, fees);
    const { points, analysis } = chartPoints(legs, net, { fees, padPct: 0.4 });

    // مظنه مصنوعی از قیمت دستی، تا ارزیاب همان مسیر واقعی را طی کند
    const quotes = legs.map((l) => {
      const p = l.price;
      const half = Math.max(1, p * 0.02);
      return {
        bid: p - half, bidQty: 1e9, ask: p + half, askQty: 1e9,
        last: p, close: p, low: p * 0.9, high: p * 1.1, state: 'A', staleSec: 0,
        book: [{ level: 1, bid: p - half, bidQty: 1e9, ask: p + half, askQty: 1e9 }],
      };
    });

    const row = evaluate({
      legs: legs.map((l) => ({ ...l, price: undefined })), quotes,
      ctx: { S: spot, Sclose: spot, days, size, qty: 1, settings: s, def, underlying: 'ورودی دستی', sigmaHist: 0.6 },
    });

    root.querySelector('#chart-note').textContent = def.feasible
      ? `${def.dir} — ${def.note || 'بدون یادداشت'}`
      : `اجرا در تابلو ممکن نیست: ${def.infeasibleWhy}`;
    const reg = profitRegions(analysis);
    root.querySelector('#chart-title').textContent =
      `بازده در سررسید — ${faDigits(reg.length)} بازه سود، ${faDigits(analysis.breakevens.length)} نقطه سربه‌سری`;

    drawKpis(row, analysis);
    drawChart(legs, net, fees, spot);
    drawSegments(analysis);
    drawRow(row);
  }

  render(true);
  return () => { chart?.destroy(); };
}
