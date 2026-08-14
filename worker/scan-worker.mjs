// ریسه اسکن.
//
// همه ترکیب‌سازی و محاسبه اینجا انجام می‌شود، نه در نخ اصلی. نخ اصلی فقط
// رسم می‌کند، پس هرچقدر هم ترکیب زیاد باشد رابط کاربری نمی‌خوابد.
//
// ریسه، خودش زنجیره را نگه می‌دارد: نخ اصلی فقط ردیف‌های تغییرکرده عکس
// لحظه‌ای را می‌فرستد و ساخت زنجیره اینجا، بیرون از مسیر رسم، انجام می‌شود.

import { buildChain, underlyingList, chainStats } from '../core/chain.mjs';
import { scan, scanAll } from '../core/scan.mjs';
import { byId } from '../strategies/catalog.mjs';

let rowsByKey = new Map();
let chain = null;
let dirty = true;
let overlay = new Map();     // insCode → { book, low, high, state, staleSec }

const rowKey = (r) => `${r.insCode_C ?? ''}|${r.insCode_P ?? ''}`;

/** عمق و وضعیت مرحله دو را روی مظنه‌های زنجیره می‌نشاند. */
function applyOverlay(ch) {
  if (!overlay.size) return;
  const put = (q) => {
    const o = q && q.ins ? overlay.get(q.ins) : null;
    if (!o) return;
    if (o.book) { q.book = o.book; q.depth = true; }
    if (o.low != null) q.low = o.low;
    if (o.high != null) q.high = o.high;
    if (o.state) q.state = o.state;
    if (o.staleSec != null) q.staleSec = o.staleSec;
    if (o.close) q.close = o.close;
    if (o.last) q.last = o.last;
  };
  for (const ua of ch.values()) {
    put(ua);
    for (const ex of ua.expiryList) {
      for (const st of ex.strikeList) { put(st.call); put(st.put); }
    }
  }
}

function ensureChain() {
  if (!dirty && chain) return chain;
  chain = buildChain([...rowsByKey.values()]);
  applyOverlay(chain);
  dirty = false;
  return chain;
}

// نخ اصلی روی هر پیام یک Promise معلق نگه می‌دارد (ui/scanner.mjs) که فقط
// resolve دارد، نه reject — پس اگر همین‌جا خطایی بی‌نگهبان پرتاب شود، آن
// Promise هرگز نمی‌شکند و دکمه اسکن تا آخر عمر «در حال اسکن…» می‌ماند.
// بلوک try/catch دور کل بدنه، تضمین می‌کند هر پیام همیشه یک جواب می‌گیرد —
// موفق یا خطا، هرگز بی‌جواب نمی‌ماند.
self.onmessage = (e) => {
  const m = e.data;
  try {
    handleMessage(m);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String(err?.message || err) });
  }
};

function handleMessage(m) {
  if (m.type === 'rows') {
    if (m.full) rowsByKey = new Map(m.rows.map((r) => [rowKey(r), r]));
    else for (const r of m.rows) rowsByKey.set(rowKey(r), r);
    dirty = true;
    const ch = ensureChain();
    self.postMessage({
      type: 'chain', id: m.id,
      list: underlyingList(ch), stats: chainStats(ch), at: m.at,
    });
    return;
  }

  if (m.type === 'overlay') {
    for (const [ins, v] of Object.entries(m.data)) {
      if (v && !v.error) overlay.set(ins, { ...(overlay.get(ins) || {}), ...v });
    }
    dirty = true;
    self.postMessage({ type: 'overlay-ok', id: m.id, count: overlay.size });
    return;
  }

  if (m.type === 'clear-overlay') {
    overlay = new Map();
    dirty = true;
    self.postMessage({ type: 'overlay-ok', id: m.id, count: 0 });
    return;
  }

  if (m.type === 'scan') {
    const def = byId(m.defId);
    if (!def) { self.postMessage({ type: 'scan', id: m.id, error: 'استراتژی ناشناخته' }); return; }
    const ch = ensureChain();
    const settings = m.onlyIds ? { ...m.settings, greeksInScan: true } : m.settings;
    const res = scan({
      def, chain: ch, uaKeys: m.uaKeys, settings,
      sigmaByUa: m.sigmaByUa || {}, qty: m.qty,
    });
    const rows = m.onlyIds
      ? res.rows.filter((r) => m.onlyIds.includes(r.id))
      : res.rows;
    // شیء payoff تابع دارد و کلون نمی‌شود؛ فقط داده رسم را می‌فرستیم
    for (const r of rows) {
      r.chart = { legs: r.__legs, netCash: r.netCash };
      delete r.payoff;
    }
    self.postMessage({
      type: 'scan', id: m.id, rows, funnel: res.funnel, ms: res.ms, total: res.total,
      refine: !!m.onlyIds,
    });
    return;
  }

  if (m.type === 'scan-all') {
    const ch = ensureChain();
    const defs = m.defIds.map((id) => byId(id)).filter(Boolean);
    const res = scanAll({
      defs, chain: ch, uaKeys: m.uaKeys, settings: m.settings,
      sigmaByUa: m.sigmaByUa || {}, qty: m.qty, limit: m.limit,
    });
    // شیء payoff تابع دارد و کلون نمی‌شود؛ فقط داده رسم را می‌فرستیم
    for (const r of res.rows) {
      r.chart = { legs: r.__legs, netCash: r.netCash };
      delete r.payoff;
    }
    self.postMessage({
      type: 'scan-all', id: m.id, rows: res.rows, funnel: res.funnel, ms: res.ms, total: res.total,
    });
    return;
  }

  if (m.type === 'chain-detail') {
    const ch = ensureChain();
    const ua = ch.get(m.uaIns);
    if (!ua) { self.postMessage({ type: 'chain-detail', id: m.id, error: 'نماد در دیده‌بان نیست' }); return; }
    const out = {
      ins: ua.ins, name: ua.name, last: ua.last, close: ua.close, yday: ua.yday,
      expiries: ua.expiryList.map((ex) => ({
        days: ex.days, endDate: ex.endDate,
        strikes: ex.strikeList.map((st) => ({
          strike: st.strike, size: st.size,
          call: { ...st.call, book: undefined },
          put: { ...st.put, book: undefined },
        })),
      })),
    };
    self.postMessage({ type: 'chain-detail', id: m.id, ua: out });
    return;
  }
}
