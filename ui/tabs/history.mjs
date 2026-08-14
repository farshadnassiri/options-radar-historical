import { CATALOG, GROUPS, byId } from '/strategies/catalog.mjs';
import { buildChain } from '/core/chain.mjs';
import { feesOf } from '/core/settings.mjs';
import {
  HISTORY_BASES, flattenActiveContracts, historyDateLabel, historyDayName,
  replayHistory, basisMatrix, entrySensitivity, optimizeExitPolicy, normalizeHistoryDate,
  holdingPeriodProfile, replayTradeDetail,
} from '/core/history.mjs';
import { fmt, faDigits, signTone, toEnDigits, normFa } from '/ui/fmt.mjs';
import { mountPayoff } from '/ui/chart.mjs';

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[c]));

const basisOptions = (manual = false) => [
  ...HISTORY_BASES.map(([value, label]) => `<option value="${value}">${label}</option>`),
  ...(manual ? ['<option value="MANUAL">قیمت دستی هر پا</option>'] : []),
].join('');

const contractLabel = (c) => `${c.name || c.ins} — ${c.kind === 'call' ? 'کال' : 'پوت'} ${fmt.int(c.strike)} — سررسید ${historyDateLabel(c.expiry)}`;
const legLabel = (leg, index) => `${faDigits(index + 1)}. ${leg.side === 'buy' ? 'خرید' : 'فروش'} ${leg.kind === 'call' ? 'کال' : leg.kind === 'put' ? 'پوت' : 'سهم پایه'} × ${faDigits(leg.ratio)}`;
const valueLabel = (value, estimated = false) => `${estimated ? '≈ ' : ''}${fmt.money(value)}`;

function filterNumber(text) {
  const normalized = toEnDigits(text).replaceAll(',', '').replaceAll('٬', '');
  const found = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  return found ? Number(found[0]) : NaN;
}

function enableColumnSort(table) {
  if (!table?.tHead?.rows?.length || table.dataset.sorts === 'on') return;
  const header = table.tHead.rows[0];
  const body = table.tBodies[0];
  if (!body) return;
  table.dataset.sorts = 'on';
  [...body.rows].forEach((row, index) => { row.dataset.originalOrder = String(index); });
  [...header.cells].forEach((cell, index) => {
    const label = cell.textContent.trim();
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'history-sort';
    button.innerHTML = cell.innerHTML;
    button.setAttribute('aria-label', `مرتب‌سازی بر اساس ${label}`);
    cell.replaceChildren(button);
    const sort = () => {
      const direction = cell.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      [...header.cells].forEach((th) => th.removeAttribute('aria-sort'));
      cell.setAttribute('aria-sort', direction);
      const sign = direction === 'ascending' ? 1 : -1;
      const rows = [...body.rows];
      rows.sort((a, b) => {
        const aText = a.cells[index]?.textContent?.trim() || '';
        const bText = b.cells[index]?.textContent?.trim() || '';
        const an = filterNumber(aText), bn = filterNumber(bText);
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return (an - bn) * sign;
        const textOrder = normFa(toEnDigits(aText)).localeCompare(normFa(toEnDigits(bText)), 'fa', { numeric: true, sensitivity: 'base' });
        if (textOrder) return textOrder * sign;
        return Number(a.dataset.originalOrder) - Number(b.dataset.originalOrder);
      });
      rows.forEach((row) => body.appendChild(row));
    };
    button.addEventListener('click', sort);
  });
}

function histogram(host, rows) {
  const values = rows.filter((r) => r.status === 'ok' && Number.isFinite(r.returnPct)).map((r) => r.returnPct);
  if (!values.length) { host.innerHTML = '<p class="empty-note">داده معتبر برای توزیع نیست.</p>'; return; }
  const lo = Math.min(...values), hi = Math.max(...values);
  const count = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(values.length))));
  const width = Math.max(1e-9, (hi - lo) / count);
  const bins = Array.from({ length: count }, (_, i) => ({ lo: lo + i * width, hi: i === count - 1 ? hi : lo + (i + 1) * width, n: 0 }));
  values.forEach((v) => { bins[Math.min(count - 1, Math.floor((v - lo) / width))].n += 1; });
  const max = Math.max(...bins.map((b) => b.n), 1);
  host.innerHTML = `<div class="history-histogram">${bins.map((b) => `<button type="button" class="hist-bin ${b.hi <= 0 ? 'loss' : b.lo >= 0 ? 'gain' : 'flat'}" title="${fmt.pct(b.lo)} تا ${fmt.pct(b.hi)}: ${fmt.int(b.n)} آفست" aria-label="از ${fmt.pct(b.lo)} تا ${fmt.pct(b.hi)}، ${fmt.int(b.n)} آفست"><b style="height:${Math.max(5, (b.n / max) * 100)}%"></b><span>${fmt.int(b.n)}</span><small>${fmt.pct((b.lo + b.hi) / 2)}</small></button>`).join('')}<span class="hist-y-title">تعداد آفست</span><span class="hist-x-title">بازده</span></div>`;
}

function lineChart(host, rows, series, { money = false } = {}) {
  const data = rows.filter((r) => r.status === 'ok');
  if (data.length < 2) {
    host.innerHTML = '<p class="empty-note">برای نمودار، دست‌کم دو روز داده معتبر لازم است.</p>';
    return;
  }
  const active = new Set(series.map((_, i) => i));
  const axis = (v) => money ? fmt.money(v) : fmt.pct(v);
  const W = 820, H = 330, L = 92, R = 24, T = 24, B = 64;
  let cursorIndex = data.length - 1;

  const render = () => {
    const shown = series.filter((_, i) => active.has(i));
    const values = data.flatMap((r) => shown.map((s) => Number(r[s.key])).filter(Number.isFinite));
    let lo = Math.min(...values, 0), hi = Math.max(...values, 0);
    if (Math.abs(hi - lo) < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (i) => L + (i / Math.max(1, data.length - 1)) * (W - L - R);
    const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
    const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const xIndexes = [...new Set(Array.from({ length: Math.min(5, data.length) }, (_, i) => Math.round((i * (data.length - 1)) / Math.max(1, Math.min(5, data.length) - 1))))];
    const grid = yTicks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="history-grid"/><text x="${L - 9}" y="${y(v) + 4}" text-anchor="end">${axis(v)}</text>`).join('');
    const xTicks = xIndexes.map((i) => `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" class="history-grid history-grid-x"/><text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${esc(data[i].dateLabel.slice(5))}</text>`).join('');
    const paths = series.map((s, index) => {
      if (!active.has(index)) return '';
      const points = data.map((r, i) => Number.isFinite(Number(r[s.key])) ? `${x(i).toFixed(1)},${y(Number(r[s.key])).toFixed(1)}` : '').filter(Boolean).join(' ');
      return `<polyline class="history-line" fill="none" stroke="${s.color}" points="${points}"/>`;
    }).join('');
    host.innerHTML = `<div class="history-chartbox"><div class="history-chart-legend">${series.map((s, i) => `<button type="button" data-series="${i}" aria-pressed="${active.has(i)}" style="--series:${s.color}"><i></i>${esc(s.label)}</button>`).join('')}</div><div class="history-chart-stage"><svg class="history-svg" viewBox="0 0 ${W} ${H}" tabindex="0" role="group" aria-label="نمودار تاریخی تعاملی؛ با حرکت ماوس جزئیات هر روز نمایش داده می‌شود">
      ${grid}${xTicks}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="chart-zero"/>${paths}
      <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="history-axis"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="history-axis"/>
      <text class="history-axis-title" x="${(L + W - R) / 2}" y="${H - 9}" text-anchor="middle">تاریخ معاملاتی</text>
      <text class="history-axis-title" transform="translate(17 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${money ? 'سود و زیان (ریال)' : 'بازده (درصد)'}</text>
      <g class="history-cursor" hidden><line y1="${T}" y2="${H - B}"/><g class="history-cursor-dots"></g></g>
    </svg><div class="history-tooltip" hidden></div></div></div>`;
    const svg = host.querySelector('svg');
    const tip = host.querySelector('.history-tooltip');
    const cursor = host.querySelector('.history-cursor');
    const showAt = (index, clientX = NaN, clientY = NaN) => {
      cursorIndex = Math.max(0, Math.min(data.length - 1, index));
      const row = data[cursorIndex], cx = x(cursorIndex);
      cursor.removeAttribute('hidden');
      const line = cursor.querySelector('line'); line.setAttribute('x1', cx); line.setAttribute('x2', cx);
      cursor.querySelector('.history-cursor-dots').innerHTML = series.map((s, i) => active.has(i) && Number.isFinite(Number(row[s.key])) ? `<circle cx="${cx}" cy="${y(Number(row[s.key]))}" r="4" fill="${s.color}"/>` : '').join('');
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(row.dayName)} ${esc(row.dateLabel)}</b>${series.map((s, i) => active.has(i) ? `<span><i style="--series:${s.color}"></i>${esc(s.label)}: <strong class="${signTone(Number(row[s.key]))}">${axis(Number(row[s.key]))}</strong></span>` : '').join('')}`;
      if (Number.isFinite(clientX)) {
        const box = host.querySelector('.history-chart-stage').getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(8, clientX - box.left + 12), Math.max(8, box.width - 210))}px`;
        tip.style.top = `${Math.max(8, clientY - box.top - 18)}px`;
      }
    };
    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const vx = ((event.clientX - box.left) / box.width) * W;
      showAt(Math.round(((vx - L) / (W - L - R)) * (data.length - 1)), event.clientX, event.clientY);
    });
    svg.addEventListener('pointerleave', () => { cursor.setAttribute('hidden', ''); tip.hidden = true; });
    svg.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); showAt(cursorIndex + (event.key === 'ArrowRight' ? 1 : -1));
    });
    host.querySelectorAll('[data-series]').forEach((button) => button.addEventListener('click', () => {
      const i = Number(button.dataset.series);
      if (active.has(i) && active.size === 1) return;
      active.has(i) ? active.delete(i) : active.add(i); render();
    }));
  };
  render();
}

