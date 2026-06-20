import Review from '../models/Review.js';
import Hotel from '../models/Hotel.js';
import { fetchHotelReviews } from '../services/hotelEnrich.service.js';
import { generateReviewResponse, isAIEnabled } from '../services/openai.service.js';
import {
  getBookingReviewsApify, findBookingUrl,
  getAgodaReviewsApify, findAgodaUrl,
  getExpediaReviewsApify, findExpediaUrl,
  getTripReviewsApify, findTripUrl,
  getYandexReviewsApify, findYandexUrl,
  hasApify,
} from '../services/apify.service.js';
import { hasYandex, findYandexOrg } from '../services/yandex.service.js';
import { hasTripAdvisorContent, syncTripAdvisor } from '../services/tripadvisorContent.service.js';

function ratingToSentiment(rating) {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'neutral';
}

// Sharh oynasi: oxirgi 14 kun (2 hafta). Eski sharhlar bazadan olib
// tashlanadi, kelgan natija ham shu oynaga filterlanadi. Foydalanuvchi
// "yangi" sharhlarni ko'rishi kerak — eski 6 oylik sharhlar bazani shishiradi.
export const REVIEW_WINDOW_DAYS = 14;

function windowCutoff() {
  return new Date(Date.now() - REVIEW_WINDOW_DAYS * 86400_000);
}

function isWithinWindow(date) {
  if (!date) return false;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() >= windowCutoff().getTime();
}

/**
 * Berilgan hotel uchun oynadan tashqaridagi sharhlarni o'chiradi.
 * `platform` berilsa — faqat shu manba uchun, aks holda — barchasi.
 * `publishedAt: null` bo'lganlar ham eski hisoblanadi va o'chiriladi.
 */
export async function purgeOldReviews(hotelId, platform = null) {
  const cutoff = windowCutoff();
  const filter = {
    ownerHotelId: hotelId,
    $or: [{ publishedAt: { $lt: cutoff } }, { publishedAt: null }],
  };
  if (platform) filter.platform = platform;
  const r = await Review.deleteMany(filter);
  return r.deletedCount || 0;
}

// Mongo nested-key buzilishini tekislash: `{Booking: {com: url}}` → `{'Booking.com': url}`
function flatBookingUrl(otaUrls) {
  if (!otaUrls) return null;
  if (typeof otaUrls['Booking.com'] === 'string') return otaUrls['Booking.com'];
  if (typeof otaUrls.Booking === 'string') return otaUrls.Booking;
  if (otaUrls.Booking && typeof otaUrls.Booking === 'object' && typeof otaUrls.Booking.com === 'string') {
    return otaUrls.Booking.com;
  }
  return null;
}

function flatAgodaUrl(otaUrls) {
  if (!otaUrls) return null;
  return typeof otaUrls.Agoda === 'string' ? otaUrls.Agoda : null;
}

function flatExpediaUrl(otaUrls) {
  if (!otaUrls) return null;
  return typeof otaUrls.Expedia === 'string' ? otaUrls.Expedia : null;
}

function flatTripUrl(otaUrls) {
  if (!otaUrls) return null;
  if (typeof otaUrls['Trip.com'] === 'string') return otaUrls['Trip.com'];
  if (typeof otaUrls.Trip === 'string') return otaUrls.Trip;
  if (otaUrls.Trip && typeof otaUrls.Trip === 'object' && typeof otaUrls.Trip.com === 'string') {
    return otaUrls.Trip.com;
  }
  return null;
}

function flatYandexUrl(otaUrls) {
  if (!otaUrls) return null;
  return typeof otaUrls.Yandex === 'string' ? otaUrls.Yandex : null;
}

