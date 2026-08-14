// محاسبات سنگین تحلیل تاریخی بیرون از نخ رابط کاربری.

import { byId } from '../strategies/catalog.mjs';
import { generateHistoricalCombos, replayHistory, rollingEntryMatrix } from '../core/history.mjs';

self.onmessage = (event) => {
  const m = event.data;
  try {
    if (m.type === 'combos') {
      const def = byId(m.defId);
      if (!def) throw new Error('استراتژی ناشناخته است');
      const generated = generateHistoricalCombos({
        def, ua: m.ua, seriesByIns: m.seriesByIns, startDate: m.startDate,
        entryBasis: m.entryBasis, settings: m.settings, filtered: m.filtered,
        liquidity: m.liquidity,
      });
      const rows = [];
      for (let i = 0; i < generated.combos.length; i++) {
        const combo = generated.combos[i];
        const replay = replayHistory({
          legs: combo.legs, seriesByIns: m.seriesByIns, baseIns: combo.uaIns,
          startDate: m.startDate, endDate: m.endDate,
          entryBasis: m.entryBasis, exitBasis: m.exitBasis,
          units: m.units, fees: m.fees, settings: m.settings, liquidity: m.liquidity,
        });
        if (replay.ok) {
          rows.push({
            id: combo.id, legs: combo.legs, strikes: combo.strikes, expiries: combo.expiries,
            spot: combo.spot, summary: replay.summary,
            entry: { gross: replay.entry.gross, fee: replay.entry.fee, netCash: replay.entry.netCash,
              cashPaid: replay.entry.cashPaid, cashReceived: replay.entry.cashReceived,
              cashNetGross: replay.entry.cashNetGross,
              capital: replay.entry.capital, margin: replay.entry.margin,
              baseMarket: replay.entry.baseMarket,
              legsMarket: replay.priced.map((l) => ({
                volume: l.entryVolume, trades: l.entryTrades,
                value: l.entryValue, valueEstimated: l.entryValueEstimated,
              })) },
          });
        }
        if (i > 0 && i % 50 === 0) {
          self.postMessage({ type: 'progress', id: m.id, done: i, total: generated.combos.length });
        }
      }
      self.postMessage({
        type: 'combos', id: m.id, rows,
        generated: { built: generated.built, noEntry: generated.noEntry,
          noLiquidity: generated.noLiquidity, capped: generated.capped },
      });
      return;
    }

    if (m.type === 'rolling') {
      const result = rollingEntryMatrix(m.args);
      self.postMessage({ type: 'rolling', id: m.id, result });
      return;
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: m.id, error: String(error?.message || error) });
  }
};
