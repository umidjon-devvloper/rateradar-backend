import Hotel from '../models/Hotel.js';
import Competitor from '../models/Competitor.js';
import PriceSnapshot from '../models/PriceSnapshot.js';
import { hasBookingRapidApi, getRoomsRaw } from '../services/booking-rapidapi.service.js';
import {
  hasApify,
  getBookingPriceApify,
  getBookingRoomsApify,
  getBookingCitySearchApify,
  matchHotelByName,
  findBookingUrl,
  findExpediaUrl,
  findAgodaUrl,
  findTripUrl,
  findHotelsUrl,
  getExpediaPriceApify,
  getHotelsComPriceApify,
  getTripComPriceApify,
} from '../services/apify.service.js';
import { hasSerpApi, getSerpApiHotelData } from '../services/serpapi.service.js';
import { hasHasData, getBookingPriceHasData } from '../services/hasdata.service.js';
import { emitToUser } from '../services/socket.service.js';
import { TARGET_CHANNELS, fetchChannelFallback } from '../services/channelFallback.service.js';

// Channel UI value → snapshot.ota matchers (case-insensitive) + competitor.latestPrices key.
// 'all' is not in this table — it means no channel filter.
// Boshqa OTA'lar (Bluepillow, Tiket.com va h.k.) `channel` parametri bevosita
// OTA nomi sifatida kelganida quyida dinamik aniqlanadi.
const CHANNEL_MAP = {
  booking: { otaAliases: ['booking.com', 'booking'], compKey: 'bookingcom' },
  agoda:   { otaAliases: ['agoda'],                  compKey: 'agoda' },
  expedia: { otaAliases: ['expedia'],                compKey: 'expedia' },
  hotels:  { otaAliases: ['hotels.com', 'hotels'],   compKey: 'hotelscom' },
  trip:    { otaAliases: ['trip.com', 'trip'],       compKey: 'tripcom' },
  google:  { otaAliases: ['google hotels', 'google'],compKey: 'google' },
};

