import cron from 'node-cron';
import Hotel from '../models/Hotel.js';
import Review from '../models/Review.js';
import { fetchHotelReviews } from './hotelEnrich.service.js';
import {
  hasApify,
  getBookingReviewsApify,
  getAgodaReviewsApify,
  getExpediaReviewsApify,
  getTripReviewsApify,
  getYandexReviewsApify,
  findYandexUrl,
} from './apify.service.js';
import { hasYandex, findYandexOrg } from './yandex.service.js';
import { hasTripAdvisorContent, syncTripAdvisor } from './tripadvisorContent.service.js';
import { REVIEW_WINDOW_DAYS, purgeOldReviews } from '../controllers/review.controller.js';

function ratingToSentiment(rating) {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'neutral';
}

function isWithinWindow(date) {
  if (!date) return false;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = Date.now() - REVIEW_WINDOW_DAYS * 86400_000;
  return d.getTime() >= cutoff;
}

function parseReviewDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = String(s).toLowerCase().match(/(\d+)\s*(hour|day|week|month|year)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const ms = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[m[2]] || 0;
  return new Date(Date.now() - n * ms);
}

function flatUrl(otaUrls, ...keys) {
  if (!otaUrls) return null;
  for (const k of keys) {
    if (typeof otaUrls[k] === 'string') return otaUrls[k];
  }
  return null;
}

async function saveReviewsForHotel(hotelId, items) {
  let added = 0;
  for (const r of items) {
    try {
      const pub = r.publishedAt instanceof Date ? r.publishedAt : new Date(r.publishedAt);
      if (!isWithinWindow(pub)) continue;
      const exists = await Review.findOne({ ownerHotelId: hotelId, externalId: r.externalId });
      if (exists) continue;
      await Review.create({
        targetType: 'own',
        targetId: hotelId,
        ownerHotelId: hotelId,
        platform: r.platform,
        externalId: r.externalId,
        author: r.author,
        rating: r.rating,
        text: r.text,
        publishedAt: pub,
        sentiment: r.sentiment,
        seenByUser: false,
      });
      added += 1;
    } catch {
      continue;
    }
  }
  return added;
}

// SerpAPI (Google + boshqa OTA aggregatlari) — 7 kunlik oyna ichida
async function fetchGoogleForHotel(hotel) {
  await purgeOldReviews(hotel._id, 'Google');
  const { reviews, propertyToken } = await fetchHotelReviews({
    name: hotel.name,
    city: hotel.city,
    countryCode: hotel.countryCode,
    propertyToken: hotel.serpPropertyToken || '',
    maxPages: 2,
  });
  if (!propertyToken) return 0;
  if (propertyToken !== hotel.serpPropertyToken) {
    await Hotel.findByIdAndUpdate(hotel._id, { serpPropertyToken: propertyToken });
  }
  let added = 0;
  for (const r of reviews) {
    const platform = r.source || 'Google';
    const pub = parseReviewDate(r.date);
    if (!isWithinWindow(pub)) continue;
    const dedup = `${platform}:${r.author}:${(r.text || '').slice(0, 40)}`;
    const externalId = `serp:${propertyToken}:${dedup}`.slice(0, 200);
    try {
      const exists = await Review.findOne({ ownerHotelId: hotel._id, externalId });
      if (exists) continue;
      await Review.create({
        targetType: 'own',
        targetId: hotel._id,
        ownerHotelId: hotel._id,
        platform,
        externalId,
        author: r.author,
        rating: r.rating,
        text: r.text,
        publishedAt: pub,
        sentiment: ratingToSentiment(r.rating),
        seenByUser: false,
      });
      added += 1;
    } catch {
      continue;
    }
  }
  return added;
}

// Apify (Booking/Agoda/Expedia/Trip) — har birini parallel
async function fetchApifyForHotel(hotel) {
  if (!hasApify()) return { added: 0 };

  const bookingUrl = flatUrl(hotel.otaUrls, 'Booking.com', 'Booking');
  const agodaUrl   = flatUrl(hotel.otaUrls, 'Agoda');
  const expediaUrl = flatUrl(hotel.otaUrls, 'Expedia');
  const tripUrl    = flatUrl(hotel.otaUrls, 'Trip.com', 'Trip');

  await Promise.all([
    purgeOldReviews(hotel._id, 'Booking.com'),
    purgeOldReviews(hotel._id, 'Agoda'),
    purgeOldReviews(hotel._id, 'Expedia'),
    purgeOldReviews(hotel._id, 'Trip.com'),
  ]);

  const [bookingItems, agodaItems, expediaItems, tripItems] = await Promise.all([
    bookingUrl ? getBookingReviewsApify(bookingUrl, { maxReviews: 50 }).catch(() => []) : [],
    agodaUrl   ? getAgodaReviewsApify(agodaUrl,     { maxReviews: 50 }).catch(() => []) : [],
    expediaUrl ? getExpediaReviewsApify(expediaUrl, { maxReviews: 50 }).catch(() => []) : [],
    tripUrl    ? getTripReviewsApify(tripUrl,       { maxReviews: 50 }).catch(() => []) : [],
  ]);

  const adds = await Promise.all([
    saveReviewsForHotel(hotel._id, bookingItems),
    saveReviewsForHotel(hotel._id, agodaItems),
    saveReviewsForHotel(hotel._id, expediaItems),
    saveReviewsForHotel(hotel._id, tripItems),
  ]);

  return { added: adds.reduce((a, b) => a + b, 0) };
}

