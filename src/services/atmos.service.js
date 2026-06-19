import axios from 'axios';
import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * ATMOS to'lov shlyuzi klienti (UzCard / Humo).
 *
 * To'lov oqimi (one-time SMS-OTP):
 *   1. createTransaction()  → /merchant/pay/create   → transaction_id
 *   2. preApply()           → /merchant/pay/pre-apply → kartaga SMS-OTP yuboradi
 *   3. apply()              → /merchant/pay/apply     → OTP bilan tasdiq, pul yechiladi
 * Qo'shimcha:
 *   getTransaction()        → /merchant/pay/get       → status tekshirish (timeout bo'lsa)
 *   reverse()               → /merchant/pay/reverse   → to'lovni qaytarish
 *
 * Token /token endpointidan olinadi va xotirada kesh qilinadi (~1 soat amal qiladi).
 *
 * DIQQAT: barcha summalar TIYINDA (1 so'm = 100 tiyin).
 * Test kartalar uchun OTP — 111111.
 *
 * Hujjat: ATMOS_API_Dokumentaciya.pdf
 */

const BASE = env.ATMOS_BASE_URL || 'https://apigw.atmos.uz';

export const isAtmosConfigured = () =>
  !!(env.ATMOS_CONSUMER_KEY && env.ATMOS_CONSUMER_SECRET && env.ATMOS_STORE_ID);

function assertConfigured() {
  if (!isAtmosConfigured()) {
    const err = new Error(
      'ATMOS sozlanmagan. .env faylga ATMOS_CONSUMER_KEY, ATMOS_CONSUMER_SECRET, ATMOS_STORE_ID qo\'shing.',
    );
    err.status = 503;
    throw err;
  }
}

// ─── Token boshqaruvi ────────────────────────────────────────────────
let _token = null;
let _tokenExpiresAt = 0; // ms timestamp

async function fetchToken() {
  const basic = Buffer.from(
    `${env.ATMOS_CONSUMER_KEY}:${env.ATMOS_CONSUMER_SECRET}`,
  ).toString('base64');

  const { data } = await axios.post(
    `${BASE}/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30_000,
    },
  );

  if (!data?.access_token) {
    throw new Error('ATMOS token olinmadi — consumer key/secret tekshiring');
  }
  _token = data.access_token;
  // expires_in (sekund) keladi; xavfsizlik uchun 60s oldin yangilaymiz.
  const ttl = (Number(data.expires_in) || 3600) - 60;
  _tokenExpiresAt = Date.now() + ttl * 1000;
  return _token;
}

async function getToken() {
  assertConfigured();
  if (_token && Date.now() < _tokenExpiresAt) return _token;
  return fetchToken();
}

// Avtorizatsiya headeri bilan POST. 401 bo'lsa tokenni bir marta yangilab qayta uradi.
async function authPost(path, body, { retry = true } = {}) {
  const token = await getToken();
  try {
    const { data } = await axios.post(`${BASE}${path}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    });
    return data;
  } catch (err) {
    if (retry && err.response?.status === 401) {
      _token = null; // keshni tozalab, yangi token bilan qayta uramiz
      return authPost(path, body, { retry: false });
    }
    throw normalizeError(err);
  }
}

// ATMOS xatosini o'qiladigan ko'rinishga keltirish.
function normalizeError(err) {
  const data = err.response?.data;
  const code = data?.result?.code || data?.code;
  const desc = data?.result?.description || data?.description || err.message;
  const e = new Error(`ATMOS xato: ${desc}${code ? ` (${code})` : ''}`);
  e.status = err.response?.status || 502;
  e.atmos = { code, description: desc, raw: data };
  return e;
}

// ATMOS javobida result.code "OK" emasligini tekshirish.
function ensureOk(data, ctx) {
  const code = data?.result?.code;
  if (code && code !== 'OK') {
    const e = new Error(
      `ATMOS ${ctx} muvaffaqiyatsiz: ${data.result.description} (${code})`,
    );
    e.status = 400;
    e.atmos = { code, description: data.result.description, raw: data };
    throw e;
  }
  return data;
}

// ─── To'lov oqimi metodlari ──────────────────────────────────────────

/**
 * 1-qadam: chernovik tranzaksiya yaratish.
 * @returns {Promise<{transaction_id:number, raw:object}>}
 */
export async function createTransaction({ amount, account, lang = 'uz' }) {
  const body = {
    amount, // tiyinda
    account: String(account),
    store_id: Number(env.ATMOS_STORE_ID),
    lang,
  };
  if (env.ATMOS_TERMINAL_ID) body.terminal_id = env.ATMOS_TERMINAL_ID;

  const data = await authPost('/merchant/pay/create', body);
  ensureOk(data, 'create');
  return { transaction_id: data.transaction_id, raw: data };
}