// OTA nomidan normalized kalit yasaydi: "Booking.com" → "bookingcom"
function normalizeOtaKey(ota) {
  return String(ota).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function competitorChannelPrice(competitor, compKey) {
  const m = competitor.latestPrices;
  if (!m) return 0;
  return m.get?.(compKey) || m[compKey] || 0;
}

/**
 * GET /prices/rate-shopper?days=7
 *
 * Returns a rate-shopper grid comparing the user's hotel price against each
 * active competitor for the next N days.
 */
export async function getRateShopper(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));

    const rawChannel = String(req.query.channel || 'all');
    let channelCfg = null;
    let channel = 'all';
    if (rawChannel.toLowerCase() !== 'all') {
      const mapped = CHANNEL_MAP[rawChannel.toLowerCase()];
      if (mapped) {
        channelCfg = mapped;
        channel = rawChannel.toLowerCase();
      } else {
        // Bevosita OTA nomi (masalan, "Bluepillow.com", "Tiket.com")
        channelCfg = {
          otaAliases: [rawChannel],
          compKey: normalizeOtaKey(rawChannel),
        };
        channel = rawChannel;
      }
    }

    const rawCompetitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true })
      .sort({ distanceKm: 1 });

    // Dedupe: bir xil nom va taxminan bir xil masofadagi raqiblarni bittasiga
    // qoldiramiz (auto-discovery natijasida ba'zan bir mehmonxona ikki marta
    // qo'shilib qoladi). Ko'rsatish limiti — 8 ta.
    const seenKeys = new Set();
    const competitors = [];
    for (const c of rawCompetitors) {
      const key = `${c.name.trim().toLowerCase()}|${Math.round((c.distanceKm || 0) * 10)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      competitors.push(c);
      if (competitors.length >= 8) break;
    }

    // Build the date columns (YYYY-MM-DD strings, starting from today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const columns = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      columns.push(d.toISOString().slice(0, 10));
    }

    // "Mening narxim":
    //  • 'all' rejimida — hotel.currentPrice (Booking.com narxi; Dashboard bilan bir xil).
    //  • Kanal tanlanganda — o'sha kanaldagi MENING narxim (eng yangi 'own' snapshot).
    //    Shunda o'z narxim ham raqiblar bilan AYNI kanalda taqqoslanadi
    //    (masalan, Bluepillow.com tanlansa — mening Bluepillow narxim ko'rinadi).
    let myPrice = hotel.currentPrice || 0;
    if (channelCfg) {
      const ownChannelSnap = await PriceSnapshot.findOne({
        ownerHotelId: hotel._id,
        targetType: 'own',
        ota: { $in: channelCfg.otaAliases.map((a) => new RegExp(`^${a}$`, 'i')) },
      })
        .sort({ snapshotAt: -1 })
        .lean();
      // Shu kanalda o'z narxim bo'lmasa — 0 (raqiblar bilan bir xil mantiq:
      // kanal tanlanganda faqat real ma'lumot ko'rsatiladi).
      myPrice = ownChannelSnap?.price || 0;
    }

    // Build rows: one per competitor
    const rows = [];
    const marketAccumulator = {};
    for (const col of columns) marketAccumulator[col] = [];

    // Barcha snapshotlarni bitta query bilan olish (N*M query o'rniga 1 ta)
    const rangeStart = new Date(today);
    const rangeEnd = new Date(today);
    rangeEnd.setDate(rangeEnd.getDate() + days);
    const compIds = competitors.map((c) => c._id);

    const snapshotQuery = {
      targetId: { $in: compIds },
      targetType: 'competitor',
      ownerHotelId: hotel._id,
      checkIn: { $gte: rangeStart, $lt: rangeEnd },
    };
    if (channelCfg) {
      snapshotQuery.ota = { $in: channelCfg.otaAliases.map((a) => new RegExp(`^${a}$`, 'i')) };
    }

    const allSnapshots = await PriceSnapshot.find(snapshotQuery)
      .sort({ snapshotAt: -1 }).lean();

    // comp._id + date string => price (eng yangi snapshot)
    const snapMap = new Map();
    for (const s of allSnapshots) {
      const dateStr = new Date(s.checkIn).toISOString().slice(0, 10);
      const key = `${s.targetId}_${dateStr}`;
      if (!snapMap.has(key)) snapMap.set(key, s.price);
    }

    // Channel-specific compKey fallback (per-competitor, single value across days)
    // — only used when channel is selected AND no per-day snapshot is found.
    // For 'all' we keep the existing daily demo so the empty-state grid still
    // looks alive.
    const channelLatestByComp = {};
    if (channelCfg) {
      for (const comp of competitors) {
        channelLatestByComp[comp._id] = competitorChannelPrice(comp, channelCfg.compKey);
      }
    }

    let realCellCount = 0;
    for (const comp of competitors) {
      const prices = {};

      for (let i = 0; i < days; i++) {
        const dateStr = columns[i];

        const key = `${comp._id}_${dateStr}`;
        let price;
        if (snapMap.has(key)) {
          price = snapMap.get(key);
          realCellCount++;
        } else if (channelCfg) {
          // Channel specific: only real data from latestPrices.<channel>
          price = channelLatestByComp[comp._id] || 0;
        } else {
          // 'all' mode: best real cached price across known channels
          const m = comp.latestPrices;
          price =
            m?.get?.('bookingcom') ||
            m?.get?.('booking') ||
            m?.get?.('google') ||
            m?.get?.('agoda') ||
            m?.get?.('expedia') ||
            m?.get?.('hotelscom') ||
            m?.get?.('tripcom') ||
            0;
        }

        const diff = price > 0 && myPrice > 0
          ? Math.round(((price - myPrice) / myPrice) * 100)
          : 0;

        prices[dateStr] = { price, diff };
        if (price > 0) marketAccumulator[dateStr].push(price);
      }

      rows.push({
        competitor: {
          _id: comp._id,
          name: comp.name,
          stars: comp.stars,
          distanceKm: comp.distanceKm,
        },
        prices,
      });
    }

    // Compute market average per day (includes competitors only; skips empty cells)
    const marketAvg = {};
    for (const dateStr of columns) {
      const pricesForDay = marketAccumulator[dateStr];
      if (pricesForDay.length === 0) {
        marketAvg[dateStr] = 0; // no data — UI shows '—'
      } else {
        const sum = pricesForDay.reduce((a, b) => a + b, 0);
        marketAvg[dateStr] = Math.round(sum / pricesForDay.length);
      }
    }

    // So'nggi 7 kunda RAQIB snapshot'larida paydo bo'lgan OTA nomlari.
    // Faqat competitor snapshot'larini olamiz — bu o'z mehmonxona nomi kabi
    // (masalan, "DENDI PLAZA HOTEL") tasodifiy yozuvlar ro'yxatga tushmaydi.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    const availableOtasRaw = await PriceSnapshot.distinct('ota', {
      ownerHotelId: hotel._id,
      targetType: 'competitor',
      source: 'serpapi',
      snapshotAt: { $gte: sevenDaysAgo },
    });
    const availableChannels = availableOtasRaw
      .filter((ota) => {
        if (!ota || typeof ota !== 'string') return false;
        const trimmed = ota.trim();
        if (!trimmed || trimmed.length > 30) return false;
        // O'zining hotel nomini tashlamaymiz — agar tasodifan kirib qolsa
        if (trimmed.toLowerCase() === String(hotel.name || '').toLowerCase()) return false;
        // Google aggregator — o'zi OTA emas, narxi boshqa OTA'lardan keladi.
        // Foydalanuvchi so'roviga ko'ra ro'yxatdan olib tashlanadi.
        const lower = trimmed.toLowerCase();
        if (lower === 'google' || lower === 'google hotels') return false;
        return true;
      })
      .map((ota) => ota.trim())
      // Lowercase variantni capitalized variant bilan dedupe qilamiz
      // ("google" va "Google Hotels" → faqat ikkinchisi qoladi)
      .filter((ota, _, arr) => {
        if (ota === ota.toLowerCase() && ota !== ota.toUpperCase()) {
          const hasCapitalizedVariant = arr.some(
            (other) => other !== ota && other.toLowerCase().startsWith(ota.toLowerCase())
          );
          if (hasCapitalizedVariant) return false;
        }
        return true;
      })
      .sort((a, b) => a.localeCompare(b));

    res.json({
      days,
      channel,
      hasRealData: realCellCount > 0,
      availableChannels,
      myHotel: {
        name: hotel.name,
        price: myPrice,
        stars: hotel.stars,
      },
      columns,
      rows,
      marketAvg,
    });
  } catch (err) {
    next(err);
  }
}

function extractMinRoomPrice(room) {
  const a = room?.min_price?.price || room?.min_price?.value;
  const b = room?.price_breakdown?.gross_price || room?.price_breakdown?.grossPrice?.value;
  const c = room?.priceBreakdown?.grossPrice?.value;
  const d = room?.price;
  const e = room?.min_total_price;
  const candidates = [a, b, c, d, e].map(Number).filter((p) => p > 0);
  return candidates.length ? Math.round(Math.min(...candidates)) : 0;
}

// Raqib snapshot'laridan har bir kun uchun REAL bozor o'rtachasini hisoblaydi.
// Snapshot bo'lmagan kunlar uchun 0 (UI "—" ko'rsatadi) — soxta qiymat yo'q.
async function realMarketAvgByDay(hotel, columns, today, days) {
  const competitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true })
    .sort({ distanceKm: 1 }).limit(8).select('_id').lean();
  const compIds = competitors.map((c) => c._id);

  const rangeStart = new Date(today);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + days);

  const snaps = compIds.length
    ? await PriceSnapshot.find({
        targetId: { $in: compIds },
        targetType: 'competitor',
        ownerHotelId: hotel._id,
        checkIn: { $gte: rangeStart, $lt: rangeEnd },
      }).sort({ snapshotAt: -1 }).lean()
    : [];

  // Har raqib × kun uchun eng yangi snapshot narxini olamiz.
  const seen = new Set();
  const byDate = {};
  for (const col of columns) byDate[col] = [];
  for (const s of snaps) {
    const dateStr = new Date(s.checkIn).toISOString().slice(0, 10);
    const key = `${s.targetId}_${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (byDate[dateStr] && s.price > 0) byDate[dateStr].push(s.price);
  }

  const avg = {};
  for (const col of columns) {
    const list = byDate[col];
    avg[col] = list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0;
  }
  return avg;
}

