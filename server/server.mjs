// سرور محلی.
//
// سرور فقط واسط عبور درخواست نیست؛ صاحب داده است.
//
//   سرور   دریافت ، کش ، سهمیه نرخ درخواست ، نگهداری عکس لحظه‌ای
//   مرورگر  ترکیب‌سازی ، محاسبه ، مرتب‌سازی ، رسم
//
// حلقه دریافت دیده‌بان اینجا می‌چرخد، نه در مرورگر. پس حتی اگر همه تب‌ها
// بسته باشد، آخرین عکس لحظه‌ای در حافظه هست و مرورگر هیچ‌وقت پشت یک
// درخواست شبکه منتظر نمی‌ماند. سهمیه هم فقط اینجا اعمال می‌شود، پس چند تب
// هم‌زمان بازار را نمی‌کوبند.
//
// اجرا:  node server/server.mjs
// بعد در مرورگر:  http://127.0.0.1:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, sanitize } from '../core/settings.mjs';
import { validIns, parseInsList, safeStaticPath, readBody, BodyTooLarge } from './guard.mjs';
import { evictOldest } from './cache.mjs';
import { watchBackoffSec } from './backoff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const SETTINGS_FILE = path.join(ROOT, 'data', 'settings.json');

// سقف بدنه درخواست. تنظیمات چند کیلوبایت است و فهرست موقعیت‌ها هم کوچک؛
// یک مگابایت جای فراوانی می‌دهد و هنوز جلوی پر کردن حافظه را می‌گیرد.
const MAX_BODY = 1024 * 1024;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://main.tsetmc.com/',
};

let S = defaults();

// ————————————————————————————————— تنظیمات روی دیسک —————————————————————————————————

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    S = sanitize(JSON.parse(raw));
    log('تنظیمات از دیسک خوانده شد');
  } catch {
    S = defaults();
    await saveSettings(S).catch(() => {});
  }
}
async function saveSettings(next) {
  S = sanitize(next);
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(S, null, 2), 'utf8');
  return S;
}

// ————————————————————————————————— تشخیص و شمارنده —————————————————————————————————

const stat = {
  started: Date.now(),
  requests: 0, cacheHits: 0, errors: 0, rateWaits: 0,
  upstreamMsTotal: 0, upstreamCount: 0,
  lastError: null, lastErrorAt: null,
  watchTicks: 0, watchRows: 0, lastWatchAt: null, lastWatchMs: 0, watchConsecutiveFails: 0,
  queueDepth: 0, inflight: 0, clients: 0, paused: false, pauseReason: '',
};

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

// ————————————————————————————————— سهمیه نرخ درخواست —————————————————————————————————
// سطل توکن: ظرفیت انفجاری برای رگبار اول، نرخ ثابت برای ادامه.

let tokens = S.burst;
let lastRefill = Date.now();

function takeToken() {
  const now = Date.now();
  tokens = Math.min(S.burst, tokens + ((now - lastRefill) / 1000) * S.ratePerSec);
  lastRefill = now;
  if (tokens >= 1) { tokens -= 1; return 0; }
  const waitMs = Math.ceil(((1 - tokens) / S.ratePerSec) * 1000);
  return waitMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ————————————————————————————————— صف با سقف هم‌زمانی —————————————————————————————————

const queue = [];
let running = 0;

function schedule(fn, priority = 5) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, priority, resolve, reject });
    queue.sort((a, b) => a.priority - b.priority);
    stat.queueDepth = queue.length;
    pump();
  });
}

async function pump() {
  if (running >= S.concurrency || !queue.length) return;
  const job = queue.shift();
  stat.queueDepth = queue.length;
  running += 1;
  stat.inflight = running;
  try {
    const wait = takeToken();
    if (wait > 0) { stat.rateWaits += 1; await sleep(wait); takeToken(); }
    job.resolve(await job.fn());
  } catch (e) {
    job.reject(e);
  } finally {
    running -= 1;
    stat.inflight = running;
    pump();
  }
}

// ————————————————————————————————— کش و ادغام درخواست در پرواز —————————————————————————————————

const cache = new Map();     // url -> { at, data }
const inflight = new Map();  // url -> Promise

