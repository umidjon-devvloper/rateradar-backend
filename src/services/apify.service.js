import axios from 'axios';
import { env } from '../config/env.js';
import { serpapi } from './serpProviders.js';

const BASE = 'https://api.apify.com/v2';

const ACTORS = {
  booking: 'voyager~booking-scraper',
  expedia: 'crawlerbros~expedia-hotels-scraper',
  hotels:  'easyapi~hotels-com-scraper',
  trip:    'powerai~trip-hotel-search-scraper',
  bookingReviews: 'voyager~booking-reviews-scraper',
  agodaReviews:   'knagymate~fast-agoda-reviews-scraper',
  expediaReviews: 'tri_angle~expedia-reviews-scraper',
  // Trip.com — sizning task'ingiz orqali (green_nomad/trip-hotel-reviews-scraper-task)
  tripReviews:    'task:green_nomad~trip-hotel-reviews-scraper-task',
  // Yandex Maps sharhlari — RU/CIS/Turkey qamrovi. Bepul test 100 ta review.
  yandexReviews:  'zen-studio~yandex-maps-reviews-scraper',
};

export function hasApify() {
  return Boolean(env.APIFY_API_KEY);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function parsePrice(val) {
  if (!val && val !== 0) return 0;
  if (typeof val === 'number') return Math.round(val);
  const m = String(val).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/gi, ' ').replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const aw = new Set(na.split(' ').filter((w) => w.length > 2));
  const common = nb.split(' ').filter((w) => w.length > 2 && aw.has(w)).length;
  return common / Math.max(aw.size, 1);
}

/**
 * Aktyorning oxirgi SUCCEEDED run natijasini qaytaradi (bepul, darhol).
 * `withinHours` ichida bo'lsa — keshlangan natijani qaytaradi, aks holda null.
 */
// `task:owner~name` prefiksi bilan task chaqirsa bo'ladi, aks holda aktyor sifatida.
function resolveResource(idOrTask) {
  if (typeof idOrTask === 'string' && idOrTask.startsWith('task:')) {
    return { path: 'actor-tasks', id: idOrTask.slice(5), isTask: true };
  }
  return { path: 'acts', id: idOrTask, isTask: false };
}

/**
 * Aktyor/task'ning oxirgi muvaffaqiyatli run natijasini qaytaradi,
 * **faqat agar input mos bo'lsa** (URL bir xil mehmonxonaga ishora qilsa).
 * Bu bir Apify hisobiga bog'langan turli foydalanuvchilar/mehmonxonalar
 * o'rtasida sharhlarning aralashib ketishini oldini oladi.
 */
async function getLastRunItems(idOrTask, { withinHours = 24, expectedInput = null } = {}) {
  const { path, id } = resolveResource(idOrTask);
  try {
    const { data: runResp } = await axios.get(`${BASE}/${path}/${id}/runs/last`, {
      params: { token: env.APIFY_API_KEY, status: 'SUCCEEDED' },
      timeout: 10_000,
    });
    const run = runResp?.data;
    if (!run?.defaultDatasetId) return null;

    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : 0;
    const ageHours = (Date.now() - startedAt) / 3_600_000;
    if (ageHours > withinHours) return null;

    // Input bo'yicha tekshirish — oxirgi run sizning mehmonxona uchun bo'lganmi?
    if (expectedInput && run.defaultKeyValueStoreId) {
      try {
        const { data: storedInput } = await axios.get(
          `${BASE}/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`,
          { params: { token: env.APIFY_API_KEY }, timeout: 10_000 }
        );
        if (!inputMatches(storedInput, expectedInput)) {
          console.log(`[Apify] ${id} — oxirgi run boshqa input uchun edi, yangi run zarur`);
          return null;
        }
      } catch {
        return null;
      }
    }

    const { data: items } = await axios.get(
      `${BASE}/datasets/${run.defaultDatasetId}/items`,
      { params: { token: env.APIFY_API_KEY, limit: 100 }, timeout: 10_000 }
    );
    return Array.isArray(items) && items.length ? items : null;
  } catch (err) {
    // 404 — aktyor mavjud emas yoki birorta run yo'q (normal holat)
    if (err.response?.status === 404) return null;
    console.warn(`[Apify] getLastRunItems(${id}): ${err.message}`);
    return null;
  }
}

