import axios from 'axios';
import { env } from '../config/env.js';
import Hotel from '../models/Hotel.js';
import Review from '../models/Review.js';

/**
 * TripAdvisor RASMIY Content API integratsiyasi.
 *
 * Bu narx emas — reyting, ranking (shahardagi o'rin), sharhlar soni, oxirgi
 * 5 ta sharh, rasmlar va havola beradi. RateRadar uchun raqobat tahlili +
 * sharh monitoringi qismiga qo'shiladi.
 *
 * Kalit: env.TRIPADVISOR_API_KEY (so'rovga ?key= sifatida qo'shiladi).
 * MUHIM: TripAdvisor kaliti IP-whitelist (yoki referer) bilan cheklanadi —
 * VPS IP'sini developer panelida ruxsat berish shart, aks holda 401/403.
 *
 * Hujjat: https://tripadvisor-content-api.readme.io/
 */

const BASE = 'https://api.content.tripadvisor.com/api/v1';
const TIMEOUT = 15000;
// Content API bepul tarifda sharh va rasmlar 5 ta bilan cheklangan.
const MAX_REVIEWS = 5;
const REVIEW_WINDOW_DAYS = 14; // RateRadar sharh oynasi (review.controller bilan bir xil)

export function hasTripAdvisorContent() {
  return Boolean(env.TRIPADVISOR_API_KEY);
}

function reqHeaders() {
  const h = { accept: 'application/json' };
  // Kalit referer bilan cheklangan bo'lsa — moslashtiramiz.
  if (env.TRIPADVISOR_REFERER) h.Referer = env.TRIPADVISOR_REFERER;
  return h;
}

