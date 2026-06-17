import axios from 'axios';
import { env } from '../config/env.js';

const BASE = 'https://api.makcorps.com';
const TIMEOUT = 15000;

// MakCorps OTA vendor → bizning kanonik nomimiz
const VENDOR_MAP = {
  'Booking.com': 'Booking.com',
  'Booking': 'Booking.com',
  'Expedia.com': 'Expedia',
  'Expedia': 'Expedia',
  'Hotels.com': 'Hotels.com',
  'Agoda.com': 'Agoda',
  'Agoda': 'Agoda',
  'Priceline': 'Priceline',
  'Trip.com': 'Trip.com',
  'Trip': 'Trip.com',
  'eDreams': 'eDreams',
  'Vio.com': 'Vio.com',
  'Orbitz': 'Orbitz',
  'Travelocity': 'Travelocity',
  'Kayak': 'Kayak',
  'Algotels': 'Algotels',
  'HotelsCombined': 'HotelsCombined',
  'TripAdvisor': 'TripAdvisor',
  'Trivago': 'Trivago',
  'Google': 'Google Hotels',
};

// 429/404 spam'ni to'xtatish — bir martalik ogohlantirish
const failedOnce = new Set();
function warnOnce(key, msg) {
  if (failedOnce.has(key)) return;
  failedOnce.add(key);
  console.warn(msg);
}

export function hasMakcorps() {
  return Boolean(env.MAKCORPS_API_KEY);
}

/**
 * GET /account?api_key=... — kredit qoldig'i va plan validity.
 * Javob: { email, credits, validity, requests_limit, requests_used }
 * Bir martagina memoize qilamiz (5 daqiqa) — har OTA Channels yangilashda chaqirib turmaslik uchun.
 */
// Cache key — API kalit bo'yicha (kalit o'zgarsa, cache avtomatik invalidatsiya)
let accountCache = { key: '', at: 0, data: null };
export async function getMakcorpsAccount({ force = false } = {}) {
  const key = env.MAKCORPS_API_KEY;
  if (!key) return null;
  const now = Date.now();
  if (!force && accountCache.key === key && accountCache.data && (now - accountCache.at) < 5 * 60_000) {
    return accountCache.data;
  }
  try {
    const r = await axios.get(`${BASE}/account`, {
      params: { api_key: key },
      timeout: TIMEOUT,
    });
    const d = r.data || {};
    // MakCorps API response field nomlari turli versiyalarda farq qiladi:
    // Eski: { credits, requests_limit, requests_used }
    // Yangi: { remainingLimit, requestLimit, requestUsed }
    const limit = Number(d.requestLimit ?? d.requests_limit ?? d.requestsLimit ?? 0);
    const used = Number(d.requestUsed ?? d.requests_used ?? d.requestsUsed ?? 0);
    const remaining = d.remainingLimit !== undefined
      ? Number(d.remainingLimit)
      : (d.credits !== undefined ? Number(d.credits) : Math.max(0, limit - used));
    const data = {
      email: d.email || '',
      credits: remaining,
      validity: Number(d.validity ?? 0),
      requestsLimit: limit,
      requestsUsed: used,
      raw: d,
    };
    accountCache = { key, at: now, data };
    return data;
  } catch (err) {
    console.warn('MakCorps /account xato:', err.response?.status, err.message);
    return null;
  }
}

/**
 * GET /hotel?hotelid=...&checkin=...&checkout=... — barcha OTA narxlari bir so'rovda.
 * Free tier rate limit'ga ega — agar 429 kelsa null qaytaradi.
 */
export async function getHotelPrices(hotelId, { checkIn, checkOut, currency = 'USD', adults = 2, rooms = 1 } = {}) {
  if (!env.MAKCORPS_API_KEY || !hotelId) {
    return { ok: false, status: 'no_key_or_id', prices: [], reviewsSummary: null };
  }
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  try {
    const r = await axios.get(`${BASE}/hotel`, {
      params: {
        api_key: env.MAKCORPS_API_KEY,
        hotelid: hotelId,
        checkin: ci,
        checkout: co,
        currency,
        adults,
        rooms,
      },
      timeout: TIMEOUT,
    });
    return {
      ok: true,
      status: 'ok',
      prices: parseHotelResponse(r.data),
      reviewsSummary: extractReviewsSummary(r.data),
      raw: r.data,
    };
  } catch (err) {
    const status = err.response?.status;
    let statusKey = 'error';
    if (status === 429) {
      warnOnce(`hotel:${hotelId}`, `MakCorps /hotel rate-limited (429) — free tier limitni urdi`);
      statusKey = 'rate_limited';
    } else if (status === 404) {
      warnOnce(`hotel:${hotelId}:404`, `MakCorps /hotel hotelid=${hotelId} topilmadi (404)`);
      statusKey = 'not_found';
    } else if (status === 401 || status === 403) {
      statusKey = 'unauthorized';
      console.warn('MakCorps /hotel auth xato:', status, err.message);
    } else {
      console.warn('MakCorps /hotel xato:', status, err.message);
    }
    return { ok: false, status: statusKey, httpStatus: status || 0, prices: [], reviewsSummary: null };
  }
}

