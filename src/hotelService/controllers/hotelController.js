const jwt       = require("jsonwebtoken");
const mongoose  = require("mongoose");
const fs        = require("fs");
const path      = require("path");
const { nanoid } = require("nanoid");
const Hotel     = require("../models/Hotel");
const Staff     = require("../models/Staff");
const Service   = require("../models/Service");
const Request   = require("../models/Request");
const Review    = require("../models/Review");
const { getBot }  = require("../bot");
const { getMsg }  = require("../bot/messages");

// ─── DEFAULT XIZMATLAR ──────────────────────────────────────────────────────────
// Har bir yangi mehmonxonaga avtomatik qo'shiladigan 4 ta asosiy xizmat.
// Mehmonxona ularni tahrirlashi/o'chirishi va o'ziniki qo'shishi mumkin.
const DEFAULT_SERVICES = [
  { name: "Room service",  icon: "🍽" },
  { name: "Kir yuvish",    icon: "🧺" },
  { name: "Tozalash",      icon: "🧹" },
  { name: "Texnik yordam", icon: "🔧" },
];

async function seedDefaultServices(hotel_id) {
  try {
    // Nomi bo'yicha yetishmayotgan default xizmatlarnigina qo'shamiz —
    // mehmonxonada boshqa xizmatlar bo'lsa ham defaultlar qo'shiladi.
    const existing = await Service.find({ hotel_id }).select("name").lean();
    const have = new Set(existing.map((s) => (s.name || "").trim().toLowerCase()));
    const toAdd = DEFAULT_SERVICES.filter(
      (s) => !have.has(s.name.toLowerCase()),
    );
    if (toAdd.length) {
      await Service.create(toAdd.map((s) => ({ ...s, hotel_id })));
    }
  } catch (err) {
    console.error("seedDefaultServices:", err.message);
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const verifySSO = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token majburiy" });

    let hotelData;
    if (process.env.SSO_SECRET) {
      try { hotelData = jwt.verify(token, process.env.SSO_SECRET); }
      catch { return res.status(401).json({ message: "SSO token yaroqsiz" }); }
    } else {
      try { hotelData = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()); }
      catch { return res.status(401).json({ message: "Token format xato" }); }
    }

    const { hotel_id, hotel_name, hotel_language, subscription } = hotelData;
    if (!hotel_id) return res.status(400).json({ message: "hotel_id topilmadi" });

    const hotel = await Hotel.findOneAndUpdate(
      { hotel_id },
      { hotel_name: hotel_name || "Hotel", language: hotel_language || "ru",
        subscription: subscription || { active: true, expires_at: null }, updated_at: new Date() },
      { upsert: true, new: true }
    );

    // Default 4 xizmatni bir marta qo'shamiz (yangi yoki hali seed qilinmagan)
    if (!hotel.defaults_seeded) {
      await seedDefaultServices(hotel.hotel_id);
      hotel.defaults_seeded = true;
      await hotel.save();
    }

    const ourToken = jwt.sign({ hotel_id: hotel.hotel_id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token: ourToken, hotel: {
      hotel_id: hotel.hotel_id, hotel_name: hotel.hotel_name,
      language: hotel.language, invite_code: hotel.invite_code,
      subscription: hotel.subscription,
    }});
  } catch (err) {
    console.error("verifySSO:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

const getMe = async (req, res) => {
  res.json({
    hotel_id: req.hotel.hotel_id, hotel_name: req.hotel.hotel_name,
    language: req.hotel.language, subscription: req.hotel.subscription,
    branding: req.hotel.branding || {},
    invite_code: req.hotel.invite_code,
    // Telegram guruh + admin integratsiyasi holati (SettingsPage ko'rsatadi)
    group_chat_id: req.hotel.group_chat_id || null,
    group_title:   req.hotel.group_title || "",
    admin_telegram_id: req.hotel.admin_telegram_id || null,
    admin_name:        req.hotel.admin_name || "",
    bot_username:  process.env.BOT_USERNAME || "",
  });
};

// ─── RASM YUKLASH (xizmat item'lari uchun) ─────────────────────────────────────
// Base64 dataURL qabul qiladi, backend/uploads/hs/<hotelId>/ ga saqlaydi.
// Express static /uploads orqali tarqatadi (app.js). Limit: ~1.5MB.
const UPLOADS_ROOT = path.resolve(__dirname, "../../../uploads");

const uploadImage = async (req, res) => {
  try {
    const { image } = req.body || {};
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(String(image || ""));
    if (!m) return res.status(400).json({ message: "image: data:image/...;base64 formati kerak" });

    const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 1.5 * 1024 * 1024) {
      return res.status(413).json({ message: "Rasm 1.5MB dan katta — kichikroq rasm yuklang" });
    }

    const dir = path.join(UPLOADS_ROOT, "hs", req.hotelId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${nanoid(10)}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);

    res.json({ url: `/uploads/hs/${req.hotelId}/${filename}` });
  } catch (err) {
    console.error("uploadImage:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── BRANDING (mehmon webapp dizayni) ───────────────────────────────────────────

const updateBranding = async (req, res) => {
  try {
    const { theme, template, primary_color, logo_url, welcome_text, bg_style } = req.body;
    const set = {};
    if (theme !== undefined) set["branding.theme"] = theme;
    if (template !== undefined) set["branding.template"] = template;
    if (primary_color !== undefined) set["branding.primary_color"] = primary_color;
    if (logo_url !== undefined) set["branding.logo_url"] = logo_url;
    if (welcome_text !== undefined) set["branding.welcome_text"] = welcome_text;
    if (bg_style !== undefined) set["branding.bg_style"] = bg_style;

    const hotel = await Hotel.findOneAndUpdate(
      { hotel_id: req.hotelId },
      { $set: set },
      { new: true },
    );
    res.json(hotel.branding);
  } catch (err) {
    console.error("updateBranding:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

const updateSettings = async (req, res) => {
  try {
    const { language } = req.body;
    if (!language) return res.status(400).json({ message: "Til kodi majburiy" });
    await Hotel.findOneAndUpdate({ hotel_id: req.hotelId }, { language });
    res.json({ message: "Saqlandi" });
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── STAFF ────────────────────────────────────────────────────────────────────

// Faqat active/inactive xodimlar (pending holat yo'q endi)
const getActiveStaff = async (req, res) => {
  try {
    const staff = await Staff.find({
      hotel_id: req.hotelId,
      status: { $in: ["active", "inactive"] },
    })
      .populate("service_ids", "name icon color invite_code")
      .sort({ activated_at: -1 });
    res.json(staff);
  } catch (_) { res.status(500).json({ message: "Server xatosi" }); }
};

const updateStaff = async (req, res) => {
  try {
    const { service_ids, status } = req.body;
    const current = await Staff.findOne({ _id: req.params.id, hotel_id: req.hotelId });
    if (!current) return res.status(404).json({ message: "Xodim topilmadi" });

    const updateData = {};
    if (service_ids !== undefined) updateData.service_ids = service_ids;
    if (status !== undefined) updateData.status = status;

    const updated = await Staff.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .populate("service_ids", "name icon color");
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

const deleteStaff = async (req, res) => {
  try {
    await Staff.findOneAndDelete({ _id: req.params.id, hotel_id: req.hotelId });
    res.json({ message: "O'chirildi" });
  } catch (_) { res.status(500).json({ message: "Server xatosi" }); }
};

// ─── SERVICES ─────────────────────────────────────────────────────────────────

const getServices = async (req, res) => {
  try {
    const services = await Service.find({ hotel_id: req.hotelId }).sort({ created_at: 1 });
    const botUsername = process.env.BOT_USERNAME || "YOUR_BOT";

    const result = services.map(s => ({
      ...s.toObject(),
      invite_link: s.invite_code
        ? `https://t.me/${botUsername}?start=${s.invite_code}`
        : null,
    }));

    res.json(result);
  } catch (_) { res.status(500).json({ message: "Server xatosi" }); }
};

// Item'larni tozalash — faqat ruxsat etilgan maydonlar (nom majburiy)
const cleanItems = (items) => (items || [])
  .filter((it) => it && String(it.name || "").trim())
  .map((it) => ({
    name: String(it.name).trim(),
    price: Number(it.price) > 0 ? Math.round(Number(it.price)) : 0,
    image_url: String(it.image_url || ""),
    is_active: it.is_active !== false,
  }));

const createService = async (req, res) => {
  try {
    const { name, icon, sub_options, items } = req.body;
    if (!name) return res.status(400).json({ message: "Xizmat nomi majburiy" });

    const cleanSubs = (sub_options || []).map(({ name: n }) => ({ name: n }));
    const service = await Service.create({
      hotel_id: req.hotelId, name,
      icon: icon || "🛎",
      sub_options: cleanSubs,
      items: cleanItems(items),
    });

    const botUsername = process.env.BOT_USERNAME || "YOUR_BOT";
    res.status(201).json({
      ...service.toObject(),
      invite_link: `https://t.me/${botUsername}?start=${service.invite_code}`,
    });
  } catch (err) {
    console.error("createService:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

const updateService = async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (updateData.sub_options) {
      updateData.sub_options = updateData.sub_options.map(({ name: n }) => ({ name: n }));
    }
    if (updateData.items) updateData.items = cleanItems(updateData.items);
    if (updateData.name) updateData.translations = {};

    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, hotel_id: req.hotelId },
      updateData, { new: true }
    );
    if (!service) return res.status(404).json({ message: "Topilmadi" });

    const botUsername = process.env.BOT_USERNAME || "YOUR_BOT";
    res.json({
      ...service.toObject(),
      invite_link: `https://t.me/${botUsername}?start=${service.invite_code}`,
    });
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

const deleteService = async (req, res) => {
  try {
    await Service.findOneAndDelete({ _id: req.params.id, hotel_id: req.hotelId });
    res.json({ message: "O'chirildi" });
  } catch (_) { res.status(500).json({ message: "Server xatosi" }); }
};

// Xizmat invite kodni yangilash
const regenerateServiceInvite = async (req, res) => {
  try {
    const newCode = `svc_${nanoid(12)}`;
    const service = await Service.findOneAndUpdate(
      { _id: req.params.id, hotel_id: req.hotelId },
      { invite_code: newCode },
      { new: true }
    );
    if (!service) return res.status(404).json({ message: "Topilmadi" });

    const botUsername = process.env.BOT_USERNAME || "YOUR_BOT";
    res.json({
      invite_code: newCode,
      invite_link: `https://t.me/${botUsername}?start=${newCode}`,
    });
  } catch (_) { res.status(500).json({ message: "Server xatosi" }); }
};

// ─── REQUESTS ─────────────────────────────────────────────────────────────────

const getRequests = async (req, res) => {
  try {
    const { room, service, status, from, to, page = 1, limit = 30 } = req.query;

    const filter = { hotel_id: req.hotelId };
    if (room)    filter.room_number = { $regex: room.trim(), $options: "i" };
    if (service) filter.service_id  = service;
    if (status)  filter.status      = status;
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to)   filter.created_at.$lte = new Date(to + "T23:59:59");
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      Request.find(filter)
        .populate("service_id", "name icon color")
        .sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)),
      Request.countDocuments(filter),
    ]);

    const staffIds = [...new Set(requests.map(r => r.accepted_by).filter(Boolean))];
    const staffMap = {};
    if (staffIds.length) {
      const list = await Staff.find({ telegram_id: { $in: staffIds } });
      list.forEach(s => { staffMap[s.telegram_id] = { full_name: s.full_name, telegram_username: s.telegram_username }; });
    }

    const data = requests.map(r => ({
      ...r.toObject(),
      staff: r.accepted_by ? staffMap[r.accepted_by] || null : null,
    }));

    res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error("getRequests:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── REPORTS ──────────────────────────────────────────────────────────────────

const getReports = async (req, res) => {
  try {
    const { month, staff_telegram_id, service_id } = req.query;

    const match = { hotel_id: req.hotelId, status: "completed" };
    if (month) {
      const start = new Date(month + "-01");
      const end   = new Date(start); end.setMonth(end.getMonth() + 1);
      match.created_at = { $gte: start, $lt: end };
    }
    if (staff_telegram_id) match.accepted_by = parseInt(staff_telegram_id);
    if (service_id) match.service_id = new mongoose.Types.ObjectId(service_id);

    const results = await Request.aggregate([
      { $match: match },
      {
        $group: {
          _id: { staff: "$accepted_by", service: "$service_id" },
          count: { $sum: 1 },
          avg_min: {
            $avg: { $divide: [{ $subtract: ["$completed_at", "$accepted_at"] }, 60000] },
          },
        },
      },
      { $lookup: { from: "hs_services", localField: "_id.service", foreignField: "_id", as: "service" } },
      // FIX: preserveNullAndEmptyArrays (oldin: preserveNullAndEmpty)
      { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
      { $sort: { count: -1 } },
    ]);

    const staffIds = [...new Set(results.map(r => r._id.staff).filter(Boolean))];
    const staffMap = {};
    if (staffIds.length) {
      const list = await Staff.find({ telegram_id: { $in: staffIds } });
      list.forEach(s => { staffMap[s.telegram_id] = s; });
    }

    res.json(results.map(r => ({
      ...r,
      staff:   r._id.staff ? staffMap[r._id.staff] || null : null,
      avg_min: r.avg_min ? Math.round(r.avg_min) : null,
    })));
  } catch (err) {
    console.error("getReports:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── REVIEWS (mehmon sharhlari) ─────────────────────────────────────────────────

const getReviews = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const filter = { hotel_id: req.hotelId };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [reviews, total, agg] = await Promise.all([
      Review.find(filter).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Review.countDocuments(filter),
      Review.aggregate([
        { $match: filter },
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      data: reviews,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      avg_rating: agg[0]?.avg ? Math.round(agg[0].avg * 10) / 10 : 0,
    });
  } catch (err) {
    console.error("getReviews:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

module.exports = {
  verifySSO, getMe, updateSettings, updateBranding, uploadImage,
  getActiveStaff, updateStaff, deleteStaff,
  getServices, createService, updateService, deleteService, regenerateServiceInvite,
  getRequests, getReports, getReviews,
};
