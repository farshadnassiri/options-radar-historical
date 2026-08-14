// نمودار بازده — امضای مشترک همه تب‌ها.
//
// از نقاط شکست دقیق کشیده می‌شود، نه از نمونه‌برداری. ناحیه سود و ناحیه زیان
// جدا رنگ می‌شوند، قیمت‌های اعمال خط‌چین می‌خورند و نقاط سربه‌سری دایره
// می‌گیرند. قیمت پایه فعلی خط نارنجی است.
//
// دو سطح دارد:
//
//   payoffSvg   یک رشته SVG ایستا. برای چاپ و جایی که تعامل لازم نیست.
//   mountPayoff نمودار تعامل‌پذیر: زوم با غلتک، پیمایش با کشیدن، و خط
//               راهنمای متحرک که سود و زیان را سر هر قیمت پایه می‌خواند.
//
// چرا زوم فقط روی محور قیمت پایه است: محور عمودی همیشه از داده همان بازه
// دوباره حساب می‌شود، پس بزرگ‌نمایی یک ناحیه باریک، خودش قد نمودار را هم
// پر می‌کند. زوم دوبعدی اینجا فقط نمودار را کج می‌کرد.

import { chartPoints, analyzePayoff } from '/core/payoff.mjs';
import { analyzeMixed, isSingleExpiry } from '/core/mixed.mjs';
import { fmt, axisNum } from '/ui/fmt.mjs';

const money = fmt.money;
const MIN_SPAN = 1e-6;
// سبک منحنی‌های «اضافه» روی هر نموداری که از frame()/diffFrame() می‌گذرد —
// نامزدهای رول روی نمودار تفاضل، و موقعیت‌های مقایسه‌ای روی نمودار بازده.
const EXTRA_STYLE = ['extra1', 'extra2', 'extra3', 'extra4'];

/**
 * گام خوانا: ۱ ، ۲ ، ۵ در توان ده.
 *
 * قبلاً محور عمودی سه مقدار ثابت داشت — کف و صفر و سقف — و هر وقت صفر به
 * یکی از دو سر نزدیک می‌شد، دو برچسب روی هم می‌افتادند. گام گرد این را حل
 * می‌کند و عددهای محور را هم خواندنی می‌کند.
 */
function niceStep(span, count) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function ticksFor(lo, hi, count) {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const step = niceStep(hi - lo, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (out.length > 40) break;
  }
  return out;
}

/** موتور درست را انتخاب می‌کند و نقاط رسم را می‌دهد. */
function seriesFor(legs, netCash, opt) {
  if (isSingleExpiry(legs)) {
    const { points, analysis } = chartPoints(legs, netCash, { fees: opt.fees, padPct: opt.padPct ?? 0.35 });
    return { points, analysis };
  }
  const analysis = analyzeMixed(legs, netCash, {
    fees: opt.fees, spot: opt.spot, sigma: opt.sigma,
    rFree: opt.rFree, divYield: opt.divYield,
  });
  return { points: analysis.points.filter((_, i) => i % 3 === 0), analysis };
}

/**
 * فقط ارزیاب سود و زیان در سررسید یک ترکیب — بدون رسم. برای منحنی‌های
 * مقایسه‌ای مصرف می‌شود که خودشان روی نمودار موقعیت دیگری سوار می‌شوند و
 * نیازی به نقاط شکست خودشان (برای پرشدن ناحیه رنگی) ندارند.
 */
export function payoffAt(legs, netCash, opt = {}) {
  return seriesFor(legs, netCash, opt).analysis.at;
}

/**
 * منحنی «امروز» — همان موتور بلک-شولز چند-سررسیدی، فقط با افق ارزش‌گذاری
 * صفر، یعنی هیچ پایی هنوز سررسید نشده فرض می‌شود. برای هر ترکیبی کار
 * می‌کند (تک‌سررسید یا چندسررسید)، چون فرمولش فقط به «چند روز مانده» هر
 * پا وابسته است، نه به اینکه سررسیدها با هم یکی‌اند یا نه.
 *
 * بدون تلاطم معتبر، قیمت‌گذاری بلک-شولز ممکن نیست، پس چیزی رسم نمی‌شود —
 * نه یک خط غلط با تلاطم پیش‌فرض حدسی.
 */
