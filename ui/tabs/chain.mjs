// تب دیده‌بان زنجیره اختیار — فاز ۳.
//
// این تب هیچ ترکیبی نمی‌سازد. کار دیگری می‌کند: نشان می‌دهد داده خام چه شکلی
// است، کدام نماد و کدام سررسید واقعاً مظنه دارد، و کجای بازار قابل کار است.
// بدون این تب، خالی بودن تب‌های چندپا گیج‌کننده می‌شود.

import { faNum, faDigits, faAgo } from '/ui/fmt.mjs';
import { makeTable, fmt } from '/ui/table.mjs';
import { makePicker } from '/ui/picker.mjs';
import { onChain, chainState, pushRows, chainDetail } from '/ui/scanner.mjs';

const COLS = [
  { key: 'name', label: 'نماد پایه', fmt: 'text' },
  { key: 'last', label: 'آخرین', fmt: 'money' },
  { key: 'contracts', label: 'قرارداد', fmt: 'int' },
  { key: 'quoted', label: 'دارای مظنه', fmt: 'int', heat: 'prob' },
  { key: 'quotedPct', label: 'نسبت مظنه ٪', fmt: 'pct', heat: 'prob' },
  { key: 'expiries', label: 'سررسید', fmt: 'int' },
  { key: 'nearestDays', label: 'نزدیک‌ترین سررسید', fmt: 'int' },
  { key: 'volume', label: 'حجم اختیار', fmt: 'int', heat: 'gain' },
  { key: 'oi', label: 'موقعیت باز', fmt: 'int', heat: 'gain' },
  { key: 'pcRatio', label: 'نسبت پوت به کال', fmt: 'num' },
  { key: 'atmIvPct', label: 'تلاطم ضمنی ٪ — نزدیک‌ترین پول', fmt: 'pct' },
];

