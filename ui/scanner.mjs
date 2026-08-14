// کنترل‌کننده اسکن در نخ اصلی.
//
// غربال دومرحله‌ای، همان چیزی که در طراحی توافق شد:
//
//   مرحله ۱   سطح اول دیده‌بان، بدون هیچ درخواست اضافه، بدون یونانی
//   مرحله ۲   عمق پنج سطحی و وضعیت نماد، فقط برای کاندیداهای برتر، با یونانی
//
// چون افت مظنه اغلب رتبه‌ها را زیر و رو می‌کند، ردیف‌های مرحله دو بعد از
// دریافت عمق دوباره مرتب می‌شوند.

import { CATALOG } from '/strategies/catalog.mjs';

let worker = null;
let seq = 0;
const waiting = new Map();
const chainSubs = new Set();

export const chainState = { list: [], stats: null, at: null };

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/worker/scan-worker.mjs', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'chain') {
      chainState.list = m.list;
      chainState.stats = m.stats;
      chainState.at = m.at;
      for (const fn of chainSubs) { try { fn(chainState); } catch (err) { console.error(err); } }
    }
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); w(m); }
  };
  worker.onerror = (err) => {
    console.error('ریسه اسکن:', err.message);
    // نگهبان آخر — اگر خطا هرگز به یک id مشخص نرسید (مثلاً خرابی سطح
    // ماژول، پیش از رسیدن به try/catch داخل ریسه)، همه منتظرها آزاد
    // می‌شوند تا دکمه اسکن برای همیشه «در حال اسکن…» قفل نماند
    for (const [id, resolve] of waiting) resolve({ id, error: err.message || 'خطای ریسه اسکن' });
    waiting.clear();
  };
  return worker;
}

function ask(msg) {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ ...msg, id });
  });
}

/** ردیف‌های عکس لحظه‌ای را به ریسه می‌دهد. ساخت زنجیره آنجا انجام می‌شود. */
export function pushRows(watch, full) {
  return ask({ type: 'rows', full, rows: watch.rows, at: watch.at });
}

export function onChain(fn) {
  chainSubs.add(fn);
  if (chainState.list.length) fn(chainState);
  return () => chainSubs.delete(fn);
}

export const chainDetail = (uaIns) => ask({ type: 'chain-detail', uaIns });

// ————————————————————————— تلاطم تاریخی —————————————————————————
const sigmaCache = new Map();

export async function sigmas(uaKeys, settings) {
  const todo = uaKeys.filter((k) => !sigmaCache.has(k)).slice(0, 24);
  await Promise.all(todo.map(async (ins) => {
    try {
      const r = await (await fetch(`/api/daily?ins=${ins}&n=${settings.volDays}`)).json();
      const closes = (r.rows || []).map((x) => x.close).filter((x) => x > 0);
      const { histVol } = await import('/core/bs.mjs');
      sigmaCache.set(ins, histVol(closes, settings.tradingDaysYr));
    } catch { sigmaCache.set(ins, NaN); }
  }));
  const out = {};
  for (const k of uaKeys) out[k] = sigmaCache.get(k);
  return out;
}

// ————————————————————————— اسکن دومرحله‌ای —————————————————————————

/**
 * onStage(stage, payload) دو بار صدا زده می‌شود:
 *   'one'  ردیف‌های مرحله یک، سریع و تقریبی
 *   'two'  همان ردیف‌ها با عمق کامل و یونانی
 */
export async function runScan({ defId, uaKeys, settings, qty, onStage }) {
  if (!uaKeys.length) {
    onStage?.('one', { rows: [], funnel: null, ms: 0, note: 'نمادی انتخاب نشده' });
    return { rows: [] };
  }

  const sigmaByUa = await sigmas(uaKeys, settings);

  // ——— مرحله یک ———
  const one = await ask({ type: 'scan', defId, uaKeys, settings, sigmaByUa, qty });
  if (one.error) { onStage?.('one', { rows: [], error: one.error }); return { rows: [] }; }
  onStage?.('one', one);

  // ——— مرحله دو: عمق برای کاندیداهای برتر ———
  const top = one.rows.slice(0, settings.maxDepthSymbols);
  if (!top.length) return one;

  const codes = new Set();
  for (const r of top) {
    for (const c of r.legIns || []) codes.add(c);
    if (r.uaIns) codes.add(r.uaIns);
  }
  const list = [...codes].slice(0, 180);
  if (!list.length) return one;

  try {
    const q = list.join(',');
    const [books, infos] = await Promise.all([
      fetch(`/api/books?ins=${q}`).then((r) => r.json()),
      fetch(`/api/infos?ins=${q}`).then((r) => r.json()),
    ]);
    const data = {};
    for (const ins of list) {
      data[ins] = { ...(infos[ins] || {}), ...(books[ins] || {}) };
    }
    await ask({ type: 'overlay', data });

    const two = await ask({
      type: 'scan', defId, uaKeys: [...new Set(top.map((r) => r.uaIns))],
      settings, sigmaByUa, qty, onlyIds: top.map((r) => r.id),
    });
    // خطای ریسه (نه فقط خطای شبکه که catch زیر می‌گیرد) هم از همین راه
    // برمی‌گردد؛ بدون این بررسی، two.rows نبود و onStage مصرف‌کننده‌اش
    // (strategy.mjs) روی res.rows.map می‌ترکید
    if (two.error) { onStage?.('two', { rows: [], error: two.error }); return one; }
    onStage?.('two', { ...two, asked: list.length });
    return two;
  } catch (e) {
    onStage?.('two', { rows: [], error: e.message });
    return one;
  }
}

export const clearOverlay = () => ask({ type: 'clear-overlay' });

/**
 * غربال روی کل کاتالوگ — «برترین موقعیت‌ها». فقط مرحله یک؛ استراتژی‌های
 * غیرشدنی (`feasible: false`) اصلاً وارد نمی‌شوند چون در تابلو اجرا ندارند.
 */
export async function runScanAll({ uaKeys, settings, qty, limit = 50 }) {
  if (!uaKeys.length) return { rows: [], total: 0, funnel: null };
  const sigmaByUa = await sigmas(uaKeys, settings);
  const defIds = CATALOG.filter((d) => d.feasible).map((d) => d.id);
  return ask({ type: 'scan-all', defIds, uaKeys, settings, sigmaByUa, qty, limit });
}
