import Notification from '../models/Notification.js';
import Hotel from '../models/Hotel.js';
import Competitor from '../models/Competitor.js';
import { emitToUser } from '../services/socket.service.js';

// Demo price for today — same logic as prices.controller.js
function demoPriceToday(competitor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const basePrice =
    competitor.latestPrices?.get?.('booking') ||
    competitor.latestPrices?.get?.('google') ||
    60 + Math.abs(competitor.distanceKm || 1) * 5;
  const seed = today.getTime() / 86400000 + (competitor._id?.toString?.().charCodeAt(0) || 0);
  const pseudoRandom = Math.abs(Math.sin(seed));
  const dow = today.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const multiplier = isWeekend ? 1.10 + pseudoRandom * 0.05 : 0.95 + pseudoRandom * 0.10;
  return Math.round(basePrice * multiplier);
}

// Aktiv mehmonxona bo'yicha filtr. Mehmonxona tanlangan bo'lsa — faqat o'sha
// mehmonxona bildirishnomalari + foydalanuvchi darajasidagilar (hotelId: null,
// masalan admin broadcast). Mehmonxona yo'q bo'lsa — barchasi (userId bo'yicha).
function notifFilter(req) {
  const userId = req.user._id;
  const hotelId = req.hotel?._id || null;
  if (!hotelId) return { userId };
  return { userId, $or: [{ hotelId }, { hotelId: null }] };
}

