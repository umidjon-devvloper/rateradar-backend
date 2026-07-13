const cron = require("node-cron");
const Request = require("../models/Request");
const Hotel = require("../models/Hotel");
const Staff = require("../models/Staff");
const { emit } = require("../socket");
const { getBot } = require("../bot");

// Buyurtma necha daqiqadan keyin "kechikkan" hisoblanadi
const OVERDUE_MS = 5 * 60 * 1000;
// Qabul qilinmaguncha qancha vaqtda bir takror eslatma yuborilsin
const REMIND_EVERY_MS = 5 * 60 * 1000;
// Qabul qilingan ish shu vaqtda "Bajarildi" bosilmasa — adminga ogohlantirish
const ACCEPT_OVERDUE_MS = 2.5 * 60 * 60 * 1000; // 2 soat 30 daqiqa

// Hotel'larni bitta run ichida keshlash (har request uchun qayta so'ramaslik)
async function getHotelCached(cache, hotelId) {
  if (!cache.has(hotelId)) {
    cache.set(hotelId, await Hotel.findOne({ hotel_id: hotelId }).lean());
  }
  return cache.get(hotelId);
}

// Adminga xabar — bot yo'q/bloklangan bo'lsa jim o'tadi
async function notifyAdmin(hotel, text) {
  if (!hotel?.admin_telegram_id) return;
  try {
    const bot = getBot();
    if (!bot) return;
    await bot.telegram.sendMessage(hotel.admin_telegram_id, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error(`Admin ogohlantirish yuborilmadi (${hotel.admin_telegram_id}):`, err.message);
  }
}

const fmtMin = (ms) => Math.round(ms / 60000);

const startTimeoutJob = () => {
  cron.schedule("* * * * *", async () => {
    const hotelCache = new Map();
    try {
      const now = Date.now();
      const overdueBefore = new Date(now - OVERDUE_MS);
      const remindBefore = new Date(now - REMIND_EVERY_MS);

      // ── 1) PENDING: 5 daqiqadan beri HECH KIM OLMADI ──────────────────
      // (hali ogohlantirilmagan YOKI oxirgi eslatmadan beri interval o'tgan)
      const overdue = await Request.find({
        status: "pending",
        created_at: { $lt: overdueBefore },
        $or: [
          { is_timeout_notified: false },
          { last_timeout_notified_at: null },
          { last_timeout_notified_at: { $lt: remindBefore } },
        ],
      })
        .populate("service_id", "name icon")
        .lean();

      for (const req of overdue) {
        emit.requestTimeout(req.hotel_id, { request: req });

        const hotel = await getHotelCached(hotelCache, req.hotel_id);
        const waitedMin = fmtMin(now - new Date(req.created_at).getTime());
        await notifyAdmin(
          hotel,
          `❗ <b>HECH KIM OLMADI</b> (${waitedMin} daqiqa)\n\n` +
          `🏠 Xona: ${req.room_number}\n` +
          `🛎 Xizmat: ${req.service_id?.name || ""}` +
          (req.sub_option_translated || req.sub_option
            ? `\n📋 Tur: ${req.sub_option_translated || req.sub_option}` : "")
        );

        await Request.findByIdAndUpdate(req._id, {
          is_timeout_notified: true,
          last_timeout_notified_at: new Date(),
        });
        console.log(
          `⏰ Eslatma (qabul qilinmadi): hotel=${req.hotel_id} room=${req.room_number}`,
        );
      }

      // ── 2) ACCEPTED: 2.5 soatdan beri BAJARILMADI ─────────────────────
      const acceptOverdueBefore = new Date(now - ACCEPT_OVERDUE_MS);
      const notDone = await Request.find({
        status: "accepted",
        accepted_at: { $lt: acceptOverdueBefore },
        $or: [
          { accepted_overdue_notified_at: null },
          { accepted_overdue_notified_at: { $lt: acceptOverdueBefore } },
        ],
      })
        .populate("service_id", "name icon")
        .lean();

      for (const req of notDone) {
        const hotel = await getHotelCached(hotelCache, req.hotel_id);
        if (!hotel?.admin_telegram_id) continue;

        // Kim olgan edi — profil ma'lumoti bilan
        const staff = await Staff.findOne({ telegram_id: req.accepted_by }).lean();
        const who = staff
          ? `${staff.full_name}${staff.telegram_username ? ` (@${staff.telegram_username})` : ""}${staff.phone ? ` · ${staff.phone}` : ""}`
          : `ID: ${req.accepted_by}`;
        const sinceMin = fmtMin(now - new Date(req.accepted_at).getTime());
        const h = Math.floor(sinceMin / 60);
        const min = sinceMin % 60;

        await notifyAdmin(
          hotel,
          `⚠️ <b>ISH BAJARILMADI</b> ("Bajarildi" bosilmagan)\n\n` +
          `👤 Qabul qilgan: <b>${who}</b>\n` +
          `🏠 Xona: ${req.room_number}\n` +
          `🛎 Xizmat: ${req.service_id?.name || ""}\n` +
          `⏳ Qabul qilinganiga: ${h ? `${h} soat ` : ""}${min} daqiqa bo'ldi`
        );

        await Request.findByIdAndUpdate(req._id, {
          accepted_overdue_notified_at: new Date(),
        });
        console.log(
          `⏰ Eslatma (bajarilmadi): hotel=${req.hotel_id} room=${req.room_number} staff=${req.accepted_by}`,
        );
      }
    } catch (err) {
      console.error("Timeout job xatosi:", err.message);
    }
  });

  console.log("✅ Timeout job ishga tushdi (takror eslatmalar + admin nazorati)");
};

module.exports = { startTimeoutJob };