// TripAdvisor (rasmiy Content API) — reyting/ranking keshi + 5 sharh
async function fetchTripAdvisorForHotel(hotel) {
  if (!hasTripAdvisorContent()) return { added: 0 };
  await purgeOldReviews(hotel._id, 'TripAdvisor');
  const r = await syncTripAdvisor(hotel, { windowDays: REVIEW_WINDOW_DAYS }).catch((err) => {
    console.warn(`[cron] TripAdvisor "${hotel.name}":`, err.message);
    return { ok: false, addedReviews: 0 };
  });
  return { added: r.addedReviews || 0 };
}

// Yandex (Geosearch URL topish + Apify sharhlar) — gibrid
async function fetchYandexForHotel(hotel) {
  if (!hasApify()) return { added: 0 };

  await purgeOldReviews(hotel._id, 'Yandex');

  // 1) URL'ni avval saqlangan otaUrls'dan olamiz; bo'lmasa Geosearch bilan
  //    bir marta topib, keyingi run'lar uchun keshlaymiz (serpPropertyToken kabi).
  let yandexUrl = flatUrl(hotel.otaUrls, 'Yandex');
  if (!yandexUrl) {
    if (hasYandex()) {
      try {
        const coords = hotel.location?.coordinates?.length === 2
          ? { longitude: hotel.location.coordinates[0], latitude: hotel.location.coordinates[1] }
          : undefined;
        const org = await findYandexOrg({ name: hotel.name, city: hotel.city, coords });
        if (!org.notFound && org.url) yandexUrl = org.url;
      } catch (err) {
        console.warn(`[cron] Yandex Geosearch "${hotel.name}":`, err.message);
      }
    }
    // Geosearch kaliti yo'q yoki topa olmasa — SerpAPI Google fallback.
    if (!yandexUrl) yandexUrl = await findYandexUrl(hotel.name, hotel.city);
    if (yandexUrl) {
      await Hotel.findByIdAndUpdate(hotel._id, { $set: { 'otaUrls.Yandex': yandexUrl } });
    }
  }
  if (!yandexUrl) return { added: 0 };

  // 2) O'sha URL'dan sharhlarni olamiz.
  const items = await getYandexReviewsApify(yandexUrl, { maxReviews: 50 }).catch(() => []);
  const added = await saveReviewsForHotel(hotel._id, items);
  return { added };
}

// Bitta hotel uchun barcha kanaldan sharh yig'adi (Google, Apify OTA'lar,
// Yandex, TripAdvisor). Cron ham, onboarding orkestratori ham shuni chaqiradi.
export async function collectReviewsForHotel(hotel) {
  const [g, a, y, ta] = await Promise.all([
    fetchGoogleForHotel(hotel).catch((err) => { console.warn(`[reviews] Google "${hotel.name}":`, err.message); return 0; }),
    fetchApifyForHotel(hotel).catch((err) => { console.warn(`[reviews] Apify "${hotel.name}":`, err.message); return { added: 0 }; }),
    fetchYandexForHotel(hotel).catch((err) => { console.warn(`[reviews] Yandex "${hotel.name}":`, err.message); return { added: 0 }; }),
    fetchTripAdvisorForHotel(hotel).catch((err) => { console.warn(`[reviews] TripAdvisor "${hotel.name}":`, err.message); return { added: 0 }; }),
  ]);
  return { google: g, apify: a.added || 0, yandex: y.added || 0, tripadvisor: ta.added || 0 };
}

async function runReviewMonitor() {
  console.log('[cron] Sharh yangilash boshlandi (7 kunlik oyna)...');
  try {
    const hotels = await Hotel.find({ isActive: true }).select('_id name city countryCode otaUrls serpPropertyToken location tripAdvisor').lean();
    for (const hotel of hotels) {
      try {
        const r = await collectReviewsForHotel(hotel);
        console.log(`[cron] ${hotel.name}: Google +${r.google}, Apify +${r.apify}, Yandex +${r.yandex}, TripAdvisor +${r.tripadvisor}`);
      } catch (err) {
        console.error(`[cron] Hotel "${hotel.name}" sharh xatosi:`, err.message);
      }
    }
    console.log('[cron] Sharh yangilash tugadi');
  } catch (err) {
    console.error('[cron] Sharh monitoring xatosi:', err.message);
  }
}

// Har dushanba 03:00 da
export function startReviewMonitor() {
  cron.schedule('0 3 * * 1', runReviewMonitor);
  console.log('[cron] Sharh monitoring yoqildi (har dushanba 03:00)');
}

// Manual trigger (server boot'da bir marta yoki testlar uchun)
export { runReviewMonitor };
