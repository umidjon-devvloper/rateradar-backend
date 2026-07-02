import axios from 'axios';
import { env } from '../config/env.js';
import { geocode } from './geo.service.js';

/**
 * HOTELS AGGREGATOR API (hotels-scraper-js fastify serveri) bilan HTTP klient.
 *
 * Skreyper alohida server sifatida ishlaydi (`hotels-scraper-js` papkasida
 * `npm run dev` yoki `npm start`, default port 3000). U Booking.com / Hotels.com'ni
 * puppeteer bilan real vaqtda skreyp qiladi.
 *
 * Haqiqiy endpointlar (autentifikatsiya: `x-api-key` sarlavhasi):
 *   GET /health
 *   GET /v1/search?provider=booking&location=<nom shahar>&checkIn=&checkOut=&adults=&limit=&currency=
 *       → { provider, count, cached, durationMs, results: [Hotel] }
 *   GET /v1/hotel?provider=booking&link=<url>&reviewsLimit=
 *       → { provider, cached, result }
 *
 * Hotel (normalizatsiya qilingan) shakli:
 *   { provider, providerId, title, thumbnail, stars,
 *     location:{address,lat,lng,distanceFromCenter},
 *     price:{currency,value,taxesAndCharges,total},
 *     rating:{score,reviews,description}, badges, highlights, link }
 *
 * Sozlamalar (backend .env):
 *   • HOTEL_SCRAPER_ENABLED  — 'true' (default) / 'false'
 *   • HOTEL_SCRAPER_URL      — server manzili (default http://localhost:3000)
 *   • HOTEL_SCRAPER_API_KEY  — skreyper API_KEYS dagi kalitlardan biri (masalan dev-key-123)
 */

const BASE_URL = (env.HOTEL_SCRAPER_URL || 'http://localhost:3000').replace(/\/+$/, '');
// Bo'sh bo'lsa skreyperning standart bootstrap kalitiga tushamiz (lokalda ishlashi uchun).
const API_KEY = env.HOTEL_SCRAPER_API_KEY || 'dev-key-123';

const HTTP_TIMEOUT_MS = 120_000;       // skreyp sekin bo'lishi mumkin
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 daqiqa
const SEARCH_LIMIT = 8;

const _cache = new Map();

/** Skreyper yoqilganmi? (env flag + URL) */
export function scraperEnabled() {
  return env.HOTEL_SCRAPER_ENABLED === 'true' && Boolean(BASE_URL);
}

function headers() {
  return API_KEY ? { 'x-api-key': API_KEY } : {};
}

function normKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cacheGet(key) {
  const c = _cache.get(key);
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.data;
  if (c) _cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  _cache.set(key, { at: Date.now(), data });
}