/**
 * GET /prices/room-shopper?days=7
 *
 * O'z mehmonxonaning xona turlari bo'yicha REAL narxlarni qaytaradi.
 * Manba: Booking.com RapidAPI (kalit bo'lsa) yoki saqlangan hotel.roomTypes
 * (POST /prices/refresh-rooms orqali Apify'dan real olib kelingan).
 * REAL ma'lumot bo'lmasa — bo'sh ro'yxat (frontend "narx yo'q" holatini
 * ko'rsatadi). HECH QANDAY soxta/demo narx yasalmaydi.
 */
export async function getRoomShopper(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const columns = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      columns.push(d.toISOString().slice(0, 10));
    }

    // 1. Booking.com RapidAPI (kalit bo'lsa) — real xona turlari
    let roomTypes = [];
    if (hotel.bookingComHotelId && hasBookingRapidApi()) {
      try {
        const checkIn = columns[1] || columns[0];
        const checkOut = new Date(checkIn);
        checkOut.setDate(checkOut.getDate() + 1);
        const raw = await getRoomsRaw(
          hotel.bookingComHotelId,
          checkIn,
          checkOut.toISOString().slice(0, 10)
        );
        const rooms = raw?.data || raw?.rooms || [];
        const parsed = rooms
          .slice(0, 6)
          .map((r) => ({
            name: r.room_name || r.name || 'Room',
            guests: r.nr_adults || r.max_persons || 2,
            sqm: r.room_surface_in_m2 || 0,
            description: r.highlights?.[0]?.text || '',
            basePrice: extractMinRoomPrice(r),
          }))
          .filter((r) => r.basePrice > 0);
        if (parsed.length) {
          roomTypes = parsed;
          Hotel.updateOne({ _id: hotel._id }, { roomTypes }).catch(() => {});
        }
      } catch (_) {
        // saqlangan roomTypes'ga o'tamiz
      }
    }

    // 2. Saqlangan real roomTypes (Apify refresh-rooms orqali olingan)
    if (!roomTypes.length && hotel.roomTypes?.length) {
      roomTypes = hotel.roomTypes
        .map((r) => (r.toObject ? r.toObject() : r))
        .filter((r) => r.basePrice > 0);
    }

    // 3. Real ma'lumot yo'q — bo'sh holat. Soxta default YASALMAYDI.
    if (!roomTypes.length) {
      return res.json({
        days,
        columns,
        rows: [],
        hasRealData: false,
        myHotel: { name: hotel.name, stars: hotel.stars },
        message: 'Real xona narxi yo\'q — "Booking narxini olish" tugmasini bosing',
      });
    }

    // Real raqib bozor o'rtachasi (snapshot bo'lmagan kunlar uchun 0)
    const marketAvgByDay = await realMarketAvgByDay(hotel, columns, today, days);

    // Har xona uchun REAL narx (basePrice) — barcha kunlarga bir xil joriy
    // Booking narxi. Bozor o'rtachasi bilan farq faqat real ma'lumot bo'lsa.
    const rows = roomTypes.map((room) => {
      const prices = {};
      for (const dateStr of columns) {
        const price = Math.round(room.basePrice);
        const market = marketAvgByDay[dateStr] || 0;
        const diff = market > 0 ? Math.round(((price - market) / market) * 100) : 0;
        prices[dateStr] = { price, diff, marketAvg: market };
      }
      return {
        room: {
          name: room.name,
          guests: room.guests,
          sqm: room.sqm,
          description: room.description,
          basePrice: room.basePrice,
        },
        prices,
      };
    });

    res.json({
      days,
      columns,
      rows,
      hasRealData: true,
      myHotel: { name: hotel.name, stars: hotel.stars },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /prices/refresh-rooms
 *
 * O'z mehmonxonaning REAL xona turlari + narxlarini Apify Booking scraper orqali
 * olib keladi va hotel.roomTypes'ga saqlaydi. Booking URL saqlangan bo'lsa
 * ishlatiladi, aks holda SerpAPI google_search orqali topiladi.
 */
export async function refreshRoomShopper(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    if (!hasApify()) return res.status(503).json({ error: 'APIFY_API_KEY sozlanmagan' });

    // Anchor sana — bugundan +7 kun, 1 kechalik (kelajak bo'lishi shart).
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const ciStr = checkIn.toISOString().slice(0, 10);
    const coStr = checkOut.toISOString().slice(0, 10);

    // Booking URL — saqlangan yoki SerpAPI orqali topamiz.
    const otaUrls = normalizeOtaUrls(hotel.otaUrls);
    let bookingUrl = otaUrls['Booking.com'] || null;
    if (!bookingUrl) {
      bookingUrl = await findBookingUrl(hotel.name, hotel.city);
      if (bookingUrl) {
        await Hotel.updateOne(
          { _id: hotel._id },
          { $set: { 'otaUrls.Booking.com': bookingUrl } }
        ).catch(() => {});
      }
    }

    if (!bookingUrl) {
      return res.status(404).json({
        error: 'Booking URL topilmadi. Sozlamalarda kiriting yoki SerpAPI kaliti sozlanganligini tekshiring.',
      });
    }

    const { rooms, minPrice, currency } = await getBookingRoomsApify(bookingUrl, {
      checkIn: ciStr,
      checkOut: coStr,
    });

    if (!rooms.length) {
      return res.json({
        found: false,
        roomsCount: 0,
        bookingUrl,
        message: 'Booking sahifasidan xona narxi kelmadi (band yoki sana mavjud emas)',
      });
    }

    // Real xonalarni hotel.roomTypes'ga saqlaymiz.
    const roomTypes = rooms.slice(0, 8).map((r) => ({
      name: r.name,
      guests: r.guests,
      sqm: 0, // Apify scraper m² bermaydi
      description: r.bedType || '',
      basePrice: r.price,
    }));

    const update = { roomTypes };
    if (minPrice > 0) {
      update.currentPrice = minPrice;
      update.currency = currency || 'USD';
    }
    await Hotel.updateOne({ _id: hotel._id }, { $set: update });

    res.json({
      found: true,
      roomsCount: roomTypes.length,
      minPrice,
      currency: currency || 'USD',
      checkIn: ciStr,
      checkOut: coStr,
      bookingUrl,
      rooms: roomTypes.map((r) => ({ name: r.name, price: r.basePrice })),
    });
  } catch (err) {
    next(err);
  }
}

function normalizeOtaUrls(raw) {
  const src = raw || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && typeof v.com === 'string' && k === 'Booking') {
      out['Booking.com'] = v.com;
    }
  }
  return out;
}

