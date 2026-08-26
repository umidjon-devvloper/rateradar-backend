import axios from 'axios';
import { env } from '../../config/env.js';

// ════════════════════════════════════════════════════════════════════
// EXELY CONNECT API — past darajali klient (OAuth2 + limit + retry)
//
// Auth: OAuth2 `client_credentials`. Token 15 DAQIQA yashaydi va refresh
// token YO'Q — muddati tugasa qaytadan so'raladi.
//
// ⛔ ENG MUHIM CHEKLOV — auth endpointi IP BO'YICHA cheklangan:
//        3 so'rov/sekund · 15/daqiqa · 300/SOAT
//    Bu ijarachi boshiga emas, BUTUN SERVER uchun. Ya'ni token keshlanmasa
//    SaaS 20-30 mijozdayoq qulaydi.
//
//    Hisob: token 15 daq → 14 daqiqada bir yangilaymiz → mijoz boshiga
//    ~4.3 so'rov/soat. 250 lik xavfsiz shiftda ≈ 58 ta mijoz/IP.
//    Shundan oshsa: (a) token TTL'ini to'liq ishlating, (b) sync'ni
//    vaqt bo'yicha yoying, (c) chiquvchi IP'ni ko'paytiring (proxy pool).
//    `authLimiterState()` shu chegaraga qancha yaqinligini ko'rsatadi.
// ════════════════════════════════════════════════════════════════════

const AUTH_PATH = '/auth/token';

// Xavfsiz shift — hujjatdagi 300 emas, 250. Qolgan 50 ta zaxira: qayta
// urinishlar, yangi mijoz ulanishi va soat chegarasidagi siljish uchun.
const MAX_PER_SEC = 3;
const MAX_PER_MIN = 15;
const MAX_PER_HOUR = 250;

// Tokenni muddati tugashidan shuncha oldin yangilaymiz — uzoq so'rov
// o'rtasida token o'lib qolmasligi uchun.
const REFRESH_MARGIN_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Auth so'rovlari uchun sirpanuvchi oyna hisoblagichi ──────────────
const authHits = []; // millisekundlik vaqt tamg'alari (o'sish tartibida)

function pruneHits(now) {
  while (authHits.length && now - authHits[0] > 3_600_000) authHits.shift();
}

/** Chegaraga tushmaslik uchun kutiladigan vaqt (ms). 0 = hozir mumkin. */
function waitNeeded(now) {
  pruneHits(now);
  const inSec = authHits.filter((t) => now - t < 1_000);
  const inMin = authHits.filter((t) => now - t < 60_000);
  if (authHits.length >= MAX_PER_HOUR) return 3_600_000 - (now - authHits[0]) + 50;
  if (inMin.length >= MAX_PER_MIN) return 60_000 - (now - inMin[0]) + 50;
  if (inSec.length >= MAX_PER_SEC) return 1_000 - (now - inSec[0]) + 50;
  return 0;
}

/** Auth so'rovi uchun "navbat" oladi — kerak bo'lsa kutadi. */
async function acquireAuthSlot() {
  for (let i = 0; i < 60; i += 1) {
    const now = Date.now();
    const wait = waitNeeded(now);
    if (wait <= 0) {
      authHits.push(now);
      return;
    }
    // Soatlik chegaraga urilish — bu tizimli muammo, jimgina kutish emas.
    if (wait > 60_000) {
      console.warn(
        `[exely] Auth soatlik chegarasi (${MAX_PER_HOUR}/soat) to'ldi — ` +
        `${Math.round(wait / 1000)}s kutiladi. Mijozlar soni IP sig'imidan oshgan bo'lishi mumkin.`,
      );
    }
    await sleep(Math.min(wait, 30_000));
  }
  throw new Error('Exely auth chegarasi: token olib bo\'lmadi (juda uzoq kutish)');
}

/** Monitoring uchun: hozir soat/daqiqa oynasida nechta auth so'rovi bor. */
export function authLimiterState() {
  const now = Date.now();
  pruneHits(now);
  return {
    lastHour: authHits.length,
    lastMinute: authHits.filter((t) => now - t < 60_000).length,
    maxPerHour: MAX_PER_HOUR,
    // Taxminiy sig'im: har ulanish soatiga ~4.3 token so'raydi.
    approxTenantCapacity: Math.floor(MAX_PER_HOUR / 4.3),
  };
}

// ── Token keshi: clientId → { token, expiresAt, apiAccesses } ────────
const tokenCache = new Map();
// Bir vaqtda bir nechta so'rov bitta mijoz uchun token so'ramasin
// (stampede) — birinchisi so'raydi, qolganlari shu promise'ni kutadi.
const inFlight = new Map();