// Sharhlarni bazaga saqlash. Faqat oxirgi REVIEW_WINDOW_DAYS ichidagilarni
// qabul qiladi; oynadan tashqaridagilar va sanasi yo'qlari `skipped`.
async function persistReviews(hotelId, items) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of items) {
    try {
      const pub = validDate(r.publishedAt);
      if (!isWithinWindow(pub)) { skipped += 1; continue; }

      const exists = await Review.findOne({ ownerHotelId: hotelId, externalId: r.externalId });
      if (exists) {
        if ((!exists.text || exists.text.trim() === '') && r.text) {
          await Review.updateOne(
            { _id: exists._id },
            { text: r.text, rating: r.rating || exists.rating, sentiment: r.sentiment },
          );
          updated += 1;
        }
        continue;
      }
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
  return { added, updated, skipped };
}

export async function listReviews(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = { ownerHotelId: hotel._id, targetType: 'own' };
    if (req.query.sentiment) filter.sentiment = req.query.sentiment;
    if (req.query.platform) filter.platform = req.query.platform;

    const [reviews, total, statsAgg, unreadCount] = await Promise.all([
      // publishedAt: -1 — eng yangi sharhlar tepada. Sana null bo'lsa
      // Mongo nullni eng kichik hisoblab pastga tushiradi (kerakli xulq).
      // createdAt — bir xil/null sanalar orasidagi tiebreaker.
      Review.find(filter).sort({ publishedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Review.countDocuments(filter),
      Review.aggregate([
        { $match: { ownerHotelId: hotel._id, targetType: 'own' } },
        {
          $group: {
            _id: null,
            positive: { $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] } },
            neutral: { $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] } },
            avgRating: { $avg: '$rating' },
          },
        },
      ]),
      Review.countDocuments({ ownerHotelId: hotel._id, targetType: 'own', seenByUser: false }),
    ]);

    const statsRaw = statsAgg[0] || { positive: 0, negative: 0, neutral: 0, avgRating: 0 };
    const stats = {
      positive: statsRaw.positive,
      negative: statsRaw.negative,
      neutral: statsRaw.neutral,
      avgRating: statsRaw.avgRating ? Math.round(statsRaw.avgRating * 10) / 10 : 0,
    };

    // Apify sharh sozlamalari (faqat birinchi sahifada qisqacha holat)
    const apifyProvider = page === 1 ? {
      configured: hasApify(),
      bookingUrl: flatBookingUrl(hotel.otaUrls),
      agodaUrl:   flatAgodaUrl(hotel.otaUrls),
      expediaUrl: flatExpediaUrl(hotel.otaUrls),
      tripUrl:    flatTripUrl(hotel.otaUrls),
      yandexUrl:  flatYandexUrl(hotel.otaUrls),
    } : null;

    // TripAdvisor keshi + kalit holati (faqat 1-sahifada)
    const tripAdvisor = page === 1 ? (hotel.tripAdvisor || null) : null;
    const tripadvisorConfigured = page === 1 ? hasTripAdvisorContent() : undefined;

    res.json({ reviews, total, page, limit, stats, unreadCount, apifyProvider, tripAdvisor, tripadvisorConfigured });
  } catch (err) {
    next(err);
  }
}

export async function markReviewSeen(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const review = await Review.findOneAndUpdate(
      { _id: req.params.id, ownerHotelId: hotel._id },
      { seenByUser: true },
      { new: true }
    );

    if (!review) return res.status(404).json({ error: 'Sharh topilmadi' });

    res.json({ review });
  } catch (err) {
    next(err);
  }
}

