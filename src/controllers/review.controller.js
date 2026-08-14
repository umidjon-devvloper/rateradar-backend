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

// Sharh SAQLASH oynasi: 2 yil (730 kun). Bu — retention (korpus) oynasi, "yangi"
// belgisi emas. Ilgari 14 kun edi — kichik mehmonxonalarda eski (lekin qimmatli)
// sharhlar o'chib ketardi ("Jami sharhlar: 1" muammosi). Sanasi noaniq sharhlar
// ham SAQLANADI (o'chirilmaydi). "Yangi" sharh — seenByUser bilan belgilanadi.
export const REVIEW_WINDOW_DAYS = 730;

function windowCutoff() {
  return new Date(Date.now() - REVIEW_WINDOW_DAYS * 86400_000);
}

function isWithinWindow(date) {
  // Sanasi yo'q/noaniq sharh ham SAQLANADI (qimmatli, tashlab yubormaymiz).
  if (!date) return true;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() >= windowCutoff().getTime();
}

/**
 * Berilgan hotel uchun retention oynasidan (2 yil) TASHQARIDAGI sharhlarni
 * o'chiradi. Sanasi noaniq (publishedAt:null) sharhlar SAQLANADI — o'chirilmaydi.
 */
export async function purgeOldReviews(hotelId, platform = null) {
  const cutoff = windowCutoff();
  const filter = {
    ownerHotelId: hotelId,
    publishedAt: { $ne: null, $lt: cutoff }, // faqat aniq-eski; null saqlanadi
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

// Scrape.do Booking "featured" sharhlarini saqlaydi. Bular tanlangan (eng
// foydali) sharhlar — ko'pincha 14 kundan eski, shuning uchun OYNA FILTRSIZ
// saqlaymiz (AI tahlil va javob generatsiyasi uchun baribir qimmatli).
// Reyting'dan sentiment chiqaramiz (Ijobiy/Salbiy filtr tablari uchun).
async function persistScrapedoReviews(hotelId, items) {
  let added = 0, updated = 0;
  for (const r of items) {
    if (!r.externalId || !r.text) continue;
    try {
      const exists = await Review.findOne({ ownerHotelId: hotelId, externalId: r.externalId });
      if (exists) {
        if ((!exists.text || !exists.text.trim()) && r.text) {
          await Review.updateOne({ _id: exists._id }, { text: r.text });
          updated += 1;
        }
        continue;
      }
      const sentiment = r.rating >= 4 ? 'positive' : r.rating > 0 && r.rating <= 2.5 ? 'negative' : 'neutral';
      await Review.create({
        targetType: 'own', targetId: hotelId, ownerHotelId: hotelId,
        platform: r.source || 'Booking.com',
        externalId: r.externalId,
        author: r.author || 'Anonymous',
        rating: r.rating || 0,
        text: r.text,
        publishedAt: r.date || null,
        sentiment,
        seenByUser: false,
      });
      added += 1;
    } catch { continue; }
  }
  return { added, updated };
}

/**
 * Booking.com JONLI SKREYPER orqali sharhlarni olib, 14 kunlik oynaga
 * filtrlab bazaga saqlaydi. SerpAPI/Apify kalitlari yo'q bo'lsa ham ishlaydi.
 * @returns {{added, skipped, total, bookingUrl, matchedName}|null}
 */
async function scrapeBookingReviewsAndPersist(hotel) {
  const { scraperEnabled, scraperReviews } = await import('../services/hotelScraper.service.js');
  if (!scraperEnabled()) return null;

  const { reviews, bookingUrl, matchedName } = await scraperReviews(hotel.name, hotel.city, 20);

  // Eski Booking sharhlarini (14 kunlik oynadan tashqari) tozalaymiz
  await purgeOldReviews(hotel._id, 'Booking.com');
  if (!reviews.length) return { added: 0, skipped: 0, total: 0, bookingUrl, matchedName };

  let added = 0;
  let skipped = 0;
  for (const r of reviews) {
    const pub = parseReviewDate(r.date);
    if (!isWithinWindow(pub)) { skipped += 1; continue; }
    const dedup = `${r.author}:${(r.text || '').slice(0, 40)}`;
    const externalId = `bookingscraper:${bookingUrl || hotel.name}:${dedup}`.slice(0, 200);
    try {
      const exists = await Review.findOne({ ownerHotelId: hotel._id, externalId });
      if (exists) continue;
      await Review.create({
        targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
        platform: 'Booking.com', externalId,
        author: r.author, rating: r.rating, text: r.text,
        publishedAt: pub, sentiment: ratingToSentiment(r.rating), seenByUser: false,
      });
      added += 1;
    } catch { continue; }
  }
  return { added, skipped, total: reviews.length, bookingUrl, matchedName };
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

    // SerpAPI muvaffaqiyatsiz (token yo'q yoki sharh qaytarmadi) — Booking.com
    // JONLI SKREYPER fallback. Shu tufayli hech qaysi pullik kalit bo'lmasa ham
    // sharhlar (14 kunlik) keladi.
    if (!propertyToken || !reviews.length) {
      const bs = await scrapeBookingReviewsAndPersist(hotel).catch((e) => {
        console.warn('Booking sharh skreyper xato:', e.message);
        return null;
      });
      if (bs && (bs.added > 0 || bs.total > 0)) {
        return res.json({
          added: bs.added,
          skipped: bs.skipped,
          windowDays: REVIEW_WINDOW_DAYS,
          total: bs.total,
          source: 'booking_scraper',
          matchedPlace: bs.matchedName ? { name: bs.matchedName } : null,
          addedBySource: bs.added ? { 'Booking.com': bs.added } : {},
          totalBySource: { 'Booking.com': bs.total },
          sources: ['Booking.com'],
          message: bs.added === 0 && bs.total > 0
            ? `Booking.com'da ${bs.total} ta sharh topildi, lekin oxirgi ${REVIEW_WINDOW_DAYS} kun ichida yangisi yo'q`
            : undefined,
        });
      }
      // Skreyper ham topa olmadi — asl SerpAPI xabarlari.
      if (!propertyToken) {
        return res.json({
          added: 0,
          propertyToken: '',
          matchedPlace: null,
          notFound: true,
          message: `"${hotel.name}" Google Hotels va Booking.com'da topilmadi. Mehmonxona nomini aniqlashtiring.`,
        });
      }
      return res.json({
        added: 0,
        propertyToken,
        matchedPlace,
        bySource: {},
        message: `"${matchedPlace?.name || hotel.name}" uchun hozircha sharh yo'q`,
      });
    }

    if (propertyToken !== hotel.serpPropertyToken) {
      await Hotel.findByIdAndUpdate(hotel._id, { serpPropertyToken: propertyToken });
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
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    // ── SCRAPE.DO Booking sharhlari (asosiy, Apify'siz ham ishlaydi) ──
    // Booking URL sozlangan bo'lsa, tanlangan sharhlarni 1 kreditga olamiz.
    // Apify yiqilsa ham sharhlar keladi.
    const wantBooking = !req.body?.source || ['all', 'booking'].includes(String(req.body.source).toLowerCase());
    let scrapedoBooking = 0;
    if (wantBooking) {
      try {
        const { hasScrapeDo, getBookingReviews } = await import('../services/scrapedo.service.js');
        const bUrl = req.body?.bookingUrl || flatBookingUrl(hotel.otaUrls)
          || (await findBookingUrl(hotel.name, hotel.city).catch(() => null));
        if (hasScrapeDo() && bUrl) {
          if (bUrl && !flatBookingUrl(hotel.otaUrls)) {
            await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: { ...(hotel.otaUrls || {}), 'Booking.com': bUrl } } }).catch(() => {});
          }
          const revs = await getBookingReviews(bUrl);
          const st = await persistScrapedoReviews(hotel._id, revs);
          scrapedoBooking = st.added;
        }
      } catch (err) { console.warn('Scrape.do Booking sharh xato:', err.message); }
    }

    // Apify yo'q bo'lsa ham Scrape.do Booking'dan sharh kelgan bo'lishi mumkin.
    if (!hasApify()) {
      return res.json({
        added: scrapedoBooking,
        windowDays: REVIEW_WINDOW_DAYS,
        source: 'scrapedo',
        addedBySource: scrapedoBooking ? { 'Booking.com': scrapedoBooking } : {},
        message: scrapedoBooking ? undefined : 'Booking sharhlari topilmadi (URL yo\'q yoki sahifada sharh yo\'q)',
      });
    }

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
    // Scrape.do Booking sharhlari (featured, eski sanali) purge'ga tushib
    // ketmasligi uchun — Scrape.do natija bergan bo'lsa Booking'ni tozalamaymiz.
    const useApifyBooking = doBooking && scrapedoBooking === 0;
    const purgedBySource = {};
    if (useApifyBooking) purgedBySource['Booking.com'] = await purgeOldReviews(hotel._id, 'Booking.com');
    if (doAgoda)   purgedBySource.Agoda         = await purgeOldReviews(hotel._id, 'Agoda');
    if (doExpedia) purgedBySource.Expedia       = await purgeOldReviews(hotel._id, 'Expedia');
    if (doTrip)    purgedBySource['Trip.com']   = await purgeOldReviews(hotel._id, 'Trip.com');
    if (doYandex)  purgedBySource.Yandex        = await purgeOldReviews(hotel._id, 'Yandex');

    // Apify scraper'lar maxReviews=50 bilan eng yangilarini qaytaradi;
    // persistReviews ichida 7 kunlik oynadan tashqari yotganlari tashlanadi.
    const [bookingItems, agodaItems, expediaItems, tripItems, yandexItems] = await Promise.all([
      (useApifyBooking && bookingUrl) ? getBookingReviewsApify(bookingUrl, { maxReviews: 50 }).catch((e) => { console.warn(e.message); return []; }) : Promise.resolve([]),
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

    const totalAdded = scrapedoBooking + bookingStats.added + agodaStats.added + expediaStats.added + tripStats.added + yandexStats.added;
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
    const status = err.taStatus || err.response?.status;
    if (status === 401 || status === 403) {
      const reason = err.taMessage ? ` — ${err.taMessage}` : '';
      return res.status(502).json({
        error: `TripAdvisor ${status}: kalit yoki IP/referer whitelist (VPS IP) tekshiring${reason}`,
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
