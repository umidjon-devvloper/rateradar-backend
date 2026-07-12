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
import { chatSupport, assistantChat } from "../services/gemini.service.js";

export function getAIStatus(req, res) {
  res.json({ enabled: isAIEnabled(), model: "gpt-4o-mini" });
}

export async function aiPriceRecommendations(req, res, next) {
  try {
    if (!isAIEnabled())
      return res.status(503).json({ error: "OpenAI API kaliti sozlanmagan" });

    const hotel = req.hotel;
    if (!hotel) return res.status(404).json({ error: "Hotel topilmadi" });

    // Kesh — token tejash uchun. refresh=true bo'lmasa va kesh mavjud bo'lsa,
    // AI'ga qayta so'rov yubormaymiz (foydalanuvchi "Yangilash" bosgandagina).
    const refresh = req.query.refresh === "true";
    if (!refresh && hotel.aiPriceRecs?.recommendations?.length) {
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
    let hotelServiceConnected = false;
    try {
      const hs = await mongoose.connection.db
        .collection("hs_hotels")
        .findOne({ hotel_id: hotel._id.toString() }, { projection: { _id: 1 } });
      hotelServiceConnected = !!hs;
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
      lang,
    });

    // Natijani keshlaymiz (faqat haqiqiy tavsiya bo'lsa).
    if (result?.recommendations?.length) {
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

/**
 * POST /ai/assistant-chat — AI-tahlil sahifasidagi CHAT.
 * Mehmonxona egasi istalgan travel/hotel savolini beradi; javobga uning
 * mehmonxonasi konteksti (nom, shahar, narx, reyting, raqiblar) qo'shiladi.
 */
export async function aiAssistantChat(req, res, next) {
  try {
    const { messages } = req.body;
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
      context = parts.join('\n');
    }

    const reply = await assistantChat(safe, context);
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