// Refresh konfiguratsiyasi har bir Apify kanali uchun:
//  - label:    PriceSnapshot.ota va competitor.latestPrices uchun nom
//  - compKey:  competitor.latestPrices'da saqlanadigan kalit
//  - urlKey:   hotel.otaUrls'da saqlangan URL kaliti
//  - finder:   URL topish funksiyasi (SerpAPI google_search orqali)
//  - own:      sizning mehmonxona narxini olish
//  - city:     raqiblar uchun shahar qidiruvi (bitta Apify run, har bir raqibni
//              nom o'xshashligi bilan map qilamiz). Faqat Booking uchun mavjud.
const REFRESH_CHANNELS = {
  booking: {
    label: 'Booking.com',
    compKey: 'bookingcom',
    urlKey: 'Booking.com',
    finder: findBookingUrl,
    own: (name, city, opts) => getBookingPriceApify(name, city, { ...opts, bookingUrl: opts.url }),
    city: getBookingCitySearchApify,
  },
  expedia: {
    label: 'Expedia',
    compKey: 'expedia',
    urlKey: 'Expedia',
    finder: findExpediaUrl,
    own: (name, city, opts) => getExpediaPriceApify(name, city, { ...opts, expediaUrl: opts.url }),
    city: null,
  },
  hotels: {
    label: 'Hotels.com',
    compKey: 'hotelscom',
    urlKey: 'Hotels.com',
    finder: null,
    own: (name, city, opts) => getHotelsComPriceApify(name, city, { ...opts, hotelsUrl: opts.url }),
    city: null,
  },
  trip: {
    label: 'Trip.com',
    compKey: 'tripcom',
    urlKey: 'Trip.com',
    finder: findTripUrl,
    own: (name, city, opts) => getTripComPriceApify(name, city, { ...opts, tripUrl: opts.url }),
    city: null,
  },
  agoda: {
    label: 'Agoda',
    compKey: 'agoda',
    urlKey: 'Agoda',
    finder: findAgodaUrl,
    own: null, // Apify Agoda narx scraper hisobda yo'q (faqat reviews)
    city: null,
  },
};