async function taGet(path, params = {}) {
  try {
    const r = await axios.get(`${BASE}${path}`, {
      params: { key: env.TRIPADVISOR_API_KEY, language: 'en', ...params },
      headers: reqHeaders(),
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    // TripAdvisor xato javobining ASL sababini logga chiqaramiz (IP/referer/kalit).
    const status = err.response?.status;
    const body = err.response?.data;
    const taMsg = body?.error?.message || body?.message || body?.Message
      || (typeof body === 'string' ? body.slice(0, 200) : '');
    console.warn(`[tripadvisor] ${status || 'ERR'} ${path} — ${taMsg || err.message}`);
    // Boyitilgan xatoni yuqoriga uzatamiz (controller foydalanuvchiga ko'rsatadi).
    err.taStatus = status;
    err.taMessage = taMsg;
    throw err;
  }
}

// ─── Lokatsiya qidirish → location_id ────────────────────────────────
// "{name} {city}" bo'yicha qidirib, nomga eng mos hotelni tanlaydi.
async function searchLocation(name, city) {
  const query = [name, city].filter(Boolean).join(' ');
  const data = await taGet('/location/search', { searchQuery: query, category: 'hotels' });
  const list = Array.isArray(data?.data) ? data.data : [];
  if (!list.length) return null;

  const target = String(name || '').toLowerCase().trim();
  const words = target.split(/\s+/).filter((w) => w.length > 3);

  let best = null;
  let bestScore = -1;
  for (const it of list) {
    const nm = String(it.name || '').toLowerCase();
    let score = 0;
    if (nm === target) score = 1000;
    else if (nm.includes(target)) score = 800;
    else if (target.includes(nm)) score = 700;
    else score = words.filter((w) => nm.includes(w)).length * 100;
    // Shahar mos kelsa biroz bonus
    const addr = String(it.address_obj?.address_string || it.address_obj?.city || '').toLowerCase();
    if (city && addr.includes(String(city).toLowerCase())) score += 50;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  if (!best || !best.location_id) return null;
  return { locationId: String(best.location_id), name: best.name };
}

// ─── Lokatsiya tafsilotlari (reyting/ranking/...) ────────────────────
async function locationDetails(locationId) {
  const d = await taGet(`/location/${locationId}/details`, { currency: 'USD' });
  if (!d || !d.location_id) return null;
  return {
    locationId: String(d.location_id),
    name: d.name || '',
    rating: Number(d.rating) || 0,
    reviewCount: parseInt(String(d.num_reviews || '0').replace(/[^0-9]/g, ''), 10) || 0,
    ranking: d.ranking_data?.ranking_string || '',
    rankingPosition: parseInt(d.ranking_data?.ranking || '0', 10) || 0,
    priceLevel: d.price_level || '',
    url: d.web_url || '',
    ratingImage: d.rating_image_url || '',
    address: d.address_obj?.address_string || '',
  };
}

// ─── Oxirgi sharhlar (5 ta) ──────────────────────────────────────────
async function locationReviews(locationId) {
  const d = await taGet(`/location/${locationId}/reviews`, { limit: MAX_REVIEWS });
  const list = Array.isArray(d?.data) ? d.data : [];
  return list.slice(0, MAX_REVIEWS).map((r) => ({
    id: String(r.id || ''),
    rating: Number(r.rating) || 0,
    title: r.title || '',
    text: r.text || '',
    publishedDate: r.published_date || null,
    author: r.user?.username || 'TripAdvisor user',
    url: r.url || '',
  }));
}

// ─── Rasmlar (5 ta) ──────────────────────────────────────────────────
async function locationPhotos(locationId) {
  try {
    const d = await taGet(`/location/${locationId}/photos`, { limit: 5 });
    const list = Array.isArray(d?.data) ? d.data : [];
    return list
      .map((p) => p.images?.large?.url || p.images?.medium?.url || p.images?.original?.url || '')
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function ratingToSentiment(rating) {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'neutral';
}

function withinWindow(dateStr, windowDays) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= Date.now() - windowDays * 86400_000;
}

/**
 * Bitta hotel uchun TripAdvisor ma'lumotini to'liq yangilaydi:
 *   1) location_id (keshdan yoki qidiruvdan)
 *   2) tafsilotlar → Hotel.tripAdvisor keshiga yoziladi
 *   3) oxirgi 5 sharh → Review kolleksiyasiga (platform: 'TripAdvisor')
 *
 * @param {object} hotel  — Hotel hujjati (yoki .lean() obyekt; _id kerak)
 * @returns {{ ok, locationId, rating, reviewCount, ranking, addedReviews, message }}
 */
export async function syncTripAdvisor(hotel, { windowDays = REVIEW_WINDOW_DAYS } = {}) {
  if (!hasTripAdvisorContent()) {
    return { ok: false, message: 'TRIPADVISOR_API_KEY sozlanmagan' };
  }

  // 1) location_id — keshda bo'lsa qayta qidirmaymiz
  let locationId = hotel.tripAdvisor?.locationId || '';
  if (!locationId) {
    const found = await searchLocation(hotel.name, hotel.city);
    if (!found) {
      return { ok: false, message: `TripAdvisor: "${hotel.name}" topilmadi` };
    }
    locationId = found.locationId;
  }

  // 2) Tafsilot + rasmlar (parallel)
  const [details, photos] = await Promise.all([
    locationDetails(locationId),
    locationPhotos(locationId),
  ]);
  if (!details) {
    return { ok: false, message: 'TripAdvisor: tafsilot olinmadi (kalit/IP whitelist?)' };
  }

  const taCache = {
    locationId,
    rating: details.rating,
    reviewCount: details.reviewCount,
    ranking: details.ranking,
    rankingPosition: details.rankingPosition,
    priceLevel: details.priceLevel,
    url: details.url,
    ratingImage: details.ratingImage,
    photos,
    address: details.address,
    updatedAt: new Date(),
  };
  await Hotel.updateOne({ _id: hotel._id }, { $set: { tripAdvisor: taCache } });

  // 3) Sharhlar → Review kolleksiyasi
  let added = 0;
  try {
    const reviews = await locationReviews(locationId);
    for (const rv of reviews) {
      if (!withinWindow(rv.publishedDate, windowDays)) continue;
      const externalId = `tripadvisor:${locationId}:${rv.id}`.slice(0, 200);
      const exists = await Review.findOne({ ownerHotelId: hotel._id, externalId });
      if (exists) continue;
      const text = [rv.title, rv.text].filter(Boolean).join(' — ');
      await Review.create({
        targetType: 'own',
        targetId: hotel._id,
        ownerHotelId: hotel._id,
        platform: 'TripAdvisor',
        externalId,
        author: rv.author,
        rating: rv.rating,
        text,
        publishedAt: new Date(rv.publishedDate),
        sentiment: ratingToSentiment(rv.rating),
        seenByUser: false,
      });
      added += 1;
    }
  } catch (err) {
    console.warn('[tripadvisor] sharh olishda xato:', err.message);
  }

  return {
    ok: true,
    locationId,
    rating: details.rating,
    reviewCount: details.reviewCount,
    ranking: details.ranking,
    url: details.url,
    addedReviews: added,
    message: `TripAdvisor: ${details.rating}/5 · ${details.reviewCount} sharh · +${added} yangi`,
  };
}