// Input mosligini tekshirish — URL maydonlari teng bo'lishi kifoya.
function inputMatches(stored, expected) {
  if (!stored || !expected) return false;
  // URL'ni har xil maydonlardan topish (har bir aktyor o'z field nomini ishlatadi)
  const urlKeys = ['hotelDetailUrl', 'agodaUrl', 'expediaUrl', 'tripUrl', 'bookingUrl', 'yandexUrl', 'url'];

  for (const key of urlKeys) {
    if (expected[key] && stored[key] && expected[key] === stored[key]) return true;
  }
  // startUrls: [{ url }] formati
  const exUrl = expected.startUrls?.[0]?.url;
  const stUrl = stored.startUrls?.[0]?.url;
  if (exUrl && stUrl && exUrl === stUrl) return true;

  return false;
}

async function runAndWait(idOrTask, input, timeoutSec = 300, { reuseLastRun = true, reuseWithinHours = 24 } = {}) {
  const { path, id, isTask } = resolveResource(idOrTask);

  if (reuseLastRun) {
    const cached = await getLastRunItems(idOrTask, {
      withinHours: reuseWithinHours,
      expectedInput: input,
    });
    if (cached) {
      console.log(`[Apify] ${id} — oxirgi run natijasi ishlatildi (${cached.length} item, input mos)`);
      return cached;
    }
  }

  let startData;
  try {
    const r = await axios.post(
      `${BASE}/${path}/${id}/runs`,
      input,
      {
        params: { token: env.APIFY_API_KEY, memory: 2048, timeout: timeoutSec },
        headers: { 'Content-Type': 'application/json' },
        timeout: 20_000,
      }
    );
    startData = r.data;
  } catch (err) {
    const status = err.response?.status;
    const label = isTask ? `task "${id}"` : `aktyor "${id}"`;
    if (status === 402) {
      throw new Error(`Apify ${label} pulli (rental) — $5 trial yetmaydi yoki tarif kerak`);
    }
    if (status === 401 || status === 403) {
      throw new Error(`Apify API kalit yaroqsiz (${status})`);
    }
    if (status === 404) {
      throw new Error(`Apify ${label} topilmadi — Apify Console'da "Try for free" qiling yoki to'g'ri nomni bering`);
    }
    if (status === 400) {
      throw new Error(`Apify ${label} — input format noto'g'ri (400). README'ni tekshiring`);
    }
    throw err;
  }

  const runId = startData.data.id;
  const deadline = Date.now() + (timeoutSec + 30) * 1000;

  while (Date.now() < deadline) {
    await sleep(8000);
    const { data: poll } = await axios.get(`${BASE}/actor-runs/${runId}`, {
      params: { token: env.APIFY_API_KEY },
      timeout: 10_000,
    });
    const status = poll.data.status;
    if (status === 'SUCCEEDED') {
      const { data: items } = await axios.get(
        `${BASE}/actor-runs/${runId}/dataset/items`,
        { params: { token: env.APIFY_API_KEY, limit: 100 }, timeout: 10_000 }
      );
      return Array.isArray(items) ? items : [];
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Actor run ${status}`);
    }
  }
  throw new Error('Actor run timeout');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Auto-find Booking.com URL via Google search ─────────────────────────────

/**
 * Mehmonxona nomi+shahar bo'yicha Google'da qidirib Booking.com property URL'ini topadi.
 * Natija: "https://www.booking.com/hotel/<country>/<slug>.html" yoki null.
 */
export async function findBookingUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:booking.com hotel`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      // Faqat property URL'lari: /hotel/<cc>/<slug>(.html)
      const m = link.match(/booking\.com\/hotel\/[a-z]{2}\/[a-z0-9-]+/i);
      if (m) {
        // Toza property URL — query parametrlarsiz
        const clean = link.split(/[?#]/)[0];
        return clean;
      }
    }
    return null;
  } catch (err) {
    console.warn('findBookingUrl xato:', err.message);
    return null;
  }
}

// ─── Booking.com ─────────────────────────────────────────────────────────────

export async function getBookingPriceApify(hotelName, city, { checkIn, checkOut, bookingUrl } = {}) {
  if (!env.APIFY_API_KEY) return null;

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  try {
    // 1-bosqich: Booking URL aniqlash. Berilmagan bo'lsa, Google qidiruv
    // orqali topamiz — Apify shahar qidiruvi (50 ta hotel, 2+ daqiqa, $0.18)
    // o'rniga tezroq va arzonroq.
    let url = bookingUrl;
    if (!url) {
      url = await findBookingUrl(hotelName, city);
    }
    if (!url) {
      console.warn(`[Apify Booking] "${hotelName}" uchun Booking URL topilmadi`);
      return null;
    }

    // 2-bosqich: faqat shu bitta URL bilan Apify run — 1-2 sahifa, ~30s, ~$0.005
    const fullUrl = url.includes('checkin=')
      ? url
      : `${url}?checkin=${ci}&checkout=${co}&adults=2&no_rooms=1&currency=USD`;

    const items = await runAndWait(ACTORS.booking, {
      startUrls: [{ url: fullUrl }],
      checkIn: ci,
      checkOut: co,
      adults: 2,
      rooms: 1,
      currency: 'USD',
      maxItems: 1,
    });

    if (!items.length) return null;

    const target = items[0];
    const rawPrice =
      target.price ?? target.pricePerNight ?? target.minPrice ??
      target.priceFormatted ?? target.cheapestPrice ?? null;

    const price = parsePrice(rawPrice);
    if (!price) return null;

    return {
      source: 'Booking.com',
      price,
      via: 'apify',
      link: target.url || target.link || url || null,
    };
  } catch (err) {
    const code = err.response?.status;
    if (code !== 404 && !err.message.includes('TIMED-OUT')) {
      console.warn(`Apify Booking.com (${code || err.message})`);
    }
    return null;
  }
}

/**
 * Booking.com sahifasidan REAL xona turlari + narxlarini Apify orqali oladi.
 * Voyager booking-scraper `rooms` massivini qaytaradi: har biri roomType, price,
 * persons (mehmon soni), bedType bilan. Bu "Xona turlari" jadvali uchun asosiy
 * real manba — soxta/demo narx o'rniga.
 *
 * @returns {Promise<{ rooms: Array<{name,price,guests,bedType}>, minPrice:number, currency:string }>}
 */
// Voyager booking-scraper: xona narxi `room.options[].price` (soliq bilan to'liq).
// Eng arzon variant narxini qaytaradi.
function cheapestRoomOptionPrice(room) {
  const opts = Array.isArray(room?.options) ? room.options : [];
  let min = Infinity;
  for (const o of opts) {
    const p = parsePrice(o.price ?? o.displayedPrice ?? o.totalPrice ?? o.rate);
    if (p > 0 && p < min) min = p;
  }
  // Variant yo'q bo'lsa — xona darajasidagi narxni sinab ko'ramiz.
  if (!Number.isFinite(min)) return parsePrice(room?.price ?? room?.minPrice);
  return min;
}

// bedTypes: [{ room, beds: ["1 large double bed"] }] → "1 large double bed"
function bedTypeLabel(room) {
  const bt = room?.bedTypes;
  if (!Array.isArray(bt) || !bt.length) return (room?.bedType || '').toString().trim();
  const beds = [];
  for (const b of bt) {
    if (Array.isArray(b?.beds)) beds.push(...b.beds);
  }
  return beds.join(', ').slice(0, 80);
}

export async function getBookingRoomsApify(bookingUrl, { checkIn, checkOut } = {}) {
  if (!env.APIFY_API_KEY || !bookingUrl) return { rooms: [], minPrice: 0, currency: 'USD' };

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  const fullUrl = bookingUrl.includes('checkin=')
    ? bookingUrl
    : `${bookingUrl}?checkin=${ci}&checkout=${co}&adults=2&no_rooms=1&currency=USD`;

  try {
    const items = await runAndWait(ACTORS.booking, {
      startUrls: [{ url: fullUrl }],
      checkIn: ci,
      checkOut: co,
      adults: 2,
      rooms: 1,
      currency: 'USD',
      maxItems: 1,
    }, 240);

    const item = items?.[0];
    if (!item) return { rooms: [], minPrice: 0, currency: 'USD' };

    const rawRooms = item.rooms || item.roomTypes || item.units || [];
    const rooms = (Array.isArray(rawRooms) ? rawRooms : [])
      .map((r) => ({
        name: (r.roomType || r.name || r.type || 'Room').toString().trim(),
        // Narx xonada emas — `options[]` ichida. Eng arzon variantni olamiz.
        price: cheapestRoomOptionPrice(r),
        guests: Number(r.persons ?? r.maxPersons ?? r.occupancy ?? r.adults ?? 2) || 2,
        bedType: bedTypeLabel(r),
      }))
      .filter((r) => r.name && r.price > 0);

    // Bir xil nomli xonalarni eng arzon variant bilan yagonalashtiramiz.
    const byName = new Map();
    for (const r of rooms) {
      const ex = byName.get(r.name);
      if (!ex || r.price < ex.price) byName.set(r.name, r);
    }
    const deduped = [...byName.values()];

    const propMin = parsePrice(item.price ?? item.minPrice ?? item.cheapestPrice);
    const roomMin = deduped.length ? Math.min(...deduped.map((r) => r.price)) : 0;
    const minPrice = roomMin || propMin || 0;

    // "US$" → "USD" kabi belgilarni normallashtiramiz.
    const rawCur = String(item.currency || 'USD');
    const currency = /\$|usd/i.test(rawCur) ? 'USD' : rawCur.replace(/[^A-Z]/gi, '').toUpperCase() || 'USD';

    return { rooms: deduped, minPrice, currency };
  } catch (err) {
    console.warn(`Apify Booking rooms: ${err.message}`);
    return { rooms: [], minPrice: 0, currency: 'USD' };
  }
}

/**
 * Shahar bo'yicha Booking.com'da qidirib, top N mehmonxonalarni qaytaradi.
 * Bitta Apify run — keyin chaqiruvchi har bir raqibni ism o'xshashligi bo'yicha
 * topadi (ko'p Apify chaqiruvi o'rniga).
 *
 * Qaytaradi: [{ name, price, url, raw }, ...]
 */
export async function getBookingCitySearchApify(city, { checkIn, checkOut, maxItems = 50 } = {}) {
  if (!env.APIFY_API_KEY || !city) return [];

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  try {
    const items = await runAndWait(ACTORS.booking, {
      search: city,
      checkIn: ci,
      checkOut: co,
      adults: 2,
      rooms: 1,
      currency: 'USD',
      maxItems,
    });

    return (items || [])
      .map((item) => {
        const name = item.name || item.hotelName || item.title || '';
        const rawPrice =
          item.price ?? item.pricePerNight ?? item.minPrice ??
          item.priceFormatted ?? item.cheapestPrice ?? null;
        const price = parsePrice(rawPrice);
        const url = item.url || item.link || null;
        return { name, price, url };
      })
      .filter((x) => x.name && x.price > 0);
  } catch (err) {
    console.warn(`Apify Booking city search: ${err.message}`);
    return [];
  }
}

/**
 * Bitta nom + items ro'yxati orasidan eng yaxshi mosligini topadi.
 * Threshold ostidan past bo'lsa — null.
 */
export function matchHotelByName(items, hotelName, threshold = 0.4) {
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = nameSimilarity(item.name, hotelName);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= threshold ? { ...best, score: bestScore } : null;
}

// ─── Agoda ────────────────────────────────────────────────────────────────────
// Agoda price scraper hisobda yo'q — faqat reviews bor (knagymate/fast-agoda-reviews-scraper).
// Narx uchun null qaytaramiz, kanal "disconnected" sifatida ko'rsatiladi.

export async function getAgodaPriceApify() {
  return null;
}

// ─── Expedia ──────────────────────────────────────────────────────────────────

export async function getExpediaPriceApify(hotelName, city, { checkIn, checkOut, expediaUrl } = {}) {
  if (!env.APIFY_API_KEY || !expediaUrl) return null;

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  try {
    const items = await runAndWait(ACTORS.expedia, {
      hotelUrls: [expediaUrl],
      checkIn: ci,
      checkOut: co,
      adults: 2,
      maxItems: 5,
    }, 180);

    const item = items?.[0];
    if (!item) return null;

    const rawPrice =
      item.price ?? item.pricePerNight ?? item.minPrice ??
      item.totalPrice ?? item.rate ?? null;

    const price = parsePrice(rawPrice);
    if (!price) return null;

    return { source: 'Expedia', price, via: 'apify', link: expediaUrl };
  } catch (err) {
    console.warn(`Apify Expedia: ${err.message}`);
    return null;
  }
}

// ─── Hotels.com ───────────────────────────────────────────────────────────────

export async function getHotelsComPriceApify(hotelName, city, { checkIn, checkOut, hotelsUrl } = {}) {
  if (!env.APIFY_API_KEY || !hotelsUrl) return null;

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  try {
    const items = await runAndWait(ACTORS.hotels, {
      startUrls: [{ url: hotelsUrl }],
      checkIn: ci,
      checkOut: co,
      adults: 2,
      maxItems: 5,
    }, 180);

    const item = items?.[0];
    if (!item) return null;

    const rawPrice =
      item.price ?? item.pricePerNight ?? item.minPrice ??
      item.totalPrice ?? item.lowestPrice ?? null;

    const price = parsePrice(rawPrice);
    if (!price) return null;

    return { source: 'Hotels.com', price, via: 'apify', link: hotelsUrl };
  } catch (err) {
    console.warn(`Apify Hotels.com: ${err.message}`);
    return null;
  }
}

// ─── Trip.com ────────────────────────────────────────────────────────────────

export async function getTripComPriceApify(hotelName, city, { checkIn, checkOut, tripUrl } = {}) {
  if (!env.APIFY_API_KEY || !tripUrl) return null;

  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);

  try {
    const items = await runAndWait(ACTORS.trip, {
      startUrls: [{ url: tripUrl }],
      checkIn: ci,
      checkOut: co,
      adults: 2,
      maxItems: 5,
    }, 180);

    const item = items?.[0];
    if (!item) return null;

    const rawPrice =
      item.price ?? item.pricePerNight ?? item.minPrice ??
      item.lowestPrice ?? item.cheapestPrice ?? null;

    const price = parsePrice(rawPrice);
    if (!price) return null;

    return { source: 'Trip.com', price, via: 'apify', link: tripUrl };
  } catch (err) {
    console.warn(`Apify Trip.com: ${err.message}`);
    return null;
  }
}

// ─── Booking.com Reviews ──────────────────────────────────────────────────────

function ratingToSentiment(rating) {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'neutral';
}

/**
 * Booking.com sahifasidan to'liq sharhlarni Apify orqali olib keladi.
 * Voyager booking-reviews-scraper aktyori — har bir sharh muallif, reyting (1-10 yoki 1-5),
 * matn, sana bilan keladi.
 */
export async function getBookingReviewsApify(bookingUrl, { maxReviews = 50, sinceDays = 14 } = {}) {
  if (!env.APIFY_API_KEY || !bookingUrl) return [];

  try {
    const items = await runAndWait(ACTORS.bookingReviews, {
      startUrls: [{ url: bookingUrl }],
      maxReviewsPerHotel: maxReviews,
      sortReviewsBy: 'f_recent_desc',
    }, 240);

    if (!items.length) return [];

    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
    return items
      .map((it) => {
        const ratingRaw = Number(it.rating ?? it.reviewScore ?? it.score ?? it.userRating ?? 0);
        // Booking 1-10 shkalada beradi; bizning baza 1-5 ishlatadi
        const rating5 = ratingRaw > 5 ? Math.round((ratingRaw / 2) * 10) / 10 : ratingRaw;

        // Booking sharhlari ko'pincha ijobiy + salbiy qismni alohida saqlaydi
        const liked = (it.liked || it.positive || it.pros || it.positiveText || it.likedText || '').trim();
        const disliked = (it.disliked || it.negative || it.cons || it.negativeText || it.dislikedText || '').trim();
        const main = (it.reviewText || it.text || it.comment || it.review || it.reviewBody || it.body || '').trim();
        const title = (it.reviewTitle || it.title || '').trim();

        let text = main;
        if (!text) {
          const parts = [];
          if (title) parts.push(title);
          if (liked) parts.push(`👍 ${liked}`);
          if (disliked) parts.push(`👎 ${disliked}`);
          text = parts.join('\n\n').trim();
        }

        const date = it.reviewDate || it.date || it.publishedAt || it.createdAt || it.stayDate || null;
        const author = it.reviewerName || it.author || it.userName || it.guestName || it.reviewer?.name || 'Anonymous';

        if (!text && !rating5) return null;
        const publishedAt = date ? new Date(date) : null;
        // Faqat oxirgi N kun ichidagi sharhlar (default 14 kun)
        if (cutoff && publishedAt && publishedAt.getTime() < cutoff) return null;
        return {
          author,
          rating: rating5,
          text,
          publishedAt,
          platform: 'Booking.com',
          sentiment: ratingToSentiment(rating5),
          externalId: `apify:booking:${it.reviewId || it.id || `${author}-${date}-${(text || '').slice(0, 30)}`}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Apify Booking reviews xato:', err.message);
    return [];
  }
}

// ─── Agoda Reviews ────────────────────────────────────────────────────────────

/**
 * Agoda sahifasidan sharhlarni Apify orqali olib keladi.
 */
export async function getAgodaReviewsApify(agodaUrl, { maxReviews = 50, sinceDays = 14 } = {}) {
  if (!env.APIFY_API_KEY || !agodaUrl) return [];

  try {
    const items = await runAndWait(ACTORS.agodaReviews, {
      startUrls: [{ url: agodaUrl }],
      maxReviewsPerHotel: maxReviews,
      maxReviews,
    }, 240);

    if (!items.length) return [];

    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
    return items
      .map((it) => {
        const ratingRaw = Number(it.rating ?? it.reviewScore ?? it.score ?? it.userRating ?? 0);
        // Agoda 1-10 shkalada; bizning baza 1-5
        const rating5 = ratingRaw > 5 ? Math.round((ratingRaw / 2) * 10) / 10 : ratingRaw;
        const liked = (it.liked || it.positive || it.pros || it.positiveText || '').trim();
        const disliked = (it.disliked || it.negative || it.cons || it.negativeText || '').trim();
        const main = (it.reviewText || it.text || it.comment || it.review || it.reviewBody || '').trim();
        const title = (it.reviewTitle || it.title || '').trim();

        let text = main;
        if (!text) {
          const parts = [];
          if (title) parts.push(title);
          if (liked) parts.push(`👍 ${liked}`);
          if (disliked) parts.push(`👎 ${disliked}`);
          text = parts.join('\n\n').trim();
        }

        const date = it.reviewDate || it.date || it.publishedAt || it.createdAt || it.stayDate || null;
        const author = it.reviewerName || it.author || it.userName || it.guestName || 'Anonymous';

        if (!text && !rating5) return null;
        const publishedAt = date ? new Date(date) : null;
        if (cutoff && publishedAt && publishedAt.getTime() < cutoff) return null;
        return {
          author,
          rating: rating5,
          text,
          publishedAt,
          platform: 'Agoda',
          sentiment: ratingToSentiment(rating5),
          externalId: `apify:agoda:${it.reviewId || it.id || `${author}-${date}-${(text || '').slice(0, 30)}`}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Apify Agoda reviews xato:', err.message);
    return [];
  }
}

// ─── Expedia Reviews ──────────────────────────────────────────────────────────

/**
 * Expedia sahifasidan sharhlarni Apify orqali olib keladi.
 */
export async function getExpediaReviewsApify(expediaUrl, { maxReviews = 50, sinceDays = 14 } = {}) {
  if (!env.APIFY_API_KEY || !expediaUrl) return [];

  try {
    const items = await runAndWait(ACTORS.expediaReviews, {
      startUrls: [{ url: expediaUrl }],
      maxReviewsPerHotel: maxReviews,
      maxReviews,
    }, 240);

    if (!items.length) return [];

    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
    return items
      .map((it) => {
        const ratingRaw = Number(it.rating ?? it.reviewScore ?? it.score ?? it.userRating ?? 0);
        // Expedia 1-10 yoki 1-5 shkala bo'lishi mumkin
        const rating5 = ratingRaw > 5 ? Math.round((ratingRaw / 2) * 10) / 10 : ratingRaw;
        const liked = (it.liked || it.positive || it.pros || it.positiveText || '').trim();
        const disliked = (it.disliked || it.negative || it.cons || it.negativeText || '').trim();
        const main = (it.reviewText || it.text || it.comment || it.review || it.reviewBody || '').trim();
        const title = (it.reviewTitle || it.title || '').trim();

        let text = main;
        if (!text) {
          const parts = [];
          if (title) parts.push(title);
          if (liked) parts.push(`👍 ${liked}`);
          if (disliked) parts.push(`👎 ${disliked}`);
          text = parts.join('\n\n').trim();
        }

        const date = it.reviewDate || it.date || it.publishedAt || it.createdAt || it.stayDate || null;
        const author = it.reviewerName || it.author || it.userName || it.guestName || 'Anonymous';

        if (!text && !rating5) return null;
        const publishedAt = date ? new Date(date) : null;
        if (cutoff && publishedAt && publishedAt.getTime() < cutoff) return null;
        return {
          author,
          rating: rating5,
          text,
          publishedAt,
          platform: 'Expedia',
          sentiment: ratingToSentiment(rating5),
          externalId: `apify:expedia:${it.reviewId || it.id || `${author}-${date}-${(text || '').slice(0, 30)}`}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Apify Expedia reviews xato:', err.message);
    return [];
  }
}

// ─── Trip.com Reviews ─────────────────────────────────────────────────────────

/**
 * Trip.com sahifasidan sharhlarni Apify orqali olib keladi.
 */
export async function getTripReviewsApify(tripUrl, { maxReviews = 50, sinceDays = 14 } = {}) {
  if (!env.APIFY_API_KEY || !tripUrl) return [];

  try {
    // green_nomad task: hotelDetailUrl + maxItems
    const items = await runAndWait(ACTORS.tripReviews, {
      hotelDetailUrl: tripUrl,
      maxItems: maxReviews,
    }, 240);

    if (!items.length) return [];

    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
    return items
      .map((it) => {
        // README: score 0-10, userName, reviewText, postedDate, reviewId
        const ratingRaw = Number(it.score ?? it.rating ?? it.reviewScore ?? 0);
        const rating5 = ratingRaw > 5 ? Math.round((ratingRaw / 2) * 10) / 10 : ratingRaw;
        const text = (it.reviewText || it.text || it.review || it.reviewBody || '').trim();
        const date = it.postedDate || it.stayDate || it.reviewDate || it.publishedAt || null;
        const author = it.userName || it.reviewerName || it.author || it.guestName || 'Anonymous';

        if (!text && !rating5) return null;
        const publishedAt = date ? new Date(date) : null;
        if (cutoff && publishedAt && publishedAt.getTime() < cutoff) return null;
        return {
          author,
          rating: rating5,
          text,
          publishedAt,
          platform: 'Trip.com',
          sentiment: ratingToSentiment(rating5),
          externalId: `apify:trip:${it.reviewId || it.id || `${author}-${date}-${(text || '').slice(0, 30)}`}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Apify Trip.com reviews xato:', err.message);
    return [];
  }
}

// ─── Yandex Maps Reviews ──────────────────────────────────────────────────────

/**
 * Yandex Maps org sahifasidan sharhlarni Apify orqali olib keladi.
 * URL Geosearch API'dan keladi: https://yandex.ru/maps/org/<id>/reviews/
 *
 * Yandex reytingi tabiiy 1-5 shkalada — Booking/Agoda (1-10) kabi /2 konversiya
 * KERAK EMAS.
 *
 * Eslatma: actor input formatini README bo'yicha tekshiring — zen-studio
 * scraper'i `startUrls` + `maxReviews` qabul qiladi (ba'zi versiyalarda
 * `maxReviewsPerPlace`).
 */
export async function getYandexReviewsApify(yandexUrl, { maxReviews = 50, sinceDays = 14 } = {}) {
  if (!env.APIFY_API_KEY || !yandexUrl) return [];

  try {
    const items = await runAndWait(ACTORS.yandexReviews, {
      startUrls: [{ url: yandexUrl }],
      yandexUrl, // cache input-match uchun (inputMatches urlKeys)
      maxReviews,
      maxReviewsPerPlace: maxReviews,
    }, 240);

    if (!items.length) return [];

    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : 0;
    return items
      .map((it) => {
        // Yandex 1-5 shkala — konversiyasiz.
        const rating = Number(it.rating ?? it.stars ?? it.score ?? it.reviewRating ?? 0);
        const text = (it.reviewText || it.text || it.review || it.comment || it.body || '').trim();
        const date = it.publishedAt || it.reviewDate || it.date || it.createdAt || it.updatedTime || null;
        const author = it.authorName || it.reviewerName || it.userName || it.author || it.name || 'Anonymous';

        if (!text && !rating) return null;
        const publishedAt = date ? new Date(date) : null;
        if (cutoff && publishedAt && publishedAt.getTime() < cutoff) return null;
        return {
          author,
          rating,
          text,
          publishedAt,
          platform: 'Yandex',
          sentiment: ratingToSentiment(rating),
          externalId: `apify:yandex:${it.reviewId || it.id || `${author}-${date}-${(text || '').slice(0, 30)}`}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Apify Yandex reviews xato:', err.message);
    return [];
  }
}

// ─── Auto-find Yandex Maps URL via Google search (Geosearch kaliti yo'q bo'lsa) ─

/**
 * Mehmonxonaning Yandex Maps org sahifasini Google qidiruvi (SerpAPI) orqali
 * topadi — YANDEX_GEOSEARCH_API_KEY bo'lmaganda fallback sifatida.
 * Natija: https://yandex.ru/maps/org/<slug>/<id>/reviews/ yoki null.
 */
export async function findYandexUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:yandex.ru/maps/org`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      // yandex.(ru|uz|com|kz)/maps/org/<slug>/<orgId>/...
      const m = link.match(/yandex\.(?:ru|uz|com|kz)\/maps\/org\/[^?#\s]+/i);
      if (m) {
        // Toza org URL — query'siz, sharhlar tab'iga normallashtiramiz.
        let clean = link.split(/[?#]/)[0].replace(/\/+$/, '');
        if (!/\/reviews$/i.test(clean)) clean += '/reviews';
        return clean + '/';
      }
    }
    return null;
  } catch (err) {
    console.warn('findYandexUrl xato:', err.message);
    return null;
  }
}

// ─── Auto-find Trip.com URL via Google search ─────────────────────────────────

export async function findTripUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:trip.com hotel`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      const m = link.match(/trip\.com\/[^?#\s]+/i);
      if (m) return link.split(/[?#]/)[0];
    }
    return null;
  } catch (err) {
    console.warn('findTripUrl xato:', err.message);
    return null;
  }
}

// ─── Auto-find Expedia URL via Google search ──────────────────────────────────

export async function findExpediaUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:expedia.com hotel`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      const m = link.match(/expedia\.com\/[^?#\s]+/i);
      if (m) return link.split(/[?#]/)[0];
    }
    return null;
  } catch (err) {
    console.warn('findExpediaUrl xato:', err.message);
    return null;
  }
}

// ─── Auto-find Hotels.com URL via Google search ───────────────────────────────

export async function findHotelsUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:hotels.com hotel`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      // hotels.com/ho<id>/ yoki hotels.com/<slug>/...
      const m = link.match(/hotels\.com\/[^?#\s]+/i);
      if (m) return link.split(/[?#]/)[0];
    }
    return null;
  } catch (err) {
    console.warn('findHotelsUrl xato:', err.message);
    return null;
  }
}

// ─── Auto-find Agoda URL via Google search ────────────────────────────────────

export async function findAgodaUrl(hotelName, city = '') {
  if (!env.SERPAPI_API_KEY) return null;
  const query = `${hotelName} ${city} site:agoda.com hotel`.trim();
  try {
    const data = await serpapi.query('google_search', { q: query, num: 5 });
    const results = data?.results || [];
    for (const r of results) {
      const link = r.link || '';
      // Agoda property URL'lari: /<lang>/<slug>/hotel/...html yoki agoda.com/hotel/...
      const m = link.match(/agoda\.com\/[^?#\s]+/i);
      if (m) return link.split(/[?#]/)[0];
    }
    return null;
  } catch (err) {
    console.warn('findAgodaUrl xato:', err.message);
    return null;
  }
}

// ─── All OTAs in parallel ─────────────────────────────────────────────────────

export async function getMultiOtaPricesApify(hotelName, city, { checkIn, checkOut, otaUrls = {} } = {}) {
  if (!env.APIFY_API_KEY) return [];

  const tasks = [
    getBookingPriceApify(hotelName, city, {
      checkIn, checkOut,
      bookingUrl: otaUrls['Booking.com'] || otaUrls['booking'] || null,
    }),
    getAgodaPriceApify(hotelName, city, {
      checkIn, checkOut,
      agodaUrl: otaUrls['Agoda'] || otaUrls['agoda'] || null,
    }),
    getExpediaPriceApify(hotelName, city, {
      checkIn, checkOut,
      expediaUrl: otaUrls['Expedia'] || otaUrls['expedia'] || null,
    }),
    getHotelsComPriceApify(hotelName, city, {
      checkIn, checkOut,
      hotelsUrl: otaUrls['Hotels.com'] || otaUrls['hotels'] || null,
    }),
    getTripComPriceApify(hotelName, city, {
      checkIn, checkOut,
      tripUrl: otaUrls['Trip.com'] || otaUrls['trip'] || null,
    }),
  ];

  const results = await Promise.allSettled(tasks);
  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}