async function fetchUpstream(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), S.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const js = await res.json();
    stat.upstreamMsTotal += Date.now() - t0;
    stat.upstreamCount += 1;
    return js;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * دریافت با کش زمان‌دار، ادغام درخواست تکراری، و تلاش مجدد با عقب‌نشینی.
 * پاسخ ناموفق هرگز کش نمی‌شود — وگرنه یک قطعی لحظه‌ای شبکه، یک نماد را
 * تا پایان نشست «شناسایی‌نشده» نگه می‌دارد.
 */
async function get(pathname, ttlSec, priority = 5) {
  const url = `${S.baseUrl}${pathname}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlSec * 1000) { stat.cacheHits += 1; return hit.data; }
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= S.retries; attempt++) {
      try {
        stat.requests += 1;
        const data = await schedule(() => fetchUpstream(url), priority);
        cache.set(url, { at: Date.now(), data });
        evictOldest(cache, S.maxCacheEntries);
        return data;
      } catch (e) {
        lastErr = e;
        stat.errors += 1;
        stat.lastError = `${e.name}: ${e.message}`;
        stat.lastErrorAt = Date.now();
        if (attempt < S.retries) await sleep(300 * 2 ** attempt);
      }
    }
    throw lastErr;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

/** کلید ریشه پاسخ‌های تی‌اس‌ای‌تی‌ام‌سی ثابت نیست؛ اولین لیست را برمی‌گرداند. */
function firstList(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length) return v;
      if (v && typeof v === 'object') { const g = firstList(v); if (g.length) return g; }
    }
  }
  return [];
}
function firstDict(obj) {
  if (!obj || typeof obj !== 'object') return {};
  for (const v of Object.values(obj)) if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return obj;
}

// ————————————————————————————————— ساعات بازار —————————————————————————————————

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// کلید انگلیسی می‌ماند چون تنظیم «روزهای معاملاتی» با همین نوشته می‌شود؛
// فقط چیزی که به کاربر نشان داده می‌شود فارسی است.
const DAY_FA = {
  Sat: 'شنبه', Sun: 'یک‌شنبه', Mon: 'دوشنبه', Tue: 'سه‌شنبه',
  Wed: 'چهارشنبه', Thu: 'پنج‌شنبه', Fri: 'جمعه',
};

function tehranNow() {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const hhmm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function marketOpen() {
  if (!S.gateMarketHours) return { open: true, why: 'دروازه ساعات بازار خاموش است' };
  const { weekday, minutes } = tehranNow();
  const days = String(S.tradeDays).split(',').map((x) => x.trim());
  if (!days.includes(weekday)) return { open: false, why: `${DAY_FA[weekday] || weekday}، روز معاملاتی نیست` };
  if (minutes < hhmm(S.openHHMM)) return { open: false, why: 'بازار باز نشده' };
  if (minutes > hhmm(S.closeHHMM)) return { open: false, why: 'بازار بسته شده' };
  return { open: true, why: '' };
}

// ————————————————————————————————— حلقه دیده‌بان و پخش رویداد —————————————————————————————————

const clients = new Set();
let watch = { at: null, rows: [], byKey: new Map() };

const TRACK = [
  'pDrCotVal_UA', 'pClosing_UA', 'pMeDem_C', 'qTitMeDem_C', 'pMeOf_C', 'qTitMeOf_C',
  'pDrCotVal_C', 'pClosing_C', 'oP_C', 'qTotTran5J_C',
  'pMeDem_P', 'qTitMeDem_P', 'pMeOf_P', 'qTitMeOf_P',
  'pDrCotVal_P', 'pClosing_P', 'oP_P', 'qTotTran5J_P',
];

const rowKey = (r) => `${r.insCode_C ?? ''}|${r.insCode_P ?? ''}`;
const rowSig = (r) => TRACK.map((k) => r[k] ?? '').join(',');

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}

/** @returns {boolean} موفق بود یا نه — بازار بسته هم موفق حساب می‌شود، عقب‌نشینی نمی‌خواهد */
async function watchTick() {
  const gate = marketOpen();
  stat.paused = !gate.open;
  stat.pauseReason = gate.why;
  if (!gate.open) return true;

  const t0 = Date.now();
  try {
    const js = await get('/Instrument/GetInstrumentOptionMarketWatch/0', S.ttlWatchSec, 1);
    const rows = firstList(js);
    const next = new Map();
    const changed = [];
    for (const r of rows) {
      const k = rowKey(r);
      const sig = rowSig(r);
      next.set(k, sig);
      if (watch.byKey.get(k) !== sig) changed.push(r);
    }
    const first = watch.rows.length === 0;
    watch = { at: Date.now(), rows, byKey: next };
    stat.watchTicks += 1;
    stat.watchRows = rows.length;
    stat.lastWatchAt = watch.at;
    stat.lastWatchMs = Date.now() - t0;
    // بار اول کل عکس، بعد فقط ردیف‌های تغییرکرده
    broadcast('watch', { at: watch.at, full: first, count: rows.length, rows: first ? rows : changed });
    return true;
  } catch (e) {
    broadcast('trouble', { at: Date.now(), message: `${e.name}: ${e.message}` });
    return false;
  }
}

async function watchLoop() {
  let fails = 0;
  for (;;) {
    const ok = await watchTick();
    fails = ok ? 0 : fails + 1;
    stat.watchConsecutiveFails = fails;
    await sleep(watchBackoffSec(Math.max(2, S.watchIntervalSec), fails) * 1000);
  }
}

// ————————————————————————————————— نقاط پایانی —————————————————————————————————

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj));

const normalizeDailyRows = (rows) => rows.map((r) => ({
  date: Number(r.dEven), close: Number(r.pClosing) || 0, last: Number(r.pDrCotVal) || 0,
  low: Number(r.priceMin) || 0, high: Number(r.priceMax) || 0, first: Number(r.priceFirst) || 0,
  yday: Number(r.priceYesterday) || 0, vol: Number(r.qTotTran5J) || 0, trades: Number(r.zTotTran) || 0,
  // qTotCap ارزش معامله ثبت‌شده است. اگر بالادست آن را در تاریخچه ندهد،
  // موتور تحلیل مقدار تقریبی «حجم × قیمت پایانی» را جداگانه می‌سازد و برچسب می‌زند.
  value: Number(r.qTotCap) || 0,
})).sort((a, b) => a.date - b.date);

async function serveStatic(res, pathname) {
  const file = safeStaticPath(ROOT, pathname);
  if (!file) return send(res, 403, 'مسیر مجاز نیست', 'text/plain; charset=utf-8');
  try {
    const buf = await fs.readFile(file);
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'یافت نشد', 'text/plain; charset=utf-8');
  }
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const ins = u.searchParams.get('ins');

  try {
    if (p === '/api/health') {
      const gate = marketOpen();
      return sendJson(res, 200, {
        ok: true, upSec: Math.round((Date.now() - stat.started) / 1000),
        market: gate, ...stat,
        avgUpstreamMs: stat.upstreamCount ? Math.round(stat.upstreamMsTotal / stat.upstreamCount) : 0,
        cacheSize: cache.size, watchAgeSec: watch.at ? Math.round((Date.now() - watch.at) / 1000) : null,
        settingsWatchIntervalSec: S.watchIntervalSec,
      });
    }

    if (p === '/api/settings') {
      if (req.method === 'GET') return sendJson(res, 200, S);
      if (req.method === 'PUT') {
        const next = await saveSettings(JSON.parse(await readBody(req, MAX_BODY) || '{}'));
        tokens = Math.min(tokens, next.burst);
        log('تنظیمات ذخیره شد');
        return sendJson(res, 200, next);
      }
      return sendJson(res, 405, { error: 'روش پشتیبانی نمی‌شود' });
    }

    if (p === '/api/watch') {
      if (!watch.rows.length) await watchTick();
      return sendJson(res, 200, { at: watch.at, count: watch.rows.length, rows: watch.rows });
    }

    // فهرست قراردادهای فعال برای تحلیل تاریخی، حتی بیرون از ساعت بازار.
    // حلقه زنده عمداً پشت دروازه ساعت بازار می‌ایستد؛ این نقطه پایانی نباید
    // بایستد چون تاریخچه باید شب و روز قابل بررسی باشد.
    if (p === '/api/history/universe') {
      const rows = watch.rows.length
        ? watch.rows
        : firstList(await get('/Instrument/GetInstrumentOptionMarketWatch/0', Math.max(60, S.ttlMetaSec), 4));
      return sendJson(res, 200, { at: watch.at, count: rows.length, rows });
    }

    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', Connection: 'keep-alive',
      });
      res.write(': متصل شد\n\n');
      clients.add(res);
      stat.clients = clients.size;
      if (watch.rows.length) {
        res.write(`event: watch\ndata: ${JSON.stringify({ at: watch.at, full: true, count: watch.rows.length, rows: watch.rows })}\n\n`);
      }
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); stat.clients = clients.size; });
      return undefined;
    }

    // ——— غنی‌سازی، فقط بر اساس تقاضا ———
    // کد ابزار مستقیم داخل مسیر بالادست می‌نشیند. بدون صحت‌سنجی، یک «..»
    // درخواست را به نقطه پایانی دیگری می‌برد.
    if (p === '/api/book' || p === '/api/info' || p === '/api/optionmeta'
      || p === '/api/daily' || p === '/api/clienttype') {
      if (!validIns(ins)) return sendJson(res, 400, { error: 'کد ابزار باید فقط رقم باشد' });
    }

    if (p === '/api/book') {
      const rows = firstList(await get(`/BestLimits/${ins}`, S.ttlBookSec, 3));
      const book = rows
        .map((r) => ({
          level: Number(r.number), bid: Number(r.pMeDem) || 0, bidQty: Number(r.qTitMeDem) || 0,
          bidOrd: Number(r.zOrdMeDem) || 0, ask: Number(r.pMeOf) || 0, askQty: Number(r.qTitMeOf) || 0,
          askOrd: Number(r.zOrdMeOf) || 0,
        }))
        .filter((r) => Number.isFinite(r.level))
        .sort((a, b) => a.level - b.level)
        .slice(0, 5);
      return sendJson(res, 200, { ins, book });
    }

    if (p === '/api/info') {
      const d = firstDict(await get(`/ClosingPrice/GetClosingPriceInfo/${ins}`, S.ttlInfoSec, 3));
      const st = d.instrumentState && typeof d.instrumentState === 'object' ? d.instrumentState : {};
      return sendJson(res, 200, {
        ins,
        last: Number(d.pDrCotVal) || 0, close: Number(d.pClosing) || 0,
        yday: Number(d.priceYesterday) || 0, first: Number(d.priceFirst) || 0,
        low: Number(d.priceMin) || 0, high: Number(d.priceMax) || 0,
        vol: Number(d.qTotTran5J) || 0, trades: Number(d.zTotTran) || 0,
        value: Number(d.qTotCap) || 0,
        hEven: Number(d.hEven) || 0, lastHEven: Number(d.lastHEven) || 0,
        state: String(st.cEtaval || '').trim(), stateTitle: String(st.cEtavalTitle || '').trim(),
      });
    }

    if (p === '/api/optionmeta') {
      const info = firstDict(await get(`/Instrument/GetInstrumentInfo/${ins}`, S.ttlMetaSec, 4));
      const iid = info.instrumentID;
      if (!iid) return sendJson(res, 200, { ins, found: false });
      const d = firstDict(await get(`/Instrument/GetInstrumentOptionByInstrumentID/${iid}`, S.ttlMetaSec, 4));
      return sendJson(res, 200, {
        ins, found: true, instrumentID: iid,
        A: Number(d.aFactor), B: Number(d.bFactor), C: Number(d.cFactor),
        contractSize: Number(d.contractSize) || 0, strike: Number(d.strikePrice) || 0,
        buyOP: Number(d.buyOP) || 0, sellOP: Number(d.sellOP) || 0,
      });
    }

    if (p === '/api/daily') {
      const rawN = u.searchParams.get('n');
      const n = rawN == null || rawN === '' ? S.volDays : Math.max(0, Math.trunc(Number(rawN) || 0));
      const rows = firstList(await get(`/ClosingPrice/GetClosingPriceDailyList/${ins}/${n}`, S.ttlDailySec, 6));
      return sendJson(res, 200, {
        ins,
        rows: normalizeDailyRows(rows),
      });
    }

    // تاریخچه دسته‌ای همه پاهای یک زنجیره. n=0 یعنی از اولین روز موجود.
    if (p === '/api/dailies') {
      const codes = parseInsList(u.searchParams.get('ins'), 200);
      const rawN = u.searchParams.get('n');
      const n = rawN == null || rawN === '' ? 0 : Math.max(0, Math.trunc(Number(rawN) || 0));
      const one = async (code) => {
        try {
          const rows = firstList(await get(`/ClosingPrice/GetClosingPriceDailyList/${code}/${n}`, S.ttlDailySec, 6));
          return [code, { ins: code, rows: normalizeDailyRows(rows) }];
        } catch (e) {
          return [code, { ins: code, rows: [], error: `${e.name}: ${e.message}` }];
        }
      };
      return sendJson(res, 200, Object.fromEntries(await Promise.all(codes.map(one))));
    }

    if (p === '/api/clienttype') {
      const d = firstDict(await get(`/ClientType/GetClientType/${ins}/1/0`, S.ttlInfoSec, 6));
      return sendJson(res, 200, { ins, ...d });
    }

    // ——— دریافت دسته‌ای: یک رفت و برگشت به‌جای چند ده تا ———
    if (p === '/api/books' || p === '/api/infos') {
      const codes = parseInsList(u.searchParams.get('ins'), 200);
      const wantBook = p === '/api/books';
      const one = async (code) => {
        try {
          if (wantBook) {
            const rows = firstList(await get(`/BestLimits/${code}`, S.ttlBookSec, 3));
            const book = rows
              .map((r) => ({
                level: Number(r.number), bid: Number(r.pMeDem) || 0, bidQty: Number(r.qTitMeDem) || 0,
                bidOrd: Number(r.zOrdMeDem) || 0, ask: Number(r.pMeOf) || 0, askQty: Number(r.qTitMeOf) || 0,
                askOrd: Number(r.zOrdMeOf) || 0,
              }))
              .filter((r) => Number.isFinite(r.level))
              .sort((a, b) => a.level - b.level)
              .slice(0, 5);
            return [code, { book }];
          }
          const d = firstDict(await get(`/ClosingPrice/GetClosingPriceInfo/${code}`, S.ttlInfoSec, 3));
          const st = d.instrumentState && typeof d.instrumentState === 'object' ? d.instrumentState : {};
          const hE = Number(d.lastHEven) || Number(d.hEven) || 0;
          const secs = hE ? (Math.floor(hE / 10000) * 3600 + Math.floor((hE / 100) % 100) * 60 + (hE % 100)) : 0;
          const nowT = tehranNow().minutes * 60;
          return [code, {
            last: Number(d.pDrCotVal) || 0, close: Number(d.pClosing) || 0,
            low: Number(d.priceMin) || 0, high: Number(d.priceMax) || 0,
            first: Number(d.priceFirst) || 0, yday: Number(d.priceYesterday) || 0,
            vol: Number(d.qTotTran5J) || 0, trades: Number(d.zTotTran) || 0,
            state: String(st.cEtaval || '').trim(), stateTitle: String(st.cEtavalTitle || '').trim(),
            staleSec: hE ? Math.max(0, nowT - secs) : null,
          }];
        } catch (e) {
          return [code, { error: `${e.name}` }];
        }
      };
      const pairs = await Promise.all(codes.map(one));
      return sendJson(res, 200, Object.fromEntries(pairs));
    }

    // ——— موقعیت‌های واقعی تو ———
    if (p === '/api/positions') {
      const file = path.join(ROOT, 'data', 'positions.json');
      if (req.method === 'GET') {
        try { return send(res, 200, await fs.readFile(file, 'utf8')); }
        catch { return sendJson(res, 200, []); }
      }
      if (req.method === 'PUT') {
        const list = JSON.parse(await readBody(req, MAX_BODY) || '[]');
        if (!Array.isArray(list)) return sendJson(res, 400, { error: 'فهرست لازم است' });
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
        log(`موقعیت‌ها ذخیره شد — ${list.length} ردیف`);
        return sendJson(res, 200, list);
      }
      return sendJson(res, 405, { error: 'روش پشتیبانی نمی‌شود' });
    }

    if (p === '/api/cache' && req.method === 'DELETE') {
      cache.clear();
      return sendJson(res, 200, { cleared: true });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'نقطه پایانی ناشناخته' });
    return serveStatic(res, p);
  } catch (e) {
    // بدنه بزرگ و جیسون خراب، خطای فرستنده‌اند نه خطای بالادست
    if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: e.message });
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'بدنه، جیسون معتبر نیست' });
    return sendJson(res, 502, { error: `${e.name}: ${e.message}` });
  }
}

await loadSettings();
http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  log(`سرور بالا آمد → http://127.0.0.1:${PORT}`);
  const g = marketOpen();
  log(g.open ? 'بازار باز است، حلقه دیده‌بان شروع شد' : `حلقه دیده‌بان متوقف: ${g.why}`);
});
watchLoop();
