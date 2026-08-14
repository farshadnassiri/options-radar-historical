// موتور بازپخش تاریخی موقعیت‌ها.
//
// هر ردیف یک سؤال مستقل است: اگر موقعیت در تاریخ شروع باز می‌شد و در این
// روز معاملاتی کامل آفست می‌شد، سود و زیان چه بود؟ قیمت گمشده هرگز با قیمت
// روز قبل پر نمی‌شود؛ ردیف ناقص صریحاً «فاقد داده» می‌ماند.

import { num, ok, EPS } from './num.mjs';
import { grossCash, entryFees, analyzePayoff } from './payoff.mjs';
import { analyzeMixed, isSingleExpiry } from './mixed.mjs';
import { strategyMargin, capitalBase } from './margin.mjs';
import { jalaliToGregorian, gregorianToJalali } from './jalali.mjs';

export const HISTORY_BASES = [
  ['LAST', 'آخرین'],
  ['CLOSE', 'پایانی'],
  ['LOW', 'کمترین'],
  ['HIGH', 'بیشترین'],
];

const DAY_FA = ['یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه', 'شنبه'];

export function dateParts(value) {
  const s = String(Math.trunc(num(value))).padStart(8, '0');
  if (!/^\d{8}$/.test(s)) return null;
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(4, 6)), d: Number(s.slice(6, 8)) };
}

/** تاریخ سررسید دیده‌بان ممکن است شمسی یا میلادی باشد؛ خروجی همیشه YYYYMMDD میلادی است. */
export function normalizeHistoryDate(value) {
  const p = dateParts(value);
  if (!p) return 0;
  if (p.y >= 1300 && p.y < 1700) {
    const [gy, gm, gd] = jalaliToGregorian(p.y, p.m, p.d);
    return gy * 10000 + gm * 100 + gd;
  }
  return p.y * 10000 + p.m * 100 + p.d;
}

export function dateUtc(value) {
  const p = dateParts(normalizeHistoryDate(value));
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)) : null;
}

export function daysBetween(a, b) {
  const da = dateUtc(a), db = dateUtc(b);
  if (!da || !db) return NaN;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

export function historyDateLabel(value) {
  const p = dateParts(normalizeHistoryDate(value));
  if (!p) return '—';
  const [jy, jm, jd] = gregorianToJalali(p.y, p.m, p.d);
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

export function historyDayName(value) {
  const d = dateUtc(value);
  return d ? DAY_FA[d.getUTCDay()] : '—';
}

export function historyPrice(row, basis, manual = NaN) {
  if (basis === 'MANUAL') return num(manual, NaN);
  if (!row) return NaN;
  const key = { LAST: 'last', CLOSE: 'close', LOW: 'low', HIGH: 'high' }[basis];
  const value = key ? num(row[key], NaN) : NaN;
  return value > 0 ? value : NaN;
}

export function indexHistory(rows = []) {
  const out = new Map();
  for (const row of rows) {
    const date = normalizeHistoryDate(row.date);
    if (date) out.set(date, { ...row, date });
  }
  return out;
}

/** حجم، تعداد معامله و ارزش روزانه؛ ارزش برآوردی هرگز با مقدار رسمی قاطی نمی‌شود. */
export function historyMarketMetrics(row) {
  if (!row) return { volume: 0, trades: 0, value: 0, valueEstimated: false };
  const volume = Math.max(0, num(row.vol));
  const trades = Math.max(0, num(row.trades));
  const official = Math.max(0, num(row.value));
  const close = historyPrice(row, 'CLOSE');
  const estimated = official > 0 ? official : (volume > 0 && close > 0 ? volume * close : 0);
  return { volume, trades, value: estimated, valueEstimated: official <= 0 && estimated > 0 };
}

function passesLiquidity(row, minVolume = 0, minValue = 0) {
  const m = historyMarketMetrics(row);
  return m.volume >= Math.max(0, num(minVolume)) && m.value >= Math.max(0, num(minValue));
}

export function flattenActiveContracts(ua) {
  const out = [];
  for (const ex of ua?.expiryList || []) {
    for (const st of ex.strikeList || []) {
      for (const kind of ['call', 'put']) {
        const q = st[kind];
        if (!q?.ins) continue;
        out.push({
          ins: String(q.ins), name: q.name || String(q.ins), kind,
          strike: st.strike, size: st.size || 1000,
          expiry: normalizeHistoryDate(ex.endDate), expiryRaw: ex.endDate,
          daysNow: ex.days,
        });
      }
    }
  }
  return out.sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || a.kind.localeCompare(b.kind));
}

const reverseSide = (side) => (side === 'buy' ? 'sell' : 'buy');

function pricedLegsAtEntry(legs, indexes, startDate, basis, manuals, units) {
  const priced = [];
  const missing = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const row = indexes.get(String(leg.ins))?.get(startDate);
    const manual = manuals?.[i];
    const price = historyPrice(row, manual != null && manual !== '' ? 'MANUAL' : basis, manual);
    if (!(price >= 0) || !Number.isFinite(price)) missing.push(i);
    const market = historyMarketMetrics(row);
    priced.push({
      ...leg,
      ratio: num(leg.ratio, 1) * Math.max(1, Math.trunc(num(units, 1))),
      price,
      days: Math.max(0, daysBetween(startDate, leg.expiry)),
      entryVolume: market.volume, entryTrades: market.trades,
      entryValue: market.value, entryValueEstimated: market.valueEstimated,
    });
  }
  return { priced, missing };
}