// Booking narxi ko'rinishi uchun check-in/out sanalari kerak (default bo'sh bo'lsa
// booking baribir bugun/ertaga oladi, lekin biz 7 kun keyinini beramiz — barqarorroq).
function dateMMDDYYYY(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** Tirik tekshiruv — /health (5s), 30s keshlanadi. */
let _healthCache = { at: 0, ok: false };
export async function scraperHealthy() {
  if (!scraperEnabled()) return false;
  if (Date.now() - _healthCache.at < 30_000) return _healthCache.ok;
  try {
    const r = await axios.get(`${BASE_URL}/health`, { timeout: 5000, headers: headers() });
    // Server `{status:"ok"}` qaytaradi (eski varianti `{ok:true}`).
    _healthCache = { at: Date.now(), ok: r.data?.status === 'ok' || Boolean(r.data?.ok) };
  } catch {
    _healthCache = { at: Date.now(), ok: false };
  }
  return _healthCache.ok;
}

// Normalizatsiya qilingan Hotel → RateRadar standart shakli.
function mapHotel(h) {
  return {
    placeId: '',
    osmId: '',
    name: h?.title || '',
    address: h?.location?.address || '',
    lat: Number.isFinite(h?.location?.lat) ? h.location.lat : undefined,
    lng: Number.isFinite(h?.location?.lng) ? h.location.lng : undefined,
    rating: Number.isFinite(h?.rating?.score) ? h.rating.score : 0,
    reviews: Number.isFinite(h?.rating?.reviews) ? h.rating.reviews : 0,
    stars: Number.isFinite(h?.stars) ? h.stars : 0,
    photoUrl: h?.thumbnail || '',
    currentPrice: Number.isFinite(h?.price?.value) ? h.price.value : 0,
    currency: h?.price?.currency || '',
    bookingUrl: h?.link || '',
    source: 'booking_scraper',
  };
}

/**
 * /v1/search chaqiruvi — nom+shahar `location` bo'yicha. Xom (geokodsiz) RateRadar
 * shakliga mapping qaytaradi. Keshlanadi.
 */
async function searchRaw(query, city, limit = SEARCH_LIMIT, provider = 'booking', daysAhead = 7) {
  const location = `${query}${city ? ` ${city}` : ''}`.trim();
  if (location.length < 2) return [];
  const key = `${provider}:${normKey(location)}|${limit}|${daysAhead}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const r = await axios.get(`${BASE_URL}/v1/search`, {
    params: {
      provider,
      location,
      checkIn: dateMMDDYYYY(daysAhead),
      checkOut: dateMMDDYYYY(daysAhead + 1),
      adults: 2,
      limit,
      currency: 'USD',
    },
    timeout: HTTP_TIMEOUT_MS,
    headers: headers(),
  });

  const results = (r.data?.results || []).map(mapHotel).filter((h) => h.name);
  cacheSet(key, results);
  return results;
}

// ─── Valyuta konvertatsiyasi (Google Hotels UZS/RUB/… → USD) ─────────────────
// Bepul FX API'dan kurslar olinadi va 12 soat keshlanadi. Kalit talab qilinmaydi.
let _fx = { at: 0, rates: null };
async function getRates() {
  if (_fx.rates && Date.now() - _fx.at < 12 * 3600_000) return _fx.rates;
  try {
    const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    if (r.data?.result === 'success' && r.data.rates) {
      _fx = { at: Date.now(), rates: r.data.rates };
    }
  } catch (e) {
    console.warn('[fx] kurs olishda xato:', e.message);
  }
  // Fallback — taxminiy kurslar (FX API ishlamasa). Nisbatlar saqlanadi.
  if (!_fx.rates) _fx.rates = { USD: 1, UZS: 12700, RUB: 90, EUR: 0.92, GBP: 0.79, KZT: 480 };
  return _fx.rates;
}
async function toUSD(amount, currency) {
  if (!(amount > 0)) return 0;
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'USD') return Math.round(amount);
  const rates = await getRates();
  const rate = rates[cur];
  if (!rate || !(rate > 0)) return 0; // noma'lum valyuta — ishonchsiz, 0
  return Math.round(amount / rate);
}

/**
 * Bitta OTA-narx provideridan (googleHotels | ostrovok) narxlarni oladi va
 * USD'ga aylantiradi. Keshlanadi.
 * @returns {{matchedName, rating, reviews, offers:[{source,price,currency,origValue,origCurrency}]}|null}
 */
async function fetchOtaPrice(provider, name, city = '') {
  if (!scraperEnabled() || String(name || '').trim().length < 2) return null;
  const key = `otaprice:${provider}:${normKey(name)}|${normKey(city)}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  let data;
  try {
    const r = await axios.get(`${BASE_URL}/v1/ota-price`, {
      params: { provider, name, city },
      timeout: HTTP_TIMEOUT_MS,
      headers: headers(),
    });
    data = r.data;
  } catch (err) {
    console.warn(`[scraper] ota-price(${provider}) xato:`, describeErr(err));
    return null;
  }

  const offers = [];
  for (const o of (data?.offers || [])) {
    const usd = await toUSD(o.value, o.currency);
    if (usd > 0) {
      offers.push({ source: o.source, price: usd, currency: 'USD', origValue: o.value, origCurrency: o.currency });
    }
  }
  const out = {
    matchedName: data?.matchedName || name,
    rating: data?.rating || null,
    reviews: data?.reviews || null,
    offers,
  };
  cacheSet(key, out);
  return out;
}

/**
 * GOOGLE HOTELS — bitta skreypda BARCHA OTA narxlari (Booking, Agoda, Expedia,
 * Hotels.com, Trip.com, Priceline, …). Narxlar USD'da.
 */
export async function scraperGoogleHotelPrices(name, city = '') {
  return fetchOtaPrice('googleHotels', name, city);
}

/** OSTROVOK.RU — MDH/O'zbekiston OTA (Google Hotels'da yo'q). USD'da. */
export async function scraperOstrovokPrice(name, city = '') {
  return fetchOtaPrice('ostrovok', name, city);
}

/**
 * BARCHA KANALLAR — Google Hotels (6+ OTA) + Ostrovok'ni PARALLEL oladi va
 * birlashtiradi. Bir manba'da bo'lgan OTA boshqasidan ustun emas — Google
 * birinchi, Ostrovok qo'shimcha. Eng to'liq narx to'plami.
 * @returns {{matchedName, rating, reviews, offers:[{source,price,currency}]}}
 */
// To'liq qamrov uchun kerakli kanallar.
const PRICE_TARGET_CHANNELS = ['Booking.com', 'Agoda', 'Expedia', 'Hotels.com', 'Trip.com', 'Priceline', 'Ostrovok'];

/**
 * PER-CHANNEL DIRECT FALLBACK registry — Google Hotels o'sha kanalni BERMAGANDA,
 * to'g'ridan-to'g'ri o'sha OTA'ni skreyp qiladi. Har biri (name, city) => USD narx | 0.
 *
 * Hozir proksisiz ishlaydigan:
 *   • Booking.com — to'g'ridan-to'g'ri Booking qidiruvi (+7/+30 kun).
 *   • Ostrovok    — yuqorida parallel olinadi (bu yerda takror emas).
 *
 * Expedia/Hotels.com/Priceline to'g'ridan-to'g'ri 429/403 bloklaydi, Agoda/Trip.com
 * murakkab — ular PROXY_URL (residential proksi) qo'shilgach shu registryga ulanadi.
 * Ulargacha bu kanallar Google Hotels orqali keladi (deyarli har doim bor).
 */
const DIRECT_CHANNEL_FALLBACKS = {
  'Booking.com': async (name, city) => {
    let m = await scraperFindHotel(name, city, 7);
    if (m && !(m.currentPrice > 0)) {
      const later = await scraperFindHotel(name, city, 30);
      if (later && later.currentPrice > 0) m = later;
    }
    return m && m.currentPrice > 0 ? m.currentPrice : 0;
  },
  // 'Agoda':     proksi kerak (agressiv anti-bot)
  // 'Expedia':   proksi kerak (429 "Bot or Not?")
  // 'Hotels.com':proksi kerak (429, Expedia bilan bir engine)
  // 'Trip.com':  proksi kerak
  // 'Priceline': proksi kerak (403 "Access denied")
};

/**
 * BARCHA KANALLAR — Google Hotels (6+ OTA) + Ostrovok'ni PARALLEL oladi, keyin
 * YETISHMAGAN target kanallar uchun to'g'ridan-to'g'ri fallback skreyper chaqiradi.
 * Eng to'liq narx to'plami.
 * @returns {{matchedName, rating, reviews, offers:[{source,price,currency}]}}
 */
export async function scraperAllChannelPrices(name, city = '') {
  if (!scraperEnabled() || String(name || '').trim().length < 2) {
    return { matchedName: name, rating: null, reviews: null, offers: [] };
  }
  const [google, ostrovok] = await Promise.all([
    scraperGoogleHotelPrices(name, city).catch(() => null),
    scraperOstrovokPrice(name, city).catch(() => null),
  ]);

  const offers = [];
  const seen = new Set();
  for (const src of [google, ostrovok]) {
    for (const o of (src?.offers || [])) {
      const k = o.source.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      offers.push(o);
    }
  }

  // Yetishmagan target kanallar uchun to'g'ridan-to'g'ri fallback.
  const missing = PRICE_TARGET_CHANNELS.filter(
    (c) => !seen.has(c.toLowerCase()) && DIRECT_CHANNEL_FALLBACKS[c],
  );
  for (const ch of missing) {
    try {
      const price = await DIRECT_CHANNEL_FALLBACKS[ch](name, city);
      if (price > 0) {
        offers.push({ source: ch, price, currency: 'USD', via: 'direct' });
        seen.add(ch.toLowerCase());
      }
    } catch { /* fallback ixtiyoriy */ }
  }

  return {
    matchedName: google?.matchedName || ostrovok?.matchedName || name,
    rating: google?.rating || ostrovok?.rating || null,
    reviews: google?.reviews || ostrovok?.reviews || null,
    offers,
  };
}

/**
 * XONA TURLARI — nom+shahar bo'yicha Booking property sahifasini topib, undagi
 * xona narx jadvalini (#hprt-table) skreyp qiladi. Narxlar USD'ga aylantiriladi.
 * Apify sozlanmaganda Room Shopper uchun asosiy manba.
 * @returns {{bookingUrl, currency, rooms:[{name, price, guests}], minPrice}}
 */
export async function scraperRooms(name, city = '', { checkIn, checkOut, adults = 2 } = {}) {
  const empty = { bookingUrl: '', currency: 'USD', rooms: [], minPrice: 0 };
  if (!scraperEnabled() || String(name || '').trim().length < 2) return empty;

  // Property URL'ni skreyperning O'ZI bitta sessiyada topadi (nom+shahar+sana) —
  // alohida keshlangan bo'sh Booking qidiruviga bog'liq emas, ishonchliroq.
  let data;
  try {
    const r = await axios.get(`${BASE_URL}/v1/rooms`, {
      params: { provider: 'booking', name, city, checkIn, checkOut, adults },
      timeout: HTTP_TIMEOUT_MS,
      headers: headers(),
    });
    data = r.data?.result || {};
  } catch (err) {
    console.warn('[scraper] rooms xato:', describeErr(err));
    return empty;
  }
  const base = data?.link || '';

  // Narxlar USD'da (selected_currency=USD), lekin xavfsizlik uchun konvertatsiya.
  const rooms = [];
  for (const room of (data.rooms || [])) {
    const usd = await toUSD(room.price, data.currency || 'USD');
    if (usd > 0) rooms.push({ name: room.name, price: usd, guests: room.guests || 2 });
  }
  rooms.sort((a, b) => a.price - b.price);
  return {
    bookingUrl: base,
    currency: 'USD',
    rooms,
    minPrice: rooms.length ? rooms[0].price : 0,
  };
}

// ─── Nom bo'yicha eng mos natijani tanlash ───────────────────────────────────
const GENERIC = new Set([
  'hotel', 'plaza', 'inn', 'resort', 'suites', 'suite', 'palace', 'grand', 'royal',
  'park', 'house', 'guest', 'guesthouse', 'lodge', 'apart', 'apartment', 'apartments',
  'boutique', 'mehmonxona', 'отель', 'гостиница', 'hostel', 'motel', 'the', 'and',
]);

function norm(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Nom bo'yicha eng mos hotelni tanlaydi. `city` berilsa, shahar so'zlari brend
// so'zi sifatida hisoblanmaydi — aks holda "Бухара Мадат" so'rovi "Бухара Олд
// Сити"ga (faqat shahar nomi mos kelgani uchun) noto'g'ri mos tushardi.
function bestMatch(hotels, name, city = '') {
  if (!hotels.length) return null;
  const target = norm(name);
  if (!target) return null;

  const cityTokens = new Set(norm(city).split(' ').filter(Boolean));
  const targetTokens = target.split(' ').filter(Boolean);
  // Brend so'zlari: umumiy so'zlar EMAS, shahar nomi EMAS, kamida 3 belgi.
  const brand = targetTokens.filter((t) => !GENERIC.has(t) && !cityTokens.has(t) && t.length >= 3);

  // Brend so'z umuman qolmasa (masalan faqat shahar nomi yozilgan) — ishonchli
  // moslik mumkin emas, taxmin qilmaymiz.
  if (!brand.length) return null;

  let best = null, bestScore = 0;
  for (const h of hotels) {
    const n = norm(h.name);
    const nTokens = n.split(' ').filter(Boolean);
    let score = 0;
    if (n === target) score = 100;
    else if (n.includes(target) || target.includes(n)) score = 90;
    else {
      // Faqat brend so'zlari bo'yicha — har biri mos kelsa ball qo'shiladi.
      const matched = brand.filter((t) => nTokens.some((nt) => nt === t || nt.includes(t) || t.includes(nt))).length;
      score = (matched / brand.length) * 85;
    }
    if (score > bestScore) { bestScore = score; best = h; }
  }
  // Kamida yarmi brend so'zi mos kelsa qaytaramiz (~43+), aks holda topilmadi.
  return bestScore >= 43 ? best : null;
}

/**
 * QIDIRUV fallback — findHotels (direct=1) uchun. Skreyperdan natija oladi va
 * koordinatani geocode bilan to'ldiradi (xaritada ko'rinishi uchun).
 */
export async function scraperSearchHotels(query, cityContext = {}) {
  if (!scraperEnabled()) return [];
  const city = cityContext?.city || '';
  if (String(query || '').trim().length < 2) return [];

  let hotels = [];
  try {
    hotels = await searchRaw(query, city, SEARCH_LIMIT);
  } catch (err) {
    console.warn('[scraper] qidiruv xato:', describeErr(err));
    return [];
  }
  // Koordinata bu yerda OLINMAYDI — typeahead tez bo'lishi uchun. Booking manzili
  // ko'rsatish uchun yetarli. Koordinata kerak bo'lganda (raqib/hotel qo'shilganda)
  // geocodeHotel() bilan keyin to'ldiriladi.
  return hotels;
}

/**
 * Berilgan hotel uchun koordinatani geocode bilan to'ldiradi (manzil yoki nom+shahar
 * bo'yicha). Qidiruvdan TANLAB qo'shilganda chaqiriladi — typeahead'ni sekinlashtirmaydi.
 * @returns {{lat:number, lng:number}|null}
 */
export async function geocodeHotel({ name = '', address = '', city = '' } = {}) {
  const addr = address || `${name} ${city}`.trim();
  if (!addr) return null;
  try {
    const geo = await geocode(addr);
    if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
      return { lat: geo.lat, lng: geo.lng };
    }
  } catch { /* ixtiyoriy */ }
  return null;
}

/**
 * BOYITISH (enrich) — nom+shahar bo'yicha eng MOS bitta natija (geokodsiz, tez).
 * Booking ro'yxatidan nomga to'g'ri kelganini tanlaydi.
 */
export async function scraperFindHotel(name, city = '', daysAhead = 7) {
  if (!scraperEnabled()) return null;
  if (String(name || '').trim().length < 2) return null;
  try {
    const hotels = await searchRaw(name, city, SEARCH_LIMIT, 'booking', daysAhead);
    return bestMatch(hotels, name, city);
  } catch (err) {
    console.warn('[scraper] enrich xato:', describeErr(err));
    return null;
  }
}

/**
 * Mehmonxona (yoki raqib) uchun eng arzon Booking narxini qaytaradi — nom+shahar
 * bo'yicha. Topilmasa null. instant-snapshot / raqib narxlari uchun fallback.
 * @returns {{price:number, currency:string, name:string, link:string}|null}
 */
export async function scraperPriceForHotel(name, city = '') {
  // 1) Barcha kanallar (Google Hotels + Ostrovok) — eng keng qamrov. Ko'pincha
  //    to'g'ridan-to'g'ri Booking qidiruvi narx bermaganda ham narx beradi.
  //    Eng arzon mavjud narxni "best price" sifatida olamiz.
  try {
    const gh = await scraperAllChannelPrices(name, city);
    const priced = (gh?.offers || []).filter((o) => o.price > 0).sort((a, b) => a.price - b.price);
    if (priced.length) {
      return {
        price: priced[0].price,
        currency: 'USD',
        name: gh.matchedName || name,
        link: '',
        rating: gh.rating || 0,
        reviews: gh.reviews || 0,
        photoUrl: '',
      };
    }
  } catch { /* google ishlamasa — pastdagi Booking qidiruvi */ }

  // 2) To'g'ridan-to'g'ri Booking qidiruv: +7 kun, narx bo'lmasa +30 kun bilan qayta.
  let match = await scraperFindHotel(name, city, 7);
  if (match && !(match.currentPrice > 0)) {
    const later = await scraperFindHotel(name, city, 30);
    if (later && later.currentPrice > 0) match = later;
  }
  if (!match || !(match.currentPrice > 0)) return null;
  return {
    price: match.currentPrice,
    currency: match.currency || 'USD',
    name: match.name,
    link: match.bookingUrl,
    rating: match.rating,
    reviews: match.reviews,
    photoUrl: match.photoUrl,
  };
}

/**
 * RAQOBATCHI TOPISH — shahar bo'yicha Booking'dan eng mashhur hotellarni (narxi
 * bilan) qaytaradi. O'z hotelni (nom bo'yicha) chiqarib tashlaydi. Sharhi ko'pi
 * birinchi. Raqobatchi avtomatik topish fallback'i uchun (Google/OSM topmasa).
 * @returns {Array} RateRadar shaklidagi hotellar (currentPrice bilan)
 */
export async function scraperDiscoverCity(city, excludeName = '', limit = 6) {
  if (!scraperEnabled() || !city) return [];
  let hotels = [];
  try {
    hotels = await searchRaw('hotels', city, Math.max(limit + 3, 10));
  } catch (err) {
    console.warn('[scraper] discovery xato:', describeErr(err));
    return [];
  }
  const ex = norm(excludeName);
  return hotels
    .filter((h) => {
      const n = norm(h.name);
      if (!n) return false;
      if (ex && (n === ex || n.includes(ex) || ex.includes(n))) return false;
      return true;
    })
    .sort((a, b) => (b.reviews || 0) - (a.reviews || 0))
    .slice(0, limit);
}

/**
 * To'liq hotel ma'lumoti — /v1/hotel orqali Booking property sahifasini chuqur
 * oladi (tavsif, qulayliklar, rasmlar, sharhlar). `link` — qidiruv natijasidagi URL.
 */
export async function scraperHotelInfo(link, reviewsLimit = 10, provider = 'booking') {
  if (!scraperEnabled() || !link) return null;
  const key = `info:${normKey(link)}:${reviewsLimit}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const r = await axios.get(`${BASE_URL}/v1/hotel`, {
      params: { provider, link, reviewsLimit },
      timeout: HTTP_TIMEOUT_MS,
      headers: headers(),
    });
    const details = r.data?.result || null;
    if (details) cacheSet(key, details);
    return details;
  } catch (err) {
    console.warn('[scraper] hotel info xato:', describeErr(err));
    return null;
  }
}

/**
 * KATEGORIYA REYTINGLARI — Booking.com subscore'lari (Staff, Cleanliness,
 * Location, Comfort, Facilities, Value, Free WiFi) + umumiy ball. HasData API
 * o'rniga (kalit kerak emas). Nom+shahar bo'yicha Booking URL topib skreyp qiladi.
 * @returns {{overall:number, scores:Object, bookingUrl:string}|null}
 */
export async function scraperCategoryRatings(name, city = '') {
  if (!scraperEnabled() || String(name || '').trim().length < 2) return null;
  const key = `catratings:${normKey(name)}|${normKey(city)}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const match = await scraperFindHotel(name, city).catch(() => null);
  const bookingUrl = match?.bookingUrl || '';
  if (!bookingUrl) return null;

  const link = `${bookingUrl.split('?')[0]}?selected_currency=USD&lang=en-us`;
  try {
    const r = await axios.get(`${BASE_URL}/v1/category-ratings`, {
      params: { provider: 'booking', link },
      timeout: HTTP_TIMEOUT_MS,
      headers: headers(),
    });
    const data = r.data?.result || {};
    if (!data.scores || !Object.keys(data.scores).length) return null;
    const out = { overall: data.overall || 0, scores: data.scores, bookingUrl };
    cacheSet(key, out);
    return out;
  } catch (err) {
    console.warn('[scraper] category-ratings xato:', describeErr(err));
    return null;
  }
}

// Booking sharhini RateRadar Review shakliga yaqinlashtiradi.
// Booking reyting /10 → /5 ga aylantiriladi (RateRadar 5 balli tizim).
function mapBookingReview(r) {
  const score10 = parseFloat(r?.reting);
  const rating5 = Number.isFinite(score10)
    ? Math.max(1, Math.min(5, Math.round((score10 / 2) * 10) / 10))
    : 0;
  let liked = '', disliked = '';
  for (const part of (r?.review || [])) {
    if (part?.liked) liked = part.liked;
    if (part?.didNotLike) disliked = part.didNotLike;
  }
  const text = [liked && `👍 ${liked}`, disliked && `👎 ${disliked}`].filter(Boolean).join('\n');
  return {
    author: r?.name || 'Anonim',
    rating: rating5,
    text: text || liked || disliked || '',
    date: r?.date || '',
    country: r?.country || '',
    hotelResponse: r?.hotelResponse || '',
  };
}

/**
 * SHARHLAR — nom+shahar bo'yicha Booking.com property sahifasini topib, undagi
 * sharhlarni (eng ko'pi `limit` ta) RateRadar shaklida qaytaradi. 14 kunlik
 * filtr chaqiruvchi tomonda (review.controller) qo'llanadi.
 * @returns {{reviews:Array, bookingUrl:string, matchedName:string}}
 */
export async function scraperReviews(name, city = '', limit = 20) {
  if (!scraperEnabled()) return { reviews: [], bookingUrl: '', matchedName: '' };
  const match = await scraperFindHotel(name, city);
  const bookingUrl = match?.bookingUrl || '';
  if (!bookingUrl) return { reviews: [], bookingUrl: '', matchedName: '' };

  const info = await scraperHotelInfo(bookingUrl, limit);
  const raw = info?.reviewsInfo?.reviews || [];
  const reviews = raw.map(mapBookingReview).filter((r) => r.text || r.author !== 'Anonim');
  return { reviews, bookingUrl, matchedName: match.name || '' };
}

function describeErr(err) {
  if (err.response) {
    const body = err.response.data?.error || err.response.statusText || '';
    return `${err.response.status} ${body}`;
  }
  if (err.code === 'ECONNREFUSED') return `server ishlamayapti (${BASE_URL}) — skreyperni 'npm run dev' bilan ishga tushiring`;
  return err.message;
}

export default {
  scraperEnabled,
  scraperHealthy,
  scraperSearchHotels,
  scraperFindHotel,
  scraperRooms,
  scraperPriceForHotel,
  scraperDiscoverCity,
  scraperGoogleHotelPrices,
  scraperOstrovokPrice,
  scraperAllChannelPrices,
  scraperCategoryRatings,
  scraperHotelInfo,
  scraperReviews,
  geocodeHotel,
};