/**
 * MakCorps `/hotel` yoki `/city` javobidan reviews aggregat (rating + count) ni ajratib oladi.
 * Free tarifda mavjud — to'liq matn yo'q, faqat o'rtacha reyting va sharhlar soni.
 *
 * Mumkin bo'lgan ko'rinishlar:
 *   { reviews: { rating: 4.5, count: 193 } }
 *   { rating: 4.5, reviewsCount: 193 }
 *   [ { reviews: {...} }, ... ]
 */
export function extractReviewsSummary(data) {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const r = item.reviews;
    if (r && typeof r === 'object') {
      const rating = toNum(r.rating ?? r.score ?? r.avg);
      const count = toInt(r.count ?? r.total ?? r.reviewsCount);
      if (rating > 0 || count > 0) return { rating, count };
    }

    const ratingTop = toNum(item.rating ?? item.score);
    const countTop = toInt(item.reviewsCount ?? item.reviewCount ?? item.totalReviews);
    if (ratingTop > 0 || countTop > 0) return { rating: ratingTop, count: countTop };
  }
  return null;
}

function toNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
}
function toInt(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * GET /booking?hotelid=<slug>&country=us&checkin=...&checkout=...
 * hotelid Booking.com URL slug'i bo'ladi, masalan "the-lenox" yoki "dendi-plaza"
 *
 * Javob format:
 * [
 *   [ { room, price: "US$1,960", payment_details: [...] }, ... ],
 *   { name, address }
 * ]
 *
 * Narx — butun qolish davomida total. Per-night uchun kechalar soniga bo'linadi.
 */
export async function getBookingPrice(hotelSlug, { checkIn, checkOut, currency = 'USD', adults = 2, rooms = 1, country = 'us' } = {}) {
  if (!env.MAKCORPS_API_KEY || !hotelSlug) return null;
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  const nights = Math.max(1, daysBetween(ci, co));
  try {
    const r = await axios.get(`${BASE}/booking`, {
      params: {
        api_key: env.MAKCORPS_API_KEY,
        country, hotelid: hotelSlug,
        checkin: ci, checkout: co,
        currency, adults, rooms, kids: 0,
      },
      timeout: TIMEOUT,
    });
    return parseBookingResponse(r.data, nights);
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) warnOnce(`booking:${hotelSlug}`, `MakCorps /booking rate-limited`);
    else if (status === 404) warnOnce(`booking:${hotelSlug}:404`, `MakCorps /booking hotelid="${hotelSlug}" topilmadi`);
    else console.warn('MakCorps /booking xato:', status, err.message);
    return null;
  }
}

/**
 * /booking javobini parse qiladi va eng arzon room narxini per-night ko'rinishida qaytaradi.
 */
function parseBookingResponse(data, nights) {
  if (!Array.isArray(data) || !data.length) return null;
  const rooms = Array.isArray(data[0]) ? data[0] : [];
  const hotelInfo = data[1] && typeof data[1] === 'object' ? data[1] : null;

  const prices = rooms
    .map((row) => parsePrice(row?.price))
    .filter((p) => p > 0);

  if (!prices.length) return null;

  const minTotal = Math.min(...prices);
  const maxTotal = Math.max(...prices);
  const perNight = Math.round(minTotal / nights);

  return {
    source: 'Booking.com',
    price: perNight,
    minTotal,
    maxTotal,
    nights,
    roomsAvailable: rooms.length,
    hotelInfo,
  };
}

function daysBetween(isoFrom, isoTo) {
  const a = new Date(isoFrom).getTime();
  const b = new Date(isoTo).getTime();
  return Math.round((b - a) / 86400_000);
}

/**
 * Booking.com URL'idan slug va country code'ni ekstrakt qiladi.
 * Misol: "https://www.booking.com/hotel/uz/dendi-plaza.html" → { slug: "dendi-plaza", country: "uz" }
 */