export async function mount(root, { state, api }) {
  root.innerHTML = `
    <div class="page-head">
      <h2>دیده‌بان زنجیره اختیار</h2>
      <p>یک درخواست، کل بازار اختیار. همه تب‌های استراتژی از همین عکس لحظه‌ای تغذیه می‌شوند و
         مرحله یک غربال هیچ درخواست اضافه‌ای نمی‌خورد.</p>
    </div>

    <div class="kpis" id="kpis"></div>

    <div class="split">
      <section class="card">
        <h3>نمادهای منتخب من</h3>
        <p class="note">همین انتخاب در همه تب‌های استراتژی هم به کار می‌رود.</p>
        <div id="pick"></div>
      </section>
      <section class="card">
        <h3>وضعیت جریان داده</h3>
        <dl class="kv" id="flow"></dl>
        <p class="note" id="gate" style="margin-top:10px"></p>
      </section>
    </div>

    <div id="table"></div>

    <section class="card" id="chain-card" style="margin-top:16px;display:none">
      <h3 id="chain-title">زنجیره</h3>
      <p class="note">هر سررسید یک جدول. سلول‌های بی‌مظنه خاکستری‌اند — همان‌هایی که ترکیب چندپا را می‌اندازند.</p>
      <div class="bar" id="exp-chips" style="margin-bottom:10px"></div>
      <div class="scroll" style="max-height:60vh"><table class="data" id="chain"></table></div>
    </section>`;

  const picker = makePicker(root.querySelector('#pick'), {});
  let list = [];
  let detail = null;
  let expIdx = 0;

  const table = makeTable(root.querySelector('#table'), COLS, {
    sortKey: 'volume',
    onPick: (r) => openChain(r.ins),
  });
  // پیام پیش‌فرض جدول («نوار تشخیص بالا می‌گوید...») برای این تب غلط است —
  // اینجا نوار تشخیص اصلاً وجود ندارد، فقط یک عکس لحظه‌ای زنجیره‌ست.
  const LOADING_MSG = 'در حال دریافت داده زنجیره اختیار…';
  const NO_CHAIN_MSG = 'این عکس لحظه‌ای هیچ نمادی ندارد.';
  table.setEmptyMessage(LOADING_MSG);

  function drawKpis(stats, at) {
    if (!stats) return;
    const items = [
      ['نماد پایه', fmt.int(stats.underlyings), ''],
      ['قرارداد', fmt.int(stats.contracts), `${fmt.int(stats.expiries)} سررسید`],
      ['دارای مظنه', fmt.int(stats.quoted), `${faNum(((stats.quoted / (stats.contracts || 1)) * 100).toFixed(0))}٪ از تابلو`],
      ['حجم امروز', fmt.int(stats.vol), 'قرارداد'],
      ['موقعیت باز', fmt.int(stats.oi), 'قرارداد'],
      ['ارزش معاملات', fmt.int(stats.value), 'ریال'],
      ['سن عکس لحظه‌ای', at ? faAgo(Date.now() - at) : '—', ''],
    ];
    root.querySelector('#kpis').innerHTML = items.map(([k, v, s2]) => `
      <div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s2}</div></div>`).join('');
  }

  async function drawFlow() {
    try {
      const h = await (await fetch('/api/health')).json();
      root.querySelector('#flow').innerHTML = `
        <dt>دور دیده‌بان</dt><dd>${fmt.int(h.watchTicks)}</dd>
        <dt>زمان آخرین دور</dt><dd>${faDigits(h.lastWatchMs)} میلی‌ثانیه</dd>
        <dt>درخواست کل</dt><dd>${fmt.int(h.requests)}</dd>
        <dt>اصابت کش</dt><dd>${fmt.int(h.cacheHits)}</dd>
        <dt>خطا</dt><dd>${fmt.int(h.errors)}</dd>
        <dt>انتظار سهمیه</dt><dd>${fmt.int(h.rateWaits)}</dd>
        <dt>در صف</dt><dd>${fmt.int(h.queueDepth)}</dd>
        <dt>میانگین پاسخ</dt><dd>${faDigits(h.avgUpstreamMs)} میلی‌ثانیه</dd>
        <dt>مشترک زنده</dt><dd>${fmt.int(h.clients)}</dd>`;
      root.querySelector('#gate').textContent = h.market?.open
        ? 'بازار باز است و حلقه دریافت می‌چرخد.'
        : `حلقه متوقف است: ${h.market?.why}. برای دیدن جریان داده بیرون از بازار، در تنظیمات «توقف خودکار» را خاموش کن.`;
    } catch { /* نوار بالا خودش خبر می‌دهد */ }
  }

  async function openChain(uaIns) {
    const res = await chainDetail(uaIns);
    if (res.error) return;
    detail = res.ua;
    expIdx = 0;
    root.querySelector('#chain-card').style.display = '';
    const chips = root.querySelector('#exp-chips');
    chips.innerHTML = '<span class="picker-sum">سررسید:</span><div class="chips" id="ec"></div>';
    const ec = chips.querySelector('#ec');
    detail.expiries.forEach((ex, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${faDigits(ex.days)} روز`;
      b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      b.addEventListener('click', () => {
        expIdx = i;
        for (const x of ec.children) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        drawChain();
      });
      ec.appendChild(b);
    });
    drawChain();
  }

  function drawChain() {
    const ex = detail.expiries[expIdx];
    const spot = detail.last || detail.close;
    root.querySelector('#chain-title').textContent =
      `${detail.name} — آخرین ${fmt.money(detail.last)} — پایانی ${fmt.money(detail.close)}`;

    const cell = (q) => {
      const dead = !(q.bid > 0 || q.ask > 0);
      const st = dead ? 'color:var(--muted);font-style:italic' : '';
      return `<td class="n" style="${st}">${fmt.money(q.bid)}</td>
              <td class="n" style="${st}">${fmt.int(q.bidQty)}</td>
              <td class="n" style="${st}">${fmt.money(q.ask)}</td>
              <td class="n" style="${st}">${fmt.money(q.last)}</td>
              <td class="n" style="${st}">${fmt.int(q.vol)}</td>
              <td class="n" style="${st}">${fmt.int(q.oi)}</td>`;
    };

    const body = ex.strikes.map((st) => {
      const near = Math.abs(st.strike - spot) / (spot || 1) < 0.02;
      return `<tr class="${near ? 'atm' : ''}">
        ${cell(st.call)}
        <td class="n" style="font-weight:700;border-inline:1px solid var(--line)">${fmt.money(st.strike)}</td>
        ${cell(st.put)}
      </tr>`;
    }).join('');

    root.querySelector('#chain').innerHTML = `
      <thead>
        <tr>
          <th colspan="6" style="text-align:center;color:var(--gain)">اختیار خرید</th>
          <th style="text-align:center">اعمال</th>
          <th colspan="6" style="text-align:center;color:var(--loss)">اختیار فروش</th>
        </tr>
        <tr>
          <th>تقاضا</th><th>حجم</th><th>عرضه</th><th>آخرین</th><th>حجم روز</th><th>موقعیت باز</th>
          <th>—</th>
          <th>تقاضا</th><th>حجم</th><th>عرضه</th><th>آخرین</th><th>حجم روز</th><th>موقعیت باز</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>`;
  }

  // atmIv و pcRatio از موتور خالص فراکشن/نسبت خام برمی‌گردند؛ درصد و برچسب
  // نمایش، کار همین تب است، نه موتور
  const withDerived = (u) => ({
    ...u,
    quotedPct: (u.quoted / (u.contracts || 1)) * 100,
    atmIvPct: Number.isFinite(u.atmIv) ? u.atmIv * 100 : NaN,
  });

  const offChain = onChain((cs) => {
    list = cs.list.map(withDerived);
    table.set(list);
    table.setEmptyMessage(NO_CHAIN_MSG);
    picker.setList(cs.list);
    drawKpis(cs.stats, cs.at);
  });
  if (chainState.list.length) {
    list = chainState.list.map(withDerived);
    table.set(list);
    table.setEmptyMessage(NO_CHAIN_MSG);
    picker.setList(chainState.list);
    drawKpis(chainState.stats, chainState.at);
  }

  const offWatch = api.subscribeWatch((w) => pushRows(w, !w.changed));
  drawFlow();
  const timer = setInterval(drawFlow, 4000);

  return () => { offWatch(); offChain(); clearInterval(timer); };
}