/**
 * POST /prices/refresh-channel
 * Body: { channel: 'booking' | 'expedia' | 'hotels' | 'trip' | 'agoda' }
 *
 * Tanlangan OTA kanali bo'yicha real narxlarni Apify orqali oladi:
 *  - Own hotel: saqlangan URL yoki SerpAPI google_search orqali topiladi
 *  - Competitors: Booking — bitta shahar qidiruvi (cost-efficient).
 *    Boshqa kanallar — Apify city search aktyori yo'q, raqiblar uchun
 *    URL talab qilinadi (hozircha o'tkazib yuboramiz).
 *
 * Snapshot saqlaydi + competitor.latestPrices.<key> yangilaydi.
 */
export async function refreshChannelPrices(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    if (!hasApify()) {
      return res.status(503).json({ error: 'APIFY_API_KEY sozlanmagan' });
    }

    const channel = String(req.body?.channel || '').toLowerCase();
    const cfg = REFRESH_CHANNELS[channel];
    if (!cfg) {
      return res.status(400).json({
        error: `Noma'lum kanal: "${channel}". Mavjud: ${Object.keys(REFRESH_CHANNELS).join(', ')}`,
      });
    }

    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const ciStr = checkIn.toISOString().slice(0, 10);
    const coStr = checkOut.toISOString().slice(0, 10);

    const summary = {
      channel: cfg.label,
      checkIn: ciStr,
      checkOut: coStr,
      own: { price: 0, found: false, message: '' },
      competitors: { total: 0, matched: 0, failed: 0, items: [] },
    };

    // ── 1. Own hotel ─────────────────────────────────────────────────────────
    if (cfg.own) {
      try {
        const otaUrls = normalizeOtaUrls(hotel.otaUrls);
        let url = otaUrls[cfg.urlKey] || null;

        if (!url && cfg.finder) {
          url = await cfg.finder(hotel.name, hotel.city);
          if (url) {
            await Hotel.updateOne(
              { _id: hotel._id },
              { $set: { [`otaUrls.${cfg.urlKey}`]: url } }
            ).catch(() => {});
          }
        }

        const ownResult = await cfg.own(hotel.name, hotel.city, {
          checkIn: ciStr,
          checkOut: coStr,
          url,
        });

        if (ownResult?.price > 0) {
          await PriceSnapshot.create({
            targetType: 'own',
            targetId: hotel._id,
            ownerHotelId: hotel._id,
            ota: cfg.label,
            price: ownResult.price,
            currency: 'USD',
            checkIn,
            checkOut,
            source: 'apify',
          });

          // Booking.com — currentPrice'ni ham yangilaymiz (Dashboard ko'rsatadi)
          if (channel === 'booking') {
            await Hotel.updateOne(
              { _id: hotel._id },
              { $set: { currentPrice: ownResult.price } }
            );
          }

          summary.own = { price: ownResult.price, found: true, message: '' };
        } else {
          summary.own.message = url
            ? `${cfg.label} URL bor, lekin narx kelmadi`
            : `${cfg.label} URL topilmadi`;
        }
      } catch (err) {
        summary.own.message = `Xato: ${err.message}`;
      }
    } else {
      summary.own.message = `${cfg.label} uchun Apify narx scraper'i mavjud emas`;
    }

    // ── 2. Competitors — faqat Booking uchun shahar qidiruvi mavjud ──────────
    const competitors = await Competitor.find({
      ownerHotelId: hotel._id,
      isActive: true,
    }).limit(20);
    summary.competitors.total = competitors.length;

    if (cfg.city && competitors.length && hotel.city) {
      const items = await cfg.city(hotel.city, {
        checkIn: ciStr,
        checkOut: coStr,
        maxItems: 50,
      });

      const ops = [];
      for (const comp of competitors) {
        const match = matchHotelByName(items, comp.name, 0.4);
        if (!match) {
          summary.competitors.failed++;
          summary.competitors.items.push({ name: comp.name, matched: false });
          continue;
        }

        ops.push(
          PriceSnapshot.create({
            targetType: 'competitor',
            targetId: comp._id,
            ownerHotelId: hotel._id,
            ota: cfg.label,
            price: match.price,
            currency: 'USD',
            checkIn,
            checkOut,
            source: 'apify',
          }).catch(() => null)
        );

        ops.push(
          Competitor.updateOne(
            { _id: comp._id },
            {
              $set: {
                [`latestPrices.${cfg.compKey}`]: match.price,
                lastPriceFetchedAt: new Date(),
              },
            }
          ).catch(() => null)
        );

        summary.competitors.matched++;
        summary.competitors.items.push({
          name: comp.name,
          matched: true,
          price: match.price,
          matchedAs: match.name,
          score: Math.round(match.score * 100),
        });
      }

      await Promise.all(ops);
    } else if (!cfg.city && competitors.length) {
      summary.competitors.message = `${cfg.label} uchun raqiblar narxini bulk olish mumkin emas — bu kanal har bir hotel URL'ini talab qiladi`;
    }

    res.json(summary);
  } catch (err) {
    next(err);
  }
}