/** JWT payload'ini o'qiydi (imzo tekshirilmaydi — bu bizning tokenimiz emas). */
function decodeJwt(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function requestToken(clientId, clientSecret) {
  await acquireAuthSlot();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const { data } = await axios.post(`${env.EXELY_BASE_URL}${AUTH_PATH}`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });
  if (!data?.access_token) throw new Error('Exely token qaytmadi');

  const payload = decodeJwt(data.access_token);
  return {
    token: data.access_token,
    // expires_in sekundda (odatda 900). Marja bilan qisqartiramiz.
    expiresAt: Date.now() + (Number(data.expires_in || 900) * 1000) - REFRESH_MARGIN_MS,
    apiAccesses: Array.isArray(payload.api_accesses) ? payload.api_accesses : [],
    roles: Array.isArray(payload.roles) ? payload.roles : [],
  };
}

/**
 * Amaldagi tokenni qaytaradi (keshdan yoki yangisini so'rab).
 * @param {{clientId:string, clientSecret:string, force?:boolean}} args
 */
export async function getToken({ clientId, clientSecret, force = false }) {
  if (!clientId || !clientSecret) throw new Error('Exely client_id/client_secret ko\'rsatilmagan');

  const cached = tokenCache.get(clientId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached;

  if (inFlight.has(clientId)) return inFlight.get(clientId);

  const p = requestToken(clientId, clientSecret)
    .then((t) => {
      tokenCache.set(clientId, t);
      return t;
    })
    .finally(() => inFlight.delete(clientId));

  inFlight.set(clientId, p);
  return p;
}

/** Keshdagi tokenni bekor qiladi (kalit almashtirilganda / 401 dan keyin). */
export function invalidateToken(clientId) {
  tokenCache.delete(clientId);
}

// ── API so'rovi ─────────────────────────────────────────────────────

/** Exely xato javobini o'qiladigan matnga aylantiradi. */
function describeError(err) {
  const res = err.response;
  if (!res) return err.message || 'tarmoq xatosi';
  const d = res.data;
  const list = Array.isArray(d?.errors) ? d.errors : null;
  const msg = list
    ? list.map((e) => `${e.code}: ${e.message}`).join('; ')
    : d?.message || (typeof d === 'string' ? d.slice(0, 200) : '');
  return `HTTP ${res.status}${msg ? ` — ${msg}` : ''}`;
}

/**
 * Exely API'ga avtorizatsiyalangan so'rov.
 *
 * Qayta urinish siyosati:
 *   • 401 — token eskirgan: bir marta majburiy yangilab qayta urinadi
 *   • 429 — Retry-After (yoki 2s) kutib qayta urinadi
 *   • 5xx — eksponensial kutish (1s, 3s), 2 marta
 *   • 4xx (400/403/404/422) — QAYTA URINILMAYDI, bu bizning xatomiz
 *
 * @param {object} a
 * @param {string} a.clientId
 * @param {string} a.clientSecret
 * @param {string} a.path      — masalan '/api/content/v1/properties'
 * @param {string} [a.method]  — default GET
 * @param {object} [a.query]
 * @param {object} [a.body]
 * @param {number} [a.timeout]
 */
export async function exelyRequest({
  clientId, clientSecret, path, method = 'GET', query, body, timeout = 45_000,
}) {
  let forceToken = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { token } = await getToken({ clientId, clientSecret, force: forceToken });
    forceToken = false;

    try {
      const { data } = await axios({
        url: `${env.EXELY_BASE_URL}${path}`,
        method,
        params: query,
        data: body,
        timeout,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      return data;
    } catch (err) {
      const status = err.response?.status;

      // Token eskirgan / bekor qilingan — bir marta yangilab ko'ramiz.
      if (status === 401 && attempt === 0) {
        invalidateToken(clientId);
        forceToken = true;
        continue;
      }
      if (status === 429) {
        const ra = Number(err.response.headers?.['retry-after']);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2_000);
        continue;
      }
      if (status >= 500 && attempt < 2) {
        await sleep(attempt === 0 ? 1_000 : 3_000);
        continue;
      }

      const e = new Error(`Exely ${method} ${path} — ${describeError(err)}`);
      e.status = status;
      e.exelyPath = path;
      throw e;
    }
  }
  throw new Error(`Exely ${method} ${path} — qayta urinishlar tugadi`);
}

/**
 * Kalitlarni tekshiradi va ulanish imkoniyatlarini qaytaradi.
 * Ulanishni saqlashdan OLDIN chaqiriladi — noto'g'ri kalit bazaga tushmasin.
 */
export async function verifyCredentials({ clientId, clientSecret }) {
  const t = await getToken({ clientId, clientSecret, force: true });
  return { apiAccesses: t.apiAccesses, roles: t.roles, expiresAt: t.expiresAt };
}

/** Ulanishda shu API ochiqmi (token `api_accesses` bo'yicha). */
export function hasAccess(integration, access) {
  return (integration?.apiAccesses || []).includes(access);
}
