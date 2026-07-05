import Hotel from '../models/Hotel.js';
import Competitor from '../models/Competitor.js';
import User from '../models/User.js';
import PriceSnapshot from '../models/PriceSnapshot.js';
import { searchNearby } from '../services/places.service.js';
import { enrichHotelData } from '../services/hotelEnrich.service.js';
import { getSerpApiReviewsForOta, getSerpApiHotelData, hasSerpApi } from '../services/serpapi.service.js';
import {
  hasApify,
  getBookingPriceApify, getHotelsComPriceApify,
  getExpediaPriceApify, getTripComPriceApify,
  findBookingUrl, findExpediaUrl, findTripUrl,
} from '../services/apify.service.js';
import { TARGET_CHANNELS, fetchChannelFallback } from '../services/channelFallback.service.js';
import { startCollect } from '../services/onboardingCollect.service.js';
import { z } from 'zod';

const createHotelSchema = z.object({
  name: z.string().min(2),
  address: z.string().optional().default(''),
  country: z.string().optional().default(''),
  countryCode: z.string().optional().default(''),
  city: z.string().optional().default(''),
  lat: z.number().optional(),
  lng: z.number().optional(),
  googlePlaceId: z.string().optional().default(''),
  osmId: z.string().optional().default(''),
  stars: z.number().min(0).max(5).optional().default(0),
  otaChannels: z.array(z.string()).optional(),
});

// Regex maxsus belgilarini ekranlaydi (exact, case-insensitive moslik uchun).
const escapeRegex = (s) => String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function createHotel(req, res, next) {
  try {
    const data = createHotelSchema.parse(req.body);
    // Multi-hotel: bitta foydalanuvchi bir nechta TURLI hotel qo'sha oladi.
    // Lekin BIR XIL mehmonxona (nom+shahar yoki osm/place ID bo'yicha) ikki marta
    // ro'yxatdan o'tolmaydi — boshqa egasi yoki o'zi tomonidan ham.
    const dup = [];
    if (data.osmId) dup.push({ osmId: data.osmId });
    if (data.googlePlaceId) dup.push({ googlePlaceId: data.googlePlaceId });
    dup.push({
      name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'),
      city: new RegExp(`^${escapeRegex(data.city || '')}$`, 'i'),
    });

    const existing = await Hotel.findOne({ $or: dup, isActive: true });
    if (existing) {
      const mine = String(existing.userId) === String(req.user._id);
      return res.status(409).json({
        error: mine
          ? "Siz bu mehmonxonani allaqachon qo'shgansiz"
          : "Bu mehmonxona allaqachon ro'yxatdan o'tgan",
      });
    }

    const hotel = await Hotel.create({
      userId: req.user._id,
      name: data.name, address: data.address,
      country: data.country, countryCode: data.countryCode, city: data.city,
      googlePlaceId: data.googlePlaceId, osmId: data.osmId,
      stars: data.stars,
      // Onboarding: ma'lumot yig'ish darrov boshlanadi — modal "collecting"da.
      collectStatus: 'collecting',
      ...(data.otaChannels && { otaChannels: data.otaChannels }),
      ...(data.lat && data.lng && { location: { type: 'Point', coordinates: [data.lng, data.lat] } }),
    });

    await User.findByIdAndUpdate(req.user._id, {
      hotelId: hotel._id, onboardingCompleted: true,
      country: data.country || req.user.country,
      countryCode: data.countryCode || req.user.countryCode,
      city: data.city || req.user.city,
    });

    // Onboarding orkestratori — raqobatchi/narx/sharhni fonda yig'adi va
    // socket orqali jonli progress yuboradi (dashboard modal'i shuni tinglaydi).
    startCollect(hotel._id, req.user._id, { lat: data.lat, lng: data.lng });

    // Internet ma'lumotlarini fonda olib keladi (non-blocking)
    autoEnrich(hotel._id).catch((err) =>
      console.error('Avto enrichment xato:', err.message)
    );

    res.status(201).json({ hotel });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Validatsiya xatosi', details: err.flatten() });
    next(err);
  }
}

// Onboarding yig'ish holati — frontend modal birinchi yuklanishda shu bilan
// holatni biladi (socket ulanmasdan oldin), keyin socket jonli yangilaydi.
export async function getCollectStatus(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    res.json({
      status: hotel.collectStatus || 'ready',
      progress: hotel.collectProgress || {},
      collectedAt: hotel.collectedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

export async function getMyHotel(req, res, next) {
  try {
    // req.hotel resolveHotel middleware tomonidan o'rnatiladi (X-Hotel-Id
    // header yoki ?hotelId= query parametrlari orqali tanlangan hotel).
    // Eski mijozlar uchun fallback: userning birinchi hoteli.
    const hotel = req.hotel || await Hotel.findOne({ userId: req.user._id });
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    res.json({ hotel });
  } catch (err) { next(err); }
}

// GET /hotels/mine/all — userning barcha hotellarini qaytaradi (switcher uchun).
export async function listMyHotels(req, res, next) {
  try {
    const hotels = await Hotel.find({ userId: req.user._id })
      .sort({ createdAt: 1 })
      .select('name city country countryCode photoUrl stars currentPrice currency rating reviewCount');
    res.json({ hotels });
  } catch (err) { next(err); }
}

export async function updateMyHotel(req, res, next) {
  try {
    if (!req.hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    const allowed = ['name', 'address', 'stars', 'otaChannels', 'rooms', 'currentPrice', 'currency', 'otaUrls', 'xoteloHotelKey', 'makcorpsHotelId'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    // Xotelo Hotel Key'ni TripAdvisor URL'dan avtomatik ajratamiz — endi
    // foydalanuvchi key'ni qo'lda kiritmaydi. Faqat key aniq yuborilmaganda.
    if (update.xoteloHotelKey === undefined) {
      const taUrl = update.otaUrls?.TripAdvisor || req.hotel.otaUrls?.TripAdvisor || '';
      if (taUrl) {
        const { extractXoteloHotelKey } = await import('../services/xotelo.service.js');
        const key = extractXoteloHotelKey(taUrl);
        if (key) update.xoteloHotelKey = key;
      }
    }

    const hotel = await Hotel.findByIdAndUpdate(req.hotel._id, update, { new: true });
    res.json({ hotel });
  } catch (err) { next(err); }
}

async function autoEnrich(hotelId) {
  const hotel = await Hotel.findById(hotelId);
  if (!hotel) return;

  const enriched = await enrichHotelData({
    name: hotel.name,
    city: hotel.city,
    country: hotel.country,
    countryCode: hotel.countryCode,
    lat: hotel.location?.coordinates?.[1],
    lng: hotel.location?.coordinates?.[0],
  });

  const updates = {};
  if (enriched.rating > 0 && !hotel.rating) updates.rating = enriched.rating;
  if (enriched.reviewCount > 0 && !hotel.reviewCount) updates.reviewCount = enriched.reviewCount;
  if (enriched.currentPrice > 0 && !hotel.currentPrice) updates.currentPrice = enriched.currentPrice;
  if (enriched.stars > 0 && !hotel.stars) updates.stars = enriched.stars;
  if (enriched.photoUrl && !hotel.photoUrl) updates.photoUrl = enriched.photoUrl;
  if (enriched.cid && !hotel.googleCid) updates.googleCid = enriched.cid;

  if (Object.keys(updates).length) {
    await Hotel.findByIdAndUpdate(hotelId, updates);
  }
}

export async function enrichMyHotel(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const enriched = await enrichHotelData({
      name: hotel.name,
      city: hotel.city,
      country: hotel.country,
      countryCode: hotel.countryCode,
      lat: hotel.location?.coordinates?.[1],
      lng: hotel.location?.coordinates?.[0],
    });

    const updates = {};
    if (enriched.rating > 0) updates.rating = enriched.rating;
    if (enriched.reviewCount > 0) updates.reviewCount = enriched.reviewCount;
    if (enriched.currentPrice > 0) updates.currentPrice = enriched.currentPrice;
    if (enriched.stars > 0) updates.stars = enriched.stars;
    if (enriched.photoUrl) updates.photoUrl = enriched.photoUrl;
    if (enriched.cid) updates.googleCid = enriched.cid;

    const updated = await Hotel.findByIdAndUpdate(hotel._id, updates, { new: true });
    res.json({ hotel: updated, enriched });
  } catch (err) {
    next(err);
  }
}

export async function getOtaPrices(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const data = await getOtaPricesForHotel({
      name: hotel.name,
      city: hotel.city,
      countryCode: hotel.countryCode,
    });

    if (data && !data.error) {
      return res.json({ hotelName: hotel.name, ...data });
    }

    // Real ma'lumot topilmadi
    res.json({
      hotelName: hotel.name,
      lowestPrice: 0,
      otaPrices: [],
      hotel: {
        name: hotel.name,
        rating: hotel.rating,
        stars: hotel.stars,
        image: hotel.photoUrl,
      },
    });
  } catch (err) {
    next(err);
  }
}

const KNOWN_OTAS = [
  'Booking.com', 'Expedia', 'Agoda', 'Hotels.com',
  'Trip.com', 'Google Hotels', 'Priceline', 'TripAdvisor',
  'Vio.com',
];

/**
 * Real narxlardan kanal metrikalarini hisoblaydi.
 * Faqat haqiqiy ma'lumot: price, share %, trend %.
 */
async function buildChannelMetrics(hotelId, livePrices) {
  // Trend uchun 7 kun oldingi snapshot'lar
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const prevSnapshots = await PriceSnapshot.find({
    ownerHotelId: hotelId,
    targetType: 'own',
    snapshotAt: { $gte: new Date(weekAgo.getTime() - 2 * 86400_000), $lte: weekAgo },
  }).lean();
  const prevByOta = new Map();
  for (const s of prevSnapshots) {
    const cur = prevByOta.get(s.ota);
    if (!cur || s.snapshotAt > cur.snapshotAt) prevByOta.set(s.ota, s);
  }

  // (Eski 'live' snapshot saqlash logikasi olib tashlandi — har sahifa
  // ochilganda dublikat yozuv yaratib, "Mening narxim" qiymatlarining
  // sahifalar o'rtasidagi nomuvofiqligiga sabab bo'lar edi. Trend
  // ma'lumotlari real 'serpapi'/'manual' snapshot'laridan o'qiladi.)


  // Share % — narx raqobatbardoshligi asosida (past narx = ko'p ulush)
  const sumInverse = livePrices.reduce((acc, p) => acc + (p.price > 0 ? 1 / p.price : 0), 0);
  return livePrices.map((p) => {
    const sharePct = sumInverse > 0 && p.price > 0
      ? Math.round((1 / p.price / sumInverse) * 100)
      : 0;
    const prev = prevByOta.get(p.source);
    const trendPct = prev && prev.price > 0
      ? Math.round(((prev.price - p.price) / prev.price) * 100 * 10) / 10
      : 0;
    return {
      source: p.source,
      status: 'connected',
      price: p.price,
      sharePct,
      trendPct,
      currency: 'USD',
      via: p.via || null,
      link: p.link || null,
      logo: p.logo || null,
      official: Boolean(p.official),
    };
  }).sort((a, b) => a.price - b.price);
}

/**
 * POST /hotels/me/find-booking-url — Google qidiruv orqali Booking.com property URL'ni topadi.
 * Body: { autoSave?: boolean }
 */
export async function findBookingUrlEndpoint(req, res, next) {
  try {
    const hotel = await Hotel.findOne({ userId: req.user._id });
    if (!hotel) return res.status(404).json({ error: 'Mehmonxona topilmadi' });

    const ota = (req.body?.ota || 'Booking.com').trim();
    const url = ota === 'Agoda'
      ? await findAgodaUrl(hotel.name, hotel.city)
      : await findBookingUrl(hotel.name, hotel.city);

    if (!url) {
      return res.json({
        url: null,
        saved: false,
        ota,
        message: `"${hotel.name}" uchun ${ota} URL'i topilmadi. Qo'lda kiritishingiz mumkin.`,
      });
    }

    let saved = false;
    if (req.body?.autoSave) {
      // MongoDB dotted key'ni nested path deb biladi, shuning uchun butun otaUrls'ni qayta yozamiz
      const nextOtaUrls = { ...(hotel.otaUrls || {}), [ota]: url };
      await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: nextOtaUrls } });
      saved = true;
    }
    res.json({ url, saved, ota });
  } catch (err) { next(err); }
}