export function parseBookingUrl(url) {
  if (!url) return null;
  const m = String(url).match(/booking\.com\/hotel\/([a-z]{2})\/([a-z0-9-]+)(?:\.[a-z]{2,5})?(?:[?#]|$)/i);
  if (!m) return null;
  return { country: m[1].toLowerCase(), slug: m[2].toLowerCase() };
}

/**
 * GET /expedia?hotelid=<numeric>&checkin=...&checkout=...
 */
export async function getExpediaPrice(hotelId, { checkIn, checkOut, currency = 'USD', adults = 2, rooms = 1 } = {}) {
  if (!env.MAKCORPS_API_KEY || !hotelId) return null;
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  try {
    const r = await axios.get(`${BASE}/expedia`, {
      params: {
        api_key: env.MAKCORPS_API_KEY,
        hotelid: hotelId,
        checkin: ci, checkout: co,
        currency, adults, rooms,
      },
      timeout: TIMEOUT,
    });
    return parseHotelResponse(r.data);
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) warnOnce(`expedia:${hotelId}`, `MakCorps /expedia rate-limited`);
    return null;
  }
}

/**
 * GET /city?cityid=...&checkin=...&checkout=... — shahar bo'yicha hotellar ro'yxati
 */
export async function searchCity(cityId, { pagination = 0, checkIn, checkOut, currency = 'USD', adults = 2, rooms = 1 } = {}) {
  if (!env.MAKCORPS_API_KEY || !cityId) return [];
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  try {
    const r = await axios.get(`${BASE}/city`, {
      params: {
        api_key: env.MAKCORPS_API_KEY,
        cityid: cityId,
        pagination,
        checkin: ci, checkout: co,
        currency, adults, rooms,
      },
      timeout: TIMEOUT,
    });
    return Array.isArray(r.data) ? r.data : r.data?.results || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) warnOnce(`city:${cityId}`, `MakCorps /city rate-limited`);
    return [];
  }
}

/**
 * GET /mapping?api_key=...&name=... — nom/joy bo'yicha hotel/city ID qidirish.
 * Javobda type=HOTEL bo'lganlarning document_id si — bizning makcorpsHotelId.
 */
export async function searchMakcorpsHotel(name, city = '') {
  if (!env.MAKCORPS_API_KEY || !name) return [];
  const query = city ? `${name} ${city}` : name;
  try {
    const r = await axios.get(`${BASE}/mapping`, {
      params: { api_key: env.MAKCORPS_API_KEY, name: query },
      timeout: TIMEOUT,
    });
    const items = Array.isArray(r.data) ? r.data : [];
    return items
      .filter((it) => it && it.type === 'HOTEL' && it.document_id)
      .map((it) => ({
        hotelId: String(it.document_id),
        name: it.name || '',
        coords: it.coords || null,
        address: it.details?.address || '',
        parentName: it.details?.parent_name || it.details?.grandparent_name || '',
      }));
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) warnOnce(`mapping:${name}`, `MakCorps /mapping rate-limited`);
    else console.warn('MakCorps /mapping xato:', status, err.message);
    return [];
  }
}

function parseHotelResponse(data) {
  const prices = [];
  const items = Array.isArray(data) ? data : [data];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const pool = item.comparison || item.prices || [item];

    for (const row of pool) {
      if (!row || typeof row !== 'object') continue;
      // vendor1/price1, vendor2/price2 ... pattern
      for (let i = 1; i <= 20; i++) {
        const v = row[`vendor${i}`];
        const p = row[`price${i}`];
        if (!v || !p) continue;
        const vendor = VENDOR_MAP[v] || v;
        const price = parsePrice(p);
        if (price > 0) prices.push({ source: vendor, price });
      }
      // { vendor, price }
      if (row.vendor && row.price) {
        const vendor = VENDOR_MAP[row.vendor] || row.vendor;
        const price = parsePrice(row.price);
        if (price > 0) prices.push({ source: vendor, price });
      }
      // { name, price } yoki { hotel_name, lowest_price }
      if (row.name && (row.price || row.lowest_price)) {
        const price = parsePrice(row.price || row.lowest_price);
        if (price > 0) prices.push({ source: VENDOR_MAP[row.name] || row.name, price });
      }
    }
  }

  // Bir xil kanal uchun bir nechta narx — eng pasti
  const byChannel = new Map();
  for (const p of prices) {
    const existing = byChannel.get(p.source);
    if (!existing || p.price < existing.price) byChannel.set(p.source, p);
  }
  return Array.from(byChannel.values());
}

function parsePrice(value) {
  if (typeof value === 'number') return value;
  const m = String(value).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
