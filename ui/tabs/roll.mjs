// تب تحلیل رول — فاز ۷.
//
// تصمیم رول، مقایسه دو پریمیوم نیست. تفاضل دو موقعیت است:
//
//   D(S) = بازده موقعیت جدید در سررسید − بازده موقعیت فعلی در سررسید
//
// نقاط تغییر علامت D مرز تصمیم‌اند. همین یک تابع جای ده جدول مقایسه‌ای را
// می‌گیرد و از همان موتور بازده مشترک می‌آید.

import { rollAnalysis, markToMarket } from '/core/positions.mjs';
import { impliedVol } from '/core/bs.mjs';
import { mountPayoff, mountDiff } from '/ui/chart.mjs';
import { fmt } from '/ui/table.mjs';
import { faDigits, signTone } from '/ui/fmt.mjs';
import { onChain, chainState, pushRows, chainDetail } from '/ui/scanner.mjs';

export async function mount(root, { state, api }) {
  const s = () => state.settings;
  let positions = [];
  let sel = 0;
  let quotesByIns = new Map();
  let detail = null;
  let candidates = [];
  let dChart = null, c1Chart = null, c2Chart = null;
  let dRange = null, c1Range = null, c2Range = null;
  let chartKey = null;

  root.innerHTML = `
    <div class="page-head">
      <h2>تحلیل رول</h2>
      <p>پای فعلی را می‌بندی و پای تازه می‌فروشی. سؤال درست این نیست که پریمیوم تازه چقدر است،
         این است که در کدام قیمت پایه، موقعیت جدید بهتر از موقعیت فعلی درمی‌آید.</p>
    </div>

    <div class="split">
      <section class="card">
        <h3>موقعیت فعلی</h3>
        <div class="field"><label>انتخاب موقعیت</label><select id="pos"></select></div>
        <div class="field"><label>پایی که بسته می‌شود</label><select id="leg"></select></div>
        <dl class="kv" id="cur" style="margin-top:10px"></dl>
      </section>
      <section class="card">
        <h3>پای تازه</h3>
        <div class="field"><label>سررسید</label><select id="exp"></select></div>
        <div class="field"><label>قرارداد تازه</label><select id="new"></select></div>
        <p class="note" id="newnote"></p>
        <div class="field"><label>هم‌زمان مقایسه با سررسید دیگر <span class="unit">اختیاری</span></label><select id="exp2"></select></div>
        <p class="note">نامزدهای این سررسید هم به جدول و نمودار زیر اضافه می‌شوند. چون آن‌وقت موقعیت پس از رول
          دیگر یک سررسید ندارد، تفاضل با تقریب بلک-شولز روی افق «امروز» سنجیده می‌شود، نه جبر دقیق سررسید.</p>
      </section>
    </div>

    <div class="kpis" id="kpis"></div>

    <section class="card">
      <h3>مقایسه نامزدهای رول — همه قیمت‌های اعمال موجود در همان سررسید</h3>
      <p class="note">هر ردیف یعنی «اگر پای تازه دقیقاً همین قیمت اعمال بود». روی هر ردیف کلیک کن تا آن را
        در نمودارهای پایین انتخاب کنی. رتبه‌بندی بر مبنای تفاضل در قیمت فعلی است، نه بستانکاری تنها.</p>
      <div class="scroll" style="max-height:40vh"><table class="data" id="cand"></table></div>
    </section>

    <section class="card">
      <h3 id="dtitle">تفاضل دو موقعیت</h3>
      <p class="note">بالای صفر یعنی رول بهتر است، پایین صفر یعنی نگه داشتن. دایره‌ها مرز تصمیم‌اند.</p>
      <div id="dchart"></div>
      <div class="legend" id="dlegend"></div>
    </section>

    <div class="split">
      <section class="card"><h3>موقعیت فعلی در سررسید</h3><div id="c1"></div></section>
      <section class="card"><h3>موقعیت پس از رول</h3><div id="c2"></div></section>
    </div>`;

  const el = (id) => root.querySelector(id);

  /**
   * تلاطم مبنا برای رول چند-سررسیدی — فقط وقتی به کار می‌آید که پای تازه
   * سررسید دیگری داشته باشد و رول از موتور تقریبی analyzeMixed بگذرد؛ رول
   * هم‌سررسید معمولی (اکثریت رول‌ها) دقیق است و اصلاً به این نیاز ندارد.
   * از قیمت زنده همان پای بسته‌شونده استخراج می‌شود، نه یک عدد سرانگشتی.
   */
  function curSigma(cur, quote, spot) {
    if (s().volSource === 'MANUAL') return s().volManual;
    const mkt = quote?.close || quote?.last;
    if (!(mkt > 0) || !(spot > 0) || !(cur.strike > 0) || !(cur.days > 0)) return NaN;
    const T = cur.days / 365;
    const iv = impliedVol(cur.kind, mkt, spot, cur.strike, T, s().rFree, s().divYield, { lo: s().ivLo, hi: s().ivHi });
    return Number.isFinite(iv) && iv > 0 ? iv : NaN;
  }

  async function load() {
    try { positions = await (await fetch('/api/positions')).json(); }
    catch { positions = []; }
    el('#pos').innerHTML = positions.length
      ? positions.map((p, i) => `<option value="${i}">${p.title || 'موقعیت'} — ${p.uaName || p.uaIns}</option>`).join('')
      : '<option value="">موقعیتی ثبت نشده</option>';
    if (!positions.length) {
      el('#kpis').innerHTML = `<div class="kpi"><div class="k">موقعیت</div><div class="v">—</div>
        <div class="s">اول در تب موقعیت‌های من یک موقعیت ثبت کن</div></div>`;
      return;
    }
    await pickPos(0);
  }

  async function pickPos(i) {
    sel = i;
    const p = positions[i];
    el('#leg').innerHTML = p.legs
      .map((l, j) => `<option value="${j}" ${l.kind !== 'underlying' ? '' : 'disabled'}>
        ${l.side === 'sell' ? 'فروش' : 'خرید'} ${l.kind === 'underlying' ? 'سهم پایه' : (l.kind === 'call' ? 'کال' : 'پوت') + ' ' + fmt.money(l.strike)}</option>`)
      .join('');
    const firstOpt = p.legs.findIndex((l) => l.kind !== 'underlying');
    el('#leg').value = String(Math.max(0, firstOpt));

    const res = await chainDetail(p.uaIns);
    detail = res.error ? null : res.ua;
    if (detail) {
      el('#exp').innerHTML = detail.expiries.map((ex, k) => `<option value="${k}">${faDigits(ex.days)} روز</option>`).join('');
      el('#exp2').innerHTML = '<option value="">هیچ</option>'
        + detail.expiries.map((ex, k) => `<option value="${k}">${faDigits(ex.days)} روز</option>`).join('');
      // پیش‌فرض: سررسید دورتر از پای فعلی
      const cur = p.legs[Number(el('#leg').value)];
      const idx = detail.expiries.findIndex((ex) => ex.days > (cur?.days || 0));
      el('#exp').value = String(idx >= 0 ? idx : 0);
      el('#exp2').value = '';
      fillNew();
    }
    await priceAll();
  }

  function fillNew() {
    if (!detail) return;
    const p = positions[sel];
    const cur = p.legs[Number(el('#leg').value)];
    const ex = detail.expiries[Number(el('#exp').value) || 0];
    if (!ex || !cur) return;
    const put = cur.kind === 'put';
    candidates = ex.strikes.map((st) => ({ st, q: put ? st.put : st.call, days: ex.days }));
    // سررسید دوم اختیاری — نامزدهایش هم به همان فهرست تخت اضافه می‌شوند،
    // هر کدام days خودش را حمل می‌کند؛ rollAnalysis و نمودار پایین خودشان
    // بر مبنای همین فیلد تشخیص می‌دهند تک‌سررسیدی‌اند یا نه.
    const ex2v = el('#exp2').value;
    if (ex2v !== '') {
      const ex2 = detail.expiries[Number(ex2v)];
      if (ex2 && ex2.days !== ex.days) {
        candidates = candidates.concat(ex2.strikes.map((st) => ({ st, q: put ? st.put : st.call, days: ex2.days })));
      }
    }
    const label = (c) => `اعمال ${fmt.money(c.st.strike)} — ${faDigits(c.days)} روز — تقاضا ${fmt.money(c.q.bid)} — موقعیت باز ${fmt.money(c.q.oi)}`;
    el('#new').innerHTML = candidates.map((c, i) => `<option value="${i}">${label(c)}</option>`).join('');
    const nearHigher = candidates.findIndex((c) => c.days === ex.days && c.st.strike > cur.strike);
    el('#new').value = String(nearHigher >= 0 ? nearHigher : 0);
    draw();
  }

  async function priceAll() {
    const p = positions[sel];
    if (!p) return;
    const codes = new Set([p.uaIns, ...p.legs.map((l) => l.ins).filter(Boolean),
      ...candidates.map((c) => c.q.ins).filter(Boolean)].filter(Boolean));
    if (!codes.size) return;
    try {
      const q = [...codes].slice(0, 180).join(',');
      const [books, infos] = await Promise.all([
        fetch(`/api/books?ins=${q}`).then((r) => r.json()),
        fetch(`/api/infos?ins=${q}`).then((r) => r.json()),
      ]);
      for (const ins of codes) {
        const b = books[ins]?.book || [];
        const i2 = infos[ins] || {};
        quotesByIns.set(ins, {
          bid: b[0]?.bid || 0, bidQty: b[0]?.bidQty || 0,
          ask: b[0]?.ask || 0, askQty: b[0]?.askQty || 0,
          last: i2.last || 0, close: i2.close || 0, state: i2.state, staleSec: i2.staleSec, book: b,
        });
      }
      draw();
    } catch { /* نوار بالا خبر می‌دهد */ }
  }

  function draw() {
    const p = positions[sel];
    if (!p || !candidates.length) return;
    const closeIdx = Number(el('#leg').value);
    const candIdx = Number(el('#new').value) || 0;
    const cand = candidates[candIdx];
    if (!cand) return;

    // قیمت‌گیری هر پانزده ثانیه دوباره draw را صدا می‌زند؛ اگر همان سناریوی
    // رول است (همان موقعیت، همان پای بسته‌شونده، همان نامزد تازه) زوم سه
    // نمودار باید بماند، نه هر بار به نمای اول برگردد
    const sameScenario = chartKey === `${sel}:${closeIdx}:${candIdx}`;
    chartKey = `${sel}:${closeIdx}:${candIdx}`;
    if (dChart) dRange = dChart.view();
    if (c1Chart) c1Range = c1Chart.view();
    if (c2Chart) c2Range = c2Chart.view();

    const fees = { buyStock: s().feeBuyStock, sellStock: s().feeSellStock, option: s().feeOption, exercise: s().feeExercise };
    const uaQ = quotesByIns.get(p.uaIns) || {};
    const spot = uaQ.last || uaQ.close || p.legs.find((l) => l.kind === 'underlying')?.price || 0;
    const quotes = p.legs.map((l) => (l.kind === 'underlying' ? uaQ : (quotesByIns.get(l.ins) || {})));

    const cur = p.legs[closeIdx];
    const newLeg = {
      kind: cur.kind, side: cur.side, ratio: cur.ratio, size: cur.size,
      strike: cand.st.strike, days: cand.days, ins: cand.q.ins,
    };
    const newQuote = quotesByIns.get(cand.q.ins) || { bid: cand.q.bid, ask: cand.q.ask, close: cand.q.close, last: cand.q.last };
    const sigma = curSigma(cur, quotes[closeIdx], spot);

    const r = rollAnalysis({ pos: p, quotes, closeIdx, newLeg, newQuote, opt: { fees, spot, basis: 'BOOK', sigma, rFree: s().rFree, divYield: s().divYield } });
    const m = markToMarket(p, quotes, { fees, spot, spotClose: uaQ.close || spot });

    el('#cur').innerHTML = `
      <dt>پایه</dt><dd>${p.uaName || p.uaIns}</dd>
      <dt>قیمت پایه</dt><dd>${fmt.money(spot)}</dd>
      <dt>تعداد قرارداد</dt><dd>${fmt.int(p.qty)}</dd>
      <dt>سود و زیان جاری</dt><dd>${fmt.money(m.pnlTotal)}</dd>
      <dt>سربه‌سری فعلی</dt><dd>${r.curBreakevens.map((b) => fmt.money(b)).join(' , ') || '—'}</dd>`;

    el('#newnote').textContent =
      `هزینه بستن پای فعلی از عرضه: ${fmt.money(-r.closeCash)} — بستانکار پای تازه از تقاضا: ${fmt.money(r.newCash)}`;

    const better = r.atSpot > 0;
    el('#kpis').innerHTML = [
      ['تفاضل در قیمت فعلی', fmt.money(r.atSpotTotal), better ? 'رول بهتر است' : 'نگه داشتن بهتر است', better ? 'gain' : 'loss'],
      ['خالص نقدی رول', fmt.money(r.netCashChange), r.netCashChange >= 0 ? 'بستانکار' : 'بدهکار', r.netCashChange >= 0 ? 'gain' : 'loss'],
      ['سقف سود فعلی', fmt.money(r.curMaxProfit), '', ''],
      ['سقف سود پس از رول', fmt.money(r.nextMaxProfit), '', ''],
      ['سربه‌سری فعلی', fmt.money(r.curBreakevens[0]), '', ''],
      ['سربه‌سری پس از رول', fmt.money(r.nextBreakevens[0]), '', ''],
      ['مرز تصمیم', r.crossings.length ? r.crossings.map((x) => fmt.money(x)).join(' , ') : 'بی‌مرز', 'قیمت پایه', ''],
    ].map(([k, v, sub, c]) => `<div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${sub}</div></div>`).join('');

    // ——— مقایسه همه نامزدهای رول، همین سررسید و سررسید دوم اختیاری ———
    // چند سررسید در فهرست هست یا نه، اینجا فهمیده می‌شود — عنوان و ستون
    // سررسید فقط وقتی نشان داده می‌شوند که واقعاً لازم باشند.
    const multiExpiry = new Set(candidates.map((c) => c.days)).size > 1;
    const candRows = candidates.map((c2, i) => {
      const nl = { kind: cur.kind, side: cur.side, ratio: cur.ratio, size: cur.size, strike: c2.st.strike, days: c2.days, ins: c2.q.ins };
      const nq = quotesByIns.get(c2.q.ins) || { bid: c2.q.bid, ask: c2.q.ask, close: c2.q.close, last: c2.q.last };
      const r2 = rollAnalysis({ pos: p, quotes, closeIdx, newLeg: nl, newQuote: nq, opt: { fees, spot, basis: 'BOOK', sigma, rFree: s().rFree, divYield: s().divYield } });
      return { i, strike: c2.st.strike, days: c2.days, r: r2 };
    });
    const best = candRows.reduce((a, x) => (x.r.atSpot > a.r.atSpot ? x : a), candRows[0]);
    const bestIdx = best.i;
    // برچسب فقط می‌گوید «بهترین بین همین نامزدها» — اگر همه نامزدها از نگه
    // داشتن بدترند، بهترینشان هم واقعاً بهتر نیست. رنگ سبز ثابت قبلاً این
    // را قایم می‌کرد: حتی وقتی atSpot بهترین گزینه هم منفی بود، همان رنگ
    // «خبر خوب» را می‌گرفت. signTone همان تابعی است که کارت‌های KPI
    // تب‌های استراتژی/برترین موقعیت‌ها (دور ۱۷) برای همین منظور دارند.
    const bestTone = signTone(best.r.atSpot);
    root.querySelector('#cand').innerHTML = `
      <thead><tr>
        <th>اعمال</th>${multiExpiry ? '<th>سررسید</th>' : ''}<th>خالص نقدی رول</th><th>تفاضل در قیمت فعلی</th>
        <th>سقف سود پس از رول</th><th>سربه‌سری پس از رول</th><th></th>
      </tr></thead>
      <tbody>${candRows.map((x) => `
        <tr data-i="${x.i}" style="cursor:pointer" class="${x.i === candIdx ? 'picked' : ''}" tabindex="0" role="button" aria-label="نامزد رول به اعمال ${fmt.money(x.strike)}">
          <td class="n">${fmt.money(x.strike)}</td>${multiExpiry ? `<td class="n">${faDigits(x.days)} روز</td>` : ''}
          <td class="n">${fmt.money(x.r.netCashChange)}</td>
          <td class="n" style="color:${x.r.atSpot >= 0 ? 'var(--gain)' : 'var(--loss)'}">${fmt.money(x.r.atSpotTotal)}</td>
          <td class="n">${fmt.money(x.r.nextMaxProfit)}</td>
          <td class="n">${fmt.money(x.r.nextBreakevens[0])}</td>
          <td>${x.i === bestIdx ? `<span class="tag ${bestTone}">بهترین تفاضل</span>` : ''}${x.i === candIdx ? '<span class="tag flat">انتخاب‌شده</span>' : ''}</td>
        </tr>`).join('')}</tbody>`;
    for (const tr of root.querySelectorAll('#cand tbody tr')) {
      const pick = () => { el('#new').value = tr.dataset.i; draw(); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        pick();
      });
    }

    const ks = [...r.curAnalysis.strikes, ...r.nextAnalysis.strikes, spot];
    const lo = Math.max(1, Math.min(...ks) * 0.75);
    const hi = Math.max(...ks) * 1.3;

    // دو نامزد دیگر رتبه اول جدول مقایسه (به‌جز انتخاب‌شده) هم‌زمان روی همان
    // نمودار تفاضل — تا شکل کلی چند گزینه با هم دیده شود، نه فقط عددشان
    // در جدول بالا
    const otherCands = candRows.filter((x) => x.i !== candIdx)
      .sort((a, b) => b.r.atSpot - a.r.atSpot).slice(0, 2);
    const extra = otherCands.map((x) => ({
      fn: (S) => x.r.diff(S) * p.qty,
      label: multiExpiry ? `اعمال ${fmt.money(x.strike)} — ${faDigits(x.days)} روز` : `اعمال ${fmt.money(x.strike)}`,
    }));

    dChart?.destroy();
    dChart = mountDiff(el('#dchart'), (S) => r.diff(S) * p.qty, lo, hi, {
      spot, width: 760, height: 240, extra, ...(sameScenario && dRange ? { initRange: dRange } : {}),
    });
    el('#dtitle').textContent = `تفاضل دو موقعیت — ${r.verdict}`;
    el('#dlegend').innerHTML = `
      <span>${r.note}</span>
      <span>مرز تصمیم: ${dChart.crossings.map((x) => fmt.money(x)).join(' , ') || 'ندارد'}</span>`;

    c1Chart?.destroy();
    c1Chart = mountPayoff(el('#c1'), p.legs, r.curNet, {
      fees, spot, sigma, rFree: s().rFree, divYield: s().divYield, width: 480, height: 220,
      ...(sameScenario && c1Range ? { initRange: c1Range } : {}),
    });
    c2Chart?.destroy();
    c2Chart = mountPayoff(el('#c2'), r.nextLegs, r.nextNet, {
      fees, spot, sigma, rFree: s().rFree, divYield: s().divYield, width: 480, height: 220,
      ...(sameScenario && c2Range ? { initRange: c2Range } : {}),
    });
  }

  el('#pos').addEventListener('change', () => pickPos(Number(el('#pos').value)));
  el('#leg').addEventListener('change', () => fillNew());
  el('#exp').addEventListener('change', () => { fillNew(); priceAll(); });
  el('#exp2').addEventListener('change', () => { fillNew(); priceAll(); });
  el('#new').addEventListener('change', draw);

  const offChain = onChain(() => {});
  const offWatch = api.subscribeWatch((w) => pushRows(w, !w.changed));
  await load();
  const timer = setInterval(priceAll, 15000);
  return () => { offChain(); offWatch(); clearInterval(timer); dChart?.destroy(); c1Chart?.destroy(); c2Chart?.destroy(); };
}