// Mongo'da `'otaUrls.Booking.com': url` $set qilinsa nested ob'ekt yaratiladi:
// `{Booking: {com: url}}`. Bunday eski yozuvlarni avtomatik tekislaymiz.
function normalizeOtaUrls(raw) {
  const src = raw || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && typeof v.com === 'string' && k === 'Booking') {
      out['Booking.com'] = v.com;
    } else if (v && typeof v === 'object') {
      // boshqa nested holatlar bo'lsa, faqat string maydonlarni olamiz
      for (const [sk, sv] of Object.entries(v)) {
        if (typeof sv === 'string') out[`${k}.${sk}`] = sv;
      }
    }
  }
  return out;
}

export async function getOtaChannels(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    // Kanal narxlari faqat Apify (PriceSnapshot keshidan) + qo'lda kiritilgan narxlardan.
    // SerpAPI/Xotelo bu sahifada ishlatilmaydi — SerpAPI faqat Google sharhlari uchun,
    // Xotelo faqat /xotelo sahifasida. Foydalanuvchi
    // POST /ota-channels/fetch orqali kerakli kanalga Apify so'rov yuboradi.
    const hotelOtaUrls = normalizeOtaUrls(hotel.otaUrls);

    // Buzuq nested yozuvni bir martagina tuzatamiz
    const wasMalformed = hotel.otaUrls && JSON.stringify(hotel.otaUrls) !== JSON.stringify(hotelOtaUrls);
    if (wasMalformed) {
      await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: hotelOtaUrls } }).catch(() => {});
    }

    const prices = [];
    let source = 'none';

    // Qo'lda kiritilgan narxlar — eng ustun
    const manualSnapshots = await PriceSnapshot.find({
      ownerHotelId: hotel._id, targetType: 'own', source: 'manual',
    }).sort({ snapshotAt: -1 }).lean();
    const manualByOta = new Map();
    for (const s of manualSnapshots) {
      if (!manualByOta.has(s.ota)) manualByOta.set(s.ota, s.price);
    }
    for (const [ota, price] of manualByOta) {
      prices.push({ source: ota, price, via: 'manual' });
    }
    if (manualByOta.size) source = 'manual';

    // So'nggi 7 kun ichidagi avtomatik snapshotlar — Google Hotels qaytargan
    // BARCHA OTA partnerlari (Booking, Agoda, Bluepillow, Tiket.com …) HAMDA
    // fallback orqali (HasData/Apify) olingan kanallar. "Narxlarni yangilash"
    // (refresh-all) ham, shu sahifadagi "Hammasini olib kelish" ham shularni yozadi.
    // Hard-coded ro'yxat yo'q: snapshot'da nima saqlangan bo'lsa shuni qaytaramiz.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    const recentSnaps = await PriceSnapshot.find({
      ownerHotelId: hotel._id,
      targetType: 'own',
      // "Narxlarni yangilash" (refresh-all) SerpAPI sozlanmaganda Google Hotels
      // skreyperidan ('google_scraper') va Booking jonli skreyperidan
      // ('booking_scraper') yozadi. Ularni ham o'qimasak, yig'ilgan narxlar bu
      // sahifada ko'rinmay qoladi (bo'sh "kanal narxi yo'q" holati).
      source: { $in: ['serpapi', 'hasdata', 'apify', 'google_scraper', 'booking_scraper'] },
      snapshotAt: { $gte: sevenDaysAgo },
    }).sort({ snapshotAt: -1 }).lean();

    const latestByOta = new Map();
    const seenManual = new Set(prices.map((p) => p.source));
    for (const s of recentSnaps) {
      if (seenManual.has(s.ota)) continue; // manual narx ustunroq
      // Google aggregator — o'zi OTA emas, foydalanuvchi so'roviga ko'ra yashiriladi.
      const lower = String(s.ota || '').toLowerCase();
      if (lower === 'google' || lower === 'google hotels') continue;
      if (!latestByOta.has(s.ota)) latestByOta.set(s.ota, { price: s.price, via: s.source });
    }
    for (const [ota, v] of latestByOta) {
      if (v.price > 0) prices.push({ source: ota, price: v.price, via: v.via });
    }
    if (latestByOta.size && source === 'none') source = 'serpapi';

    // Xotelo (bepul TripAdvisor-asosli API) — agar foydalanuvchi
    // hotel.xoteloHotelKey saqlagan bo'lsa, jonli narxlarni olamiz.
    const xoteloConfigured = Boolean(hotel.xoteloHotelKey);
    if (xoteloConfigured) {
      try {
        const { getXoteloRatesForHotel } = await import('../services/xotelo.service.js');
        const xoteloData = await getXoteloRatesForHotel({ hotelKey: hotel.xoteloHotelKey });
        if (xoteloData?.rates?.length) {
          const seenSources = new Set(prices.map((p) => p.source));
          for (const r of xoteloData.rates) {
            // Xotelo natijasi serpapi/manual'dan ustun emas — faqat to'ldiruvchi
            if (seenSources.has(r.source)) continue;
            prices.push({ source: r.source, price: r.price, via: 'xotelo' });
          }
          if (source === 'none') source = 'xotelo';
        }
      } catch (err) {
        console.warn('Xotelo fetch xato:', err.message);
      }
    }

    const channels = await buildChannelMetrics(hotel._id, prices);

    res.json({
      hotel: { name: hotel.name, stars: hotel.stars, rating: hotel.rating, photo: hotel.photoUrl },
      source,
      providers: {
        serpapi: { configured: hasSerpApi() },
        apify: {
          configured: hasApify(),
          bookingUrl: hotelOtaUrls['Booking.com'] || hotelOtaUrls.Booking || null,
        },
        xotelo: {
          configured: xoteloConfigured,
          hotelKey: hotel.xoteloHotelKey || null,
        },
      },
      channels,
      asOf: new Date().toISOString(),
    });
  } catch (err) { next(err); }
}

/**
 * GET /hotels/me/xotelo-rates
 * Xotelo sahifasi uchun maxsus endpoint — to'g'ridan-to'g'ri Xotelo bepul
 * API'dan narxlarni oladi (getOtaChannels'dagi SerpAPI/manual dedupe'ga
 * tushmaydi). Key hotel.xoteloHotelKey'dan yoki TripAdvisor URL'dan olinadi.
 */