function todaySeries(legs, netCash, opt) {
  if (!(opt.sigma > 0)) return null;
  const today = analyzeMixed(legs, netCash, {
    fees: opt.fees, spot: opt.spot, sigma: opt.sigma,
    rFree: opt.rFree, divYield: opt.divYield, horizonDays: 0,
  });
  return { points: today.points.filter((_, i) => i % 3 === 0), at: today.at };
}

/**
 * بدنه رسم. روی یک بازه دلخواه از محور قیمت پایه کار می‌کند، پس هم برای
 * نمای اول و هم برای هر سطح زوم یکی است.
 */
function frame(points, analysis, opt, xMin, xMax, todayPoints) {
  const spot = opt.spot;
  const W = opt.width ?? 760, H = opt.height ?? 280;
  // حاشیه چپ جا برای برچسب محور عمودی باز می‌کند و حاشیه پایین برای دو ردیف
  // برچسب: قیمت اعمال بالای محور، و مقیاس قیمت پایه زیر آن.
  const pad = { t: 20, r: 16, b: 40, l: 54 };

  // فقط نقاط داخل بازه، به‌علاوه دو نقطه لبه که خط تا لبه قاب برسد
  const at = analysis.at;
  const inRange = points.filter((p) => p.S >= xMin && p.S <= xMax);
  const seq = [{ S: xMin, pnl: at(xMin) }, ...inRange, { S: xMax, pnl: at(xMax) }]
    .filter((p) => Number.isFinite(p.pnl))
    .sort((a, b) => a.S - b.S);

  if (seq.length < 2) return null;

  const ys = seq.map((p) => p.pnl);
  let yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0);
  const padY = (yMax - yMin) * 0.12 || 1;
  yMin -= padY; yMax += padY;

  const X = (v) => pad.l + ((v - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const y0 = Y(0);

  const areas = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i], b = seq[i + 1];
    const cls = (a.pnl + b.pnl) / 2 >= 0 ? 'fill-gain' : 'fill-loss';
    areas.push(`<path class="${cls}" d="M${X(a.S)},${y0} L${X(a.S)},${Y(a.pnl)} L${X(b.S)},${Y(b.pnl)} L${X(b.S)},${y0} Z"/>`);
  }

  const line = seq.map((p, i) => `${i ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join(' ');

  // ——— منحنی «امروز» — همان محور، رنگ و خط‌چین جدا، بدون ناحیه رنگی خودش ———
  // چون تلاطم زمان را صاف می‌کند، این خط معمولاً داخل محدوده منحنی سررسید
  // می‌ماند؛ مقیاس Y از منحنی سررسید گرفته شده، نه دوباره حساب شده.
  let todayLine = '';
  if (todayPoints && Number.isFinite(spot)) {
    const inRange2 = todayPoints.points.filter((p) => p.S >= xMin && p.S <= xMax);
    const seq2 = [{ S: xMin, pnl: todayPoints.at(xMin) }, ...inRange2, { S: xMax, pnl: todayPoints.at(xMax) }]
      .filter((p) => Number.isFinite(p.pnl))
      .sort((a, b) => a.S - b.S);
    if (seq2.length >= 2) {
      todayLine = seq2.map((p, i) => `${i ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(Math.min(Math.max(p.pnl, yMin), yMax)).toFixed(1)}`).join(' ');
    }
  }

  // ——— موقعیت‌های مقایسه‌ای — بازده سررسید موقعیت‌های دیگر هم‌نماد ———
  // همان الگوی نامزدهای رول روی نمودار تفاضل (diffFrame): نمونه‌برداری یکنواخت
  // روی بازه فعلی، مقیاس Y از منحنی اصلی همین موقعیت، نه دوباره حساب‌شده —
  // این‌ها هم برای مقایسه شکل‌اند، نه خواندن دقیق عدد.
  const CMP_N = 120;
  const cmpLines = (opt.compare || []).slice(0, EXTRA_STYLE.length).map((c, i) => {
    const raw = [];
    for (let j = 0; j <= CMP_N; j++) {
      const S = xMin + ((xMax - xMin) * j) / CMP_N;
      const v = c.at(S);
      if (Number.isFinite(v)) raw.push({ S, v });
    }
    if (raw.length < 2) return null;
    const d = raw.map((p, j) => `${j ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(Math.min(Math.max(p.v, yMin), yMax)).toFixed(1)}`).join(' ');
    return { d, cls: EXTRA_STYLE[i], label: c.label, full: c.full };
  }).filter(Boolean);

  // ——— محور عمودی: گام گرد، برچسب سمت چپ، صفر جدا کشیده می‌شود ———
  const yTicks = ticksFor(yMin, yMax, 4).filter((v) => Math.abs(Y(v) - y0) > 9 || v === 0);
  const grid = yTicks.map((v) => `
    <line class="grid-line" x1="${pad.l}" y1="${Y(v)}" x2="${W - pad.r}" y2="${Y(v)}"/>
    <text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${axisNum(v)}</text>`).join('');

  // ——— محور افقی: مقیاس قیمت پایه، زیر خط محور ———
  // قیمت اعمال خودش برچسب دارد و اغلب دقیقاً روی یک گام گرد می‌افتد. اگر هر
  // دو کشیده شوند، دو عدد یکسان زیر هم می‌نشینند. پس گامی که نزدیک یک قیمت
  // اعمال است حذف می‌شود و برچسب دقیق‌تر — همان قیمت اعمال — می‌ماند.
  const shownStrikes = analysis.strikes.filter((k) => k >= xMin && k <= xMax);
  const xTicks = ticksFor(xMin, xMax, 6)
    .filter((v) => !shownStrikes.some((k) => Math.abs(X(k) - X(v)) < 20))
    .map((v) => `
    <line class="grid-line" x1="${X(v)}" y1="${H - pad.b}" x2="${X(v)}" y2="${H - pad.b + 4}"/>
    <text x="${X(v)}" y="${H - pad.b + 15}" text-anchor="middle">${axisNum(v)}</text>`).join('');

  // قیمت اعمال بالای محور می‌نشیند تا با مقیاس قیمت پایه قاطی نشود
  const strikes = shownStrikes.map((k) => `
    <line class="strike" x1="${X(k)}" y1="${pad.t}" x2="${X(k)}" y2="${H - pad.b}"/>
    <text class="lbl strike-lbl" x="${X(k)}" y="${H - pad.b - 5}" text-anchor="middle">${axisNum(k)}</text>`).join('');

  const bes = analysis.breakevens.filter((b) => b >= xMin && b <= xMax).map((b) => `
    <circle class="be" cx="${X(b)}" cy="${y0}" r="4"/>
    <text class="lbl" x="${X(b)}" y="${y0 - 9}" text-anchor="middle">${money(b)}</text>`).join('');

  const spotLine = Number.isFinite(spot) && spot >= xMin && spot <= xMax
    ? `<line class="spot" x1="${X(spot)}" y1="${pad.t}" x2="${X(spot)}" y2="${H - pad.b}"/>
       <text class="lbl" x="${X(spot)}" y="${pad.t - 6}" text-anchor="middle" style="fill:var(--warn)">پایه ${money(spot)}</text>` : '';

  // legend فقط وقتی بیش از یک منحنی روی نمودار هست معنا دارد — «امروز» و/یا
  // هر موقعیت مقایسه‌ای انتخاب‌شده. برچسب‌ها می‌توانند طولانی باشند (نام
  // موقعیت مقایسه‌ای)، پس عرض جعبه از حالت ثابت دوخطی به فهرست باز شد.
  const legendItems = [
    ...(todayLine ? [{ cls: 'curve-today', label: 'امروز' }] : []),
    ...((todayLine || cmpLines.length) ? [{ cls: 'curve', label: 'سررسید' }] : []),
    ...cmpLines.map((c) => ({ cls: `curve-${c.cls}`, label: c.label, full: c.full })),
  ];
  // برچسب مقایسه‌ای بریده‌شده (پای‌های کامل جا نمی‌شوند)، پس متن کامل به‌عنوان
  // title روی <text> می‌نشیند تا با هاور مرورگر دیده شود.
  const legend2 = legendItems.length ? `
    <g class="curve2-legend">
      ${legendItems.map((it, i) => `
      <line x1="${W - pad.r - 92}" y1="${pad.t + 5 + i * 13}" x2="${W - pad.r - 72}" y2="${pad.t + 5 + i * 13}" class="${it.cls}"/>
      <text x="${W - pad.r - 96}" y="${pad.t + 8 + i * 13}" text-anchor="end" class="lbl">${it.label}${it.full && it.full !== it.label ? `<title>${it.full}</title>` : ''}</text>`).join('')}
    </g>` : '';

  const cmpPaths = cmpLines.map((c) => `<path class="curve-${c.cls}" d="${c.d}"/>`).join('');

  const svg = `<svg class="payoff" viewBox="0 0 ${W} ${H}" role="img" aria-label="نمودار بازده در سررسید">
      ${grid}${areas.join('')}${strikes}${spotLine}
      <line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>
      ${xTicks}
      <line class="zero" x1="${pad.l}" y1="${y0}" x2="${W - pad.r}" y2="${y0}"/>
      ${todayLine ? `<path class="curve-today" d="${todayLine}"/>` : ''}
      ${cmpPaths}
      <path class="curve" d="${line}"/>${bes}${legend2}
      <g class="cursor" hidden>
        <line class="cur-x" y1="${pad.t}" y2="${H - pad.b}"/>
        <circle class="cur-dot" r="3.5"/>
      </g>
    </svg>`;

  return { svg, W, H, pad, X, Y, y0, xMin, xMax, yMin, yMax };
}

/** نمای اول: بازه‌ای که قیمت‌های اعمال و قیمت پایه را با حاشیه در بر می‌گیرد. */
function homeRange(points, analysis, opt) {
  const xs = points.map((p) => p.S).filter(Number.isFinite);
  let lo = Math.min(...xs), hi = Math.max(...xs);
  if (Number.isFinite(opt.spot)) { lo = Math.min(lo, opt.spot); hi = Math.max(hi, opt.spot); }
  if (!(hi > lo)) { lo = Math.max(0, lo - 1); hi = lo + 2; }
  return [lo, hi];
}

/** رشته SVG ایستا — همان امضای قبلی، برای جاهایی که تعامل لازم نیست. */
export function payoffSvg(legs, netCash, opt = {}) {
  const { points, analysis } = seriesFor(legs, netCash, opt);
  const ys = points.map((p) => p.pnl).filter(Number.isFinite);
  if (!ys.length) return { svg: '<div class="note">نمودار قابل رسم نیست.</div>', analysis };
  const [lo, hi] = homeRange(points, analysis, opt);
  const f = frame(points, analysis, opt, lo, hi);
  return { analysis, svg: f ? f.svg : '<div class="note">نمودار قابل رسم نیست.</div>' };
}

/**
 * زیرساخت مشترک نمودار تعامل‌پذیر: زوم با غلتک، کشیدن، خط راهنما، دکمه‌های
 * زوم و نمای اول. mountPayoff و mountDiff هر دو از همین عبور می‌کنند و فقط
 * `frameOf` (رسم روی یک بازه) و `valueAt` (مقدار زیر نشانگر) را عوض می‌کنند.
 *
 *   غلتک          زوم حول همان نقطه‌ای که نشانگر رویش است
 *   کشیدن         پیمایش افقی
 *   حرکت نشانگر   خط راهنما و خواندن مقدار سر همان قیمت پایه
 *   دوبار کلیک    برگشت به نمای اول
 *
 * `opt.initRange` بازه شروع را به‌جای نمای اول می‌نشاند — برای وقتی که
 * نمودار قبلی برای همان موقعیت نابود و از نو ساخته می‌شود (اسکن پیوسته)
 * و کاربر وسط زوم یا پن بوده.
 */
function mountInteractive(host, { homeLo, homeHi, initRange, frameOf, valueAt, readLabel, hint }) {
  let lo = homeLo, hi = homeHi;
  const [initLo, initHi] = Array.isArray(initRange) ? initRange : [];
  if (Number.isFinite(initLo) && Number.isFinite(initHi) && initLo >= 0 && initHi - initLo > MIN_SPAN) {
    lo = initLo; hi = initHi;
  }
  let geo = null;

  host.innerHTML = `
    <div class="chart-box">
      <div class="chart-canvas" tabindex="0" role="group" aria-label="نمودار تعامل‌پذیر — فلش چپ و راست برای پیمایش، + و − برای زوم، Home برای نمای اول"></div>
      <div class="chart-tools">
        <span class="chart-read">${hint}</span>
        <span class="sp"></span>
        <button type="button" class="ghost" data-act="out">−</button>
        <button type="button" class="ghost" data-act="in">+</button>
        <button type="button" class="ghost" data-act="home">نمای اول</button>
      </div>
    </div>`;

  const canvas = host.querySelector('.chart-canvas');
  const read = host.querySelector('.chart-read');

  function render() {
    geo = frameOf(lo, hi);
    canvas.innerHTML = geo ? geo.svg : '<div class="note">بازه بیش از حد باریک است.</div>';
  }
  render();

  // ——— تبدیل مختصات صفحه به قیمت پایه ———
  // viewBox مقیاس می‌خورد، پس نسبت افقی داخل قاب گرفته می‌شود نه پیکسل خام.
  function priceAt(ev) {
    const svg = canvas.querySelector('svg');
    if (!svg || !geo) return NaN;
    const b = svg.getBoundingClientRect();
    if (!b.width) return NaN;
    const vx = ((ev.clientX - b.left) / b.width) * geo.W;
    const inner = geo.W - geo.pad.l - geo.pad.r;
    const t = (vx - geo.pad.l) / (inner || 1);
    return lo + t * (hi - lo);
  }

  function clampRange(nextLo, nextHi) {
    // بازه هرگز وارونه یا صفر نمی‌شود، و از صفر پایین‌تر نمی‌رود
    if (!(nextHi - nextLo > MIN_SPAN)) return;
    lo = Math.max(0, nextLo);
    hi = Math.max(lo + MIN_SPAN, nextHi);
    render();
  }

  function zoomAt(pivot, factor) {
    const p = Number.isFinite(pivot) ? pivot : (lo + hi) / 2;
    clampRange(p - (p - lo) * factor, p + (hi - p) * factor);
  }

  const onWheel = (ev) => {
    ev.preventDefault();
    zoomAt(priceAt(ev), ev.deltaY > 0 ? 1.15 : 1 / 1.15);
  };

  // ——— پیمایش با کشیدن ———
  let drag = null;
  const onDown = (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, lo, hi };
    canvas.classList.add('dragging');
    canvas.setPointerCapture?.(ev.pointerId);
  };
  const onMove = (ev) => {
    if (drag) {
      const svg = canvas.querySelector('svg');
      const b = svg?.getBoundingClientRect();
      if (!b?.width) return;
      const inner = geo.W - geo.pad.l - geo.pad.r;
      const perPx = (drag.hi - drag.lo) / ((b.width * inner) / geo.W || 1);
      const dx = (ev.clientX - drag.x) * perPx;
      // در راست‌به‌چپ هم محور قیمت از چپ به راست بالا می‌رود، پس علامت ثابت است
      clampRange(drag.lo - dx, drag.hi - dx);
      return;
    }
    showCursor(priceAt(ev));
  };
  const onUp = (ev) => {
    drag = null;
    canvas.classList.remove('dragging');
    canvas.releasePointerCapture?.(ev.pointerId);
  };

  // ——— خط راهنما ———
  function showCursor(S) {
    const svg = canvas.querySelector('svg');
    const g = svg?.querySelector('.cursor');
    if (!g || !geo || !Number.isFinite(S)) return;
    const v = valueAt(S);
    if (!Number.isFinite(v)) { g.setAttribute('hidden', ''); return; }
    const x = geo.X(S);
    const y = Math.min(Math.max(geo.Y(v), geo.pad.t), geo.H - geo.pad.b);
    g.removeAttribute('hidden');
    g.querySelector('.cur-x').setAttribute('x1', x);
    g.querySelector('.cur-x').setAttribute('x2', x);
    g.querySelector('.cur-dot').setAttribute('cx', x);
    g.querySelector('.cur-dot').setAttribute('cy', y);
    read.innerHTML = `پایه <b>${money(S)}</b> — ${readLabel} `
      + `<b style="color:${v >= 0 ? 'var(--gain)' : 'var(--loss)'}">${money(v)}</b>`;
  }
  function hideCursor() {
    canvas.querySelector('.cursor')?.setAttribute('hidden', '');
    read.textContent = hint;
  }

  const reset = () => { lo = homeLo; hi = homeHi; render(); };

  // ——— صفحه‌کلید — همان سه حرکت ماوس (زوم، پیمایش، نمای اول)، برای
  // کاربری که نمودار را با Tab گرفته، نه با نشانگر. .chart-canvas از قبل
  // tabindex دارد، فقط keydown کم بود.
  const onKey = (ev) => {
    const step = (hi - lo) * 0.1;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); clampRange(lo + step, hi + step); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); clampRange(lo - step, hi - step); }
    else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomAt(NaN, 1 / 1.3); }
    else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomAt(NaN, 1.3); }
    else if (ev.key === 'Home') { ev.preventDefault(); reset(); }
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', hideCursor);
  canvas.addEventListener('dblclick', reset);
  canvas.addEventListener('keydown', onKey);
  host.querySelector('[data-act="home"]').addEventListener('click', reset);
  host.querySelector('[data-act="in"]').addEventListener('click', () => zoomAt(NaN, 1 / 1.3));
  host.querySelector('[data-act="out"]').addEventListener('click', () => zoomAt(NaN, 1.3));

  return {
    view: () => [lo, hi],
    reset,
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', hideCursor);
      canvas.removeEventListener('dblclick', reset);
      canvas.removeEventListener('keydown', onKey);
    },
  };
}

const PAYOFF_HINT = 'غلتک برای زوم ، کشیدن برای پیمایش ، دوبار کلیک برای نمای اول ، فلش/±/Home با صفحه‌کلید';

/**
 * نمودار بازده تعامل‌پذیر. برمی‌گرداند { analysis, view, reset, destroy }.
 * چرا زوم فقط روی محور قیمت پایه است: محور عمودی همیشه از داده همان بازه
 * دوباره حساب می‌شود، پس بزرگ‌نمایی یک ناحیه باریک، خودش قد نمودار را هم
 * پر می‌کند. زوم دوبعدی اینجا فقط نمودار را کج می‌کرد.
 *
 * `opt.compare` — تا ۴ موقعیت مقایسه‌ای دیگر، `[{ at, label }]`. هر `at`
 * ارزیاب سود و زیان سررسید همان موقعیت است (از `payoffAt` بگیر)؛ روی همان
 * محور و همان مقیاس Y منحنی اصلی رسم می‌شوند.
 */
export function mountPayoff(host, legs, netCash, opt = {}) {
  const { points, analysis } = seriesFor(legs, netCash, opt);
  const ys = points.map((p) => p.pnl).filter(Number.isFinite);
  if (!ys.length) {
    host.innerHTML = '<div class="note">نمودار قابل رسم نیست.</div>';
    return { analysis, view: () => null, reset() {}, destroy() {} };
  }
  const todayPoints = opt.showToday === false ? null : todaySeries(legs, netCash, opt);
  const [homeLo, homeHi] = homeRange(points, analysis, opt);
  const api = mountInteractive(host, {
    homeLo, homeHi, initRange: opt.initRange,
    frameOf: (lo, hi) => frame(points, analysis, opt, lo, hi, todayPoints),
    valueAt: (S) => analysis.at(S),
    readLabel: 'سود و زیان',
    hint: PAYOFF_HINT,
  });
  return { analysis, ...api };
}

/** بدنه رسم نمودار تفاضل، روی یک بازه دلخواه — همان نقش frame() برای بازده. */
function diffFrame(fn, opt, xMin, xMax) {
  const W = opt.width ?? 760, H = opt.height ?? 240;
  const pad = { t: 16, r: 14, b: 30, l: 14 };
  const N = 160;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const S = xMin + ((xMax - xMin) * i) / N;
    pts.push({ S, v: fn(S) });
  }
  const vs = pts.map((p) => p.v).filter(Number.isFinite);
  if (vs.length < 2) return null;
  let yMin = Math.min(...vs, 0), yMax = Math.max(...vs, 0);
  const py = (yMax - yMin) * 0.12 || 1;
  yMin -= py; yMax += py;
  const X = (v) => pad.l + ((v - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const y0 = Y(0);

  const areas = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const cls = (a.v + b.v) / 2 >= 0 ? 'fill-gain' : 'fill-loss';
    areas.push(`<path class="${cls}" d="M${X(a.S)},${y0} L${X(a.S)},${Y(a.v)} L${X(b.S)},${Y(b.v)} L${X(b.S)},${y0} Z"/>`);
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');

  // ——— نامزدهای دیگر رول، هم‌زمان روی همان محور — نه یکی‌یکی ———
  // مقیاس Y از نامزد انتخاب‌شده می‌آید، نه دوباره حساب می‌شود؛ چون این‌ها
  // فقط برای مقایسه شکل کلی‌اند، نه خواندن دقیق مقدار.
  const extraLines = (opt.extra || []).slice(0, EXTRA_STYLE.length).map((ex, i) => {
    const exPts = pts.map((p) => ({ S: p.S, v: ex.fn(p.S) })).filter((p) => Number.isFinite(p.v));
    if (exPts.length < 2) return null;
    const d = exPts.map((p, j) => `${j ? 'L' : 'M'}${X(p.S).toFixed(1)},${Y(Math.min(Math.max(p.v, yMin), yMax)).toFixed(1)}`).join(' ');
    return { d, cls: EXTRA_STYLE[i], label: ex.label };
  }).filter(Boolean);

  // نقاط تغییر علامت: مرز تصمیم
  const cross = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.v < 0 && b.v > 0) || (a.v > 0 && b.v < 0)) {
      const t = -a.v / (b.v - a.v);
      cross.push(a.S + t * (b.S - a.S));
    }
  }
  const dots = cross.map((S) => `<circle class="be" cx="${X(S)}" cy="${y0}" r="4"/>
    <text class="lbl" x="${X(S)}" y="${y0 - 8}" text-anchor="middle">${money(S)}</text>`).join('');
  const spotLine = Number.isFinite(opt.spot) && opt.spot >= xMin && opt.spot <= xMax
    ? `<line class="spot" x1="${X(opt.spot)}" y1="${pad.t}" x2="${X(opt.spot)}" y2="${H - pad.b}"/>` : '';

  const extraPaths = extraLines.map((ex) => `<path class="curve-${ex.cls}" d="${ex.d}"/>`).join('');
  const extraLegend = extraLines.length ? `
    <g class="curve2-legend">
      <line x1="${W - pad.r - 92}" y1="${pad.t + 5}" x2="${W - pad.r - 72}" y2="${pad.t + 5}" class="curve"/>
      <text x="${W - pad.r - 96}" y="${pad.t + 8}" text-anchor="end" class="lbl">انتخاب‌شده</text>
      ${extraLines.map((ex, i) => `
      <line x1="${W - pad.r - 92}" y1="${pad.t + 18 + i * 13}" x2="${W - pad.r - 72}" y2="${pad.t + 18 + i * 13}" class="curve-${ex.cls}"/>
      <text x="${W - pad.r - 96}" y="${pad.t + 21 + i * 13}" text-anchor="end" class="lbl">${ex.label}</text>`).join('')}
    </g>` : '';

  const svg = `<svg class="payoff" viewBox="0 0 ${W} ${H}" role="img" aria-label="نمودار تفاضل دو موقعیت">
      ${areas.join('')}${spotLine}
      <line class="zero" x1="${pad.l}" y1="${y0}" x2="${W - pad.r}" y2="${y0}"/>
      ${extraPaths}
      <path class="curve" d="${line}"/>${dots}${extraLegend}
      <g class="cursor" hidden>
        <line class="cur-x" y1="${pad.t}" y2="${H - pad.b}"/>
        <circle class="cur-dot" r="3.5"/>
      </g>
    </svg>`;

  return { svg, W, H, pad, X, Y, y0, crossings: cross };
}

/** نمودار تفاضل دو موقعیت — ورودی تصمیم رول. رشته SVG ایستا. */
export function diffSvg(fn, xMin, xMax, opt = {}) {
  const f = diffFrame(fn, opt, xMin, xMax);
  return f ? { svg: f.svg, crossings: f.crossings } : { svg: '<div class="note">نمودار قابل رسم نیست.</div>', crossings: [] };
}

/**
 * نمودار تفاضل تعامل‌پذیر — همان diffSvg با زوم، پیمایش و خط راهنما.
 * برمی‌گرداند { crossings, view, reset, destroy }. crossings مرز تصمیم را
 * روی نمای اول می‌دهد؛ اگر بعد از زوم لازم شد، از frame بازگشتی view خواند.
 */
export function mountDiff(host, fn, xMin, xMax, opt = {}) {
  const home = diffFrame(fn, opt, xMin, xMax);
  if (!home) {
    host.innerHTML = '<div class="note">نمودار قابل رسم نیست.</div>';
    return { crossings: [], view: () => null, reset() {}, destroy() {} };
  }
  const api = mountInteractive(host, {
    homeLo: xMin, homeHi: xMax, initRange: opt.initRange,
    frameOf: (lo, hi) => diffFrame(fn, opt, lo, hi),
    valueAt: fn,
    readLabel: 'تفاضل',
    hint: PAYOFF_HINT,
  });
  return { crossings: home.crossings, ...api };
}