function closeAtDate(priced, indexes, date, basis, fees) {
  const closeLegs = [];
  const missing = [];
  const perLeg = [];
  for (let i = 0; i < priced.length; i++) {
    const leg = priced[i];
    const row = indexes.get(String(leg.ins))?.get(date);
    const price = historyPrice(row, basis);
    if (!Number.isFinite(price)) missing.push(i);
    const close = { ...leg, side: reverseSide(leg.side), price };
    closeLegs.push(close);
    const entryGross = grossCash([leg]);
    const closeGross = Number.isFinite(price) ? grossCash([close]) : NaN;
    const entryFee = entryFees([leg], fees);
    const exitFee = Number.isFinite(price) ? entryFees([close], fees) : NaN;
    const market = historyMarketMetrics(row);
    perLeg.push({
      index: i, ins: leg.ins, name: leg.name, kind: leg.kind, side: leg.side,
      strike: leg.strike, entryPrice: leg.price, exitPrice: price,
      grossPnl: entryGross + closeGross,
      netPnl: entryGross + closeGross - entryFee - exitFee,
      entryFee, exitFee,
      volume: market.volume, trades: market.trades,
      value: market.value, valueEstimated: market.valueEstimated,
    });
  }
  if (missing.length) return { missing, perLeg };
  const gross = grossCash(closeLegs);
  const fee = entryFees(closeLegs, fees);
  return { missing, perLeg, closeLegs, gross, fee };
}

function capitalForEntry(priced, netCash, spot, settings, fees) {
  const payoff = isSingleExpiry(priced)
    ? analyzePayoff(priced, netCash, { fees })
    : analyzeMixed(priced, netCash, {
      fees, spot, rFree: settings.rFree, divYield: settings.divYield,
      sigma: settings.volManual,
    });
  const closes = Object.fromEntries(priced.map((l, i) => [i, l.price]));
  const margin = strategyMargin(priced, {
    S: spot, closes,
    params: { A: settings.marginA, B: settings.marginB, C: settings.marginC, maint: settings.marginMaint },
    creditMode: settings.creditSpreadMargin, capitalMode: settings.capitalMode,
  });
  const capital = capitalBase({
    legs: priced, netCash, marginNet: margin.marginNet, maxLoss: payoff.maxLoss,
  });
  return { payoff, margin, capital };
}

function baseMetrics(baseIndex, date, startRow, previousDate) {
  const row = baseIndex.get(date);
  const prev = previousDate ? baseIndex.get(previousDate) : null;
  const close = historyPrice(row, 'CLOSE');
  const prevClose = historyPrice(prev, 'CLOSE');
  const startClose = historyPrice(startRow, 'CLOSE');
  const market = historyMarketMetrics(row);
  return {
    baseClose: close,
    baseDailyPct: close > 0 && prevClose > 0 ? ((close / prevClose) - 1) * 100 : NaN,
    baseCumulativePct: close > 0 && startClose > 0 ? ((close / startClose) - 1) * 100 : NaN,
    baseVolume: market.volume, baseTrades: market.trades,
    baseValue: market.value, baseValueEstimated: market.valueEstimated,
  };
}