export async function getHotelXoteloRates(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const { getXoteloMergedRates, extractXoteloHotelKey } = await import('../services/xotelo.service.js');

    const taUrl = hotel.otaUrls?.TripAdvisor || hotel.tripAdvisorUrl || '';
    const hotelKey = hotel.xoteloHotelKey || extractXoteloHotelKey(taUrl);

    if (!hotelKey) {
      return res.json({ configured: false, hotelKey: null, channels: [], asOf: new Date().toISOString() });
    }

    // Bir nechta yaqin sanani tekshirib, ULANGAN BARCHA kanallarni yig'amiz.
    let xoteloData = null;
    try {
      xoteloData = await getXoteloMergedRates({ hotelKey, tripAdvisorUrl: taUrl });
    } catch (err) {
      console.warn('Xotelo rates xato:', err.message);
    }

    const channels = (xoteloData?.rates || [])
      .filter((r) => r.price > 0)
      .map((r) => ({ source: r.source, price: r.price, via: 'xotelo', currency: 'USD', checkIn: r.checkIn || null }))
      .sort((a, b) => a.price - b.price);

    // Narxlarni 'own' snapshot sifatida saqlaymiz — Rate Shopper o'z narxni
    // kanal bo'yicha shu yerdan ham oladi (SerpAPI ishlatilmagan bo'lsa ham).
    // Har kanal o'z tekshiruv sanasi (ertaga/indin) bilan saqlanadi.
    for (const ch of channels) {
      const checkIn = ch.checkIn ? new Date(ch.checkIn) : new Date();
      const checkOut = new Date(checkIn);
      checkOut.setDate(checkOut.getDate() + 1);
      await PriceSnapshot.create({
        targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
        ota: ch.source, price: ch.price, currency: 'USD',
        checkIn, checkOut, source: 'xotelo',
      }).catch(() => {});
    }

    res.json({
      configured: true,
      hotelKey,
      channels,
      asOf: new Date().toISOString(),
    });
  } catch (err) { next(err); }
}

/**
 * Bitta raqib uchun Xotelo narxini oladi (kerak bo'lsa TripAdvisor URL'ni
 * DuckDuckGo'dan topadi, kalitni saqlaydi). Eng arzon narxni qaytaradi.
 * instantSnapshot ichida parallel ishlatiladi.
 */
async function fetchOneCompetitorXotelo(competitor, city) {
  // Yaqinda (< 2 daqiqa) narx olingan bo'lsa — masalan skreyper discovery'da —
  // qayta skreyp/Xotelo qilmaymiz, keshlangan narxni qaytaramiz.
  if (
    competitor.lastPriceFetchedAt &&
    Date.now() - new Date(competitor.lastPriceFetchedAt).getTime() < 2 * 60 * 1000 &&
    competitor.latestPrices?.size
  ) {
    const prices = [...competitor.latestPrices.values()].filter((p) => p > 0);
    if (prices.length) return { best: Math.min(...prices), count: prices.length };
  }

  const { findTripAdvisorUrl, getXoteloRates, extractXoteloHotelKey } =
    await import('../services/xotelo.service.js');

  let key = extractXoteloHotelKey(competitor.tripAdvisorUrl);
  if (!key) {
    const url = await findTripAdvisorUrl(competitor.name, city).catch(() => null);
    if (url) {
      key = extractXoteloHotelKey(url);
      competitor.tripAdvisorUrl = url;
    }
  }
  if (!key) {
    competitor.lastPriceFetchedAt = new Date();
    await competitor.save().catch(() => {});
    return null;
  }

  const data = await getXoteloRates(key).catch(() => null);
  const rates = (data?.rates || []).filter((r) => r.price > 0);
  if (!rates.length) {
    // Xotelo bu raqib uchun narx topmadi — Booking.com JONLI SKREYPER fallback.
    try {
      const { scraperEnabled, scraperPriceForHotel } = await import('../services/hotelScraper.service.js');
      if (scraperEnabled()) {
        const sp = await scraperPriceForHotel(competitor.name, city);
        if (sp?.price > 0) {
          if (!competitor.latestPrices) competitor.latestPrices = new Map();
          competitor.latestPrices.set('bookingcom', sp.price);
          competitor.lastPriceFetchedAt = new Date();
          await competitor.save().catch(() => {});

          const ci = new Date(); ci.setDate(ci.getDate() + 7);
          const co = new Date(ci); co.setDate(co.getDate() + 1);
          await PriceSnapshot.create({
            targetType: 'competitor', targetId: competitor._id, ownerHotelId: competitor.ownerHotelId,
            ota: 'Booking.com', price: sp.price, currency: 'USD', checkIn: ci, checkOut: co, source: 'booking_scraper',
          }).catch(() => {});

          return { best: sp.price, count: 1 };
        }
      }
    } catch (err) { console.warn('[snapshot] skreyper raqib narx xato:', err.message); }

    competitor.lastPriceFetchedAt = new Date();
    await competitor.save().catch(() => {});
    return null;
  }

  if (!competitor.latestPrices) competitor.latestPrices = new Map();
  for (const r of rates) {
    const k = r.source.toLowerCase().replace(/[^a-z0-9]/g, '');
    competitor.latestPrices.set(k, r.price);
  }
  competitor.lastPriceFetchedAt = new Date();
  await competitor.save().catch(() => {});

  // Trend uchun snapshot
  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 7);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);
  for (const r of rates) {
    await PriceSnapshot.create({
      targetType: 'competitor', targetId: competitor._id, ownerHotelId: competitor.ownerHotelId,
      ota: r.source, price: r.price, currency: 'USD', checkIn, checkOut, source: 'xotelo',
    }).catch(() => {});
  }

  const best = Math.min(...rates.map((r) => r.price));
  return { best, count: rates.length };
}

/**
 * POST /hotels/me/instant-snapshot
 *
 * "Aha moment" — bitta so'rovda, BEPUL Xotelo (TripAdvisor → 8+ OTA) orqali:
 *   1. O'z mehmonxonam narxini oladi (kalit yo'q bo'lsa nom+shahar bo'yicha topadi).
 *   2. Raqiblar yo'q bo'lsa atrofdagilarni avtomatik topadi.
 *   3. Har bir raqib narxini oladi (parallel).
 *   4. Bozordagi o'rnim, o'rtacha narx, farq va taxminiy yo'qotishni hisoblaydi.
 *
 * Hech qanday pullik API ishlatilmaydi.
 */
// Qayta ishlatiladigan yadro — HTTP handler ham, onboarding orkestratori ham
// shu funksiyani chaqiradi (o'z kanallar + raqib topish + raqib narxlari +
// PriceSnapshot yozish). `hotel` to'liq hujjat bo'lishi kerak.
export async function runInstantSnapshot(hotel) {
    const { getXoteloMergedRates, extractXoteloHotelKey, searchXoteloHotel } =
      await import('../services/xotelo.service.js');

    // ── 1. O'Z MEHMONXONAM ─────────────────────────────────────────────
    const taUrl = hotel.otaUrls?.TripAdvisor || hotel.tripAdvisorUrl || '';
    let ownKey = hotel.xoteloHotelKey || extractXoteloHotelKey(taUrl);
    if (!ownKey) {
      ownKey = await searchXoteloHotel(hotel.name, hotel.city).catch(() => null);
      if (ownKey) {
        hotel.xoteloHotelKey = ownKey;
        await hotel.save().catch(() => {});
      }
    }

    let ownChannels = [];
    if (ownKey) {
      const data = await getXoteloMergedRates({ hotelKey: ownKey, tripAdvisorUrl: taUrl }).catch(() => null);
      ownChannels = (data?.rates || [])
        .filter((r) => r.price > 0)
        .map((r) => ({ source: r.source, price: r.price, checkIn: r.checkIn || null }))
        .sort((a, b) => a.price - b.price);

      for (const ch of ownChannels) {
        const ci = ch.checkIn ? new Date(ch.checkIn) : new Date();
        const co = new Date(ci); co.setDate(co.getDate() + 1);
        await PriceSnapshot.create({
          targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
          ota: ch.source, price: ch.price, currency: 'USD', checkIn: ci, checkOut: co, source: 'xotelo',
        }).catch(() => {});
      }
    }

    // Xotelo o'z narxni topmasa — Booking.com JONLI SKREYPER fallback.
    if (!ownChannels.length) {
      try {
        const { scraperEnabled, scraperPriceForHotel } = await import('../services/hotelScraper.service.js');
        if (scraperEnabled()) {
          const sp = await scraperPriceForHotel(hotel.name, hotel.city);
          if (sp?.price > 0) {
            ownChannels = [{ source: 'Booking.com', price: sp.price, checkIn: null }];
            const ci = new Date();
            const co = new Date(ci); co.setDate(co.getDate() + 1);
            await PriceSnapshot.create({
              targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
              ota: 'Booking.com', price: sp.price, currency: 'USD',
              checkIn: ci, checkOut: co, source: 'booking_scraper',
            }).catch(() => {});
          }
        }
      } catch (err) { console.warn('[snapshot] skreyper own narx xato:', err.message); }
    }

    const myBest = ownChannels.length ? ownChannels[0].price : (hotel.currentPrice || 0);

    // ── 2. RAQIBLAR (yo'q bo'lsa avtomatik topamiz) ────────────────────
    let competitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true });
    if (!competitors.length) {
      const coords = hotel.location?.coordinates || [];
      const lng = coords[0], lat = coords[1];
      // 2a. Google Places / OSM — koordinata bo'yicha yaqin atrofdan.
      if (lat && lng) {
        await autoFindCompetitors(hotel._id, lat, lng).catch(() => {});
        competitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true });
      }
      // 2b. Booking.com SKREYPER fallback — yuqoridagilar topmasa (yoki koordinata
      //     yo'q bo'lsa) shahar bo'yicha eng mashhur 5 hotelni narxi bilan topadi.
      if (!competitors.length) {
        competitors = await discoverCompetitorsViaScraper(hotel).catch(() => []);
      }
    }

    const targets = competitors.slice(0, AUTO_DISCOVERY_LIMIT);
    const settled = await Promise.allSettled(
      targets.map((c) => fetchOneCompetitorXotelo(c, hotel.city)),
    );
    const competitorSummaries = targets.map((c, i) => {
      const r = settled[i];
      const best = r.status === 'fulfilled' && r.value ? r.value.best : null;
      return { id: c._id, name: c.name, bestPrice: best };
    });

    // ── 3. XULOSA ──────────────────────────────────────────────────────
    const compPrices = competitorSummaries.map((c) => c.bestPrice).filter((p) => p > 0);
    const marketAvg = compPrices.length
      ? Math.round(compPrices.reduce((a, b) => a + b, 0) / compPrices.length)
      : 0;
    const cheapest = compPrices.length ? Math.min(...compPrices) : 0;

    const ranked = [myBest, ...compPrices].filter((p) => p > 0).sort((a, b) => a - b);
    const position = myBest > 0 ? ranked.indexOf(myBest) + 1 : 0;
    const total = ranked.length;
    const gapPct = myBest > 0 && marketAvg > 0
      ? Math.round(((myBest - marketAvg) / marketAvg) * 100)
      : 0;

    // Taxminiy oylik yo'qotish (faqat o'z narxim bozordan qimmat bo'lsa):
    // (narx farqi) × xona soni × 30 kun × 20% (taxminiy band bo'lmay qolish ulushi).
    const roomsCount = hotel.rooms > 0 ? hotel.rooms : 10;
    const estMonthlyLossUSD = gapPct > 0 && marketAvg > 0
      ? Math.round((myBest - marketAvg) * roomsCount * 30 * 0.2)
      : 0;

    return {
      own: { bestPrice: myBest, channels: ownChannels, hotelKey: ownKey || null },
      competitors: competitorSummaries,
      summary: {
        marketAvg, cheapest, position, total, gapPct,
        estMonthlyLossUSD, currency: 'USD',
        competitorsCount: compPrices.length,
      },
      asOf: new Date().toISOString(),
    };
}