// Topilgan URL'ni hotel.otaUrls'ga saqlaymiz (keyingi safar qayta qidirmaslik
// uchun). otaUrls — oddiy Object, shuning uchun butun obyektni yozamiz
// (mongo dotted-path "Hotels.com" kalitini nested qilib yuborishining oldini oladi).
// TARGET_CHANNELS va fetchChannelFallback — channelFallback.service.js'dan.
async function persistOtaUrl(hotel, key, url) {
  if (!url) return;
  const merged = { ...(hotel.otaUrls || {}), [key]: url };
  hotel.otaUrls = merged;
  await Hotel.updateOne({ _id: hotel._id }, { $set: { otaUrls: merged } }).catch(() => {});
}

/**
 * POST /prices/refresh-all
 * SerpAPI google_hotels orqali BARCHA OTA kanallari uchun bitta yugurishda
 * narxlarni yangilaydi:
 *  - O'z mehmonxona: 1 ta SerpAPI so'rovi → Booking + Agoda + Hotels.com + Expedia + Trip.com + …
 *  - Har bir raqib: 1 ta SerpAPI so'rovi → o'sha barcha kanallar.
 *
 * Bu Apify (har OTA alohida actor) o'rniga juda tejamli — N ta raqib × 1 ta SerpAPI = N so'rov.
 */