export async function listNotifications(req, res, next) {
  try {
    const filter = notifFilter(req);

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const unreadCount = await Notification.countDocuments({ ...filter, read: false });

    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function getUnreadCount(req, res, next) {
  try {
    const count = await Notification.countDocuments({ ...notifFilter(req), read: false });
    res.json({ count });
  } catch (err) {
    next(err);
  }
}

export async function markRead(req, res, next) {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { read: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Bildirishnoma topilmadi' });
    }

    res.json({ notification });
  } catch (err) {
    next(err);
  }
}

export async function markAllRead(req, res, next) {
  try {
    const result = await Notification.updateMany(
      { ...notifFilter(req), read: false },
      { read: true, readAt: new Date() }
    );

    res.json({ updated: result.modifiedCount });
  } catch (err) {
    next(err);
  }
}

export async function checkCompetitorPrices(req, res, next) {
  try {
    const lang = ['uz', 'en', 'ru'].includes(req.query.lang) ? req.query.lang : 'en';

    const hotel = req.hotel;
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel topilmadi' });
    }

    if (!hotel.currentPrice || hotel.currentPrice === 0) {
      return res.json({ created: 0, message: 'Hotel currentPrice not set' });
    }

    const competitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true });

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let created = 0;

    // OTA kalitlarini insondek o'qiladigan brand nomiga aylantirish
    const OTA_LABEL = {
      bookingcom: 'Booking.com',
      booking: 'Booking.com',
      agoda: 'Agoda',
      hotelscom: 'Hotels.com',
      hotels: 'Hotels.com',
      expedia: 'Expedia',
      tripcom: 'Trip.com',
      trip: 'Trip.com',
      priceline: 'Priceline',
      viocom: 'Vio.com',
      vio: 'Vio.com',
      edreams: 'eDreams',
      tripadvisor: 'TripAdvisor',
      hostelworld: 'Hostelworld',
      bluepillowcom: 'Bluepillow.com',
      bluepillow: 'Bluepillow.com',
      google: 'Google Hotels',
    };

    for (const comp of competitors) {
      // Eng arzon narxni va u qaysi OTA'dan kelganini topamiz
      let lowestPrice = null;
      let lowestSource = '';
      if (comp.latestPrices && comp.latestPrices.size > 0) {
        for (const [key, price] of comp.latestPrices) {
          if (typeof price === 'number' && price > 0) {
            if (lowestPrice === null || price < lowestPrice) {
              lowestPrice = price;
              lowestSource = key;
            }
          }
        }
      }
      // Fallback: use demo price if no real data exists
      if (lowestPrice === null) {
        lowestPrice = demoPriceToday(comp);
      }

      if (!lowestPrice || lowestPrice >= hotel.currentPrice) continue;

      // Check for duplicate notification within last 24h
      const existingNotification = await Notification.findOne({
        userId: req.user._id,
        hotelId: hotel._id,
        type: 'competitor_below',
        relatedId: comp._id,
        createdAt: { $gte: since24h },
      });

      if (existingNotification) continue;

      const diff = Math.round(((hotel.currentPrice - lowestPrice) / hotel.currentPrice) * 100);
      const sourceLabel = lowestSource ? (OTA_LABEL[lowestSource] || lowestSource) : '';

      const messages = {
        uz: {
          title: '⚠️ Raqobatdosh narxi past',
          message: sourceLabel
            ? `${comp.name} ${sourceLabel}'da sizdan ${diff}% arzon narx qo'ydi. Narxingizni ko'rib chiqing!`
            : `${comp.name} sizdan ${diff}% arzon narx qo'ydi. Narxingizni ko'rib chiqing!`,
        },
        en: {
          title: '⚠️ Competitor price lower',
          message: sourceLabel
            ? `${comp.name} listed on ${sourceLabel} ${diff}% lower than yours. Review your pricing!`
            : `${comp.name} set price ${diff}% lower than yours. Review your pricing!`,
        },
        ru: {
          title: '⚠️ Цена конкурента ниже',
          message: sourceLabel
            ? `${comp.name} на ${sourceLabel} установил цену на ${diff}% ниже вашей. Пересмотрите цены!`
            : `${comp.name} установил цену на ${diff}% ниже вашей. Пересмотрите цены!`,
        },
      };

      const { title, message } = messages[lang];

      const created_notif = await Notification.create({
        userId: req.user._id,
        hotelId: hotel._id,
        type: 'competitor_below',
        severity: 'warning',
        title,
        message,
        relatedType: 'competitor',
        relatedId: comp._id,
        payload: {
          competitorName: comp.name,
          competitorPrice: lowestPrice,
          competitorSource: sourceLabel,
          hotelPrice: hotel.currentPrice,
          diffPercent: diff,
        },
      });

      emitToUser(req.user._id, 'notification:new', created_notif.toObject());
      created++;
    }

    // ── BOZOR SIGNALI — bir nechta raqib birga narx ko'targanda (sezon/talab) ──
    // Kuniga bir marta (24h dedup): "bozor ko'tarilyapti, siz ham ko'ring".
    try {
      const { analyzePriceMovements } = await import('../services/priceSignal.service.js');
      const mv = await analyzePriceMovements(hotel._id);
      if (mv.market.rising) {
        const dup = await Notification.findOne({
          userId: req.user._id, hotelId: hotel._id, type: 'market_rising',
          createdAt: { $gte: since24h },
        });
        if (!dup) {
          const mt = {
            uz: { title: '📈 Bozor ko\'tarilyapti', message: `${mv.market.risers}/${mv.market.total} raqib narxni ~${mv.market.avgRise}% oshirdi (sezon/talab). Siz ham narxni ko'tarishni ko'rib chiqing.` },
            en: { title: '📈 Market is rising', message: `${mv.market.risers}/${mv.market.total} competitors raised prices ~${mv.market.avgRise}% (season/demand). Consider raising yours.` },
            ru: { title: '📈 Рынок растёт', message: `${mv.market.risers}/${mv.market.total} конкурентов подняли цены ~${mv.market.avgRise}% (сезон/спрос). Рассмотрите повышение.` },
          }[lang];
          const n = await Notification.create({
            userId: req.user._id, hotelId: hotel._id,
            type: 'market_rising', severity: 'info',
            title: mt.title, message: mt.message,
            payload: { risers: mv.market.risers, total: mv.market.total, avgRise: mv.market.avgRise },
          });
          emitToUser(req.user._id, 'notification:new', n.toObject());
          created++;
        }
      }
    } catch { /* signal ixtiyoriy */ }

    res.json({ created });
  } catch (err) {
    next(err);
  }
}
