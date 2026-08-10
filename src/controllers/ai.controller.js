import mongoose from "mongoose";
import Hotel from "../models/Hotel.js";
import Competitor from "../models/Competitor.js";
import Review from "../models/Review.js";
import {
  analyzeReview,
  getPriceRecommendations,
  summarizeReviews,
  isAIEnabled,
} from "../services/openai.service.js";
import { chatSupport, assistantChat, getOtaChannelAdvice, isGeminiEnabled } from "../services/gemini.service.js";
import PriceSnapshot from "../models/PriceSnapshot.js";
import { planAllows } from "../config/plans.js";

export function getAIStatus(req, res) {
  // allowed — foydalanuvchi tarifida AI bormi (Starter'da yo'q). Frontend
  // shuni o'qib AI tugmalarini yashiradi/qulflaydi.
  const allowed = req.user?.role === 'admin' || planAllows(req.user?.plan, 'ai');
  res.json({ enabled: isAIEnabled(), model: "gpt-4o-mini", allowed });
}

export async function aiPriceRecommendations(req, res, next) {
  try {
    if (!isAIEnabled())
      return res.status(503).json({ error: "OpenAI API kaliti sozlanmagan" });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: "Hotel topilmadi" });

    // Kesh — token tejash uchun. refresh=true bo'lmasa va kesh mavjud bo'lsa,
    // AI'ga qayta so'rov yubormaymiz. MUHIM: kesh TILI ham mos bo'lishi kerak —
    // sayt tili o'zgarsa (uz→ru), eski tildagi kesh ishlatilmaydi.
    const refresh = req.query.refresh === "true";
    const reqLang = req.query.lang || "uz";
    if (!refresh && hotel.aiPriceRecs?.recommendations?.length &&
        (hotel.aiPriceRecs.lang || "uz") === reqLang) {
      return res.json({ ...hotel.aiPriceRecs, cached: true, asOf: hotel.aiPriceRecsAt });
    }

    const competitors = await Competitor.find({
      ownerHotelId: hotel._id,
      isActive: true,
    }).limit(10);
    const bestCompPrice = (c) => {
      const get = (k) => c.latestPrices?.get?.(k) || 0;
      return get("bookingcom") || get("booking") || get("agoda") ||
        get("expedia") || get("hotelscom") || get("tripcom") ||
        get("tripadvisorcom") || get("viocom") || 0;
    };
    const compData = competitors.map((c) => ({
      name: c.name,
      price: bestCompPrice(c),
      stars: c.stars || 0,
      distanceKm: c.distanceKm || 0,
    }));

    const prices = compData.map((c) => c.price).filter((p) => p > 0);
    const marketAvg = prices.length
      ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
      : 0;

    // Mehmonxona-xizmati moduliga ulanganmi? — hs_hotels kolleksiyasida
    // hotel_id = RateRadar hotel _id (SSO birinchi kirishda yaratiladi).
    // Ulangan bo'lsa oxirgi 30 kunlik REAL statistika ham yig'iladi —
    // AI "service" bo'limi shu raqamlar asosida tahlil beradi.
    let hotelServiceConnected = false;
    let hsStats = null;
    try {
      const hsId = hotel._id.toString();
      const hs = await mongoose.connection.db
        .collection("hs_hotels")
        .findOne({ hotel_id: hsId }, { projection: { _id: 1 } });
      hotelServiceConnected = !!hs;

      if (hotelServiceConnected) {
        const since = new Date(Date.now() - 30 * 86400_000);
        const reqCol = mongoose.connection.db.collection("hs_requests");
        const [total, completed, pending, avgAgg, topAgg] = await Promise.all([
          reqCol.countDocuments({ hotel_id: hsId, created_at: { $gte: since } }),
          reqCol.countDocuments({ hotel_id: hsId, created_at: { $gte: since }, status: "completed" }),
          reqCol.countDocuments({ hotel_id: hsId, created_at: { $gte: since }, status: "pending" }),
          reqCol.aggregate([
            { $match: { hotel_id: hsId, created_at: { $gte: since }, status: "completed", accepted_at: { $ne: null } } },
            { $group: { _id: null, avgMin: { $avg: { $divide: [{ $subtract: ["$completed_at", "$accepted_at"] }, 60000] } } } },
          ]).toArray(),
          reqCol.aggregate([
            { $match: { hotel_id: hsId, created_at: { $gte: since } } },
            { $group: { _id: "$service_id", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 3 },
            { $lookup: { from: "hs_services", localField: "_id", foreignField: "_id", as: "svc" } },
          ]).toArray(),
        ]);
        if (total > 0) {
          hsStats = {
            total,
            completed,
            pending,
            avgCompleteMin: avgAgg[0]?.avgMin ? Math.round(avgAgg[0].avgMin) : null,
            topServices: topAgg.map((t) => ({ name: t.svc?.[0]?.name || "?", count: t.count })),
          };
        }
      }
    } catch {
      /* kolleksiya yo'q bo'lsa — ulanmagan deb hisoblaymiz */
    }

    const lang = req.query.lang || "uz";

    // ── BARCHA SAHIFALAR ma'lumoti — holistik (butun boshli) AI maslahat uchun.
    // Kategoriya reytinglari (Reyting xaritasi sahifasi), OTA kanallar (OTA
    // Kanallar), xona narxlari (Rate/Room Shopper), sharhlar (Sharhlar sahifasi).
    const categoryScores =
      hotel.categoryRatings?.scores && Object.keys(hotel.categoryRatings.scores).length
        ? hotel.categoryRatings.scores
        : null;
    const otaChannels = Array.isArray(hotel.otaChannels) ? hotel.otaChannels : [];
    const roomTypes = (hotel.roomTypes || []).map((r) => ({
      name: r.name,
      price: r.basePrice || 0,
      guests: r.guests || 2,
    }));

    // Oxirgi sharhlar (o'z hotel) — takroriy shikoyat/maqtov mavzulari uchun.
    let reviewsDigest = [];
    try {
      const recent = await Review.find({ ownerHotelId: hotel._id, targetType: "own" })
        .sort({ publishedAt: -1 })
        .limit(15)
        .lean();
      reviewsDigest = recent
        .map((r) => ({
          rating: r.rating,
          sentiment: r.sentiment,
          text: (r.text || "").slice(0, 160),
        }))
        .filter((r) => r.text);
    } catch {
      /* sharh bo'lmasa — bo'sh */
    }

    const result = await getPriceRecommendations({
      myHotel: hotel.name,
      myPrice: hotel.currentPrice || 0,
      competitors: compData,
      marketAvg,
      rating: hotel.rating || 0,
      reviewCount: hotel.reviewCount || 0,
      stars: hotel.stars || 0,
      hotelServiceConnected,
      categoryScores,
      otaChannels,
      roomTypes,
      reviewsDigest,
      city: hotel.city || "",
      country: hotel.country || "",
      todayStr: new Date().toISOString().slice(0, 10),
      hsStats,
      lang,
    });

    // Natijani keshlaymiz (faqat haqiqiy tavsiya bo'lsa) — tili bilan birga.
    if (result?.recommendations?.length) {
      result.lang = lang;
      const now = new Date();
      await Hotel.updateOne(
        { _id: hotel._id },
        { $set: { aiPriceRecs: result, aiPriceRecsAt: now } },
      ).catch(() => {});
      return res.json({ ...result, cached: false, asOf: now });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function aiSummarizeReviews(req, res, next) {
  try {
    if (!isAIEnabled())
      return res.status(503).json({ error: "OpenAI API kaliti sozlanmagan" });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: "Hotel topilmadi" });

    const lang = req.query.lang || "uz";
    const reviews = await Review.find({ ownerHotelId: hotel._id })
      .sort({ publishedAt: -1 })
      .limit(20)
      .lean();

    if (!reviews.length) {
      return res.json({
        strengths: [],
        weaknesses: [],
        summary:
          lang === "uz"
            ? "Hali sharhlar mavjud emas."
            : lang === "ru"
              ? "Отзывов пока нет."
              : "No reviews yet.",
        recommendedActions: [],
      });
    }

    const result = await summarizeReviews(reviews, lang);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function aiAnalyzeSingleReview(req, res, next) {
  try {
    if (!isAIEnabled())
      return res.status(503).json({ error: "OpenAI API kaliti sozlanmagan" });

    const { text, lang = "uz" } = req.body;
    if (!text || !text.trim())
      return res.status(400).json({ error: "text maydoni talab etiladi" });

    const result = await analyzeReview(text.trim(), lang);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// OTA nomini bir xil kalitga keltirish ("Booking.com" == "bookingcom")
const otaKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Ko'rsatiladigan standart nomlar
const OTA_DISPLAY = {
  bookingcom: 'Booking.com', booking: 'Booking.com', agoda: 'Agoda',
  expedia: 'Expedia', hotelscom: 'Hotels.com', tripcom: 'Trip.com',
  google: 'Google', priceline: 'Priceline', viocom: 'Vio.com',
};

/**
 * GET /ai/ota-advice — HAR BIR OTA KANALI uchun AI narx tavsiyasi.
 * Own va raqib narxlari PriceSnapshot'dan (oxirgi 7 kun, har kanal bo'yicha
 * eng so'nggisi) olinadi, statistika serverda hisoblanadi, Gemini har kanalga
 * suggestedPrice + sabab beradi. 6 soat keshlanadi; ?refresh=true — majburiy.
 */
const OTA_ADVICE_FRESH_MS = 6 * 3600_000;

export async function aiOtaAdvice(req, res, next) {
  try {
    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: 'Hotel topilmadi' });
    if (!isGeminiEnabled()) return res.status(503).json({ error: 'Gemini API kaliti sozlanmagan' });

    const refresh = req.query.refresh === 'true';
    const reqLang2 = req.query.lang || 'uz';
    const isFresh = hotel.aiOtaAdviceAt &&
      Date.now() - new Date(hotel.aiOtaAdviceAt).getTime() < OTA_ADVICE_FRESH_MS;
    // Kesh tili sayt tiliga mos bo'lsagina ishlatiladi
    if (!refresh && isFresh && hotel.aiOtaAdvice?.channels?.length &&
        (hotel.aiOtaAdvice.lang || 'uz') === reqLang2) {
      return res.json({ ...hotel.aiOtaAdvice, asOf: hotel.aiOtaAdviceAt, cached: true });
    }

    // ── Oxirgi 7 kunlik snapshotlardan har (target, kanal) ning eng so'nggisi ──
    const since = new Date(Date.now() - 7 * 86400_000);
    const snaps = await PriceSnapshot.aggregate([
      { $match: { ownerHotelId: hotel._id, snapshotAt: { $gte: since }, price: { $gt: 0 } } },
      { $sort: { snapshotAt: -1 } },
      {
        $group: {
          _id: { targetType: '$targetType', targetId: '$targetId', ota: '$ota' },
          price: { $first: '$price' },
        },
      },
    ]);

    // Raqib nomlari (kartada "Hotel X: $104" deb chiqarish uchun)
    const compIds = [...new Set(
      snaps.filter((s) => s._id.targetType === 'competitor').map((s) => String(s._id.targetId))
    )];
    const comps = await Competitor.find({ _id: { $in: compIds } }).select('name').lean();
    const compName = new Map(comps.map((c) => [String(c._id), c.name]));

    // Kanal bo'yicha guruhlash
    const byChannel = new Map(); // key → { channel, currentPrice, compPrices: [{name, price}] }
    for (const s of snaps) {
      const key = otaKey(s._id.ota);
      if (!key) continue;
      const display = OTA_DISPLAY[key] || s._id.ota;
      if (!byChannel.has(key)) byChannel.set(key, { channel: display, currentPrice: 0, compPrices: [] });
      const ch = byChannel.get(key);
      if (s._id.targetType === 'own') {
        if (!ch.currentPrice) ch.currentPrice = Math.round(s.price);
      } else {
        const nm = compName.get(String(s._id.targetId));
        // Bitta raqibning bitta kanalda faqat eng so'nggi narxi
        if (nm && !ch.compPrices.some((p) => p.name === nm)) {
          ch.compPrices.push({ name: nm, price: Math.round(s.price) });
        }
      }
    }

    // Statistika — faqat raqib narxi bor kanallar tahlilga kiradi
    const channels = [...byChannel.values()]
      .filter((c) => c.compPrices.length > 0)
      .map((c) => {
        const prices = c.compPrices.map((p) => p.price).sort((a, b) => a - b);
        const mid = Math.floor(prices.length / 2);
        const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
        const total = prices.length + (c.currentPrice > 0 ? 1 : 0);
        const rank = c.currentPrice > 0
          ? prices.filter((p) => p < c.currentPrice).length + 1
          : null;
        return {
          ...c,
          min: prices[0],
          max: prices[prices.length - 1],
          median: Math.round(median * 10) / 10,
          rank,
          total,
        };
      });

    if (!channels.length) {
      return res.json({
        summary: '', channels: [], asOf: null, cached: false,
        reason: 'no_data',
      });
    }

    const lang = req.query.lang || 'uz';

    // NARX SIGNALI — raqib narxi nega o'zgardi (bozor/sezon vs shaxsiy to'lish).
    // AI shu kontekstda "bozor ko'targan" vs "bitta raqib" farqini hisobga oladi.
    let signal = null;
    try {
      const { getPriceSignals } = await import('../services/priceSignal.service.js');
      signal = await getPriceSignals(hotel._id);
    } catch { /* signal ixtiyoriy */ }

    const ai = await getOtaChannelAdvice({
      hotelName: hotel.name,
      stars: hotel.stars || 0,
      rating: hotel.rating || 0,
      channels,
      lang,
      marketSignal: signal ? { headline: signal.headline, recommendation: signal.recommendation } : null,
    });

    // AI javobini server statistikasi bilan birlashtiramiz
    const aiByKey = new Map((ai.channels || []).map((c) => [otaKey(c.channel), c]));
    const merged = channels.map((c) => {
      const a = aiByKey.get(otaKey(c.channel)) || {};
      const suggested = Number(a.suggestedPrice) > 0 ? Math.round(a.suggestedPrice) : 0;
      return {
        channel: c.channel,
        currentPrice: c.currentPrice,
        suggestedPrice: suggested,
        delta: c.currentPrice > 0 && suggested ? suggested - c.currentPrice : 0,
        action: ['raise', 'lower', 'keep'].includes(a.action)
          ? a.action
          : suggested && c.currentPrice ? (suggested > c.currentPrice ? 'raise' : suggested < c.currentPrice ? 'lower' : 'keep') : 'keep',
        reason: a.reason || '',
        stats: { min: c.min, max: c.max, median: c.median, rank: c.rank, total: c.total },
      };
    }).filter((c) => c.suggestedPrice > 0 || c.currentPrice > 0);

    const result = { summary: ai.summary || '', channels: merged, engine: 'gemini', lang };
    const now = new Date();
    await Hotel.updateOne(
      { _id: hotel._id },
      { $set: { aiOtaAdvice: result, aiOtaAdviceAt: now } },
    ).catch(() => {});

    res.json({ ...result, asOf: now, cached: false });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /ai/assistant-chat — AI-tahlil sahifasidagi CHAT.
 * Mehmonxona egasi istalgan travel/hotel savolini beradi; javobga uning
 * mehmonxonasi konteksti (nom, shahar, narx, reyting, raqiblar) qo'shiladi.
 */
export async function aiAssistantChat(req, res, next) {
  try {
    const { messages, lang: chatLang } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages talab etiladi" });
    }
    const safe = messages.slice(-20).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 1000),
    }));

    // Hotel konteksti — qisqa, tokenlarni tejab
    const hotel = req.hotel;
    let context = '';
    if (hotel) {
      const parts = [
        `Nomi: ${hotel.name}${hotel.city ? `, ${hotel.city}` : ''}${hotel.country ? ` (${hotel.country})` : ''}`,
        hotel.stars ? `Yulduz: ${hotel.stars}` : '',
        hotel.rating ? `Reyting: ${hotel.rating} (${hotel.reviewCount || 0} sharh)` : '',
        hotel.currentPrice ? `Joriy narx: ${hotel.currentPrice} ${hotel.currency || 'USD'}` : '',
        hotel.rooms ? `Xonalar soni: ${hotel.rooms}` : '',
      ].filter(Boolean);
      try {
        const comps = await Competitor.find({ ownerHotelId: hotel._id, isActive: true })
          .select('name latestPrices stars').limit(6).lean();
        if (comps.length) {
          const compLine = comps.map((c) => {
            const p = c.latestPrices?.bookingcom || c.latestPrices?.booking ||
              Object.values(c.latestPrices || {}).find((v) => v > 0) || 0;
            return `${c.name}${p ? ` ($${p})` : ''}`;
          }).join(', ');
          parts.push(`Raqiblar: ${compLine}`);
        }
      } catch { /* raqibsiz davom etamiz */ }

      // Oxirgi SHARHLAR — AI ular haqida bemalol gaplasha olishi uchun.
      // Eng yangi 15 tasi, matni qisqartirilgan (token tejash).
      try {
        const reviews = await Review.find({ ownerHotelId: hotel._id, targetType: 'own' })
          .sort({ publishedAt: -1 })
          .select('platform rating text sentiment publishedAt author')
          .limit(15)
          .lean();
        if (reviews.length) {
          const lines = reviews.map((r) => {
            const d = r.publishedAt ? new Date(r.publishedAt).toISOString().slice(0, 10) : '';
            const txt = String(r.text || '').replace(/\s+/g, ' ').slice(0, 220);
            return `- [${r.platform} ${r.rating}★ ${d}] ${txt}`;
          });
          parts.push(`Oxirgi sharhlar (${reviews.length} ta):\n${lines.join('\n')}`);
        }
      } catch { /* sharhsiz davom etamiz */ }

      context = parts.join('\n');
    }

    const reply = await assistantChat(safe, context, chatLang || 'uz');
    res.json({ reply });
  } catch (err) {
    next(err);
  }
}

export async function aiChatSupport(req, res, next) {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages talab etiladi" });
    }
    // Xavfsizlik: maksimum 20 xabar, har biri 500 belgidan oshmasin
    const safe = messages.slice(-20).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500),
    }));
    const reply = await chatSupport(safe);
    res.json({ reply });
  } catch (err) {
    next(err);
  }
}