export async function markAllReviewsSeen(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const result = await Review.updateMany(
      { ownerHotelId: hotel._id, seenByUser: false },
      { seenByUser: true }
    );

    res.json({ updated: result.modifiedCount });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /reviews/:id/generate-response — AI javob generatsiya qiladi
 */
export async function generateResponse(req, res, next) {
  try {
    if (!isAIEnabled()) return res.status(503).json({ error: 'OpenAI API kaliti sozlanmagan' });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const review = await Review.findOne({ _id: req.params.id, ownerHotelId: hotel._id }).lean();
    if (!review) return res.status(404).json({ error: 'Sharh topilmadi' });

    const lang = req.body?.lang || req.query.lang || 'ru';
    const result = await generateReviewResponse({
      review, hotelName: hotel.name, lang,
    });

    if (!result.response) {
      return res.status(502).json({ error: 'AI javob qaytarmadi' });
    }
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * POST /reviews/scrape — SerpAPI google_hotels_reviews orqali Booking.com,
 * Agoda, Hotels.com, Expedia, TripAdvisor, Google va boshqa OTA'lardan
 * sharhlarni olib keladi va bazaga saqlaydi (har biri o'z `platform` bilan).
 *
 * ?reset=true  — eski property_token'ni e'tiborga olmasdan qayta qidiradi va
 *                eski SerpAPI sharhlarini o'chiradi.
 * ?pages=N     — necha sahifa olib kelish (default 5, max 10 ≈ 100 review)
 */
export async function scrapeReviews(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const reset = req.query.reset === 'true';
    // 7 kunlik oyna uchun 2 sahifa yetarli (~20 review) — Google eng yangilarini
    // birinchi sahifada qaytaradi. Oynadan tashqaridagilar baribir tashlanadi.
    const maxPages = Math.min(15, Math.max(1, parseInt(req.query.pages) || 2));

    // Avvalo barcha eski Google sharhlarini o'chirish (oynadan tashqari + null sana)
    const purgedOld = await purgeOldReviews(hotel._id, 'Google');

    const { reviews, propertyToken, matchedPlace, bySource } = await fetchHotelReviews({
      name: hotel.name,
      city: hotel.city,
      countryCode: hotel.countryCode,
      propertyToken: reset ? '' : (hotel.serpPropertyToken || ''),
      maxPages,
    });

    // Reset rejimi — yangi token topilsa qolgan SerpAPI sharhlarini ham tozalaymiz
    if (reset && propertyToken && propertyToken !== hotel.serpPropertyToken) {
      await Review.deleteMany({
        ownerHotelId: hotel._id,
        externalId: { $regex: '^serp:' },
      });
    }

    if (!propertyToken) {
      return res.json({
        added: 0,
        propertyToken: '',
        matchedPlace: null,
        notFound: true,
        message: `"${hotel.name}" Google Hotels'da topilmadi. Mehmonxona nomini aniqlashtiring.`,
      });
    }

    if (propertyToken !== hotel.serpPropertyToken) {
      await Hotel.findByIdAndUpdate(hotel._id, { serpPropertyToken: propertyToken });
    }

    if (!reviews.length) {
      return res.json({
        added: 0,
        propertyToken,
        matchedPlace,
        bySource: {},
        message: `"${matchedPlace?.name || hotel.name}" uchun hozircha sharh yo'q`,
      });
    }

    let added = 0;
    let skipped = 0;
    const addedBySource = {};
    for (const r of reviews) {
      const platform = r.source || 'Google';
      const pub = parseReviewDate(r.date);
      if (!isWithinWindow(pub)) { skipped += 1; continue; }

      // Dedup kaliti: propertyToken + source + author + matn boshlanishi
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
        addedBySource[platform] = (addedBySource[platform] || 0) + 1;
      } catch {
        continue;
      }
    }

    // Manba bo'yicha hisob: backenddan kelgan barcha sharhlar
    const totalBySource = {};
    for (const [src, list] of Object.entries(bySource || {})) {
      totalBySource[src] = list.length;
    }

    res.json({
      added,
      skipped,
      purgedOld,
      windowDays: REVIEW_WINDOW_DAYS,
      total: reviews.length,
      addedBySource,
      totalBySource,
      sources: Object.keys(totalBySource),
      propertyToken,
      matchedPlace,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /reviews/scrape-apify — Apify orqali Booking.com va Agoda sharhlarini parallel olib keladi.
 * Body: { bookingUrl?, agodaUrl?, autoFind?: boolean }
 * autoFind=true bo'lsa va URL berilmasa, Google search orqali topadi va hotelda saqlaydi.
 */
export async function scrapeApifyReviews(req, res, next) {
  try {
    if (!hasApify()) return res.status(503).json({ error: 'APIFY_API_KEY .env da sozlanmagan' });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    // reset=true bo'lsa — bu mehmonxonaning eski Apify sharhlarini o'chiramiz
    // (boshqa hotelning aralashib ketgan ma'lumotlarini tozalash uchun)
    if (req.body?.reset === true) {
      await Review.deleteMany({
        ownerHotelId: hotel._id,
        externalId: { $regex: '^apify:' },
      });
    }

    // source: 'booking' | 'agoda' | 'expedia' | 'trip' | 'yandex' | 'all' (default 'all')
    const source = (req.body?.source || 'all').toLowerCase();
    const doBooking = source === 'all' || source === 'booking';
    const doAgoda   = source === 'all' || source === 'agoda';
    const doExpedia = source === 'all' || source === 'expedia';
    const doTrip    = source === 'all' || source === 'trip';
    const doYandex  = source === 'all' || source === 'yandex';

    let bookingUrl = doBooking ? (req.body?.bookingUrl || flatBookingUrl(hotel.otaUrls)) : null;
    let agodaUrl   = doAgoda   ? (req.body?.agodaUrl   || flatAgodaUrl(hotel.otaUrls))   : null;
    let expediaUrl = doExpedia ? (req.body?.expediaUrl || flatExpediaUrl(hotel.otaUrls)) : null;
    let tripUrl    = doTrip    ? (req.body?.tripUrl    || flatTripUrl(hotel.otaUrls))    : null;
    let yandexUrl  = doYandex  ? (req.body?.yandexUrl  || flatYandexUrl(hotel.otaUrls))  : null;

    const autoFind = req.body?.autoFind !== false;
    const nextOtaUrls = { ...(hotel.otaUrls || {}) };
    let savedAny = false;

    if (doBooking && !bookingUrl && autoFind) {
      bookingUrl = await findBookingUrl(hotel.name, hotel.city);
      if (bookingUrl) { nextOtaUrls['Booking.com'] = bookingUrl; savedAny = true; }
    }
    if (doAgoda && !agodaUrl && autoFind) {
      agodaUrl = await findAgodaUrl(hotel.name, hotel.city);
      if (agodaUrl) { nextOtaUrls.Agoda = agodaUrl; savedAny = true; }
    }
    if (doExpedia && !expediaUrl && autoFind) {
      expediaUrl = await findExpediaUrl(hotel.name, hotel.city);
      if (expediaUrl) { nextOtaUrls.Expedia = expediaUrl; savedAny = true; }
    }
    if (doTrip && !tripUrl && autoFind) {
      tripUrl = await findTripUrl(hotel.name, hotel.city);
      if (tripUrl) { nextOtaUrls['Trip.com'] = tripUrl; savedAny = true; }
    }
    // Yandex — avval rasmiy Geosearch API (kalit bo'lsa), bo'lmasa SerpAPI
    // Google qidiruvi (mavjud kalit bilan ishlaydi).
    if (doYandex && !yandexUrl && autoFind) {
      if (hasYandex()) {
        try {
          const coords = hotel.location?.coordinates?.length === 2
            ? { longitude: hotel.location.coordinates[0], latitude: hotel.location.coordinates[1] }
            : undefined;
          const org = await findYandexOrg({ name: hotel.name, city: hotel.city, coords });
          if (!org.notFound && org.url) yandexUrl = org.url;
        } catch (err) {
          console.warn('Yandex Geosearch:', err.message);
        }
      }
      // Geosearch topa olmasa yoki kalit yo'q bo'lsa — Google fallback.
      if (!yandexUrl) {
        yandexUrl = await findYandexUrl(hotel.name, hotel.city);
      }
      if (yandexUrl) { nextOtaUrls.Yandex = yandexUrl; savedAny = true; }
    }
    if (savedAny) {
      await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: nextOtaUrls } });
    }

    if ((doBooking && !bookingUrl) && (doAgoda && !agodaUrl) && (doExpedia && !expediaUrl) && (doTrip && !tripUrl) && (doYandex && !yandexUrl)) {
      return res.status(404).json({
        error: 'URL topilmadi. Sozlamalarda kiriting yoki SerpAPI/Yandex kaliti sozlanganligini tekshiring.',
      });
    }

    // Har bir tanlangan manba uchun eski sharhlarni o'chiramiz (7 kunlik oynadan tashqari).
    // Bu apify scraper natijasi yo'q bo'lib qolsa ham eski yozuvlarni baribir tozalaydi.
    const purgedBySource = {};
    if (doBooking) purgedBySource['Booking.com'] = await purgeOldReviews(hotel._id, 'Booking.com');
    if (doAgoda)   purgedBySource.Agoda         = await purgeOldReviews(hotel._id, 'Agoda');
    if (doExpedia) purgedBySource.Expedia       = await purgeOldReviews(hotel._id, 'Expedia');
    if (doTrip)    purgedBySource['Trip.com']   = await purgeOldReviews(hotel._id, 'Trip.com');
    if (doYandex)  purgedBySource.Yandex        = await purgeOldReviews(hotel._id, 'Yandex');

    // Apify scraper'lar maxReviews=50 bilan eng yangilarini qaytaradi;
    // persistReviews ichida 7 kunlik oynadan tashqari yotganlari tashlanadi.
    const [bookingItems, agodaItems, expediaItems, tripItems, yandexItems] = await Promise.all([
      (doBooking && bookingUrl) ? getBookingReviewsApify(bookingUrl, { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
      (doAgoda && agodaUrl)     ? getAgodaReviewsApify(agodaUrl,   { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
      (doExpedia && expediaUrl) ? getExpediaReviewsApify(expediaUrl, { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
      (doTrip && tripUrl)       ? getTripReviewsApify(tripUrl,     { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
      (doYandex && yandexUrl)   ? getYandexReviewsApify(yandexUrl, { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
    ]);

    const [bookingStats, agodaStats, expediaStats, tripStats, yandexStats] = await Promise.all([
      persistReviews(hotel._id, bookingItems),
      persistReviews(hotel._id, agodaItems),
      persistReviews(hotel._id, expediaItems),
      persistReviews(hotel._id, tripItems),
      persistReviews(hotel._id, yandexItems),
    ]);

    const totalAdded = bookingStats.added + agodaStats.added + expediaStats.added + tripStats.added + yandexStats.added;
    const totalUpdated = bookingStats.updated + agodaStats.updated + expediaStats.updated + tripStats.updated + yandexStats.updated;
    const totalSkipped = bookingStats.skipped + agodaStats.skipped + expediaStats.skipped + tripStats.skipped + yandexStats.skipped;
    const totalFetched = bookingItems.length + agodaItems.length + expediaItems.length + tripItems.length + yandexItems.length;

    res.json({
      added: totalAdded,
      updated: totalUpdated,
      skipped: totalSkipped,
      total: totalFetched,
      windowDays: REVIEW_WINDOW_DAYS,
      purgedBySource,
      bySource: {
        'Booking.com': { added: bookingStats.added, updated: bookingStats.updated, skipped: bookingStats.skipped, fetched: bookingItems.length, url: bookingUrl },
        Agoda:         { added: agodaStats.added,   updated: agodaStats.updated,   skipped: agodaStats.skipped,   fetched: agodaItems.length,   url: agodaUrl },
        Expedia:       { added: expediaStats.added, updated: expediaStats.updated, skipped: expediaStats.skipped, fetched: expediaItems.length, url: expediaUrl },
        'Trip.com':    { added: tripStats.added,    updated: tripStats.updated,    skipped: tripStats.skipped,    fetched: tripItems.length,    url: tripUrl },
        Yandex:        { added: yandexStats.added,  updated: yandexStats.updated,  skipped: yandexStats.skipped,  fetched: yandexItems.length,  url: yandexUrl },
      },
    });
  } catch (err) { next(err); }
}

/**
 * POST /reviews/scrape-tripadvisor — TripAdvisor rasmiy Content API orqali
 * reyting, ranking, sharhlar soni va oxirgi 5 sharhni olib keladi.
 * ?reset=true — keshlangan location_id'ni unutib qaytadan qidiradi.
 */
export async function scrapeTripadvisor(req, res, next) {
  try {
    if (!hasTripAdvisorContent()) {
      return res.status(503).json({ error: 'TRIPADVISOR_API_KEY .env da sozlanmagan' });
    }
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    // reset — keshlangan location_id'ni tozalab qayta moslashtirish
    if (req.query.reset === 'true' && hotel.tripAdvisor?.locationId) {
      await Hotel.updateOne({ _id: hotel._id }, { $set: { 'tripAdvisor.locationId': '' } });
      hotel.tripAdvisor = { ...(hotel.tripAdvisor || {}), locationId: '' };
    }

    // Oynadan tashqari eski TripAdvisor sharhlarini tozalaymiz
    await purgeOldReviews(hotel._id, 'TripAdvisor');

    const result = await syncTripAdvisor(hotel, { windowDays: REVIEW_WINDOW_DAYS });
    if (!result.ok) {
      return res.status(404).json({ error: result.message });
    }

    // Yangilangan keshni qaytaramiz
    const fresh = await Hotel.findById(hotel._id).select('tripAdvisor').lean();
    res.json({
      ...result,
      added: result.addedReviews,
      tripAdvisor: fresh?.tripAdvisor || null,
    });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(502).json({
        error: 'TripAdvisor 401/403 — kalit yoki IP whitelist (VPS IP) tekshiring',
      });
    }
    next(err);
  }
}

// Sharhdagi sana — ISO yoki "1 week ago"/"2 months ago" formatida. Aniqlab
// bo'lmasa null qaytaramiz, shunda sort ularni pastga tushiradi (Mongo nullni
// eng kichik qiymat hisoblaydi). Avval `new Date()` bilan to'ldirilardi, bu
// barcha sanasi yo'q sharhlarni "hozir" deb belgilab sortni buzardi.
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

// Apify scraper'lardan kelgan Date obyekti — yaroqsiz bo'lsa null
function validDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