const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const median = (values) => quantile(values, 0.5);
function quantile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
function stdDev(values) {
  if (values.length < 2) return NaN;
  const m = average(values);
  return Math.sqrt(values.reduce((s, v) => s + ((v - m) ** 2), 0) / (values.length - 1));
}
function correlation(a, b) {
  if (a.length < 2 || a.length !== b.length) return NaN;
  const ma = average(a), mb = average(b);
  const top = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  const da = Math.sqrt(a.reduce((s, v) => s + ((v - ma) ** 2), 0));
  const db = Math.sqrt(b.reduce((s, v) => s + ((v - mb) ** 2), 0));
  return da > EPS && db > EPS ? top / (da * db) : NaN;
}
function longestStreak(values, predicate) {
  let best = 0, run = 0;
  for (const value of values) { run = predicate(value) ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

export function summarizeReplay(rows, entry = {}) {
  const valid = rows.filter((r) => r.status === 'ok');
  if (!valid.length) return {
    validDays: 0, missingDays: rows.filter((r) => r.status === 'missing').length, best: null, worst: null,
    positiveDays: 0, negativeDays: 0, flatDays: 0,
    positivePct: NaN, negativePct: NaN, maxDrawdown: NaN, firstProfit: null,
    liquidityDays: rows.filter((r) => r.status === 'liquidity').length,
  };
  const best = valid.reduce((a, r) => (r.netPnl > a.netPnl ? r : a));
  const worst = valid.reduce((a, r) => (r.netPnl < a.netPnl ? r : a));
  const positiveDays = valid.filter((r) => r.netPnl > 0).length;
  const negativeDays = valid.filter((r) => r.netPnl < 0).length;
  const flatDays = valid.length - positiveDays - negativeDays;
  const firstProfit = valid.find((r) => r.netPnl > 0) || null;
  const pnls = valid.map((r) => r.netPnl);
  const returns = valid.map((r) => r.returnPct).filter(Number.isFinite);
  const gains = pnls.filter((v) => v > 0), losses = pnls.filter((v) => v < 0);
  const paired = valid.filter((r) => Number.isFinite(r.returnPct) && Number.isFinite(r.baseCumulativePct));
  return {
    validDays: valid.length,
    missingDays: rows.filter((r) => r.status === 'missing').length,
    liquidityDays: rows.filter((r) => r.status === 'liquidity').length,
    best, worst, last: valid.at(-1), firstProfit,
    positiveDays, negativeDays, flatDays,
    positivePct: (positiveDays / valid.length) * 100,
    negativePct: (negativeDays / valid.length) * 100,
    flatPct: (flatDays / valid.length) * 100,
    maxDrawdown: Math.min(...valid.map((r) => r.drawdown)),
    meanPnl: average(pnls), medianPnl: median(pnls), pnlStdDev: stdDev(pnls),
    meanReturn: average(returns), medianReturn: median(returns), returnStdDev: stdDev(returns),
    p10: quantile(returns, 0.10), p25: quantile(returns, 0.25),
    p75: quantile(returns, 0.75), p90: quantile(returns, 0.90),
    avgGain: average(gains), avgLoss: average(losses),
    profitFactor: losses.length ? gains.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : (gains.length ? Infinity : NaN),
    longestPositive: longestStreak(pnls, (v) => v > 0),
    longestNegative: longestStreak(pnls, (v) => v < 0),
    returnBaseCorrelation: correlation(paired.map((r) => r.returnPct), paired.map((r) => r.baseCumulativePct)),
    entryGross: entry.gross, entryFee: entry.fee, netCash: entry.netCash,
    cashPaid: entry.cashPaid, cashReceived: entry.cashReceived,
    cashNetGross: entry.cashNetGross,
    capital: entry.capital?.value, capitalLabel: entry.capital?.label,
    margin: entry.margin?.margin, marginNet: entry.margin?.marginNet,
    conditionalMargin: entry.margin?.conditionalMargin,
  };
}

/**
 * بازپخش یک ترکیب انتخاب‌شده. seriesByIns شیء ins → آرایه روزانه است.
 */
export function replayHistory({
  legs, seriesByIns, baseIns, startDate, endDate,
  entryBasis = 'CLOSE', exitBasis = 'LAST', manualEntry = {}, units = 1,
  fees = {}, settings = {}, liquidity = {},
}) {
  const start = normalizeHistoryDate(startDate), requestedEnd = normalizeHistoryDate(endDate);
  const indexes = new Map(Object.entries(seriesByIns || {}).map(([ins, rows]) => [String(ins), indexHistory(rows)]));
  const baseIndex = indexes.get(String(baseIns)) || new Map();
  const expiry = Math.min(...legs.filter((l) => l.kind !== 'underlying').map((l) => normalizeHistoryDate(l.expiry)).filter(Boolean));
  const end = Number.isFinite(expiry) ? Math.min(requestedEnd, expiry) : requestedEnd;
  const { priced, missing } = pricedLegsAtEntry(legs, indexes, start, entryBasis, manualEntry, units);
  const startBase = baseIndex.get(start);
  const spot = historyPrice(startBase, 'CLOSE');
  if (missing.length || !(spot > 0)) {
    return {
      ok: false, error: 'قیمت ورود یک یا چند پا یا قیمت پایانی نماد پایه موجود نیست',
      missingEntryLegs: missing, rows: [], priced,
    };
  }

  const startBaseMarket = historyMarketMetrics(startBase);
  const baseEntryLiquid = passesLiquidity(startBase, liquidity.minBaseVolume, liquidity.minBaseValue);
  const illiquidEntryLegs = priced
    .map((leg, i) => ({ leg, i, row: indexes.get(String(leg.ins))?.get(start) }))
    .filter(({ leg, row }) => leg.kind !== 'underlying' && !passesLiquidity(row, liquidity.minLegVolume, liquidity.minLegValue))
    .map(({ i }) => i);
  if (!baseEntryLiquid || illiquidEntryLegs.length) {
    return {
      ok: false, error: 'حجم یا ارزش روز ورود از حداقل فیلتر نقدشوندگی کمتر است',
      liquidityError: true, illiquidEntryLegs, rows: [], priced,
    };
  }

  const legCash = priced.map((leg) => grossCash([leg]));
  const cashReceived = legCash.filter((value) => value > 0).reduce((a, b) => a + b, 0);
  const cashPaid = Math.abs(legCash.filter((value) => value < 0).reduce((a, b) => a + b, 0));
  const gross = cashReceived - cashPaid;
  const fee = entryFees(priced, fees);
  const netCash = gross - fee;
  const risk = capitalForEntry(priced, netCash, spot, settings, fees);
  const entry = {
    gross, fee, netCash, cashReceived, cashPaid, cashNetGross: gross,
    ...risk, baseMarket: startBaseMarket,
  };
  const dates = [...baseIndex.keys()].filter((d) => d >= start && d <= end).sort((a, b) => a - b);
  const rows = [];
  let peak = -Infinity, previousPnl = NaN;
  let previousLegPnl = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const close = closeAtDate(priced, indexes, date, exitBasis, fees);
    const base = baseMetrics(baseIndex, date, startBase, dates[i - 1]);
    if (close.missing.length) {
      rows.push({
        date, dateLabel: historyDateLabel(date), dayName: historyDayName(date),
        holdingDays: daysBetween(start, date), status: 'missing', missingLegs: close.missing,
        perLeg: close.perLeg, ...base,
      });
      continue;
    }
    const grossPnl = gross + close.gross;
    const netPnl = netCash + close.gross - close.fee;
    const cap = risk.capital.value;
    const returnPct = cap > EPS ? (netPnl / cap) * 100 : NaN;
    const baseLiquid = base.baseVolume >= Math.max(0, num(liquidity.minBaseVolume))
      && base.baseValue >= Math.max(0, num(liquidity.minBaseValue));
    const illiquidLegs = close.perLeg
      .map((leg, index) => ({ leg, index }))
      .filter(({ leg, index }) => priced[index].kind !== 'underlying'
        && (leg.volume < Math.max(0, num(liquidity.minLegVolume)) || leg.value < Math.max(0, num(liquidity.minLegValue))))
      .map(({ index }) => index);
    const status = baseLiquid && !illiquidLegs.length ? 'ok' : 'liquidity';
    if (status === 'ok') peak = Math.max(peak, netPnl);
    const drawdown = Number.isFinite(peak) ? netPnl - peak : 0;
    const pnlDelta = Number.isFinite(previousPnl) ? netPnl - previousPnl : 0;
    close.perLeg.forEach((leg, index) => {
      leg.pnlDelta = Number.isFinite(previousLegPnl[index]) ? leg.netPnl - previousLegPnl[index] : 0;
    });
    const currentCloses = Object.fromEntries(close.perLeg.map((l, index) => [index, l.exitPrice]));
    const dayMargin = strategyMargin(priced, {
      S: base.baseClose, closes: currentCloses,
      params: { A: settings.marginA, B: settings.marginB, C: settings.marginC, maint: settings.marginMaint },
      creditMode: settings.creditSpreadMargin, capitalMode: settings.capitalMode,
    });
    rows.push({
      date, dateLabel: historyDateLabel(date), dayName: historyDayName(date),
      holdingDays: daysBetween(start, date), daysToExpiry: Number.isFinite(expiry) ? daysBetween(date, expiry) : NaN,
      status, illiquidLegs, baseLiquid, grossPnl, entryFee: fee, exitFee: close.fee,
      totalFees: fee + close.fee, netPnl, pnlDelta, returnPct, drawdown,
      margin: dayMargin.margin, marginNet: dayMargin.marginNet,
      conditionalMargin: dayMargin.conditionalMargin, marginPerLeg: dayMargin.perLeg,
      perLeg: close.perLeg, ...base,
    });
    previousPnl = netPnl;
    previousLegPnl = close.perLeg.map((l) => l.netPnl);
  }
  return {
    ok: true, startDate: start, endDate: end, expiry, entryBasis, exitBasis,
    priced, entry, rows, summary: summarizeReplay(rows, entry),
    approximateCapital: !isSingleExpiry(priced),
  };
}

function choose(arr, k, cap = Infinity) {
  const out = [];
  const walk = (at, picked) => {
    if (out.length >= cap) return;
    if (picked.length === k) { out.push([...picked]); return; }
    for (let i = at; i < arr.length; i++) {
      picked.push(arr[i]); walk(i + 1, picked); picked.pop();
      if (out.length >= cap) return;
    }
  };
  walk(0, []);
  return out;
}

function equalWidth(strikes) {
  if (strikes.length < 3) return true;
  const width = strikes[1] - strikes[0];
  return strikes.slice(2).every((k, i) => Math.abs((k - strikes[i + 1]) - width) <= Math.max(1, width * 0.02));
}

/** تمام ترکیب‌های ساختاری یک استراتژی روی قراردادهای فعال. */
export function generateHistoricalCombos({ def, ua, seriesByIns, startDate, entryBasis = 'CLOSE', settings = {}, filtered = true, liquidity = {} }) {
  const start = normalizeHistoryDate(startDate);
  const contracts = flattenActiveContracts(ua);
  const indexes = new Map(Object.entries(seriesByIns || {}).map(([ins, rows]) => [String(ins), indexHistory(rows)]));
  const baseIndex = indexes.get(String(ua.ins)) || new Map();
  const spot = historyPrice(baseIndex.get(start), 'CLOSE');
  if (!(spot > 0)) return { combos: [], built: 0, noEntry: 0, noLiquidity: 0, capped: false };
  if (!passesLiquidity(baseIndex.get(start), liquidity.minBaseVolume, liquidity.minBaseValue)) {
    return { combos: [], built: 0, noEntry: 0, noLiquidity: 1, capped: false };
  }
  const expiries = [...new Set(contracts.map((c) => c.expiry))]
    .filter((expiry) => expiry > start)
    .filter((expiry) => {
      if (!filtered) return true;
      const days = daysBetween(start, expiry);
      return days >= num(settings.minDays, 0) && days <= num(settings.maxDays, 400);
    })
    .sort((a, b) => a - b);
  const expirySets = def.expiries > 1
    ? expiries.flatMap((a, i) => expiries.slice(i + 1).map((b) => [a, b]))
    : expiries.map((e) => [e]);
  const byKey = new Map(contracts.map((c) => [`${c.expiry}|${c.kind}|${c.strike}`, c]));
  const out = [];
  let built = 0, noEntry = 0, noLiquidity = 0, capped = false;
  const maxRows = Math.max(1, Math.trunc(num(settings.maxRows, 4000)));
  const maxPerExpiry = Math.max(1, Math.trunc(num(settings.maxCombosPerExpiry, 400)));
  const windowPct = num(settings.comboWindowPct, 25) / 100;

  for (const exSet of expirySets) {
    const strikes = [...new Set(contracts.filter((c) => c.expiry === exSet[0]).map((c) => c.strike))]
      .filter((k) => !filtered || (k >= spot * (1 - windowPct) && k <= spot * (1 + windowPct)))
      .sort((a, b) => a - b);
    const sets = def.strikes === 1 ? strikes.map((k) => [k]) : choose(strikes, def.strikes, maxPerExpiry * 4);
    let made = 0;
    for (const strikeSet of sets) {
      if (made >= maxPerExpiry || out.length >= maxRows) { capped = true; break; }
      if (filtered && def.strikes >= 3 && settings.wingsEqualWidth && !equalWidth(strikeSet)) continue;
      built += 1;
      const legs = [];
      let missingStructure = false;
      for (const t of def.legs) {
        if (t.kind === 'underlying') {
          const size = contracts[0]?.size || 1000;
          legs.push({ kind: 'underlying', side: t.side, ratio: t.ratio, size, ins: String(ua.ins), name: ua.name, expiry: exSet[0] });
          continue;
        }
        const expiry = exSet[Math.min(t.exp, exSet.length - 1)];
        const strike = strikeSet[t.slot - 1];
        const c = byKey.get(`${expiry}|${t.kind}|${strike}`);
        if (!c) { missingStructure = true; break; }
        legs.push({ ...c, side: t.side, ratio: t.ratio, slot: t.slot, exp: t.exp });
      }
      if (missingStructure) continue;
      const hasEntry = legs.every((l) => Number.isFinite(historyPrice(indexes.get(String(l.ins))?.get(start), entryBasis)));
      if (!hasEntry) { noEntry += 1; continue; }
      const liquidEntry = legs.every((l) => l.kind === 'underlying'
        || passesLiquidity(indexes.get(String(l.ins))?.get(start), liquidity.minLegVolume, liquidity.minLegValue));
      if (!liquidEntry) { noLiquidity += 1; continue; }
      made += 1;
      out.push({
        id: legs.map((l) => l.ins).join('|'), legs, strikes: strikeSet,
        expiries: exSet, spot, underlying: ua.name, uaIns: String(ua.ins),
      });
    }
    if (out.length >= maxRows) break;
  }
  return { combos: out, built, noEntry, noLiquidity, capped };
}

/** مقایسه چهار مبنای ورود × چهار مبنای آفست در آخرین روز معتبر. */
export function basisMatrix(args) {
  const rows = [];
  for (const [entry] of HISTORY_BASES) {
    for (const [exit] of HISTORY_BASES) {
      const replay = replayHistory({ ...args, entryBasis: entry, exitBasis: exit, manualEntry: {} });
      rows.push({ entry, exit, ok: replay.ok, result: replay.summary?.last || null });
    }
  }
  return rows;
}

/** حساسیت قیمت ورود هر پا با شوک درصدی؛ آفست در آخرین روز بازه ثابت می‌ماند. */
export function entrySensitivity(args, shocks = [-10, -5, 0, 5, 10]) {
  const base = replayHistory(args);
  if (!base.ok) return [];
  const out = [];
  for (let i = 0; i < base.priced.length; i++) {
    for (const shockPct of shocks) {
      const manualEntry = Object.fromEntries(base.priced.map((l, j) => [j, j === i ? l.price * (1 + shockPct / 100) : l.price]));
      const replay = replayHistory({ ...args, manualEntry });
      out.push({ legIndex: i, shockPct, entryPrice: manualEntry[i], result: replay.summary?.last || null });
    }
  }
  return out;
}

/** ماتریس ورودهای پیاپی برای یک ترکیب؛ هر خانه نتیجه ورود i و آفست j است. */
export function rollingEntryMatrix(args) {
  const baseRows = (args.seriesByIns?.[String(args.baseIns)] || [])
    .map((r) => normalizeHistoryDate(r.date))
    .filter((d) => d >= normalizeHistoryDate(args.startDate) && d <= normalizeHistoryDate(args.endDate))
    .sort((a, b) => a - b);
  const cells = [];
  for (let i = 0; i < baseRows.length; i++) {
    const replay = replayHistory({ ...args, startDate: baseRows[i], manualEntry: {} });
    if (!replay.ok) continue;
    for (const row of replay.rows) {
      if (row.date < baseRows[i] || row.status !== 'ok') continue;
      cells.push({ entryDate: baseRows[i], exitDate: row.date, netPnl: row.netPnl, returnPct: row.returnPct });
    }
  }
  return { dates: baseRows, cells };
}

/**
 * جست‌وجوی یک قاعده خروج قابل‌تکرار روی همه روزهای ورود ممکن:
 * نخستین رسیدن به هدف بازده، وگرنه خروج در سقف روز معاملاتی.
 * رتبه‌بندی با میانه بازده انجام می‌شود تا یک خروج استثنایی نتیجه را منحرف نکند.
 */
export function optimizeExitPolicy(args, {
  targets = [2, 5, 8, 10, 15, 20, 30],
  holdingDays = [1, 2, 3, 5, 8, 10, 15, 20],
} = {}) {
  const start = normalizeHistoryDate(args.startDate), end = normalizeHistoryDate(args.endDate);
  const dates = (args.seriesByIns?.[String(args.baseIns)] || [])
    .map((r) => normalizeHistoryDate(r.date))
    .filter((d) => d >= start && d <= end)
    .sort((a, b) => a - b);
  const replays = [];
  for (const entryDate of dates.slice(0, -1)) {
    const replay = replayHistory({ ...args, startDate: entryDate, manualEntry: {} });
    if (!replay.ok) continue;
    const valid = replay.rows.filter((r) => r.status === 'ok' && r.date > entryDate);
    if (valid.length) replays.push({ entryDate, rows: valid });
  }
  const policies = [];
  for (const targetPct of targets) {
    for (const maxTradingDays of holdingDays) {
      const exits = [];
      for (const sample of replays) {
        const window = sample.rows.slice(0, maxTradingDays);
        if (!window.length) continue;
        const hit = window.find((r) => r.returnPct >= targetPct);
        const exit = hit || window.at(-1);
        exits.push({
          entryDate: sample.entryDate, exitDate: exit.date,
          returnPct: exit.returnPct, netPnl: exit.netPnl,
          tradingDays: window.indexOf(exit) + 1, targetHit: Boolean(hit),
        });
      }
      if (!exits.length) continue;
      const returns = exits.map((x) => x.returnPct);
      const pnls = exits.map((x) => x.netPnl);
      policies.push({
        targetPct, maxTradingDays, samples: exits.length,
        meanReturn: average(returns), medianReturn: median(returns),
        returnStdDev: stdDev(returns), meanPnl: average(pnls),
        winPct: (returns.filter((v) => v > 0).length / returns.length) * 100,
        targetHitPct: (exits.filter((x) => x.targetHit).length / exits.length) * 100,
        avgTradingDays: average(exits.map((x) => x.tradingDays)), exits,
      });
    }
  }
  policies.sort((a, b) =>
    (b.medianReturn - a.medianReturn)
    || (b.winPct - a.winPct)
    || (b.meanReturn - a.meanReturn)
    || (a.returnStdDev - b.returnStdDev));
  const fixed = replayHistory(args);
  return {
    sampleEntries: replays.length,
    bestPolicy: policies[0] || null,
    policies: policies.slice(0, 12),
    bestObserved: fixed.ok ? fixed.summary.best : null,
  };
}