export async function instantSnapshot(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    res.json(await runInstantSnapshot(hotel));
  } catch (err) { next(err); }
}

/**
 * GET /hotels/me/category-ratings
 * Mening hotelimning Booking.com kategoriya subscore'lari (Cleanliness,
 * Location, Staff, Comfort, Facilities, Value). HasData Place API'dan olinadi
 * va 14 kun keshlanadi (kredit tejaladi). ?refresh=true — majburiy yangilash.
 */
const CATEGORY_FRESH_MS = 14 * 86400_000;
const CATEGORY_ORDER = ['Location', 'Cleanliness', 'Staff', 'Comfort', 'Facilities', 'Value for money', 'Free Wifi'];

function categoriesToArray(scores = {}) {
  const keys = Object.keys(scores);
  keys.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return keys.map((label) => ({ label, value: scores[label] }));
}

export async function getMyCategoryRatings(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const refresh = req.query.refresh === 'true';
    const cached = hotel.categoryRatings?.scores && Object.keys(hotel.categoryRatings.scores).length;
    const isFresh = hotel.categoryRatingsAt &&
      (Date.now() - new Date(hotel.categoryRatingsAt).getTime() < CATEGORY_FRESH_MS);

    // Yangi kerak emas — keshdan qaytaramiz (kreditsiz).
    if (cached && isFresh && !refresh) {
      return res.json({
        configured: true,
        overall: hotel.categoryRatings.overall || 0,
        categories: categoriesToArray(hotel.categoryRatings.scores),
        asOf: hotel.categoryRatingsAt,
        cached: true,
      });
    }

    const fallback = () => res.json({
      configured: Boolean(cached),
      overall: hotel.categoryRatings?.overall || 0,
      categories: cached ? categoriesToArray(hotel.categoryRatings.scores) : [],
      asOf: hotel.categoryRatingsAt || null,
    });

    let data = null;

    // 1) HasData (kalit bo'lsa) — Booking URL bilan.
    const { getBookingCategoryRatings, hasHasData } = await import('../services/hasdata.service.js');
    if (hasHasData()) {
      let bookingUrl = hotel.otaUrls?.['Booking.com'] || hotel.otaUrls?.Booking || '';
      if (!bookingUrl) {
        try { bookingUrl = await findBookingUrl(hotel.name, hotel.city); } catch { bookingUrl = ''; }
        if (bookingUrl) {
          const nextOtaUrls = { ...(hotel.otaUrls || {}), 'Booking.com': bookingUrl };
          await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: nextOtaUrls } }).catch(() => {});
        }
      }
      if (bookingUrl) {
        try { data = await getBookingCategoryRatings({ bookingUrl }); }
        catch (err) { console.warn('Category ratings (hasdata) xato:', err.message); }
      }
    }

    // 2) JONLI SKREYPER fallback — HasData yo'q yoki natija bermadi. Booking
    //    URL'ni o'zi topadi (kalit/sozlama kerak emas).
    if (!data?.scores || !Object.keys(data.scores).length) {
      try {
        const { scraperEnabled, scraperCategoryRatings } = await import('../services/hotelScraper.service.js');
        if (scraperEnabled()) {
          const sc = await scraperCategoryRatings(hotel.name, hotel.city);
          if (sc?.scores && Object.keys(sc.scores).length) {
            data = { overall: sc.overall, scores: sc.scores };
            if (sc.bookingUrl && !(hotel.otaUrls?.['Booking.com'])) {
              const nextOtaUrls = { ...(hotel.otaUrls || {}), 'Booking.com': sc.bookingUrl };
              await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: nextOtaUrls } }).catch(() => {});
            }
          }
        }
      } catch (err) { console.warn('Category ratings (scraper) xato:', err.message); }
    }

    if (!data?.scores || !Object.keys(data.scores).length) {
      if (cached) return fallback();
      return res.json({ configured: false, categories: [], reason: 'no_data' });
    }

    const now = new Date();
    await Hotel.updateOne(
      { _id: hotel._id },
      { $set: { categoryRatings: { overall: data.overall || 0, scores: data.scores }, categoryRatingsAt: now } },
    ).catch(() => {});

    res.json({
      configured: true,
      overall: data.overall || 0,
      categories: categoriesToArray(data.scores),
      asOf: now,
      cached: false,
    });
  } catch (err) { next(err); }
}

/**
 * POST /hotels/me/ota-channels/fetch-all
 * SerpAPI google_hotels orqali BITTA so'rovda barcha OTA narxlarini oladi.
 * Booking, Agoda, Hotels.com, Expedia, Trip.com, Priceline, Vio.com, eDreams …
 * Har biri PriceSnapshot sifatida saqlanadi (Rate Shopper jadvali uchun).
 */