export async function refreshAllChannels(req, res, next) {
  try {
    if (!hasSerpApi()) return res.status(503).json({ error: 'SERPAPI_API_KEY sozlanmagan' });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });

    // Jonli progress — frontend animatsiyali panelda ko'rsatadi.
    const userId = req.user?._id;
    const emitProgress = (p) => { try { emitToUser(userId, 'price:progress', p); } catch { /* noop */ } };

    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + 7);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const ciStr = checkIn.toISOString().slice(0, 10);
    const coStr = checkOut.toISOString().slice(0, 10);

    const summary = {
      provider: 'serpapi',
      checkIn: ciStr,
      checkOut: coStr,
      own: { channels: 0, otaPrices: [], message: '' },
      competitors: { total: 0, matched: 0, failed: 0, items: [] },
    };

    emitProgress({ stage: 'start', channels: TARGET_CHANNELS.map((c) => c.label) });

    // ── 1. O'z mehmonxona — 1 ta SerpAPI so'rovi ─────────────────────────
    emitProgress({ stage: 'own', status: 'searching' });
    try {
      const data = await getSerpApiHotelData({
        name: hotel.name, city: hotel.city, countryCode: hotel.countryCode,
        propertyToken: hotel.serpPropertyToken || '',
      });

      const resolvedCurrency = data?.currency || 'USD';

      // Manba nomini 5 ta canonical kanaldan biriga moslaymiz (boshqalari —
      // Priceline, Vio.com — o'z nomi bilan qoladi).
      const canonLabel = (src) => {
        const lower = String(src).toLowerCase();
        const t = TARGET_CHANNELS.find((c) => c.aliases.includes(lower));
        return t ? t.label : src;
      };

      // collected: kanal label → narx. Avval SerpAPI bergan kanallarni yig'amiz.
      const collected = new Map();

      // Google aggregator narxini OTA sifatida saqlamaymiz — boshqa
      // OTA'lardan keladi va dublikat hisoblanadi.
      const serpOtaPrices = (data?.otaPrices || []).filter((o) => {
        if (!o.source || !(o.price > 0)) return false;
        const lower = String(o.source).toLowerCase();
        return lower !== 'google' && lower !== 'google hotels';
      });
      for (const ota of serpOtaPrices) {
        await PriceSnapshot.create({
          targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
          ota: ota.source, price: ota.price, currency: ota.currency || resolvedCurrency,
          checkIn, checkOut, source: 'serpapi',
          raw: { priceType: ota.priceType, link: ota.link, official: ota.official },
        }).catch(() => {});
        const label = canonLabel(ota.source);
        if (!collected.has(label)) {
          collected.set(label, {
            source: label, price: ota.price, currency: ota.currency || resolvedCurrency, via: 'serpapi',
          });
          emitProgress({ stage: 'own', channel: label, status: 'done', price: ota.price, via: 'serpapi' });
        }
      }

      // ── Waterfall fallback: yetishmagan 5 kanalni to'ldiramiz ──────────
      // SerpAPI bermagan kanallar uchun maxsus API yuboramiz (Booking → HasData,
      // Expedia/Hotels.com/Trip.com → Apify). Parallel — tezroq.
      const presentLabels = new Set(collected.keys());
      const missing = TARGET_CHANNELS.filter(
        (c) => !presentLabels.has(c.label) && c.label !== 'Agoda'
      );
      const ownTarget = {
        name: hotel.name,
        city: hotel.city,
        otaUrls: normalizeOtaUrls(hotel.otaUrls),
        persist: (key, url) => persistOtaUrl(hotel, key, url),
      };
      // Agoda fallbacksiz — UI'da kulrang "o'tkazib yuborildi" sifatida ko'rsatamiz.
      if (!presentLabels.has('Agoda')) {
        emitProgress({ stage: 'own', channel: 'Agoda', status: 'skipped' });
      }
      const fallbackResults = await Promise.all(
        missing.map(async (c) => {
          emitProgress({ stage: 'own', channel: c.label, status: 'processing', via: 'fallback' });
          const res = await fetchChannelFallback(ownTarget, c.label, ciStr, coStr);
          emitProgress({
            stage: 'own', channel: c.label,
            status: res ? 'done' : 'fail',
            price: res?.price, via: res?.via || 'fallback',
          });
          return { label: c.label, res };
        })
      );
      const fallbackSummary = [];
      for (const { label, res } of fallbackResults) {
        if (!res) { fallbackSummary.push({ source: label, found: false }); continue; }
        await PriceSnapshot.create({
          targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
          ota: label, price: res.price, currency: res.currency || 'USD',
          checkIn, checkOut, source: res.via,
          raw: { link: res.link, via: res.via },
        }).catch(() => {});
        collected.set(label, { source: label, price: res.price, currency: res.currency || 'USD', via: res.via });
        fallbackSummary.push({ source: label, found: true, price: res.price, via: res.via });
      }

      // "Mening narxim" — Booking.com narxi (foydalanuvchi so'roviga ko'ra).
      // Booking topilmasa, eng arzon kanal narxi bilan to'ldiramiz.
      const all = [...collected.values()];
      if (all.length) {
        const booking = all.find((o) => o.source === 'Booking.com');
        const chosen = booking || all.reduce((a, b) => (b.price < a.price ? b : a));
        if (chosen.price > 0) {
          await Hotel.updateOne(
            { _id: hotel._id },
            { $set: { currentPrice: chosen.price, currency: chosen.currency || resolvedCurrency } }
          ).catch(() => {});
        }
        summary.own.channels = all.length;
        summary.own.otaPrices = all.map((o) => ({ source: o.source, price: o.price, via: o.via }));
      } else {
        summary.own.message = "Bu mehmonxona uchun hech qaysi kanaldan narx topilmadi";
      }
      summary.own.fallback = fallbackSummary;

      if (data?.propertyToken && !hotel.serpPropertyToken) {
        await Hotel.updateOne({ _id: hotel._id }, { $set: { serpPropertyToken: data.propertyToken } }).catch(() => {});
      }

      // Hotel metadata (reyting, sharh soni, rasm, yulduz) ham yangilanadi —
      // Rating Map sahifasida ko'rinadi. (Faqat SerpAPI data bo'lsa.)
      if (data) {
        const metaUpdate = {};
        if (data.rating > 0) metaUpdate.rating = data.rating;
        if (data.reviewCount > 0) metaUpdate.reviewCount = data.reviewCount;
        if (data.image) metaUpdate.photoUrl = data.image;
        if (data.hotelClass > 0) metaUpdate.stars = data.hotelClass;
        if (Object.keys(metaUpdate).length) {
          await Hotel.updateOne({ _id: hotel._id }, { $set: metaUpdate }).catch(() => {});
        }
      }
    } catch (err) {
      summary.own.message = `Xato: ${err.message}`;
    }
    emitProgress({ stage: 'own', status: 'complete', channels: summary.own.channels });

    // ── 2. Raqiblar — har biri uchun 1 ta SerpAPI so'rovi ────────────────
    const competitors = await Competitor.find({
      ownerHotelId: hotel._id, isActive: true,
    }).limit(20);
    summary.competitors.total = competitors.length;
    emitProgress({ stage: 'competitors', status: 'start', total: competitors.length });

    let compIndex = 0;
    for (const comp of competitors) {
      compIndex += 1;
      emitProgress({
        stage: 'competitor', name: comp.name,
        index: compIndex, total: competitors.length, status: 'processing',
      });
      try {
        const data = await getSerpApiHotelData({
          name: comp.name, city: hotel.city, countryCode: hotel.countryCode,
        });
        // Google aggregator olib tashlanadi.
        const compCurrency = data?.currency || 'USD';
        const serpOtas = (data?.otaPrices || []).filter((o) => {
          if (!o.source || !(o.price > 0)) return false;
          const lower = String(o.source).toLowerCase();
          return lower !== 'google' && lower !== 'google hotels';
        }).map((o) => ({
          source: o.source, price: o.price, currency: o.currency || compCurrency,
          priceType: o.priceType, link: o.link, via: 'serpapi',
        }));

        // SerpAPI raqibni topsa — undan olaveramiz. Topolmasa (bo'sh) —
        // raqibni HasData/Apify fallback'ga yuboramiz (foydalanuvchi so'rovi).
        let otaPrices = serpOtas;
        let viaFallback = false;
        if (!otaPrices.length) {
          const compTarget = { name: comp.name, city: hotel.city, otaUrls: {}, persist: null };
          const fbChannels = TARGET_CHANNELS.filter((c) => c.label !== 'Agoda');
          const fb = await Promise.all(
            fbChannels.map(async (c) => {
              const res = await fetchChannelFallback(compTarget, c.label, ciStr, coStr);
              return res
                ? { source: c.label, price: res.price, currency: res.currency || 'USD', link: res.link, via: res.via }
                : null;
            })
          );
          otaPrices = fb.filter(Boolean);
          viaFallback = otaPrices.length > 0;
        }

        if (!otaPrices.length) {
          summary.competitors.failed++;
          summary.competitors.items.push({ name: comp.name, matched: false });
          emitProgress({
            stage: 'competitor', name: comp.name,
            index: compIndex, total: competitors.length, status: 'failed',
          });
          continue;
        }

        // latestPrices Map yangilash
        if (!(comp.latestPrices instanceof Map)) {
          comp.latestPrices = new Map(Object.entries(comp.latestPrices || {}));
        }
        for (const ota of otaPrices) {
          const key = ota.source.toLowerCase().replace(/[^a-z0-9]/g, '');
          comp.latestPrices.set(key, ota.price);
        }
        // Google aggregator narxini latestPrices'da ham saqlamaymiz.
        comp.latestPrices.delete('google');
        if (data) {
          if (!comp.stars && data.hotelClass) comp.stars = data.hotelClass;
          if (!comp.rating && data.rating) comp.rating = data.rating;
          if (!comp.reviewCount && data.reviewCount) comp.reviewCount = data.reviewCount;
          if (!comp.photoUrl && data.image) comp.photoUrl = data.image;
        }
        comp.lastPriceFetchedAt = new Date();
        await comp.save();

        // PriceSnapshot — Rate Shopper jadvali uchun
        for (const ota of otaPrices) {
          await PriceSnapshot.create({
            targetType: 'competitor', targetId: comp._id, ownerHotelId: hotel._id,
            ota: ota.source, price: ota.price, currency: ota.currency || compCurrency,
            checkIn, checkOut, source: ota.via || 'serpapi',
            raw: { priceType: ota.priceType, link: ota.link, via: ota.via },
          }).catch(() => {});
        }

        summary.competitors.matched++;
        const compLowest = Math.min(...otaPrices.map((o) => o.price));
        summary.competitors.items.push({
          name: comp.name,
          matched: true,
          via: viaFallback ? 'fallback' : 'serpapi',
          channels: otaPrices.length,
          lowest: compLowest,
        });
        emitProgress({
          stage: 'competitor', name: comp.name,
          index: compIndex, total: competitors.length, status: 'done',
          channels: otaPrices.length, lowest: compLowest,
          via: viaFallback ? 'fallback' : 'serpapi',
        });
      } catch (err) {
        summary.competitors.failed++;
        summary.competitors.items.push({ name: comp.name, matched: false, error: err.message });
        emitProgress({
          stage: 'competitor', name: comp.name,
          index: compIndex, total: competitors.length, status: 'failed',
        });
      }
    }

    emitProgress({ stage: 'complete', summary });
    res.json(summary);
  } catch (err) { next(err); }
}