/**
 * 2-qadam: karta raqami + amal muddatini yuborib, SMS-OTP jo'natish.
 * @param expiry "YYMM" formatida (masalan 02/28 → "2802")
 */
export async function preApply({ transactionId, cardNumber, expiry }) {
  const body = {
    card_number: String(cardNumber).replace(/\s+/g, ''),
    expiry: String(expiry),
    store_id: Number(env.ATMOS_STORE_ID),
    transaction_id: Number(transactionId),
  };
  const data = await authPost('/merchant/pay/pre-apply', body);
  ensureOk(data, 'pre-apply');
  return { raw: data };
}

/**
 * 3-qadam: OTP bilan tasdiqlash va pulni yechish.
 * Test kartalar uchun otp = "111111".
 * @returns success_trans_id (reverse uchun), maskalangan card_id, ofd_url
 */
export async function apply({ transactionId, otp }) {
  const body = {
    transaction_id: Number(transactionId),
    otp: String(otp),
    store_id: Number(env.ATMOS_STORE_ID),
  };
  const data = await authPost('/merchant/pay/apply', body);
  ensureOk(data, 'apply');
  const st = data.store_transaction || {};
  return {
    success_trans_id: st.success_trans_id ?? null,
    card_id: st.card_id ?? null,
    confirmed: st.confirmed === true,
    ofd_url: data.ofd_url ?? null,
    raw: data,
  };
}

/** SMS-OTP kodini qayta yuborish. */
export async function retryOtp({ transactionId }) {
  const body = {
    store_id: Number(env.ATMOS_STORE_ID),
    transaction_id: Number(transactionId),
  };
  const data = await authPost('/merchant/pay/retry-otp', body);
  ensureOk(data, 'retry-otp');
  return { raw: data };
}

/**
 * Tranzaksiya holatini so'rash. apply javobi kelmay qolsa (timeout)
 * shu metod bilan haqiqiy holatni tekshirish kerak.
 */
export async function getTransaction({ transactionId }) {
  const body = {
    store_id: Number(env.ATMOS_STORE_ID),
    transaction_id: Number(transactionId),
  };
  // Bu yerda ensureOk chaqirmaymiz — "Транзакция закрыта" (STPIMS-ERR-092)
  // ham aslida ma'lumot beradi (closed = to'langan/yopilgan).
  const data = await authPost('/merchant/pay/get', body);
  return { store_transaction: data.store_transaction || null, raw: data };
}

/**
 * To'lovni bekor qilish (qaytarish).
 * @param transactionId — bu apply javobidagi success_trans_id bo'lishi kerak.
 */
export async function reverse({ transactionId, reason = 'refund' }) {
  const body = { transaction_id: Number(transactionId), reason };
  const data = await authPost('/merchant/pay/reverse', body);
  ensureOk(data, 'reverse');
  return { transaction_id: data.transaction_id, raw: data };
}

// ─── Callback imzosini tekshirish ────────────────────────────────────
/**
 * Callback sign formulasi (ATMOS hujjati):
 *   md5(store_id + transaction_id + account + amount + api_key)  (ajratgichsiz)
 */
export function verifyCallbackSign({ store_id, transaction_id, account, amount, sign }) {
  if (!env.ATMOS_API_KEY) return false;
  const raw = `${store_id}${transaction_id}${account}${amount}${env.ATMOS_API_KEY}`;
  const expected = crypto.createHash('md5').update(raw).digest('hex');
  return expected === String(sign).toLowerCase();
}

/**
 * "02/28" yoki "0228" yoki "2802" ko'rinishidagi muddatni ATMOS "YYMM" formatiga keltiradi.
 * Frontenddan odatda "MM/YY" (02/28) keladi → "2802".
 */
export function normalizeExpiry(input) {
  const digits = String(input).replace(/\D/g, '');
  if (digits.length !== 4) {
    const e = new Error('Karta amal muddati noto\'g\'ri (MM/YY kutilgan)');
    e.status = 400;
    throw e;
  }
  // MMYY (0228) → YYMM (2802). Agar allaqachon YYMM bo'lsa-chi?
  // Heuristik: birinchi ikki raqam 12 dan katta bo'lsa, bu YY → demak YYMM.
  const a = Number(digits.slice(0, 2));
  if (a > 12) return digits; // allaqachon YYMM
  // MMYY → YYMM
  return digits.slice(2) + digits.slice(0, 2);
}