function scatterChart(host, rows) {
  const data = rows.filter((r) => Number.isFinite(r.summary?.last?.returnPct) && Number.isFinite(r.summary?.maxDrawdown));
  if (!data.length) { host.innerHTML = '<p class="empty-note">ترکیب معتبری برای نمودار نیست.</p>'; return; }
  const W = 820, H = 330, L = 92, R = 24, T = 24, B = 64;
  const xs = data.map((r) => Math.abs(r.summary.maxDrawdown));
  const ys = data.map((r) => r.summary.last.returnPct);
  const xMax = Math.max(...xs, 1), yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0, 1);
  const x = (v) => L + (v / xMax) * (W - L - R);
  const y = (v) => T + ((yMax - v) / Math.max(1e-9, yMax - yMin)) * (H - T - B);
  const plotted = data.slice(0, 800);
  const circles = plotted.map((r, index) => {
    const ret = r.summary.last.returnPct;
    const title = `${r.legs.map((l) => l.name).join(' + ')} | بازده ${fmt.pct(ret)} | افت ${fmt.money(Math.abs(r.summary.maxDrawdown))}`;
    return `<circle data-point="${index}" cx="${x(Math.abs(r.summary.maxDrawdown))}" cy="${y(ret)}" r="4" class="${ret >= 0 ? 'scatter-gain' : 'scatter-loss'}"><title>${esc(title)}</title></circle>`;
  }).join('');
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const xTicks = Array.from({ length: 5 }, (_, i) => (xMax * i) / 4);
  host.innerHTML = `<div class="history-chart-stage"><svg class="history-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="ریسک در برابر بازده؛ برای جزئیات روی نقطه برو">
    ${yTicks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="history-grid"/><text x="${L - 9}" y="${y(v) + 4}" text-anchor="end">${fmt.pct(v)}</text>`).join('')}
    ${xTicks.map((v) => `<line x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}" class="history-grid history-grid-x"/><text x="${x(v)}" y="${H - B + 20}" text-anchor="middle">${fmt.money(v)}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="chart-zero"/>${circles}
    <text class="history-axis-title" x="${(L + W - R) / 2}" y="${H - 9}" text-anchor="middle">قدر مطلق افت از قله</text><text class="history-axis-title" transform="translate(17 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">بازده پایان</text>
  </svg><div class="history-tooltip" hidden></div></div>`;
  const stage = host.querySelector('.history-chart-stage'), tip = host.querySelector('.history-tooltip');
  stage.addEventListener('pointermove', (event) => {
    const point = event.target.closest?.('[data-point]');
    if (!point) { tip.hidden = true; return; }
    const r = plotted[Number(point.dataset.point)], box = stage.getBoundingClientRect();
    tip.hidden = false; tip.style.left = `${Math.min(event.clientX - box.left + 12, Math.max(8, box.width - 250))}px`; tip.style.top = `${Math.max(8, event.clientY - box.top - 18)}px`;
    tip.innerHTML = `<b>${esc(r.legs.map((l) => l.name).join(' + '))}</b><span>بازده: <strong class="${signTone(r.summary.last.returnPct)}">${fmt.pct(r.summary.last.returnPct)}</strong></span><span>افت: ${fmt.money(Math.abs(r.summary.maxDrawdown))}</span>`;
  });
  stage.addEventListener('pointerleave', () => { tip.hidden = true; });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function mount(root, { state }) {
  root.innerHTML = `
    <section class="history-hero">
      <div>
        <p class="eyebrow">بازپخش واقعی قیمت قرارداد</p>
        <h1>تحلیل تاریخی استراتژی</h1>
        <p>یک موقعیت را در روز شروع باز کن و ببین آفست کامل آن در هر روز معاملاتی چه نتیجه‌ای می‌داد. قیمت تاریخی، قیمت دستی و محاسبه مدل‌محور جدا می‌مانند.</p>
      </div>
      <span class="history-local">محلی · بدون ارسال داده تو</span>
    </section>

    <section class="card history-controls">
      <div class="history-control-grid">
        <label for="h-base">نماد پایه<select id="h-base"><option value="">در حال دریافت…</option></select></label>
        <label for="h-strategy">استراتژی<select id="h-strategy"></select></label>
        <div class="history-expiry-field" id="h-expiry-field">
          <span>سررسیدهای قابل بررسی</span>
          <details id="h-expiry-picker">
            <summary id="h-expiry-summary">ابتدا نماد پایه را انتخاب کن</summary>
            <div class="expiry-picker-popover"><div class="expiry-picker-tools"><button type="button" class="ghost" id="h-expiry-all">انتخاب همه</button><button type="button" class="ghost" id="h-expiry-none">پاک کردن</button></div>
            <div id="h-expiry-list" class="expiry-picker-list"></div></div>
          </details>
        </div>
        <label for="h-mode">حالت بررسی<select id="h-mode"><option value="manual">انتخاب دستی قراردادها</option><option value="all">تمام ترکیب‌های ممکن</option></select></label>
        <label for="h-units">تعداد واحد استراتژی<input id="h-units" type="number" min="1" max="10000" step="1" value="${Math.max(1, state.settings.qtyDefault || 1)}"></label>
        <label for="h-entry">مبنای قیمت ورود<select id="h-entry">${basisOptions(true)}</select></label>
        <label for="h-exit">مبنای قیمت آفست<select id="h-exit">${basisOptions(false)}</select></label>
        <label for="h-filter">ترکیب‌سازی<select id="h-filter"><option value="filtered">فیلترهای تاریخی قابل‌اعمال</option><option value="structural">تمام ترکیب‌های ساختاری</option></select></label>
      </div>
      <div class="history-liquidity-controls">
        <div><p class="eyebrow">فیلتر نقدشوندگی در زمان اجرا</p><b>حداقل‌های روز ورود و هر روز آفست</b></div>
        <label for="h-base-value">ارزش پایه (میلیارد ریال)<input id="h-base-value" type="number" min="0" step="0.1" value="0"></label>
        <label for="h-base-volume">حجم پایه<input id="h-base-volume" type="number" min="0" step="1" value="0"></label>
        <label for="h-leg-value">ارزش هر قرارداد (میلیون ریال)<input id="h-leg-value" type="number" min="0" step="0.1" value="0"></label>
        <label for="h-leg-volume">حجم هر قرارداد<input id="h-leg-volume" type="number" min="0" step="1" value="0"></label>
      </div>
      <div class="history-actions">
        <button class="primary" id="h-load" type="button">دریافت تاریخچه قراردادهای فعال</button>
        <button class="primary" id="h-run" type="button" disabled>اجرای تحلیل</button>
        <button class="ghost" id="h-export" type="button" disabled>خروجی CSV روزانه</button>
        <span id="h-status" role="status" aria-live="polite">در حال دریافت فهرست قراردادهای فعال…</span>
      </div>
      <p class="history-caveat">آخرین، پایانی، کمترین و بیشترین قیمت تاریخی‌اند؛ هیچ‌کدام تضمین اجرای واقعی سفارش نیستند. روز ناقص با «فاقد داده» می‌ماند.</p>
    </section>

    <section class="card history-range" id="h-range" hidden>
      <div class="range-head"><h2>بازه روزهای معاملاتی</h2><b id="h-range-label">—</b></div>
      <label>شروع<input type="range" id="h-start" min="0" value="0"></label>
      <label>پایان<input type="range" id="h-end" min="0" value="0"></label>
      <div id="h-base-liquidity" class="base-liquidity-snapshot">—</div>
    </section>

    <section class="card" id="h-legs-card" hidden>
      <div class="section-head"><div><p class="eyebrow">حالت دستی</p><h2>پاهای موقعیت</h2></div><span>قیمت دستی می‌تواند بیرون از بازه معامله آن روز باشد.</span></div>
      <div id="h-legs" class="history-leg-grid"></div>
    </section>

    <section id="h-results" hidden>
      <aside class="history-frozen" id="h-frozen-strategy" aria-live="polite">
        <div class="frozen-summary"><span>استراتژی انتخاب‌شده</span><b>پس از اجرای تحلیل، مشخصات قرارداد اینجا ثابت می‌ماند.</b></div>
      </aside>
      <div class="history-kpis" id="h-kpis"></div>
      <section class="card" id="h-auto-card" hidden>
        <div class="section-head"><div><p class="eyebrow">حالت خودکار</p><h2>ترکیب‌های ممکن</h2></div><span id="h-combo-note"></span></div>
        <div id="h-scatter" class="history-chart"></div>
        <p class="note">برای مرتب‌سازی صعودی یا نزولی روی عنوان هر ستون کلیک کن. انتخاب هر ردیف، همه تحلیل‌های پایین را برای همان ترکیب بازسازی می‌کند.</p>
        <div class="history-table-wrap"><table class="history-table" id="h-combos-table"><thead><tr><th>ترکیب</th><th>قیمت اعمال</th><th>سررسید</th><th>نتیجه پایان</th><th>بازده استراتژی</th><th>بازده سهم پایه</th><th>میانگین بازده</th><th>میانه بازده</th><th>بهترین خروج</th><th>بدترین خروج</th><th>افت بیشینه</th><th>مثبت / منفی</th><th>سرمایه درگیر</th><th>مبلغ پرداختی</th><th>مبلغ دریافتی</th><th>خالص جریان نقدی</th><th>ارزش پایه ورود</th><th>کمترین حجم پا</th><th>وجه تضمین خالص</th><th>کیفیت داده</th></tr></thead><tbody id="h-combos"></tbody></table></div>
        <div class="history-auto-manual" id="h-auto-manual" hidden>
          <div class="section-head"><div><p class="eyebrow">بازمحاسبه ترکیب انتخابی</p><h3>قیمت ورود دستی هر پا</h3></div><span>محدود به کمترین و بیشترین روز نیست.</span></div>
          <div id="h-auto-prices" class="history-leg-grid"></div>
          <button class="primary" id="h-auto-replay" type="button">محاسبه دوباره با قیمت‌های دستی</button>
        </div>
      </section>

      <section class="card history-payoff-card">
        <div class="section-head"><div><p class="eyebrow">ورودی ثابت روز اول؛ قیمت پایه متغیر در هر روز</p><h2>نمودار روزانه سود و زیان استراتژی</h2></div><b id="h-payoff-date">—</b></div>
        <p class="note">منحنی از قیمت‌های ورود روز اول ساخته می‌شود و ثابت می‌ماند؛ با جابه‌جایی روز، فقط خط قیمت پایانی سهم پایه و شاخص‌های تصمیم به‌روز می‌شوند. سود آفست واقعی همان روز جدا از سود سناریویی سررسید گزارش می‌شود.</p>
        <div class="payoff-day-controls">
          <label for="h-payoff-day">روز معاملاتی<input id="h-payoff-day" type="range" min="0" value="0"></label>
          <div class="payoff-layer-controls" aria-label="لایه‌های نمودار">
            <label><input type="checkbox" data-payoff-layer="fill" checked> ناحیه سود/زیان</label>
            <label><input type="checkbox" data-payoff-layer="strike" checked> قیمت‌های اعمال</label>
            <label><input type="checkbox" data-payoff-layer="be" checked> سربه‌سری‌ها</label>
            <label><input type="checkbox" data-payoff-layer="spot" checked> قیمت پایه روز</label>
            <label><input type="checkbox" data-payoff-layer="metrics" checked> پارامترهای تصمیم</label>
          </div>
        </div>
        <div class="history-payoff-shell"><div id="h-payoff-decisions" class="payoff-decision-strip"></div><div id="h-daily-payoff"></div></div>
      </section>

      <div class="history-chart-grid">
        <section class="card"><div class="section-head"><h2>سود و زیان در زمان</h2></div><div id="h-pnl-chart" class="history-chart"></div></section>
        <section class="card"><div class="section-head"><h2>بازده استراتژی و تغییر پایه</h2></div><div id="h-ret-chart" class="history-chart"></div></section>
        <section class="card"><div class="section-head"><h2>افت از قله</h2></div><div id="h-dd-chart" class="history-chart"></div></section>
        <section class="card"><div class="section-head"><h2>سهم هر پا در نتیجه پایان</h2></div><div id="h-leg-contrib" class="leg-contrib"></div></section>
        <section class="card"><div class="section-head"><h2>اثر تجمعی هر پا در هر روز</h2></div><div id="h-leg-chart" class="history-chart"></div></section>
        <section class="card"><div class="section-head"><h2>توزیع نتایج آفست</h2></div><div id="h-distribution" class="history-chart"></div></section>
      </div>

      <div class="history-analysis-grid">
        <section class="card"><div class="section-head"><div><p class="eyebrow">آمار کل دوره</p><h2>تحلیل آماری دقیق</h2></div></div><div id="h-stats" class="history-table-wrap"></div></section>
        <section class="card"><div class="section-head"><div><p class="eyebrow">تفکیک روز هفته</p><h2>رفتار زمانی سود و زیان</h2></div></div><div id="h-weekday-stats" class="history-table-wrap"></div></section>
      </div>

      <section class="card">
        <div class="section-head"><div><p class="eyebrow">آفست کامل</p><h2>جدول روزبه‌روز</h2></div><span id="h-selected-label"></span></div>
        <p class="note">در ستون هر پا، سطر اول قیمت آفست، سطر دوم اثر تجمعی همان پا و سطر سوم تغییر اثر آن نسبت به روز قبل است.</p>
        <div class="history-table-wrap"><table class="history-table"><thead id="h-days-head"></thead><tbody id="h-days"></tbody></table></div>
      </section>

      <div class="history-analysis-grid">
        <section class="card"><div class="section-head"><h2>مقایسه ۱۶ مبنای ورود و خروج</h2></div><div id="h-basis-matrix" class="history-table-wrap"></div></section>
        <section class="card"><div class="section-head"><h2>حساسیت قیمت ورود هر پا</h2></div><div id="h-sensitivity" class="history-table-wrap"></div></section>
        <section class="card"><div class="section-head"><div><p class="eyebrow">روز ورود و هر روز بعد</p><h2>وجه تضمین و پوشش</h2></div></div><div id="h-margin" class="history-table-wrap"></div></section>
        <section class="card"><div class="section-head"><div><p class="eyebrow">خروج مشاهده‌شده و قاعده قابل‌تکرار</p><h2>بهینه‌سازی زمان و قیمت خروج</h2></div></div><div id="h-optimal"></div></section>
      </div>

      <section class="card">
        <div class="section-head"><div><p class="eyebrow">۱۴ روز قبل، ۱۳ روز قبل، …</p><h2>ماتریس ورودهای پیاپی</h2></div><button class="primary" id="h-rolling" type="button">محاسبه ماتریس</button></div>
        <div class="rolling-controls">
          <label class="rolling-strategy-field" for="h-rolling-strategy">استراتژی / ترکیب قراردادها<select id="h-rolling-strategy"><option value="">ابتدا یک تحلیل معتبر اجرا کن</option></select></label>
          <label for="h-rolling-entry">قیمت ورود<select id="h-rolling-entry">${basisOptions(false)}</select></label>
          <label for="h-rolling-exit">قیمت تسویه / آفست<select id="h-rolling-exit">${basisOptions(false)}</select></label>
          <label for="h-rolling-units">تعداد واحد<input id="h-rolling-units" type="number" min="1" max="10000" step="1" value="${Math.max(1, state.settings.qtyDefault || 1)}"></label>
          <label for="h-rolling-start">شروع بررسی<select id="h-rolling-start"></select></label>
          <label for="h-rolling-end">پایان بررسی<select id="h-rolling-end"></select></label>
          <label for="h-rolling-base-value">حداقل ارزش پایه (میلیارد ریال)<input id="h-rolling-base-value" type="number" min="0" step="0.1" value="0"></label>
          <label for="h-rolling-base-volume">حداقل حجم پایه<input id="h-rolling-base-volume" type="number" min="0" step="1" value="0"></label>
          <label for="h-rolling-leg-value">حداقل ارزش هر قرارداد (میلیون ریال)<input id="h-rolling-leg-value" type="number" min="0" step="0.1" value="0"></label>
          <label for="h-rolling-leg-volume">حداقل حجم هر قرارداد<input id="h-rolling-leg-volume" type="number" min="0" step="1" value="0"></label>
        </div>
        <p class="note">تنظیمات این بخش مستقل از تحلیل اصلی است. هر خانه نتیجه ورود با مبنای انتخابی در تاریخ ردیف و آفست با مبنای انتخابی در تاریخ ستون است؛ کارمزدهای تنظیمات برنامه اعمال می‌شوند.</p>
        <div id="h-rolling-out" class="rolling-wrap"></div>
      </section>

      <section class="card">
        <div class="section-head"><div><p class="eyebrow">ردیف = تاریخ ورود؛ ستون = تاریخ خروج</p><h2>ماتریس بازده ورود × خروج و مسیر معامله</h2></div><div class="matrix-mode" role="group" aria-label="نوع بازده ماتریس"><button type="button" class="ghost" data-matrix-mode="cumulative" aria-pressed="true">انباشته از ورود</button><button type="button" class="ghost" data-matrix-mode="daily" aria-pressed="false">تغییر همان روز</button></div></div>
        <p class="note">روی هر عدد کلیک کن تا مسیر کامل معامله، بهترین/بدترین نقطه، افت، کارمزد، اثر هر پا و نسبت سود حفظ‌شده تا خروج نمایش داده شود.</p>
        <div id="h-return-matrix" class="rolling-wrap"><p class="empty-note">ابتدا «محاسبه ماتریس» را بزن.</p></div>
        <div id="h-trade-detail" class="trade-detail" hidden></div>
        <div class="section-head holding-head"><div><p class="eyebrow">تجمیع همه تاریخ‌های ورود</p><h3>پروفایل افق نگهداری</h3></div><span>برای کشف افق پایدار، میانه بازده با جریمه پراکندگی رتبه‌بندی می‌شود.</span></div>
        <div id="h-holding-profile" class="history-table-wrap"><p class="empty-note">پس از محاسبه ماتریس ساخته می‌شود.</p></div>
      </section>
    </section>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const baseSelect = $('h-base'), strategySelect = $('h-strategy'), modeSelect = $('h-mode');
  const entrySelect = $('h-entry'), exitSelect = $('h-exit'), status = $('h-status');
  const loadBtn = $('h-load'), runBtn = $('h-run'), exportBtn = $('h-export');
  let chain = new Map(), ua = null, analysisUa = null, contracts = [], seriesByIns = {}, dates = [];
  let currentReplay = null, currentArgs = null, autoRows = [], selectedAuto = null;
  let rollingResult = null, rollingArgs = null, rollingCandidates = [], matrixMode = 'cumulative', payoffChart = null;
  let worker = null, seq = 0, rollingResolve = null;

  for (const [group, title] of Object.entries(GROUPS)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = title;
    for (const def of CATALOG.filter((d) => d.group === group)) {
      const option = document.createElement('option');
      option.value = def.id;
      option.textContent = `${def.name}${def.feasible ? '' : ' — مطالعه‌ای'}`;
      optgroup.appendChild(option);
    }
    strategySelect.appendChild(optgroup);
  }
  strategySelect.value = 'short-strangle';
  $('h-filter').disabled = true;

  const setStatus = (text, error = false) => {
    status.textContent = text;
    status.toggleAttribute('data-error', error);
  };

  const liquidityArgs = () => ({
    minBaseValue: Math.max(0, Number($('h-base-value').value) || 0) * 1e9,
    minBaseVolume: Math.max(0, Number($('h-base-volume').value) || 0),
    minLegValue: Math.max(0, Number($('h-leg-value').value) || 0) * 1e6,
    minLegVolume: Math.max(0, Number($('h-leg-volume').value) || 0),
  });

  const rollingLiquidityArgs = () => ({
    minBaseValue: Math.max(0, Number($('h-rolling-base-value').value) || 0) * 1e9,
    minBaseVolume: Math.max(0, Number($('h-rolling-base-volume').value) || 0),
    minLegValue: Math.max(0, Number($('h-rolling-leg-value').value) || 0) * 1e6,
    minLegVolume: Math.max(0, Number($('h-rolling-leg-volume').value) || 0),
  });

  const basisName = (value) => HISTORY_BASES.find(([key]) => key === value)?.[1] || value || '—';
  const legSignature = (legs = []) => legs.map((leg) => `${leg.ins}|${leg.side}|${leg.ratio}`).join('::');

  function renderFrozenStrategy(legs, replay, label = '') {
    const def = byId(strategySelect.value);
    const first = replay.rows.find((row) => Number.isFinite(row.baseClose));
    const title = label || def?.name || 'ترکیب انتخاب‌شده';
    const entryMethod = Object.keys(currentArgs?.manualEntry || {}).length ? 'دستی هر پا' : basisName(currentArgs?.entryBasis);
    const cards = replay.priced.map((leg, index) => {
      const kind = leg.kind === 'call' ? 'اختیار خرید' : leg.kind === 'put' ? 'اختیار فروش' : 'دارایی پایه';
      const side = leg.side === 'buy' ? 'خرید' : 'فروش';
      const strike = leg.kind === 'underlying' ? '—' : fmt.int(leg.strike);
      const expiry = leg.expiry ? historyDateLabel(leg.expiry) : '—';
      return `<article class="frozen-leg">
        <b>${faDigits(index + 1)}. ${esc(side)} ${esc(kind)} · ${esc(leg.name || leg.ins)}</b>
        <span>کد <strong>${esc(leg.ins)}</strong></span><span>اعمال <strong>${strike}</strong></span>
        <span>سررسید <strong>${expiry}</strong></span><span>اندازه <strong>${fmt.int(leg.size || 1)}</strong></span>
        <span>نسبت کل <strong>${fmt.num(leg.ratio)}</strong></span><span>ورود <strong>${fmt.money(leg.price)}</strong></span>
      </article>`;
    }).join('');
    $('h-frozen-strategy').innerHTML = `<div class="frozen-summary">
      <span>استراتژی انتخاب‌شده · ثابت هنگام پیمایش</span><b>${esc(title)}</b>
      <small>پایه ${esc(ua?.name || '')} (${esc(ua?.ins || '')}) · قیمت پایه ورود ${fmt.money(first?.baseClose)} · ${historyDateLabel(replay.startDate)} تا ${historyDateLabel(replay.endDate)} · ورود ${esc(entryMethod)} / خروج ${esc(basisName(currentArgs?.exitBasis))}</small>
    </div><div class="frozen-legs">${cards}</div>`;
  }

  function refreshRollingDates() {
    const start = $('h-rolling-start'), end = $('h-rolling-end');
    const options = dates.map((date) => `<option value="${date}">${historyDayName(date)} ${historyDateLabel(date)}</option>`).join('');
    start.innerHTML = options; end.innerHTML = options;
    if (dates.length) {
      start.value = String(dates[Math.max(0, Number($('h-start').value) || 0)]);
      end.value = String(dates[Math.min(dates.length - 1, Number($('h-end').value) || dates.length - 1)]);
    }
  }

  function setRollingCandidates(candidates, preferredLegs = null) {
    rollingCandidates = candidates.filter((item) => item?.legs?.length);
    const select = $('h-rolling-strategy');
    select.innerHTML = rollingCandidates.length
      ? rollingCandidates.map((item, index) => `<option value="${index}">${esc(item.label)}</option>`).join('')
      : '<option value="">ابتدا یک تحلیل معتبر اجرا کن</option>';
    if (preferredLegs) {
      const preferred = legSignature(preferredLegs);
      const index = rollingCandidates.findIndex((item) => legSignature(item.legs) === preferred);
      if (index >= 0) select.value = String(index);
    }
  }

  function rollingArgsForSelection() {
    const candidate = rollingCandidates[Number($('h-rolling-strategy').value)];
    if (!candidate) throw new Error('برای ماتریس یک استراتژی یا ترکیب قرارداد انتخاب کن');
    const startDate = Number($('h-rolling-start').value), endDate = Number($('h-rolling-end').value);
    if (!startDate || !endDate || startDate > endDate) throw new Error('بازه زمانی ماتریس معتبر نیست');
    return {
      legs: candidate.legs, seriesByIns, baseIns: String(ua.ins), startDate, endDate,
      entryBasis: $('h-rolling-entry').value, exitBasis: $('h-rolling-exit').value,
      manualEntry: {}, units: Math.max(1, Math.trunc(Number($('h-rolling-units').value) || 1)),
      fees: feesOf(state.settings), settings: state.settings, liquidity: rollingLiquidityArgs(),
    };
  }

  const selectedExpirySet = () => new Set([...root.querySelectorAll('[data-history-expiry]:checked')].map((input) => Number(input.value)));

  function paintExpirySummary() {
    const selected = selectedExpirySet();
    const total = ua?.expiryList?.length || 0;
    const def = byId(strategySelect.value);
    $('h-expiry-summary').textContent = !total ? 'سررسیدی موجود نیست'
      : selected.size === total ? `همه ${fmt.int(total)} سررسید`
        : selected.size ? `${fmt.int(selected.size)} از ${fmt.int(total)} سررسید`
          : 'هیچ سررسیدی انتخاب نشده';
    $('h-expiry-summary').classList.toggle('warn', selected.size < (def?.expiries || 1));
  }

  function invalidateLoadedHistory() {
    analysisUa = null; contracts = []; seriesByIns = {}; dates = [];
    rollingArgs = null; rollingResult = null; setRollingCandidates([]);
    runBtn.disabled = true; exportBtn.disabled = true;
    $('h-range').hidden = true; $('h-legs-card').hidden = true; $('h-results').hidden = true;
  }

  function buildExpiryControls() {
    const host = $('h-expiry-list');
    host.innerHTML = '';
    for (const expiry of ua?.expiryList || []) {
      const date = normalizeHistoryDate(expiry.endDate);
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${date}" data-history-expiry checked><span>${historyDateLabel(date)}</span><small>${fmt.int(expiry.days)} روز · ${fmt.int(expiry.strikeList?.length || 0)} قیمت اعمال</small>`;
      label.querySelector('input').addEventListener('change', () => { paintExpirySummary(); invalidateLoadedHistory(); });
      host.appendChild(label);
    }
    paintExpirySummary();
  }

  function ensureHistoryWorker() {
    if (worker) return worker;
    worker = new Worker('/worker/history-worker.mjs', { type: 'module' });
    worker.onmessage = (event) => {
      const m = event.data;
      if (m.type === 'progress') {
        setStatus(`${fmt.int(m.done)} از ${fmt.int(m.total)} ترکیب بررسی شد…`);
        return;
      }
      if (rollingResolve && m.id === rollingResolve.id) {
        const resolve = rollingResolve.resolve;
        rollingResolve = null;
        resolve(m);
        return;
      }
      root.dispatchEvent(new CustomEvent(`history:${m.id}`, { detail: m }));
    };
    return worker;
  }

  const askWorker = (message) => new Promise((resolve) => {
    const id = ++seq;
    const handler = (event) => { root.removeEventListener(`history:${id}`, handler); resolve(event.detail); };
    root.addEventListener(`history:${id}`, handler);
    ensureHistoryWorker().postMessage({ ...message, id });
  });

  async function loadUniverse() {
    try {
      const response = await fetch('/api/history/universe');
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error || 'فهرست دریافت نشد');
      chain = buildChain(payload.rows || []);
      baseSelect.innerHTML = '<option value="">نماد پایه را انتخاب کن</option>';
      for (const item of [...chain.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa'))) {
        const option = document.createElement('option');
        option.value = item.ins;
        option.textContent = `${item.name} — ${fmt.int(item.contracts)} قرارداد${item.value > 0 ? ` — ارزش امروز ${fmt.money(item.value)}` : ''}`;
        baseSelect.appendChild(option);
      }
      setStatus(`${fmt.int(chain.size)} نماد پایه آماده است.`);
    } catch (error) {
      setStatus(`فهرست قراردادهای فعال دریافت نشد: ${error.message}`, true);
    }
  }

  const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  async function loadHistory() {
    ua = chain.get(baseSelect.value);
    if (!ua) { setStatus('اول نماد پایه را انتخاب کن.', true); return; }
    const expirySet = selectedExpirySet();
    if (!expirySet.size) { setStatus('دست‌کم یک سررسید را انتخاب کن.', true); return; }
    analysisUa = { ...ua, expiryList: ua.expiryList.filter((expiry) => expirySet.has(normalizeHistoryDate(expiry.endDate))) };
    contracts = flattenActiveContracts(analysisUa);
    if (!contracts.length) { setStatus('در سررسیدهای انتخاب‌شده قراردادی پیدا نشد.', true); return; }
    const codes = [...new Set([String(ua.ins), ...contracts.map((c) => String(c.ins))])];
    loadBtn.disabled = true; runBtn.disabled = true;
    setStatus(`در حال دریافت تاریخچه ${fmt.int(codes.length)} نماد…`);
    try {
      const payloads = await Promise.all(chunks(codes, 70).map(async (part) => {
        const response = await fetch(`/api/dailies?ins=${part.join(',')}&n=0`);
        const payload = await response.json();
        if (!response.ok || payload.error) throw new Error(payload.error || 'تاریخچه دریافت نشد');
        return payload;
      }));
      seriesByIns = {};
      for (const payload of payloads) {
        for (const [ins, value] of Object.entries(payload)) seriesByIns[ins] = value.rows || [];
      }
      const optionSeries = contracts.map((c) => seriesByIns[String(c.ins)] || []).filter((rows) => rows.length);
      const firstContractDate = Math.min(...optionSeries.map((rows) => Number(rows[0].date)).filter(Boolean));
      const lastContractDate = Math.max(...optionSeries.map((rows) => Number(rows.at(-1).date)).filter(Boolean));
      dates = (seriesByIns[String(ua.ins)] || [])
        .map((r) => Number(r.date)).filter((d) => d && d >= firstContractDate && d <= lastContractDate)
        .sort((a, b) => a - b);
      if (!dates.length) throw new Error('برای نماد پایه تاریخچه‌ای برنگشت');
      const start = $('h-start'), end = $('h-end');
      start.max = end.max = String(dates.length - 1);
      start.value = String(Math.max(0, dates.length - 15));
      end.value = String(dates.length - 1);
      $('h-range').hidden = false;
      runBtn.disabled = false;
      buildLegControls();
      paintRange();
      refreshRollingDates();
      $('h-rolling-entry').value = entrySelect.value === 'MANUAL' ? 'CLOSE' : entrySelect.value;
      $('h-rolling-exit').value = exitSelect.value;
      $('h-rolling-units').value = $('h-units').value;
      $('h-rolling-base-value').value = $('h-base-value').value;
      $('h-rolling-base-volume').value = $('h-base-volume').value;
      $('h-rolling-leg-value').value = $('h-leg-value').value;
      $('h-rolling-leg-volume').value = $('h-leg-volume').value;
      const withData = codes.filter((code) => seriesByIns[code]?.length).length;
      setStatus(`تاریخچه ${fmt.int(withData)} از ${fmt.int(codes.length)} نماد آماده است.`);
    } catch (error) {
      setStatus(`دریافت تاریخچه کامل نشد: ${error.message}`, true);
    } finally {
      loadBtn.disabled = false;
    }
  }

  function paintRange() {
    if (!dates.length) return;
    const start = $('h-start'), end = $('h-end');
    if (+start.value > +end.value) {
      if (document.activeElement === start) end.value = start.value; else start.value = end.value;
    }
    $('h-range-label').textContent = `${historyDayName(dates[+start.value])} ${historyDateLabel(dates[+start.value])} تا ${historyDayName(dates[+end.value])} ${historyDateLabel(dates[+end.value])}`;
    const startRow = (seriesByIns[String(ua?.ins)] || []).find((r) => Number(r.date) === dates[+start.value]);
    if (startRow) {
      const official = Number(startRow.value) || 0;
      const estimated = official > 0 ? official : (Number(startRow.vol) || 0) * (Number(startRow.close) || 0);
      $('h-base-liquidity').innerHTML = `<b>${esc(ua?.name || '')} در روز شروع</b><span>حجم ${fmt.int(Number(startRow.vol) || 0)}</span><span>تعداد معامله ${fmt.int(Number(startRow.trades) || 0)}</span><span>ارزش ${valueLabel(estimated, !official && estimated > 0)} ریال</span>${!official && estimated > 0 ? '<small>≈ برآورد حجم × پایانی؛ مقدار رسمی در تاریخچه موجود نبوده است.</small>' : ''}`;
    } else $('h-base-liquidity').textContent = 'برای روز شروع داده نقدشوندگی موجود نیست.';
  }

  function buildLegControls() {
    const def = byId(strategySelect.value);
    const host = $('h-legs');
    host.innerHTML = '';
    if (!ua || !def) return;
    const manual = entrySelect.value === 'MANUAL';
    def.legs.forEach((leg, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'history-leg';
      const heading = document.createElement('b');
      heading.textContent = legLabel(leg, index);
      wrap.appendChild(heading);
      if (leg.kind === 'underlying') {
        const fixed = document.createElement('span');
        fixed.textContent = `${ua.name} — سهم پایه`;
        wrap.appendChild(fixed);
      } else {
        const select = document.createElement('select');
        select.dataset.leg = String(index);
        select.setAttribute('aria-label', `قرارداد پای ${index + 1}`);
        for (const c of contracts.filter((x) => x.kind === leg.kind)) {
          const option = document.createElement('option');
          option.value = c.ins;
          option.textContent = contractLabel(c);
          select.appendChild(option);
        }
        wrap.appendChild(select);
      }
      const price = document.createElement('input');
      price.type = 'number'; price.min = '0'; price.step = 'any';
      price.placeholder = 'قیمت دستی ورود';
      price.dataset.manual = String(index);
      price.hidden = !manual;
      price.setAttribute('aria-label', `قیمت دستی پای ${index + 1}`);
      wrap.appendChild(price);
      host.appendChild(wrap);
    });
    $('h-legs-card').hidden = modeSelect.value !== 'manual';
  }

  function manualLegs() {
    const def = byId(strategySelect.value);
    const optionLegs = [];
    def.legs.forEach((t, index) => {
      if (t.kind === 'underlying') return;
      const ins = root.querySelector(`select[data-leg="${index}"]`)?.value;
      const c = contracts.find((x) => String(x.ins) === String(ins));
      if (c) optionLegs.push({ index, template: t, contract: c });
    });
    const nearestExpiry = Math.min(...optionLegs.map((x) => x.contract.expiry));
    const size = optionLegs[0]?.contract.size || 1000;
    return def.legs.map((t, index) => {
      if (t.kind === 'underlying') return { kind: 'underlying', side: t.side, ratio: t.ratio, size, ins: String(ua.ins), name: ua.name, expiry: nearestExpiry };
      const found = optionLegs.find((x) => x.index === index)?.contract;
      return found ? { ...found, side: t.side, ratio: t.ratio, slot: t.slot, exp: t.exp } : null;
    }).filter(Boolean);
  }

  function manualPrices() {
    const out = {};
    if (entrySelect.value !== 'MANUAL') return out;
    for (const input of root.querySelectorAll('[data-manual]')) {
      if (input.value !== '') out[input.dataset.manual] = Number(input.value);
    }
    return out;
  }

  function argsFor(legs, manualEntry = {}) {
    return {
      legs, seriesByIns, baseIns: String(ua.ins),
      startDate: dates[+$('h-start').value], endDate: dates[+$('h-end').value],
      entryBasis: entrySelect.value === 'MANUAL' ? 'CLOSE' : entrySelect.value,
      exitBasis: exitSelect.value,
      manualEntry, units: Math.max(1, Math.trunc(Number($('h-units').value) || 1)),
      fees: feesOf(state.settings), settings: state.settings, liquidity: liquidityArgs(),
    };
  }

  function paintKpis(replay) {
    const s = replay.summary;
    const items = [
      ['نتیجه پایان', s.last ? fmt.money(s.last.netPnl) : '—', signTone(s.last?.netPnl)],
      ['بازده پایان', s.last ? fmt.pct(s.last.returnPct) : '—', signTone(s.last?.returnPct)],
      ['بهترین آفست', s.best ? `${fmt.money(s.best.netPnl)} · ${s.best.dateLabel}` : '—', 'gain'],
      ['بدترین آفست', s.worst ? `${fmt.money(s.worst.netPnl)} · ${s.worst.dateLabel}` : '—', 'loss'],
      ['بیشترین افت', fmt.money(s.maxDrawdown), signTone(s.maxDrawdown)],
      ['آفست‌های سودده', `${fmt.int(s.positiveDays)} از ${fmt.int(s.validDays)} · ${fmt.pct(s.positivePct)}`, 'gain'],
      ['آفست‌های زیان‌ده', `${fmt.int(s.negativeDays)} از ${fmt.int(s.validDays)} · ${fmt.pct(s.negativePct)}`, s.negativeDays ? 'loss' : 'gain'],
      ['آفست‌های سربه‌سر', `${fmt.int(s.flatDays)} · ${fmt.pct(s.flatPct)}`, 'flat'],
      ['میانگین نتیجه', `${fmt.money(s.meanPnl)} · ${fmt.pct(s.meanReturn)}`, signTone(s.meanPnl)],
      ['میانه نتیجه', `${fmt.money(s.medianPnl)} · ${fmt.pct(s.medianReturn)}`, signTone(s.medianPnl)],
      ['ضریب سود', fmt.num(s.profitFactor), s.profitFactor >= 1 ? 'gain' : 'loss'],
      ['اولین روز سود', s.firstProfit ? `${s.firstProfit.dayName} ${s.firstProfit.dateLabel}` : 'نداشت', s.firstProfit ? 'gain' : 'flat'],
      ['سرمایه درگیر', `${fmt.money(s.capital)} · ${s.capitalLabel || ''}`, 'flat'],
      ['مبلغ پرداختی ورود', fmt.money(s.cashPaid), 'flat'],
      ['مبلغ دریافتی ورود', fmt.money(s.cashReceived), 'flat'],
      ['خالص جریان نقدی ورود', fmt.money(s.netCash), signTone(s.netCash)],
      ['وجه تضمین خالص ورود', s.marginNet > 0 ? fmt.money(s.marginNet) : 'بدون وجه تضمین', 'flat'],
      ['کارمزد ورود', fmt.money(s.entryFee), 'flat'],
      ['روز فاقد داده', fmt.int(s.missingDays), s.missingDays ? 'loss' : 'gain'],
      ['روز حذف‌شده با فیلتر نقدشوندگی', fmt.int(s.liquidityDays), s.liquidityDays ? 'loss' : 'gain'],
    ];
    $('h-kpis').innerHTML = items.map(([label, value, tone]) => `<article class="history-kpi ${tone || 'flat'}"><span>${esc(label)}</span><b>${esc(value)}</b></article>`).join('');
  }

  function paintStatistics(replay) {
    const s = replay.summary;
    const stats = [
      ['تعداد آفست معتبر', fmt.int(s.validDays), 'روز معاملاتی'],
      ['مثبت / منفی / سربه‌سر', `${fmt.int(s.positiveDays)} / ${fmt.int(s.negativeDays)} / ${fmt.int(s.flatDays)}`, `${fmt.pct(s.positivePct)} / ${fmt.pct(s.negativePct)} / ${fmt.pct(s.flatPct)}`],
      ['میانگین / میانه سود', `${fmt.money(s.meanPnl)} / ${fmt.money(s.medianPnl)}`, 'ریال'],
      ['انحراف معیار سود', fmt.money(s.pnlStdDev), 'پراکندگی نتیجه آفست‌ها'],
      ['میانگین / میانه بازده', `${fmt.pct(s.meanReturn)} / ${fmt.pct(s.medianReturn)}`, 'روی سرمایه درگیر'],
      ['انحراف معیار بازده', fmt.pct(s.returnStdDev), 'ریسک پراکندگی'],
      ['صدک ۱۰ / ۲۵', `${fmt.pct(s.p10)} / ${fmt.pct(s.p25)}`, 'کران پایین توزیع'],
      ['صدک ۷۵ / ۹۰', `${fmt.pct(s.p75)} / ${fmt.pct(s.p90)}`, 'کران بالای توزیع'],
      ['میانگین سود / میانگین زیان', `${fmt.money(s.avgGain)} / ${fmt.money(s.avgLoss)}`, 'به‌ازای یک روز آفست'],
      ['ضریب سود', fmt.num(s.profitFactor), 'جمع سودها ÷ قدرمطلق جمع زیان‌ها'],
      ['طولانی‌ترین رشته مثبت / منفی', `${fmt.int(s.longestPositive)} / ${fmt.int(s.longestNegative)}`, 'روز معاملاتی'],
      ['همبستگی بازده با تغییر پایه', fmt.num(s.returnBaseCorrelation), 'از ۱− تا ۱+'],
    ];
    $('h-stats').innerHTML = `<table class="history-table"><thead><tr><th>شاخص</th><th>مقدار</th><th>توضیح</th></tr></thead><tbody>${stats.map(([k, v, note]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td><td>${esc(note)}</td></tr>`).join('')}</tbody></table>`;

    const groups = new Map();
    replay.rows.filter((r) => r.status === 'ok').forEach((r) => {
      const g = groups.get(r.dayName) || [];
      g.push(r); groups.set(r.dayName, g);
    });
    $('h-weekday-stats').innerHTML = `<table class="history-table"><thead><tr><th>روز هفته</th><th>تعداد</th><th>مثبت</th><th>منفی</th><th>درصد مثبت</th><th>میانگین سود</th><th>میانه بازده</th></tr></thead><tbody>${[...groups].map(([day, rows]) => {
      const pos = rows.filter((r) => r.netPnl > 0).length;
      const sorted = rows.map((r) => r.returnPct).sort((a, b) => a - b);
      const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      return `<tr><td>${esc(day)}</td><td>${fmt.int(rows.length)}</td><td class="gain">${fmt.int(pos)}</td><td class="loss">${fmt.int(rows.filter((r) => r.netPnl < 0).length)}</td><td>${fmt.pct((pos / rows.length) * 100)}</td><td class="${signTone(rows.reduce((a, r) => a + r.netPnl, 0))}">${fmt.money(rows.reduce((a, r) => a + r.netPnl, 0) / rows.length)}</td><td class="${signTone(med)}">${fmt.pct(med)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function paintDayTable(replay) {
    const legHeads = replay.priced.map((l, i) => `<th>${esc(legLabel(l, i))}</th>`).join('');
    const table = $('h-days-head').closest('table');
    delete table.dataset.sorts;
    $('h-days-head').innerHTML = `<tr><th>روز</th><th>نماد پایه</th><th>پایانی پایه</th><th>حجم پایه</th><th>ارزش پایه</th><th>تعداد معامله پایه</th><th>تغییر روزانه</th><th>تغییر از ورود</th>${legHeads}<th>سود ناخالص</th><th>کارمزد کل</th><th>سود خالص</th><th>تغییر سود روز</th><th>بازده</th><th>افت از قله</th><th>وجه تضمین خالص</th><th>وضعیت</th></tr>`;
    $('h-days').innerHTML = replay.rows.map((r) => {
      const legCells = r.perLeg.map((l) => `<td title="ورود ${fmt.money(l.entryPrice)}"><b>${Number.isFinite(l.exitPrice) ? fmt.money(l.exitPrice) : '—'}</b><small class="${signTone(l.netPnl)}">اثر ${Number.isFinite(l.netPnl) ? fmt.money(l.netPnl) : '—'}</small><small class="${signTone(l.pnlDelta)}">Δ ${Number.isFinite(l.pnlDelta) ? fmt.money(l.pnlDelta) : '—'} · حجم ${fmt.int(l.volume)} · ارزش ${valueLabel(l.value, l.valueEstimated)}</small></td>`).join('');
      const statusText = r.status === 'ok' ? 'معتبر'
        : r.status === 'liquidity' ? `حذف نقدشوندگی${r.baseLiquid ? '' : ' · پایه'}${r.illiquidLegs?.length ? ` · پای ${faDigits(r.illiquidLegs.map((i) => i + 1).join('،'))}` : ''}`
          : `فاقد داده · پای ${faDigits((r.missingLegs || []).map((i) => i + 1).join('،'))}`;
      return `<tr class="${r.status === 'missing' ? 'history-missing' : r.status === 'liquidity' ? 'history-liquidity' : ''}">
        <td><b>${esc(r.dayName)}</b><small>${esc(r.dateLabel)} · روز ${fmt.int(r.holdingDays)}</small></td>
        <td><b>${esc(ua?.name || '')}</b><small>${esc(ua?.ins || '')}</small></td><td>${fmt.money(r.baseClose)}</td><td>${fmt.int(r.baseVolume)}</td><td>${valueLabel(r.baseValue, r.baseValueEstimated)}</td><td>${fmt.int(r.baseTrades)}</td><td class="${signTone(r.baseDailyPct)}">${fmt.pct(r.baseDailyPct)}</td><td class="${signTone(r.baseCumulativePct)}">${fmt.pct(r.baseCumulativePct)}</td>
        ${legCells}<td>${Number.isFinite(r.grossPnl) ? fmt.money(r.grossPnl) : '—'}</td><td>${Number.isFinite(r.totalFees) ? fmt.money(r.totalFees) : '—'}</td>
        <td class="${signTone(r.netPnl)}">${Number.isFinite(r.netPnl) ? fmt.money(r.netPnl) : '—'}</td><td class="${signTone(r.pnlDelta)}">${Number.isFinite(r.pnlDelta) ? fmt.money(r.pnlDelta) : '—'}</td><td class="${signTone(r.returnPct)}">${Number.isFinite(r.returnPct) ? fmt.pct(r.returnPct) : '—'}</td>
        <td class="${signTone(r.drawdown)}">${Number.isFinite(r.drawdown) ? fmt.money(r.drawdown) : '—'}</td><td>${Number.isFinite(r.marginNet) && r.marginNet > 0 ? fmt.money(r.marginNet) : 'بدون وجه تضمین'}</td><td>${esc(statusText)}</td>
      </tr>`;
    }).join('');
    enableColumnSort(table);
  }

  function paintContrib(replay) {
    const last = replay.rows.filter((r) => r.status === 'ok').at(-1);
    $('h-leg-contrib').innerHTML = last ? last.perLeg.map((l, i) => `<div><span>${esc(legLabel(replay.priced[i], i))}</span><b class="${signTone(l.netPnl)}">${fmt.money(l.netPnl)}</b><small>ورود ${fmt.money(l.entryPrice)} · خروج ${fmt.money(l.exitPrice)}</small></div>`).join('') : '<p class="empty-note">داده معتبر نیست.</p>';
  }

  function paintLegEvolution(replay) {
    const rows = replay.rows.map((r) => ({ ...r, ...Object.fromEntries((r.perLeg || []).map((l, i) => [`leg${i}`, l.netPnl])) }));
    const colors = ['#0b6e6b', '#a86c16', '#7254a3', '#a81f32', '#2f6f9f'];
    lineChart($('h-leg-chart'), rows, replay.priced.map((leg, i) => ({ key: `leg${i}`, label: legLabel(leg, i), color: colors[i % colors.length] })), { money: true });
  }

  function paintBasis(args) {
    const matrix = basisMatrix(args);
    const map = new Map(matrix.map((r) => [`${r.entry}|${r.exit}`, r.result]));
    $('h-basis-matrix').innerHTML = `<table class="history-table"><thead><tr><th>ورود \ آفست</th>${HISTORY_BASES.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${HISTORY_BASES.map(([e, el]) => `<tr><th>${el}</th>${HISTORY_BASES.map(([x]) => { const r = map.get(`${e}|${x}`); return `<td class="${signTone(r?.returnPct)}">${r ? fmt.pct(r.returnPct) : '—'}<small>${r ? fmt.money(r.netPnl) : ''}</small></td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
    enableColumnSort($('h-basis-matrix').querySelector('table'));
  }

  function paintSensitivity(args, replay) {
    const rows = entrySensitivity(args);
    $('h-sensitivity').innerHTML = `<table class="history-table"><thead><tr><th>پا</th><th>شوک ورود</th><th>قیمت ورود</th><th>نتیجه پایان</th><th>بازده</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(legLabel(replay.priced[r.legIndex], r.legIndex))}</td><td class="${signTone(r.shockPct)}">${fmt.pct(r.shockPct)}</td><td>${fmt.money(r.entryPrice)}</td><td class="${signTone(r.result?.netPnl)}">${r.result ? fmt.money(r.result.netPnl) : '—'}</td><td class="${signTone(r.result?.returnPct)}">${r.result ? fmt.pct(r.result.returnPct) : '—'}</td></tr>`).join('')}</tbody></table>`;
    enableColumnSort($('h-sensitivity').querySelector('table'));
  }

  function paintMargin(replay) {
    const margin = replay.entry.margin;
    const rows = margin?.perLeg || [];
    const last = replay.rows.filter((r) => r.status === 'ok').at(-1);
    const summary = [
      ['کل وجه تضمین ورود', margin?.margin > 0 ? fmt.money(margin.margin) : 'بدون وجه تضمین'],
      ['وجه تضمین خالص ورود', margin?.marginNet > 0 ? fmt.money(margin.marginNet) : 'بدون وجه تضمین'],
      ['وجه تضمین شرطی', margin?.conditionalMargin > 0 ? fmt.money(margin.conditionalMargin) : '—'],
      ['وجه تضمین خالص آخرین روز', last?.marginNet > 0 ? fmt.money(last.marginNet) : 'بدون وجه تضمین'],
      ['وضعیت پوشش', margin?.coverage || '—'],
    ];
    $('h-margin').innerHTML = `<div class="margin-summary">${summary.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>${rows.length ? `<table class="history-table"><thead><tr><th>پای فروش</th><th>اعمال</th><th>اولیه</th><th>لازم</th><th>حداقل نگهداشت</th><th>سهم مطالبه‌شده</th><th>پوشش‌دار</th><th>لخت</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(legLabel(replay.priced[r.index], r.index))}</td><td>${fmt.int(r.strike)}</td><td>${fmt.money(r.initial)}</td><td>${fmt.money(r.required)}</td><td>${fmt.money(r.minimum)}</td><td>${fmt.money(r.due)}</td><td>${fmt.num(r.covered)}</td><td class="${r.naked > 0 ? 'loss' : 'gain'}">${fmt.num(r.naked)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-note">این موقعیت پای فروش مشمول وجه تضمین ندارد.</p>'}`;
    enableColumnSort($('h-margin').querySelector('table'));
  }

  function paintOptimal(args, replay) {
    const result = optimizeExitPolicy(args);
    const observed = result.bestObserved;
    const observedPrices = observed?.perLeg?.map((leg, index) => `<li><span>${esc(legLabel(replay.priced[index], index))}</span><b>${fmt.money(leg.exitPrice)}</b></li>`).join('') || '';
    const best = result.bestPolicy;
    $('h-optimal').innerHTML = `${observed ? `<article class="optimal-observed"><span>بهترین خروج مشاهده‌شده برای همین ورود</span><b>${observed.dayName} ${observed.dateLabel} · ${fmt.money(observed.netPnl)} · ${fmt.pct(observed.returnPct)}</b><ul>${observedPrices}</ul></article>` : '<p class="empty-note">خروج معتبر مشاهده نشد.</p>'}
      ${best ? `<article class="optimal-policy"><span>بهترین قاعده روی ${fmt.int(best.samples)} ورود تاریخی</span><b>هدف ${fmt.pct(best.targetPct)}؛ حداکثر ${fmt.int(best.maxTradingDays)} روز معاملاتی</b><p>میانه بازده ${fmt.pct(best.medianReturn)} · میانگین ${fmt.pct(best.meanReturn)} · موفقیت ${fmt.pct(best.winPct)} · رسیدن به هدف ${fmt.pct(best.targetHitPct)} · متوسط نگهداری ${fmt.num(best.avgTradingDays)} روز</p></article><table class="history-table"><thead><tr><th>هدف سود</th><th>حداکثر نگهداری</th><th>نمونه</th><th>میانه بازده</th><th>میانگین بازده</th><th>درصد موفقیت</th><th>رسیدن به هدف</th><th>متوسط زمان خروج</th></tr></thead><tbody>${result.policies.map((p) => `<tr><td>${fmt.pct(p.targetPct)}</td><td>${fmt.int(p.maxTradingDays)}</td><td>${fmt.int(p.samples)}</td><td class="${signTone(p.medianReturn)}">${fmt.pct(p.medianReturn)}</td><td class="${signTone(p.meanReturn)}">${fmt.pct(p.meanReturn)}</td><td>${fmt.pct(p.winPct)}</td><td>${fmt.pct(p.targetHitPct)}</td><td>${fmt.num(p.avgTradingDays)}</td></tr>`).join('')}</tbody></table><p class="note">«بهینه» بر اساس بیشترین میانه بازده رتبه‌بندی شده تا یک روز استثنایی نتیجه را منحرف نکند. این تحلیل تضمین اجرای سفارش یا تکرار آینده نیست.</p>` : '<p class="empty-note">برای برآورد قاعده خروج، تعداد روزهای ورود معتبر کافی نیست.</p>'}`;
    enableColumnSort($('h-optimal').querySelector('table'));
  }

  function renderDailyPayoff() {
    const valid = currentReplay?.rows?.filter((r) => r.status === 'ok' && Number.isFinite(r.baseClose)) || [];
    if (!valid.length) { $('h-daily-payoff').innerHTML = '<p class="empty-note">روز معتبر برای رسم وجود ندارد.</p>'; return; }
    const slider = $('h-payoff-day');
    slider.max = String(valid.length - 1);
    slider.value = String(Math.min(valid.length - 1, Math.max(0, Number(slider.value) || 0)));
    const row = valid[Number(slider.value)];
    $('h-payoff-date').textContent = `${row.dayName} ${row.dateLabel} · پایه ${fmt.money(row.baseClose)}`;
    const enabled = Object.fromEntries([...root.querySelectorAll('[data-payoff-layer]')].map((input) => [input.dataset.payoffLayer, input.checked]));
    payoffChart?.destroy?.();
    payoffChart = mountPayoff($('h-daily-payoff'), currentReplay.priced, currentReplay.entry.netCash, {
      fees: feesOf(state.settings), spot: row.baseClose, showToday: false, padPct: 0.38, layers: enabled,
    });
    const analysis = payoffChart.analysis;
    const capital = currentReplay.entry?.capital?.value;
    const bes = analysis?.breakevens || [];
    const nearest = bes.length ? bes.reduce((a, b) => Math.abs(b - row.baseClose) < Math.abs(a - row.baseClose) ? b : a) : NaN;
    const beDistance = Number.isFinite(nearest) && row.baseClose > 0 ? ((nearest / row.baseClose) - 1) * 100 : NaN;
    const maxProfitPct = Number.isFinite(analysis?.maxProfit) && capital > 0 ? (analysis.maxProfit / capital) * 100 : analysis?.maxProfit;
    const maxLossPct = Number.isFinite(analysis?.maxLoss) && capital > 0 ? (analysis.maxLoss / capital) * 100 : analysis?.maxLoss;
    const scenario = analysis?.at?.(row.baseClose);
    const decision = [
      ['سربه‌سری', bes.length ? bes.map((v) => fmt.money(v)).join(' · ') : 'ندارد'],
      ['نزدیک‌ترین فاصله', Number.isFinite(beDistance) ? `${fmt.pct(beDistance)} · ${fmt.money(nearest)}` : '—'],
      ['حداکثر سود', Number.isFinite(analysis?.maxProfit) ? `${fmt.money(analysis.maxProfit)} · ${fmt.pct(maxProfitPct)}` : 'نامحدود'],
      ['حداکثر زیان', Number.isFinite(analysis?.maxLoss) ? `${fmt.money(analysis.maxLoss)} · ${fmt.pct(maxLossPct)}` : 'نامحدود'],
      ['سناریوی سررسید در پایه روز', Number.isFinite(scenario) ? fmt.money(scenario) : '—'],
      ['آفست واقعی همان روز', `${fmt.money(row.netPnl)} · ${fmt.pct(row.returnPct)}`],
      ['تا سررسید', Number.isFinite(row.daysToExpiry) ? `${fmt.int(row.daysToExpiry)} روز` : '—'],
    ];
    $('h-payoff-decisions').innerHTML = decision.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');
    const chart = $('h-daily-payoff');
    chart.querySelectorAll('.fill-gain,.fill-loss').forEach((el) => { el.hidden = !enabled.fill; });
    chart.querySelectorAll('.strike,.strike-lbl').forEach((el) => { el.hidden = !enabled.strike; });
    chart.querySelectorAll('.be,.be-lbl').forEach((el) => { el.hidden = !enabled.be; });
    chart.querySelectorAll('.spot,.spot-lbl,.spot-pnl').forEach((el) => { el.hidden = !enabled.spot; });
    $('h-payoff-decisions').hidden = !enabled.metrics;
  }

  function heatColor(value, max) {
    if (!Number.isFinite(value)) return 'transparent';
    const alpha = 0.12 + Math.min(1, Math.abs(value) / Math.max(max, 1e-9)) * 0.76;
    return value >= 0 ? `rgba(11,110,107,${alpha})` : `rgba(168,31,50,${alpha})`;
  }

  function sampledDates(allDates) {
    const step = Math.max(1, Math.ceil(allDates.length / 45));
    return allDates.filter((_, i) => i % step === 0 || i === allDates.length - 1);
  }

  function renderReturnMatrix() {
    if (!rollingResult?.dates?.length) return;
    const shown = sampledDates(rollingResult.dates);
    const map = new Map((rollingResult.cells || []).map((c) => [`${c.entryDate}|${c.exitDate}`, c]));
    const key = matrixMode === 'daily' ? 'dailyReturnPct' : 'returnPct';
    const vals = [...map.values()].map((c) => Math.abs(c[key])).filter(Number.isFinite);
    const max = Math.max(...vals, 1);
    $('h-return-matrix').innerHTML = `<table class="rolling-table return-matrix"><thead><tr><th>ورود \ خروج</th>${shown.map((d) => `<th title="${historyDateLabel(d)}">${historyDateLabel(d).slice(5)}</th>`).join('')}</tr></thead><tbody>${shown.map((entry) => `<tr><th>${historyDateLabel(entry)}</th>${shown.map((exit) => {
      const c = map.get(`${entry}|${exit}`), value = c?.[key];
      if (!c || exit < entry) return '<td class="matrix-empty"></td>';
      const label = matrixMode === 'daily' ? 'تغییر همان روز' : 'بازده انباشته';
      return `<td style="background:${heatColor(value, max)}"><button type="button" data-trade-cell="${entry}|${exit}" title="${label}: ${fmt.pct(value)} · انباشته ${fmt.pct(c.returnPct)} · ${fmt.money(c.netPnl)}">${fmt.pct(value)}</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function renderHoldingProfile() {
    const profile = holdingPeriodProfile(rollingResult);
    const best = profile.best;
    $('h-holding-profile').innerHTML = `${best ? `<div class="holding-best"><span>افق مقاوم‌تر در این نمونه</span><b>${fmt.int(best.holdingTradingDays)} روز معاملاتی</b><small>امتیاز محافظه‌کارانه ${fmt.pct(best.robustScore)} · میانه ${fmt.pct(best.medianReturn)} · موفقیت ${fmt.pct(best.winPct)} · ${fmt.int(best.samples)} نمونه</small></div>` : ''}<table class="history-table"><thead><tr><th>روز نگهداری</th><th>نمونه</th><th>میانگین بازده</th><th>میانه بازده</th><th>چارک ۲۵٪</th><th>چارک ۷۵٪</th><th>انحراف معیار</th><th>درصد سودده</th><th>میانگین تغییر روز خروج</th><th>امتیاز مقاوم</th></tr></thead><tbody>${profile.rows.map((r) => `<tr${best === r ? ' class="holding-picked"' : ''}><td>${fmt.int(r.holdingTradingDays)}</td><td>${fmt.int(r.samples)}</td><td class="${signTone(r.meanReturn)}">${fmt.pct(r.meanReturn)}</td><td class="${signTone(r.medianReturn)}">${fmt.pct(r.medianReturn)}</td><td class="${signTone(r.p25)}">${fmt.pct(r.p25)}</td><td class="${signTone(r.p75)}">${fmt.pct(r.p75)}</td><td>${fmt.pct(r.returnStdDev)}</td><td>${fmt.pct(r.winPct)}</td><td class="${signTone(r.meanDailyChange)}">${fmt.pct(r.meanDailyChange)}</td><td class="${signTone(r.robustScore)}">${fmt.pct(r.robustScore)}</td></tr>`).join('')}</tbody></table><p class="note">امتیاز مقاوم = میانه بازده منهای یک‌چهارم انحراف معیار. این معیار برای مقایسه افق‌هاست، نه پیش‌بینی یا توصیه خرید و فروش.</p>`;
    enableColumnSort($('h-holding-profile').querySelector('table'));
  }

  function showTradeDetail(entryDate, exitDate) {
    const detail = replayTradeDetail(rollingArgs || currentArgs, entryDate, exitDate);
    const host = $('h-trade-detail');
    if (!detail.ok) { host.hidden = false; host.innerHTML = `<p class="empty-note">${esc(detail.error)}</p>`; return; }
    const { selected, best, worst, firstProfit, path } = detail;
    const selectedDailyPnl = detail.tradingDays === 0 ? selected.netPnl : selected.pnlDelta;
    const metrics = [
      ['ورود → خروج', `${historyDateLabel(entryDate)} ← ${historyDateLabel(exitDate)}`],
      ['مدت', `${fmt.int(detail.tradingDays)} روز معاملاتی · ${fmt.int(detail.calendarDays)} روز تقویمی`],
      ['بازده/سود خروج', `${fmt.pct(selected.returnPct)} · ${fmt.money(selected.netPnl)}`],
      ['تغییر همان روز', `${fmt.pct(detail.capital > 0 ? (selectedDailyPnl / detail.capital) * 100 : NaN)} · ${fmt.money(selectedDailyPnl)}`],
      ['بهترین نقطه مسیر', `${best.dateLabel} · ${fmt.pct(best.returnPct)} · ${fmt.money(best.netPnl)}`],
      ['بدترین نقطه مسیر', `${worst.dateLabel} · ${fmt.pct(worst.returnPct)} · ${fmt.money(worst.netPnl)}`],
      ['اولین روز سود', firstProfit ? `${firstProfit.dateLabel} · روز ${fmt.int(firstProfit.holdingDays)}` : 'نداشته'],
      ['سود حفظ‌شده از بهترین نقطه', Number.isFinite(detail.capturePct) ? fmt.pct(detail.capturePct) : '—'],
      ['بازده پایه', fmt.pct(selected.baseCumulativePct)],
      ['کل کارمزد ورود و خروج', fmt.money(selected.totalFees)],
    ];
    host.hidden = false;
    host.innerHTML = `<div class="section-head"><div><p class="eyebrow">جزئیات خانه انتخاب‌شده</p><h3>${historyDateLabel(entryDate)} تا ${historyDateLabel(exitDate)}</h3></div><button type="button" class="ghost" data-close-detail>بستن</button></div><div class="trade-detail-kpis">${metrics.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div><div class="history-chart" data-trade-path></div><div class="history-table-wrap"><table class="history-table"><thead><tr><th>تاریخ</th><th>روز</th><th>پایه</th><th>بازده پایه</th><th>سود خالص</th><th>بازده انباشته</th><th>تغییر همان روز</th><th>افت از قله</th><th>قیمت/اثر هر پا</th></tr></thead><tbody>${path.map((r, index) => { const daily = index === 0 ? r.netPnl : r.pnlDelta; return `<tr><td>${r.dateLabel}</td><td>${r.dayName}</td><td>${fmt.money(r.baseClose)}</td><td class="${signTone(r.baseCumulativePct)}">${fmt.pct(r.baseCumulativePct)}</td><td class="${signTone(r.netPnl)}">${fmt.money(r.netPnl)}</td><td class="${signTone(r.returnPct)}">${fmt.pct(r.returnPct)}</td><td class="${signTone(daily)}">${fmt.money(daily)}</td><td class="${signTone(r.drawdown)}">${fmt.money(r.drawdown)}</td><td>${r.perLeg.map((leg, i) => `${faDigits(i + 1)}: ${fmt.money(leg.exitPrice)} / ${fmt.money(leg.netPnl)}`).join('<br>')}</td></tr>`; }).join('')}</tbody></table></div>`;
    lineChart(host.querySelector('[data-trade-path]'), path, [
      { key: 'returnPct', label: 'بازده انباشته', color: '#0b6e6b' },
      { key: 'baseCumulativePct', label: 'بازده پایه', color: '#7254a3' },
    ]);
    enableColumnSort(host.querySelector('table'));
    host.querySelector('[data-close-detail]').addEventListener('click', () => { host.hidden = true; });
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderReplay(legs, manualEntry = {}, label = '') {
    const args = argsFor(legs, manualEntry);
    const replay = replayHistory(args);
    if (!replay.ok) { setStatus(replay.error, true); return; }
    currentReplay = replay; currentArgs = args;
    $('h-results').hidden = false; exportBtn.disabled = false;
    $('h-selected-label').textContent = label || legs.map((l) => l.name).join(' · ');
    renderFrozenStrategy(legs, replay, label);
    if (!rollingCandidates.length) {
      setRollingCandidates([{ legs, label: `${byId(strategySelect.value)?.name || 'استراتژی'} — ${legs.map((leg) => leg.name || leg.ins).join(' + ')}` }], legs);
    } else {
      setRollingCandidates(rollingCandidates, legs);
    }
    paintKpis(replay); paintStatistics(replay); paintDayTable(replay); paintContrib(replay);
    paintLegEvolution(replay); histogram($('h-distribution'), replay.rows);
    paintBasis(args); paintSensitivity(args, replay); paintMargin(replay); paintOptimal(args, replay);
    $('h-payoff-day').value = '0'; renderDailyPayoff();
    enableColumnSort($('h-stats').querySelector('table'));
    enableColumnSort($('h-weekday-stats').querySelector('table'));
    lineChart($('h-pnl-chart'), replay.rows, [
      { key: 'netPnl', label: 'خالص', color: '#0b6e6b' }, { key: 'grossPnl', label: 'ناخالص', color: '#a86c16' },
    ], { money: true });
    lineChart($('h-ret-chart'), replay.rows, [
      { key: 'returnPct', label: 'بازده استراتژی', color: '#0b6e6b' }, { key: 'baseCumulativePct', label: 'تغییر پایه', color: '#7254a3' },
    ]);
    lineChart($('h-dd-chart'), replay.rows, [{ key: 'drawdown', label: 'افت از قله', color: '#a81f32' }], { money: true });
    rollingResult = null;
    rollingArgs = null;
    $('h-rolling-out').innerHTML = '';
    $('h-return-matrix').innerHTML = '<p class="empty-note">ابتدا «محاسبه ماتریس» را بزن.</p>';
    $('h-holding-profile').innerHTML = '<p class="empty-note">پس از محاسبه ماتریس ساخته می‌شود.</p>';
    $('h-trade-detail').hidden = true;
    setStatus(`تحلیل ${fmt.int(replay.summary.validDays)} روز معتبر آماده شد.`);
  }

  function renderAutoTable(rows, generated) {
    $('h-auto-card').hidden = false;
    $('h-combo-note').textContent = `${fmt.int(rows.length)} ترکیب معتبر · ${fmt.int(generated.noEntry)} فاقد قیمت ورود · ${fmt.int(generated.noLiquidity || 0)} حذف نقدشوندگی${generated.capped ? ' · سقف ترکیب اعمال شد' : ''}`;
    const sorted = [...rows].sort((a, b) => (b.summary.last?.returnPct ?? -Infinity) - (a.summary.last?.returnPct ?? -Infinity));
    autoRows = sorted;
    setRollingCandidates(sorted.slice(0, 1000).map((row) => ({
      legs: row.legs,
      label: `${byId(strategySelect.value)?.name || 'استراتژی'} — ${row.legs.map((leg) => leg.name || leg.ins).join(' + ')} — اعمال ${row.strikes.map((strike) => fmt.int(strike)).join(' / ')} — ${fmt.pct(row.summary.last?.returnPct)}`,
    })));
    $('h-combos').innerHTML = sorted.slice(0, 1000).map((r, index) => `<tr tabindex="0" data-combo="${index}">
      <td>${esc(r.legs.map((l) => l.name).join(' + '))}</td><td>${r.strikes.map((k) => fmt.int(k)).join(' · ')}</td><td>${r.expiries.map(historyDateLabel).join(' · ')}</td>
      <td class="${signTone(r.summary.last?.netPnl)}">${fmt.money(r.summary.last?.netPnl)}</td><td class="${signTone(r.summary.last?.returnPct)}">${fmt.pct(r.summary.last?.returnPct)}</td><td class="${signTone(r.summary.last?.baseCumulativePct)}">${fmt.pct(r.summary.last?.baseCumulativePct)}</td>
      <td class="${signTone(r.summary.meanReturn)}">${fmt.pct(r.summary.meanReturn)}</td><td class="${signTone(r.summary.medianReturn)}">${fmt.pct(r.summary.medianReturn)}</td>
      <td class="gain">${fmt.money(r.summary.best?.netPnl)}<small>${r.summary.best?.dateLabel || '—'} · ${fmt.pct(r.summary.best?.returnPct)}</small></td><td class="loss">${fmt.money(r.summary.worst?.netPnl)}<small>${r.summary.worst?.dateLabel || '—'} · ${fmt.pct(r.summary.worst?.returnPct)}</small></td><td class="loss">${fmt.money(r.summary.maxDrawdown)}</td>
      <td>${fmt.int(r.summary.positiveDays)} / ${fmt.int(r.summary.negativeDays)}<small>${fmt.pct(r.summary.positivePct)} / ${fmt.pct(r.summary.negativePct)}</small></td>
      <td>${fmt.money(r.entry?.capital?.value)}<small>${esc(r.entry?.capital?.label || '')}</small></td><td>${fmt.money(r.entry?.cashPaid)}</td><td>${fmt.money(r.entry?.cashReceived)}</td><td class="${signTone(r.entry?.netCash)}">${fmt.money(r.entry?.netCash)}<small>پس از کارمزد ورود</small></td>
      <td>${valueLabel(r.entry?.baseMarket?.value, r.entry?.baseMarket?.valueEstimated)}</td><td>${fmt.int(Math.min(...(r.entry?.legsMarket || []).map((m) => m.volume).filter(Number.isFinite)))}</td><td>${r.entry?.margin?.marginNet > 0 ? fmt.money(r.entry.margin.marginNet) : 'بدون وجه تضمین'}</td>
      <td>${fmt.int(r.summary.validDays)} معتبر · ${fmt.int(r.summary.missingDays)} ناقص · ${fmt.int(r.summary.liquidityDays)} نقدشوندگی</td></tr>`).join('');
    [...$('h-combos').rows].forEach((row, index) => { row.dataset.originalOrder = String(index); });
    enableColumnSort($('h-combos-table'));
    scatterChart($('h-scatter'), sorted);
    if (sorted[0]) selectAutoCombo(sorted[0]);
  }

  function selectAutoCombo(combo) {
    selectedAuto = combo;
    const selectedSignature = legSignature(combo.legs);
    const rollingIndex = rollingCandidates.findIndex((item) => legSignature(item.legs) === selectedSignature);
    if (rollingIndex >= 0) $('h-rolling-strategy').value = String(rollingIndex);
    [...$('h-combos').rows].forEach((row) => row.classList.toggle('selected', autoRows[Number(row.dataset.combo)] === combo));
    const baseline = replayHistory(argsFor(combo.legs, {}));
    if (!baseline.ok) { setStatus(baseline.error, true); return; }
    $('h-auto-manual').hidden = false;
    $('h-auto-prices').innerHTML = baseline.priced.map((leg, index) => `<label class="history-leg"><b>${esc(legLabel(leg, index))}</b><span>${esc(leg.name || leg.ins)}</span><input type="number" min="0" step="any" value="${leg.price}" data-auto-manual="${index}" aria-label="قیمت دستی ورود پای ${index + 1}"></label>`).join('');
    renderReplay(combo.legs, {}, combo.legs.map((l) => l.name).join(' + '));
  }

  async function runAnalysis() {
    if (!ua || !dates.length) { setStatus('اول تاریخچه را دریافت کن.', true); return; }
    runBtn.disabled = true;
    $('h-auto-card').hidden = true;
    try {
      if (modeSelect.value === 'manual') {
        const legs = manualLegs();
        if (legs.length !== byId(strategySelect.value).legs.length) throw new Error('برای همه پاها قرارداد انتخاب نشده است');
        const manual = manualPrices();
        if (entrySelect.value === 'MANUAL' && Object.keys(manual).length !== legs.length) throw new Error('قیمت دستی ورود همه پاها را وارد کن');
        setRollingCandidates([{ legs, label: `${byId(strategySelect.value)?.name || 'استراتژی'} — ${legs.map((leg) => leg.name || leg.ins).join(' + ')}` }], legs);
        renderReplay(legs, manual);
      } else {
        if (entrySelect.value === 'MANUAL') throw new Error('در حالت تمام ترکیب‌ها ابتدا یکی از چهار قیمت تاریخی را انتخاب کن');
        autoRows = []; selectedAuto = null; rollingArgs = null; rollingResult = null; setRollingCandidates([]);
        $('h-results').hidden = false;
        setStatus('در حال ساخت و ارزیابی ترکیب‌های تاریخی…');
        const response = await askWorker({
          type: 'combos', defId: strategySelect.value, ua: analysisUa || ua, seriesByIns,
          startDate: dates[+$('h-start').value], endDate: dates[+$('h-end').value],
          entryBasis: entrySelect.value, exitBasis: exitSelect.value,
          units: Math.max(1, Math.trunc(Number($('h-units').value) || 1)),
          fees: feesOf(state.settings), settings: state.settings,
          liquidity: liquidityArgs(),
          filtered: $('h-filter').value === 'filtered',
        });
        if (response.error) throw new Error(response.error);
        renderAutoTable(response.rows || [], response.generated || {});
        setStatus(`${fmt.int(response.rows?.length || 0)} ترکیب تاریخی آماده شد.`);
      }
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      runBtn.disabled = false;
    }
  }

  function exportCsv() {
    if (!currentReplay) return;
    const legHeads = currentReplay.priced.flatMap((_, i) => [`قیمت آفست پای ${i + 1}`, `اثر تجمعی پای ${i + 1}`, `تغییر روز پای ${i + 1}`, `حجم پای ${i + 1}`, `ارزش پای ${i + 1}`]);
    const heads = ['تاریخ', 'روز', 'روز نگهداری', 'نماد پایه', 'کد پایه', 'پایانی پایه', 'حجم پایه', 'ارزش پایه', 'تعداد معامله پایه', 'تغییر روزانه پایه ٪', 'تغییر از ورود پایه ٪', ...legHeads, 'سود ناخالص', 'کارمزد کل', 'سود خالص', 'تغییر سود روز', 'بازده ٪', 'افت از قله', 'وجه تضمین خالص', 'وضعیت'];
    const lines = [heads, ...currentReplay.rows.map((r) => [r.dateLabel, r.dayName, r.holdingDays, ua?.name || '', ua?.ins || '', r.baseClose, r.baseVolume, r.baseValue, r.baseTrades, r.baseDailyPct, r.baseCumulativePct, ...r.perLeg.flatMap((l) => [l.exitPrice, l.netPnl, l.pnlDelta, l.volume, l.value]), r.grossPnl, r.totalFees, r.netPnl, r.pnlDelta, r.returnPct, r.drawdown, r.marginNet, r.status === 'ok' ? 'معتبر' : r.status === 'liquidity' ? 'حذف نقدشوندگی' : 'فاقد داده'])];
    const blob = new Blob(['\ufeff' + lines.map((row) => row.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = `options-history-${currentReplay.startDate}-${currentReplay.endDate}.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  async function renderRolling() {
    if (!currentArgs) return;
    const button = $('h-rolling'); button.disabled = true;
    $('h-rolling-out').innerHTML = '<p class="empty-note">در حال محاسبه…</p>';
    let response;
    try {
      rollingArgs = rollingArgsForSelection();
      const id = ++seq;
      response = await new Promise((resolve) => {
        rollingResolve = { id, resolve };
        ensureHistoryWorker().postMessage({ type: 'rolling', id, args: rollingArgs });
      });
    } catch (error) {
      $('h-rolling-out').textContent = error.message;
      setStatus(error.message, true);
      return;
    } finally {
      button.disabled = false;
    }
    if (response.error) { $('h-rolling-out').textContent = response.error; return; }
    const result = response.result;
    rollingResult = result;
    const allDates = result.dates || [];
    if (!allDates.length) { $('h-rolling-out').textContent = 'داده‌ای برای ماتریس نیست.'; return; }
    const shown = sampledDates(allDates);
    const map = new Map((result.cells || []).map((c) => [`${c.entryDate}|${c.exitDate}`, c]));
    const vals = [...map.values()].map((c) => Math.abs(c.returnPct)).filter(Number.isFinite);
    const max = Math.max(...vals, 1);
    $('h-rolling-out').innerHTML = `<table class="rolling-table"><thead><tr><th>ورود \ آفست</th>${shown.map((d) => `<th title="${historyDateLabel(d)}">${historyDateLabel(d).slice(5)}</th>`).join('')}</tr></thead><tbody>${shown.map((entry) => `<tr><th>${historyDateLabel(entry)}</th>${shown.map((exit) => { const c = map.get(`${entry}|${exit}`); return `<td style="background:${heatColor(c?.returnPct, max)}" title="${c ? `${historyDateLabel(entry)} تا ${historyDateLabel(exit)}: ${fmt.pct(c.returnPct)} · ${fmt.money(c.netPnl)}` : 'فاقد داده'}">${c ? fmt.pct(c.returnPct) : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
    renderReturnMatrix(); renderHoldingProfile();
    $('h-trade-detail').hidden = true;
    setStatus(`ماتریس با ورود ${basisName(rollingArgs.entryBasis)} و خروج ${basisName(rollingArgs.exitBasis)} آماده شد.`);
  }

  baseSelect.addEventListener('change', () => {
    ua = chain.get(baseSelect.value) || null;
    invalidateLoadedHistory(); buildExpiryControls();
  });
  strategySelect.addEventListener('change', () => { paintExpirySummary(); if (dates.length) buildLegControls(); $('h-results').hidden = true; });
  modeSelect.addEventListener('change', () => { $('h-legs-card').hidden = modeSelect.value !== 'manual' || !dates.length; $('h-filter').disabled = modeSelect.value !== 'all'; if (modeSelect.value === 'all' && entrySelect.value === 'MANUAL') entrySelect.value = 'CLOSE'; buildLegControls(); });
  entrySelect.addEventListener('change', buildLegControls);
  $('h-start').addEventListener('input', paintRange); $('h-end').addEventListener('input', paintRange);
  $('h-rolling-start').addEventListener('change', () => {
    if (Number($('h-rolling-start').value) > Number($('h-rolling-end').value)) $('h-rolling-end').value = $('h-rolling-start').value;
  });
  $('h-rolling-end').addEventListener('change', () => {
    if (Number($('h-rolling-end').value) < Number($('h-rolling-start').value)) $('h-rolling-start').value = $('h-rolling-end').value;
  });
  loadBtn.addEventListener('click', loadHistory); runBtn.addEventListener('click', runAnalysis);
  exportBtn.addEventListener('click', exportCsv); $('h-rolling').addEventListener('click', renderRolling);
  $('h-payoff-day').addEventListener('input', renderDailyPayoff);
  root.querySelectorAll('[data-payoff-layer]').forEach((input) => input.addEventListener('change', renderDailyPayoff));
  root.querySelectorAll('[data-matrix-mode]').forEach((button) => button.addEventListener('click', () => {
    matrixMode = button.dataset.matrixMode;
    root.querySelectorAll('[data-matrix-mode]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    renderReturnMatrix();
  }));
  $('h-return-matrix').addEventListener('click', (event) => {
    const button = event.target.closest('[data-trade-cell]');
    if (!button) return;
    const [entry, exit] = button.dataset.tradeCell.split('|').map(Number);
    showTradeDetail(entry, exit);
  });
  $('h-expiry-all').addEventListener('click', () => {
    root.querySelectorAll('[data-history-expiry]').forEach((input) => { input.checked = true; });
    paintExpirySummary(); invalidateLoadedHistory();
  });
  $('h-expiry-none').addEventListener('click', () => {
    root.querySelectorAll('[data-history-expiry]').forEach((input) => { input.checked = false; });
    paintExpirySummary(); invalidateLoadedHistory();
  });
  $('h-combos').addEventListener('click', (event) => {
    const row = event.target.closest('[data-combo]');
    const combo = row ? autoRows[Number(row.dataset.combo)] : null;
    if (combo) selectAutoCombo(combo);
  });
  $('h-combos').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-combo]');
    if (row) { event.preventDefault(); row.click(); }
  });
  $('h-auto-replay').addEventListener('click', () => {
    if (!selectedAuto) return;
    const manual = {};
    for (const input of root.querySelectorAll('[data-auto-manual]')) {
      if (input.value === '') { setStatus('قیمت دستی همه پاها را وارد کن.', true); return; }
      manual[input.dataset.autoManual] = Number(input.value);
    }
    renderReplay(selectedAuto.legs, manual, `${selectedAuto.legs.map((l) => l.name).join(' + ')} · ورود دستی`);
  });

  await loadUniverse();
  return () => { payoffChart?.destroy?.(); if (worker) worker.terminate(); };
}