export async function fetchAllOtaChannels(req, res, next) {
  try {
    if (!hasSerpApi()) return res.status(503).json({ error: 'SERPAPI_API_KEY sozlanmagan' });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const data = await getSerpApiHotelData({
      name: hotel.name,
      city: hotel.city,
      countryCode: hotel.countryCode,
      propertyToken: hotel.serpPropertyToken || '',
    });


    // Property token saqlash (sharhlar uchun keyinchalik foydali)
    if (data?.propertyToken && !hotel.serpPropertyToken) {
      hotel.serpPropertyToken = data.propertyToken;
      await hotel.save().catch(() => {});
    }

    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const ciStr = checkIn.toISOString().slice(0, 10);
    const coStr = checkOut.toISOString().slice(0, 10);

    const resolvedCurrency = data?.currency || 'USD';

    const canonLabel = (src) => {
      const lower = String(src).toLowerCase();
      const t = TARGET_CHANNELS.find((c) => c.aliases.includes(lower));
      return t ? t.label : src;
    };

    // 1) SerpAPI bergan kanallar (Google aggregator chiqarib tashlanadi).
    const serpOtas = (data?.otaPrices || []).filter((o) => {
      if (!o.source || !(o.price > 0)) return false;
      const lower = String(o.source).toLowerCase();
      return lower !== 'google' && lower !== 'google hotels';
    });

    const saved = [];
    const collected = new Map(); // label -> true (dublikatlarni oldini olish)
    for (const ota of serpOtas) {
      try {
        await PriceSnapshot.create({
          targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
          ota: ota.source, price: ota.price, currency: ota.currency || resolvedCurrency,
          checkIn, checkOut, source: 'serpapi',
          raw: { priceType: ota.priceType, link: ota.link, official: ota.official },
        });
        saved.push({
          source: ota.source, price: ota.price, priceType: ota.priceType,
          link: ota.link, logo: ota.logo, official: ota.official, via: 'serpapi',
        });
        collected.set(canonLabel(ota.source), true);
      } catch {}
    }

    // 2) Waterfall fallback — SerpAPI bermagan 5 kanalni HasData/Apify orqali to'ldiramiz.
    //    Shu sabab SerpAPI mehmonxonani topmasa ham kanallar bo'sh qolmaydi.
    const persist = async (key, url) => {
      if (!url) return;
      const merged = { ...(hotel.otaUrls || {}), [key]: url };
      hotel.otaUrls = merged;
      await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: merged } }).catch(() => {});
    };
    const target = { name: hotel.name, city: hotel.city, otaUrls: hotel.otaUrls || {}, persist };
    const missing = TARGET_CHANNELS.filter((c) => !collected.has(c.label) && c.label !== 'Agoda');
    const fbResults = await Promise.all(
      missing.map(async (c) => ({ label: c.label, res: await fetchChannelFallback(target, c.label, ciStr, coStr) }))
    );
    for (const { label, res: fb } of fbResults) {
      if (!fb?.price) continue;
      try {
        await PriceSnapshot.create({
          targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
          ota: label, price: fb.price, currency: fb.currency || 'USD',
          checkIn, checkOut, source: fb.via,
          raw: { link: fb.link, via: fb.via },
        });
      } catch {}
      saved.push({ source: label, price: fb.price, link: fb.link, via: fb.via });
      collected.set(label, true);
    }

    // SerpAPI ham, fallback ham hech narsa topmasa — 422.
    if (!saved.length) {
      return res.status(422).json({
        error: 'Bu mehmonxona uchun hech qaysi kanaldan narx topilmadi',
        hint: 'no_data',
      });
    }

    // "Mening narxim" — Booking.com narxi (yoki eng arzon kanal fallback sifatida).
    const booking = saved.find((o) => {
      const lower = String(o.source).toLowerCase();
      return lower === 'booking.com' || lower === 'booking';
    });
    const myPrice = booking?.price || Math.min(...saved.map((o) => o.price));
    if (myPrice > 0) {
      await Hotel.updateOne(
        { _id: hotel._id },
        { $set: { currentPrice: myPrice, currency: resolvedCurrency } }
      ).catch(() => {});
    }

    res.json({
      provider: 'serpapi',
      hotelName: data?.name || hotel.name,
      lowestPrice: data?.lowestPrice || 0,
      channels: saved.length,
      otaPrices: saved,
    });
  } catch (err) { next(err); }
}

/**
 * POST /me/ota-channels/fetch
 * Body: { source: 'booking' | 'hotels' | 'expedia' | 'trip' }
 * Faqat tanlangan kanalga Apify so'rovi yuboradi va PriceSnapshot saqlaydi.
 * Foydalanuvchi har bir kanalni alohida bosib oladi (sahifa kirganda emas).
 */
export async function fetchOtaChannel(req, res, next) {
  try {
    if (!hasApify()) return res.status(503).json({ error: 'APIFY_API_KEY sozlanmagan' });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const source = String(req.body?.source || '').toLowerCase();

    const SOURCES = {
      booking: { fn: getBookingPriceApify, urlKey: 'Booking.com', urlArg: 'bookingUrl', finder: findBookingUrl, label: 'Booking.com' },
      hotels:  { fn: getHotelsComPriceApify, urlKey: 'Hotels.com', urlArg: 'hotelsUrl', finder: null, label: 'Hotels.com' },
      expedia: { fn: getExpediaPriceApify, urlKey: 'Expedia', urlArg: 'expediaUrl', finder: findExpediaUrl, label: 'Expedia' },
      trip:    { fn: getTripComPriceApify, urlKey: 'Trip.com', urlArg: 'tripUrl', finder: findTripUrl, label: 'Trip.com' },
    };
    const cfg = SOURCES[source];
    if (!cfg) return res.status(400).json({ error: `Noma'lum source: ${source}` });

    const hotelOtaUrls = normalizeOtaUrls(hotel.otaUrls);
    let url = hotelOtaUrls[cfg.urlKey] || null;

    // URL yo'q bo'lsa — avtomatik topishga harakat qilamiz
    if (!url && cfg.finder) {
      url = await cfg.finder(hotel.name, hotel.city);
      if (url) {
        await Hotel.updateOne(
          { _id: hotel._id },
          { $set: { [`otaUrls.${cfg.urlKey}`]: url } }
        ).catch(() => {});
      }
    }

    if (!url) {
      return res.status(404).json({
        error: `${cfg.label} URL topilmadi. Sozlamalarda qo'shing.`,
      });
    }

    const result = await cfg.fn(hotel.name, hotel.city, { [cfg.urlArg]: url });
    if (!result?.price) {
      return res.json({
        source: cfg.label,
        price: 0,
        url,
        message: `${cfg.label}'dan narx kelmadi`,
      });
    }

    // PriceSnapshot saqlash — keyingi safar lite rejimida ham ko'rinadi
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);

    await PriceSnapshot.create({
      targetType: 'own',
      targetId: hotel._id,
      ownerHotelId: hotel._id,
      ota: cfg.label,
      price: result.price,
      currency: 'USD',
      checkIn,
      checkOut,
      source: 'apify',
    }).catch(() => {});

    res.json({
      source: cfg.label,
      price: result.price,
      url,
      via: 'apify',
      link: result.link || url,
    });
  } catch (err) { next(err); }
}

export async function setOtaChannelPrice(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    const ota = decodeURIComponent(req.params.source);
    const price = Number(req.body?.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Narx noto\'g\'ri' });
    }

    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);

    if (price === 0) {
      // 0 — qo'lda kiritilganni o'chirish
      await PriceSnapshot.deleteMany({
        ownerHotelId: hotel._id, targetType: 'own', ota, source: 'manual',
      });
      return res.json({ ota, price: 0, cleared: true });
    }

    const snap = await PriceSnapshot.create({
      targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
      ota, price, currency: 'USD', checkIn, checkOut, source: 'manual',
    });
    res.json({ ota, price: snap.price });
  } catch (err) { next(err); }
}

export async function getOtaChannelDetail(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    const ota = decodeURIComponent(req.params.source);

    // Oxirgi 30 kun trend
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
    const [snapshots, Review] = await Promise.all([
      PriceSnapshot.find({
        ownerHotelId: hotel._id, targetType: 'own', ota,
        snapshotAt: { $gte: thirtyDaysAgo },
      }).sort({ snapshotAt: 1 }).lean(),
      import('../models/Review.js').then((m) => m.default),
    ]);

    // Kun bo'yicha guruhlash (eng so'nggi narx kun uchun)
    const byDay = new Map();
    for (const s of snapshots) {
      const day = new Date(s.snapshotAt).toISOString().slice(0, 10);
      const cur = byDay.get(day);
      if (!cur || s.snapshotAt > cur.snapshotAt) byDay.set(day, s);
    }
    const trend = Array.from(byDay.entries())
      .map(([day, s]) => ({ date: day, price: s.price }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Ushbu OTA kanali uchun sharhlar:
    // 1) SerpAPI'dan live olish (Google Hotels barcha OTA sharhlarini aggregatsiya qiladi —
    //    har bir review'da `source` maydoni: Booking.com, Agoda, Hotels.com, Expedia, TripAdvisor …)
    // 2) DB dan saqlangan platform=ota sharhlar
    // 3) Hech narsa topilmasa — Google sharhlar (fallback)

    let serpReviews = [];
    let serpStats = null;
    if (hasSerpApi() && hotel.serpPropertyToken) {
      try {
        const serpData = await getSerpApiReviewsForOta({
          propertyToken: hotel.serpPropertyToken,
          otaName: ota,
          maxPages: 2,
        });
        if (serpData?.reviews?.length) {
          serpReviews = serpData.reviews.slice(0, 8).map((r) => ({
            _id: `serp-${r.source}-${r.author}-${r.date}`,
            author: r.author,
            rating: r.rating,
            text: r.text,
            sentiment: r.rating >= 4 ? 'positive' : r.rating <= 2 ? 'negative' : 'neutral',
            platform: r.source,
            publishedAt: parseSerpDate(r.date),
            link: r.link,
          }));
          serpStats = {
            avg: Math.round((serpReviews.reduce((a, r) => a + r.rating, 0) / serpReviews.length) * 10) / 10,
            total: serpData.totalReviews || serpReviews.length,
            positive: serpReviews.filter((r) => r.sentiment === 'positive').length,
            negative: serpReviews.filter((r) => r.sentiment === 'negative').length,
            fromChannel: true,
            availableSources: serpData.allSources,
          };
        }
      } catch (err) {
        console.warn('SerpAPI reviews uchun OTA xato:', err.message);
      }
    }

    let dbChannelReviews = [];
    let dbGoogleReviews = [];
    if (!serpReviews.length) {
      [dbChannelReviews, dbGoogleReviews] = await Promise.all([
        Review.find({
          ownerHotelId: hotel._id,
          targetType: 'own',
          platform: ota,
        }).sort({ publishedAt: -1 }).limit(5).lean(),
        Review.find({
          ownerHotelId: hotel._id,
          targetType: 'own',
          platform: 'Google',
        }).sort({ publishedAt: -1 }).limit(5).lean(),
      ]);
    }

    const dbSource = dbChannelReviews.length ? dbChannelReviews : dbGoogleReviews;
    const reviews = serpReviews.length
      ? serpReviews
      : dbSource.map((r) => ({
          _id: r._id,
          author: r.author,
          rating: r.rating,
          text: r.text,
          sentiment: r.sentiment,
          platform: r.platform,
          publishedAt: r.publishedAt,
        }));

    const reviewStats = serpStats
      ? serpStats
      : dbSource.length
        ? {
            avg: Math.round((dbSource.reduce((a, r) => a + r.rating, 0) / dbSource.length) * 10) / 10,
            total: dbSource.length,
            positive: dbSource.filter((r) => r.sentiment === 'positive').length,
            negative: dbSource.filter((r) => r.sentiment === 'negative').length,
            fromChannel: dbChannelReviews.length > 0,
          }
        : null;

    res.json({
      ota,
      status: trend.length ? 'connected' : 'disconnected',
      trend,
      summary: trend.length
        ? {
            avg: Math.round(trend.reduce((a, b) => a + b.price, 0) / trend.length),
            min: Math.min(...trend.map((t) => t.price)),
            max: Math.max(...trend.map((t) => t.price)),
            last: trend[trend.length - 1]?.price || 0,
          }
        : null,
      reviews,
      reviewStats,
    });
  } catch (err) { next(err); }
}

// Auto-discovery: mehmonxona atrofidagi 300 metr ichidagi eng yaqin
// mehmonxonalarni raqib sifatida oladi. Faqat masofa muhim — yulduz darajasidan
// qat'i nazar yonidagilarni oladi. Ko'proq kerak bo'lsa foydalanuvchi qo'lda qo'shadi.
const AUTO_DISCOVERY_LIMIT = 5;
const AUTO_DISCOVERY_RADIUS_KM = 0.3;

/**
 * GET /hotels/discover-nearby?lat=&lng=&radius=2
 *
 * Berilgan koordinatadan radius ichidagi barcha mehmonxonalarni topadi
 * (Google Places yoki OSM). Foydalanuvchi xaritadan biror joyni bosgach,
 * o'sha joydan atrofdagi hotellarni ko'rib, raqib sifatida qo'shishi mumkin.
 */
export async function discoverNearbyHotels(req, res, next) {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = Math.min(10, Math.max(0.2, parseFloat(req.query.radius) || 2));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat va lng zarur' });
    }

    const nearby = await searchNearby([lng, lat], radius);

    // Allaqachon qo'shilgan raqiblarni va o'z hotelni belgilab qaytaramiz —
    // frontend ularni boshqacha rangda ko'rsatishi mumkin.
    const myHotel = req.hotel;
    let existingPlaceIds = new Set();
    let existingNames = new Set();
    if (myHotel) {
      const existing = await Competitor.find({
        ownerHotelId: myHotel._id, isActive: true,
      }).select('googlePlaceId name');
      for (const c of existing) {
        if (c.googlePlaceId) existingPlaceIds.add(c.googlePlaceId);
        if (c.name) existingNames.add(c.name.trim().toLowerCase());
      }
    }

    const results = nearby.map((h) => ({
      placeId: h.placeId || '',
      osmId: h.osmId || '',
      name: h.name,
      address: h.address || '',
      lat: h.lat,
      lng: h.lng,
      rating: h.rating || 0,
      reviewCount: h.reviews || 0,
      source: h.source,
      isOwn: myHotel && h.name?.trim().toLowerCase() === myHotel.name?.trim().toLowerCase(),
      isAdded: existingPlaceIds.has(h.placeId) ||
        existingNames.has((h.name || '').trim().toLowerCase()),
    }));

    res.json({ hotels: results, center: { lat, lng }, radius });
  } catch (err) { next(err); }
}

