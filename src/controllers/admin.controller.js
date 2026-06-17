import User from "../models/User.js";
import Hotel from "../models/Hotel.js";
import Competitor from "../models/Competitor.js";
import PriceSnapshot from "../models/PriceSnapshot.js";
import Review from "../models/Review.js";
import ApiUsage from "../models/ApiUsage.js";
import Notification from "../models/Notification.js";
import { PROVIDER_REGISTRY, RECOMMENDED_APIS } from "../utils/apiUsageTracker.js";
import { sendBroadcastEmail } from "../services/email.service.js";
import { emitToUser } from "../services/socket.service.js";
import { env } from "../config/env.js";

export async function getDashboard(req, res, next) {
  try {
    const [users, hotels, competitors, snapshots, reviews] = await Promise.all([
      User.countDocuments(),
      Hotel.countDocuments(),
      Competitor.countDocuments(),
      PriceSnapshot.countDocuments(),
      Review.countDocuments(),
    ]);
    const usersByPlan = await User.aggregate([
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]);
    const usersByCountry = await User.aggregate([
      { $group: { _id: "$countryCode", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentSignups = await User.countDocuments({
      createdAt: { $gte: sevenDaysAgo },
    });
    res.json({
      counts: { users, hotels, competitors, snapshots, reviews, recentSignups },
      usersByPlan,
      usersByCountry,
    });
  } catch (err) {
    next(err);
  }
}


export async function listUsers(req, res, next) {
  try {
    const { page = 1, limit = 50, search = "", plan = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const filter = {};
    if (search) {
      filter.$or = [
        { email: new RegExp(search, "i") },
        { name: new RegExp(search, "i") },
        { city: new RegExp(search, "i") },
      ];
    }
    if (plan) filter.plan = plan;
    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);
    res.json({
      users,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
}

export async function getUserDetail(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Topilmadi" });
    const hotel = await Hotel.findOne({ userId: user._id });
    const competitorCount = hotel
      ? await Competitor.countDocuments({ ownerHotelId: hotel._id })
      : 0;
    res.json({ user, hotel, competitorCount });
  } catch (err) {
    next(err);
  }
}

export async function toggleUserActive(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Topilmadi" });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

export async function getApiStats(req, res, next) {
  try {
    const ym = new Date().toISOString().slice(0, 7);
    const usageDocs = await ApiUsage.aggregate([
      { $match: { yearMonth: ym } },
      {
        $group: {
          _id: "$provider",
          requestCount: { $sum: "$requestCount" },
          successCount: { $sum: "$successCount" },
          failureCount: { $sum: "$failureCount" },
          lastSuccessAt: { $max: "$lastSuccessAt" },
          lastFailureAt: { $max: "$lastFailureAt" },
          lastError: { $last: "$lastError" },
          disabled: { $max: "$disabled" },
        },
      },
    ]);
    const usageByName = Object.fromEntries(usageDocs.map((u) => [u._id, u]));

    const keyMap = {
      serpapi: env.SERPAPI_API_KEY,
      apify: env.APIFY_API_KEY,
      hasdata: env.HASDATA_API_KEY,
      google_places: env.GOOGLE_PLACES_API_KEY,
      yandex: env.YANDEX_GEOSEARCH_API_KEY,
      gemini: env.GEMINI_API_KEY,
      openai: env.OPENAI_API_KEY,
    };

    const providers = Object.entries(PROVIDER_REGISTRY).map(([name, info]) => {
      const usage = usageByName[name] || {};
      const requestCount = usage.requestCount || 0;
      const remaining = info.monthlyLimit
        ? Math.max(0, info.monthlyLimit - requestCount)
        : null;
      return {
        name,
        label: info.label,
        category: info.category,
        website: info.website,
        monthlyLimit: info.monthlyLimit,
        free: info.free || false,
        payPerUse: info.payPerUse || false,
        note: info.note || "",
        recommended: info.recommended || false,
        // Bepul provayderlar (xotelo, duckduckgo) kalit talab qilmaydi — doim "ulangan".
        configured: info.free ? true : !!keyMap[name],
        usage: {
          requestCount,
          successCount: usage.successCount || 0,
          failureCount: usage.failureCount || 0,
          remaining,
          percentUsed: info.monthlyLimit
            ? Math.round((requestCount / info.monthlyLimit) * 100)
            : 0,
          lastSuccessAt: usage.lastSuccessAt || null,
          lastFailureAt: usage.lastFailureAt || null,
          lastError: usage.lastError || "",
          disabled: usage.disabled || false,
        },
      };
    });

    res.json({
      providers,
      recommendations: RECOMMENDED_APIS,
      currentMonth: ym,
    });
  } catch (err) {
    next(err);
  }
}

// Yangilik / e'lon xabarini barcha (filtrlangan) foydalanuvchilarga yuborish.
// body: { subject, title?, message, lang?, countryCode?, inApp? }
export async function sendBroadcast(req, res, next) {
  try {
    const { subject, title = "", message, lang = "", countryCode = "", inApp = true } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ error: "subject va message majburiy" });
    }

    const filter = { isActive: true };
    if (lang) filter.lang = lang;
    if (countryCode) filter.countryCode = countryCode.toUpperCase();

    const recipients = await User.find(filter).select("_id email name lang").lean();
    if (!recipients.length) {
      return res.json({ sent: 0, failed: 0, inApp: 0, total: 0 });
    }

    // Email yuborish — bittasi xato bo'lsa boshqalari to'xtamasin
    const results = await Promise.allSettled(
      recipients.map((u) =>
        sendBroadcastEmail({ to: u.email, subject, title, body: message })
      )
    );
    const sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
    const failed = results.length - sent;

    // Ilova ichidagi bildirishnoma (qo'ng'iroq belgisi) + real-time push
    let inAppCount = 0;
    if (inApp) {
      for (const u of recipients) {
        try {
          const notif = await Notification.create({
            userId: u._id,
            type: "system",
            severity: "info",
            title: title || subject,
            message,
            relatedType: "broadcast",
          });
          emitToUser(u._id, "notification:new", notif.toObject());
          inAppCount++;
        } catch {
          /* bitta foydalanuvchi xatosi butun jarayonni to'xtatmasin */
        }
      }
    }

    res.json({ sent, failed, inApp: inAppCount, total: recipients.length });
  } catch (err) {
    next(err);
  }
}

export async function recentActivity(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const recent = await User.find().sort({ createdAt: -1 }).limit(limit);
    res.json({ recent });
  } catch (err) {
    next(err);
  }
}

export async function activeUsers(req, res, next) {
  try {
    // 30 kun ichida login qilganlar = faol
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [active, inactive, total] = await Promise.all([
      User.find({ lastLoginAt: { $gte: since }, isActive: true })
        .sort({ lastLoginAt: -1 })
        .limit(50),
      User.countDocuments({
        $or: [{ lastLoginAt: { $lt: since } }, { lastLoginAt: null }],
      }),
      User.countDocuments(),
    ]);
    res.json({
      active,
      stats: { activeCount: active.length, inactiveCount: inactive, total },
    });
  } catch (err) {
    next(err);
  }
}