export async function autoFindCompetitors(hotelId, lat, lng) {
  const nearby = await searchNearby([lng, lat], AUTO_DISCOVERY_RADIUS_KM);
  const myHotel = await Hotel.findById(hotelId);
  if (!myHotel) return;

  const dismissed = new Set(myHotel.dismissedCompetitors || []);
  const filtered = nearby.filter(
    (h) => h.name && h.name !== myHotel.name && !dismissed.has(nameSlug(h.name)),
  );

  // Faqat masofa bo'yicha — eng yaqin mehmonxonalarni oldinga.
  // Radius ichidagilarni aniq masofa bo'yicha kesib, eng yaqin LIMIT tasini olamiz.
  const selected = filtered
    .map((h) => ({ hotel: h, distanceKm: haversine(lat, lng, h.lat, h.lng) }))
    .filter((r) => r.distanceKm <= AUTO_DISCOVERY_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, AUTO_DISCOVERY_LIMIT);

  const competitors = selected.map(({ hotel: h, distanceKm: dKm }) => ({
    ownerHotelId: hotelId,
    name: h.name, address: h.address || '',
    googlePlaceId: h.placeId || h.osmId || stablePlaceKey(h), osmId: h.osmId || '',
    stars: h.stars || 0, rating: h.rating || 0, reviewCount: h.reviews || 0,
    location: { type: 'Point', coordinates: [h.lng, h.lat] },
    distanceKm: dKm,
    autoAdded: true,
  }));

  if (competitors.length) {
    try { await Competitor.insertMany(competitors, { ordered: false }); } catch {}
  }
}

// Nomdan barqaror slug — skreyper raqobatchilari uchun dedup kaliti (googlePlaceId).
function nameSlug(s) {
  return String(s)
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * RAQOBATCHI TOPISH — Booking.com JONLI SKREYPER orqali (Google/OSM fallback).
 * Shahar bo'yicha eng mashhur hotellarni topadi, narxi BILAN (bir so'rovda) va
 * Competitor sifatida saqlaydi. Koordinata yo'q hotellar uchun ham ishlaydi.
 * @returns {Promise<Array>} saqlangan Competitor hujjatlari
 */
async function discoverCompetitorsViaScraper(hotel) {
  const { scraperEnabled, scraperDiscoverCity } = await import('../services/hotelScraper.service.js');
  if (!scraperEnabled() || !hotel.city) return [];

  const found = await scraperDiscoverCity(hotel.city, hotel.name, AUTO_DISCOVERY_LIMIT).catch(() => []);
  if (!found.length) return [];

  // Foydalanuvchi o'chirgan raqiblarni qayta qo'shmaymiz.
  const dismissed = new Set(hotel.dismissedCompetitors || []);
  const fresh = found.filter((h) => h.name && !dismissed.has(nameSlug(h.name)));
  if (!fresh.length) return [];

  // Scraper (Google Hotels/Booking) koordinata bermaydi — xaritada ko'rinishi
  // uchun geocode bilan to'ldiramiz (nom + shahar bo'yicha). Parallel, ixtiyoriy.
  try {
    const { geocodeHotel } = await import('../services/hotelScraper.service.js');
    await Promise.all(
      fresh.map(async (h) => {
        if (Number(h.lat) && Number(h.lng)) return; // allaqachon bor
        const geo = await geocodeHotel({ name: h.name, city: hotel.city }).catch(() => null);
        if (geo) { h.lat = geo.lat; h.lng = geo.lng; }
      }),
    );
  } catch { /* geocode ixtiyoriy — koordinatasiz ham saqlayveramiz */ }

  const docs = fresh.map((h) => ({
    ownerHotelId: hotel._id,
    name: h.name,
    address: h.address || hotel.city,
    googlePlaceId: `booking:${nameSlug(h.name)}`,
    bookingUrl: h.bookingUrl || '',
    stars: h.stars || 0,
    rating: h.rating || 0,
    reviewCount: h.reviews || 0,
    photoUrl: h.photoUrl || '',
    location: { type: 'Point', coordinates: [Number(h.lng) || 0, Number(h.lat) || 0] },
    latestPrices: h.currentPrice > 0 ? { bookingcom: h.currentPrice } : {},
    lastPriceFetchedAt: h.currentPrice > 0 ? new Date() : null,
    autoAdded: true,
  }));

  try { await Competitor.insertMany(docs, { ordered: false }); } catch {}

  const saved = await Competitor.find({ ownerHotelId: hotel._id, isActive: true });

  // Narxli raqobatchilar uchun trend snapshot'i.
  const ci = new Date(); ci.setDate(ci.getDate() + 7);
  const co = new Date(ci); co.setDate(co.getDate() + 1);
  for (const c of saved) {
    const price = c.latestPrices?.get?.('bookingcom');
    if (price > 0) {
      await PriceSnapshot.create({
        targetType: 'competitor', targetId: c._id, ownerHotelId: hotel._id,
        ota: 'Booking.com', price, currency: 'USD', checkIn: ci, checkOut: co, source: 'booking_scraper',
      }).catch(() => {});
    }
  }
  return saved;
}

// SerpAPI sana stringi (masalan "2 weeks ago", "3 months ago", "2024-12-15")
function parseSerpDate(s) {
  if (!s) return new Date();
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = String(s).toLowerCase().match(/(\d+)\s*(day|week|month|year|hour)/);
  if (!m) return new Date();
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[unit] || 0;
  return new Date(Date.now() - n * ms);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

// Skreyper raqib-topishni bir hotel uchun tez-tez (har sahifa yuklanishida)
// qayta ishga tushirmaslik throttle'i — skreyper 0 qaytarsa ham 30 daqiqa kutadi.
const _scraperDiscTried = new Map();
function shouldTryScraperDiscovery(hotelId) {
  const k = String(hotelId);
  const last = _scraperDiscTried.get(k);
  if (last && Date.now() - last < 30 * 60 * 1000) return false;
  _scraperDiscTried.set(k, Date.now());
  return true;
}

export async function getCompetitors(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Avval hotel yarating' });
    const existingCount = await Competitor.countDocuments({ ownerHotelId: myHotel._id, isActive: true });
    const [lng, lat] = myHotel.location?.coordinates || [];
    if (existingCount < AUTO_DISCOVERY_LIMIT && lat && lng) {
      await autoFindCompetitors(myHotel._id, lat, lng);
    }

    // Google/OSM hech narsa topmasa (yoki koordinata yo'q bo'lsa) — Booking.com
    // JONLI SKREYPER fallback: shahar bo'yicha eng mashhur 5 hotelni narxi bilan
    // topadi va saqlaydi. Shu tufayli "Raqiblar" sahifasi bo'sh qolmaydi.
    const stillEmpty = await Competitor.countDocuments({ ownerHotelId: myHotel._id, isActive: true });
    if (stillEmpty === 0 && shouldTryScraperDiscovery(myHotel._id)) {
      await discoverCompetitorsViaScraper(myHotel).catch((e) =>
        console.warn('[competitors] skreyper fallback xato:', e.message));
    }

    // ── Faqat eng yaqin 5 auto-raqib qoladi ──────────────────────────────
    // Eski kengroq radius (avval 20/600m) davridan bazada to'planib qolgan
    // ortiqcha auto-raqiblarni o'chiramiz (isActive:false). Shunda BARCHA joy
    // (refresh-all, Rate Shopper, hisoblagich) bir xil 5 tani ko'radi.
    // Qo'lda qo'shilganlarga (autoAdded:false) tegmaymiz.
    const allAuto = await Competitor.find({
      ownerHotelId: myHotel._id, isActive: true, autoAdded: true,
    }).sort({ distanceKm: 1 });
    if (allAuto.length > AUTO_DISCOVERY_LIMIT) {
      const extraIds = allAuto.slice(AUTO_DISCOVERY_LIMIT).map((c) => c._id);
      await Competitor.updateMany(
        { _id: { $in: extraIds } },
        { $set: { isActive: false } }
      ).catch(() => {});
    }

    // Auto-qo'shilgan raqiblar uchun 5 ta yaqin chegarasi — qolganlari (qo'lda
    // qo'shilganlari) baribir ko'rinadi. Foydalanuvchi qo'lda 5 dan ortiq qo'shsa,
    // o'sha ortiqchalar ham ko'rsatiladi.
    const auto = await Competitor.find({
      ownerHotelId: myHotel._id, isActive: true, autoAdded: true,
    }).sort({ distanceKm: 1 }).limit(AUTO_DISCOVERY_LIMIT);
    const manual = await Competitor.find({
      ownerHotelId: myHotel._id, isActive: true, autoAdded: false,
    }).sort({ distanceKm: 1 });
    const merged = [...auto, ...manual];
    console.log(`Auto-discovery: ${auto.length} ta raqib topildi, ${manual.length} ta qo'lda qo'shilgan, jami ${merged.length}`);
    // Dedupe: bir xil nom va taxminan bir xil masofadagi takrorlarni olib
    // tashlaymiz (auto-discovery natijasida bir mehmonxona ikki marta
    // qo'shilib qolishi mumkin). Birinchi uchragani qoladi.
    const seen = new Set();
    const competitors = [];
    for (const c of merged) {
      const key = `${(c.name || '').trim().toLowerCase()}|${Math.round((c.distanceKm || 0) * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      competitors.push(c);
    }
    res.json({ competitors });
  } catch (err) { next(err); }
}

export async function addCompetitor(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Avval hotel yarating' });
    const data = req.body;

    // Koordinata berilmagan bo'lsa (masalan skreyper natijasidan — typeahead tez
    // bo'lishi uchun geocode qilinmagan), shu yerda nom+manzil bo'yicha to'ldiramiz.
    let lat = data.lat, lng = data.lng;
    if (!(lat && lng)) {
      try {
        const { scraperEnabled, geocodeHotel } = await import('../services/hotelScraper.service.js');
        if (scraperEnabled()) {
          const geo = await geocodeHotel({ name: data.name, address: data.address, city: myHotel.city });
          if (geo) { lat = geo.lat; lng = geo.lng; }
        }
      } catch { /* geocode ixtiyoriy */ }
    }

    const competitor = await Competitor.create({
      ownerHotelId: myHotel._id,
      name: data.name, address: data.address || '',
      googlePlaceId: data.googlePlaceId || data.osmId || stablePlaceKey(data),
      osmId: data.osmId || '',
      stars: data.stars || 0, rating: data.rating || 0,
      location: lat && lng ? { type: 'Point', coordinates: [lng, lat] } : undefined,
      distanceKm: lat && lng && myHotel.location?.coordinates
        ? haversine(myHotel.location.coordinates[1], myHotel.location.coordinates[0], lat, lng) : 0,
      autoAdded: false,
    });
    res.status(201).json({ competitor });
  } catch (err) { next(err); }
}

function stablePlaceKey(place) {
  return `${place.source || 'manual'}:${place.name || ''}:${place.address || ''}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 180);
}

export async function deleteCompetitor(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    const result = await Competitor.findOneAndDelete({ _id: req.params.id, ownerHotelId: myHotel._id });
    if (!result) return res.status(404).json({ error: 'Raqib topilmadi' });
    // O'chirilgan raqibni "dismissed"ga qo'shamiz — aks holda auto-discovery uni
    // keyingi sahifa yuklanishida qayta topib qo'shib qo'yadi (o'chmagandek).
    if (result.name) {
      await Hotel.updateOne(
        { _id: myHotel._id },
        { $addToSet: { dismissedCompetitors: nameSlug(result.name) } },
      ).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/**
 * POST /hotels/competitors/:id/fetch-price
 * SerpAPI google_hotels orqali raqib narxini yangilaydi — BITTA so'rovda
 * barcha OTA kanallari (Booking, Agoda, Expedia, Hotels.com, Trip.com, Priceline,
 * Vio.com, eDreams va boshqalar) keladi. Sof narx (soliqsiz) saqlanadi.
 */
export async function fetchCompetitorPrice(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      ownerHotelId: myHotel._id,
      isActive: true,
    });
    if (!competitor) return res.status(404).json({ error: 'Raqib topilmadi' });

    let otaPrices = [];
    let meta = { lowestPrice: 0 };
    let provider = 'serpapi';

    // 1) SerpAPI (kalit bo'lsa) — bitta so'rovda barcha OTA.
    if (hasSerpApi()) {
      const data = await getSerpApiHotelData({
        name: competitor.name,
        city: myHotel.city,
        countryCode: myHotel.countryCode,
      });
      otaPrices = (data?.otaPrices || [])
        .filter((o) => o.source && o.price > 0)
        .map((o) => ({ source: o.source, price: o.price, currency: o.currency || 'USD', priceType: o.priceType, link: o.link, official: o.official }));
      meta = { lowestPrice: data?.lowestPrice || 0, stars: data?.hotelClass, rating: data?.rating, reviewCount: data?.reviewCount, image: data?.image };
    }

    // 2) SerpAPI yo'q yoki topmadi — GOOGLE HOTELS (Booking/Agoda/Expedia/Hotels.com/
    //    Trip.com/Priceline) + Ostrovok. Pullik kalitsiz ham real narx topadi.
    if (!otaPrices.length) {
      try {
        const { scraperEnabled, scraperAllChannelPrices } = await import('../services/hotelScraper.service.js');
        if (scraperEnabled()) {
          const gh = await scraperAllChannelPrices(competitor.name, myHotel.city);
          otaPrices = (gh?.offers || [])
            .filter((o) => o.price > 0)
            .map((o) => ({ source: o.source, price: o.price, currency: 'USD' }));
          if (gh?.rating) meta.rating = meta.rating || gh.rating;
          if (gh?.reviews) meta.reviewCount = meta.reviewCount || gh.reviews;
          provider = 'google_scraper';
        }
      } catch (e) { console.warn('[competitor] google narx xato:', e.message); }
    }

    // Hech qaysi manbadan narx topilmadi — 422 + suggestRemove (frontend "narxi
    // yo'q, o'chirib tashlang" deb taklif qilishi mumkin).
    if (!otaPrices.length) {
      competitor.lastPriceFetchedAt = new Date();
      await competitor.save();
      return res.status(422).json({
        error: `"${competitor.name}" uchun hech qaysi kanaldan (Booking/Agoda/Google Hotels) narx topilmadi`,
        hint: 'no_data',
        suggestRemove: true,
      });
    }

    // latestPrices Map'iga barcha kanallarni yozish
    if (!(competitor.latestPrices instanceof Map)) {
      competitor.latestPrices = new Map(Object.entries(competitor.latestPrices || {}));
    }
    for (const ota of otaPrices) {
      const key = ota.source.toLowerCase().replace(/[^a-z0-9]/g, '');
      competitor.latestPrices.set(key, ota.price);
    }
    if (meta.lowestPrice > 0) competitor.latestPrices.set('google', meta.lowestPrice);

    if (!competitor.stars && meta.stars) competitor.stars = meta.stars;
    if (!competitor.rating && meta.rating) competitor.rating = meta.rating;
    if (!competitor.reviewCount && meta.reviewCount) competitor.reviewCount = meta.reviewCount;
    if (!competitor.photoUrl && meta.image) competitor.photoUrl = meta.image;

    competitor.lastPriceFetchedAt = new Date();
    await competitor.save();

    // PriceSnapshot — har kanal uchun alohida (Rate Shopper jadvali uchun)
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const snapSource = provider === 'serpapi' ? 'serpapi' : 'google_scraper';
    try {
      for (const ota of otaPrices) {
        await PriceSnapshot.create({
          targetType: 'competitor', targetId: competitor._id,
          ownerHotelId: myHotel._id, ota: ota.source,
          price: ota.price, currency: ota.currency || 'USD',
          checkIn, checkOut, source: snapSource,
          raw: { priceType: ota.priceType, link: ota.link, official: ota.official },
        }).catch(() => {});
      }
      if (meta.lowestPrice > 0) {
        await PriceSnapshot.create({
          targetType: 'competitor', targetId: competitor._id,
          ownerHotelId: myHotel._id, ota: 'google',
          price: meta.lowestPrice, currency: 'USD',
          checkIn, checkOut, source: 'serpapi',
          raw: { rating: competitor.rating || 0 },
        }).catch(() => {});
      }
    } catch {}

    res.json({
      _id: competitor._id,
      provider,
      googlePrice: meta.lowestPrice || 0,
      otaPrices,
      stars: competitor.stars,
      rating: competitor.rating,
      lastPriceFetchedAt: competitor.lastPriceFetchedAt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /hotels/competitors/:id/fetch-xotelo
 * Faqat Xotelo (bepul) orqali Booking/Expedia/Agoda/Hotels.com narxlari.
 * SerpAPI quota'siga tegmaydi. Sahifa yuklanishida bulk avto-trigger uchun.
 */
export async function fetchCompetitorXoteloPrice(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      ownerHotelId: myHotel._id,
      isActive: true,
    });
    if (!competitor) return res.status(404).json({ error: 'Raqib topilmadi' });

    const { findTripAdvisorUrl, getXoteloRates, extractXoteloHotelKey } = await import('../services/xotelo.service.js');

    // 1. hotel_key — DB'da saqlangan TripAdvisor URL'dan yoki DuckDuckGo'dan topib olamiz.
    let xoteloKey = extractXoteloHotelKey(competitor.tripAdvisorUrl);
    if (!xoteloKey) {
      const url = await findTripAdvisorUrl(competitor.name, myHotel.city);
      if (!url) {
        competitor.lastPriceFetchedAt = new Date();
        await competitor.save();
        return res.status(422).json({
          error: 'TripAdvisor URL topilmadi',
          hint: 'DuckDuckGo qidiruvi bu hotel uchun tripadvisor.com link qaytarmadi',
          diagnostic: { provider: 'duckduckgo', error: 'no_url', query: `${competitor.name} ${myHotel.city} site:tripadvisor.com` },
        });
      }
      xoteloKey = extractXoteloHotelKey(url);
      competitor.tripAdvisorUrl = url;
      if (!xoteloKey) {
        competitor.lastPriceFetchedAt = new Date();
        await competitor.save();
        return res.status(422).json({
          error: 'TripAdvisor URL\'idan hotel_key ajratib olinmadi',
          diagnostic: { provider: 'duckduckgo', error: 'bad_url', url },
        });
      }
    }

    // 2. Xotelo /rates — bepul, direct API. hotel_key bo'yicha 8 ta OTA narxi bir so'rovda.
    const xoteloData = await getXoteloRates(xoteloKey);
    if (!xoteloData?.rates?.length) {
      competitor.lastPriceFetchedAt = new Date();
      await competitor.save();
      return res.status(422).json({
        error: 'Xotelo bu hotel uchun narx topa olmadi',
        diagnostic: { provider: 'xotelo', error: 'no_rates', hotelKey: xoteloKey },
      });
    }

    if (!competitor.latestPrices) competitor.latestPrices = new Map();
    const otaPrices = [];
    for (const r of xoteloData.rates) {
      if (!r.source || !(r.price > 0)) continue;
      const key = r.source.toLowerCase().replace(/[^a-z0-9]/g, '');
      competitor.latestPrices.set(key, r.price);
      otaPrices.push({ source: r.source, price: r.price, via: 'xotelo' });
    }
    competitor.lastPriceFetchedAt = new Date();
    await competitor.save();

    // PriceSnapshot - trend uchun
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    try {
      for (const ota of otaPrices) {
        await PriceSnapshot.create({
          targetType: 'competitor', targetId: competitor._id,
          ownerHotelId: myHotel._id, ota: ota.source,
          price: ota.price, currency: 'USD',
          checkIn, checkOut, source: 'manual',
        }).catch(() => {});
      }
    } catch {}

    res.json({
      _id: competitor._id,
      provider: 'xotelo',
      googlePrice: 0,
      otaPrices,
      stars: competitor.stars,
      rating: competitor.rating,
      lastPriceFetchedAt: competitor.lastPriceFetchedAt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /hotels/competitors/:id/fetch-hasdata
 * SerpAPI kanali topmagan raqib uchun to'g'ridan-to'g'ri Booking.com narxini
 * HasData orqali oladi. bookingUrl saqlangan bo'lsa Place API, aks holda nom
 * bo'yicha Search API ishlatiladi.
 */
export async function fetchCompetitorHasDataPrice(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const { getBookingPriceHasData, hasHasData } = await import('../services/hasdata.service.js');
    if (!hasHasData()) {
      return res.status(503).json({ error: 'HasData API kaliti sozlanmagan' });
    }

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      ownerHotelId: myHotel._id,
      isActive: true,
    });
    if (!competitor) return res.status(404).json({ error: 'Raqib topilmadi' });

    const result = await getBookingPriceHasData({
      name: competitor.name,
      city: myHotel.city,
      bookingUrl: competitor.bookingUrl,
    });

    if (result?.notFound || !(result?.price > 0)) {
      competitor.lastPriceFetchedAt = new Date();
      await competitor.save();
      return res.status(422).json({
        error: 'Booking.com\'da bu mehmonxona uchun narx topilmadi',
        diagnostic: { provider: 'hasdata', error: 'no_price', candidates: result?.candidates || [] },
      });
    }

    if (!competitor.latestPrices) competitor.latestPrices = new Map();
    competitor.latestPrices.set('bookingcom', result.price);
    // Topilgan Booking URL'ni saqlaymiz — keyingi safar Place API (aniqroq).
    if (result.url && !competitor.bookingUrl) competitor.bookingUrl = result.url;
    if (result.stars && !competitor.stars) competitor.stars = result.stars;
    competitor.lastPriceFetchedAt = new Date();
    await competitor.save();

    // PriceSnapshot — trend uchun
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    await PriceSnapshot.create({
      targetType: 'competitor', targetId: competitor._id,
      ownerHotelId: myHotel._id, ota: 'Booking.com',
      price: result.price, currency: result.currency || 'USD',
      checkIn, checkOut, source: 'manual',
    }).catch(() => {});

    res.json({
      _id: competitor._id,
      provider: 'hasdata',
      googlePrice: 0,
      otaPrices: [{ source: 'Booking.com', price: result.price, via: 'hasdata' }],
      matchedName: result.matchedName,
      matchScore: result.matchScore,
      bookingUrl: competitor.bookingUrl,
      stars: competitor.stars,
      rating: competitor.rating,
      lastPriceFetchedAt: competitor.lastPriceFetchedAt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /hotels/competitors/:id/detail
 * Raqib uchun barcha OTA narxlari + 30 kunlik narx tarixi
 */
export async function getCompetitorDetail(req, res, next) {
  try {
    const myHotel = req.hotel;
    if (!myHotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const competitor = await Competitor.findOne({
      _id: req.params.id,
      ownerHotelId: myHotel._id,
      isActive: true,
    });
    if (!competitor) return res.status(404).json({ error: 'Raqib topilmadi' });

    // latestPrices Map → plain object
    const otaPrices = {};
    if (competitor.latestPrices instanceof Map) {
      for (const [k, v] of competitor.latestPrices) otaPrices[k] = v;
    } else if (competitor.latestPrices) {
      Object.assign(otaPrices, competitor.latestPrices);
    }

    // Narx tarixi — google narxi, oxirgi 30 kun
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
    const snapshots = await PriceSnapshot.find({
      targetType: 'competitor',
      targetId: competitor._id,
      ota: 'google',
      snapshotAt: { $gte: thirtyDaysAgo },
    }).sort({ snapshotAt: 1 }).lean();

    // Kun bo'yicha eng so'nggi narx
    const byDay = new Map();
    for (const s of snapshots) {
      const day = new Date(s.snapshotAt).toISOString().slice(0, 10);
      const cur = byDay.get(day);
      if (!cur || s.snapshotAt > cur.snapshotAt) byDay.set(day, s);
    }
    const history = Array.from(byDay.entries())
      .map(([date, s]) => ({
        date,
        price: s.price,
        rating: s.raw?.rating || null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Rating tarixi — faqat rating qiymati bor kunlar
    const ratingHistory = history
      .filter((h) => h.rating > 0)
      .map((h) => ({ date: h.date, rating: h.rating }));

    res.json({
      competitor: {
        _id: competitor._id,
        name: competitor.name,
        address: competitor.address,
        stars: competitor.stars,
        rating: competitor.rating,
        reviewCount: competitor.reviewCount,
        distanceKm: competitor.distanceKm,
        lastPriceFetchedAt: competitor.lastPriceFetchedAt,
      },
      otaPrices,
      history,
      ratingHistory,
    });
  } catch (err) {
    next(err);
  }
}
