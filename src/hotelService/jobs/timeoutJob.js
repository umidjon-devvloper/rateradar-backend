const cron = require("node-cron");
const Request = require("../models/Request");
const { emit } = require("../socket");

// Buyurtma necha daqiqadan keyin "kechikkan" hisoblanadi
const OVERDUE_MS = 5 * 60 * 1000;
// Qabul qilinmaguncha qancha vaqtda bir takror eslatma yuborilsin
const REMIND_EVERY_MS = 5 * 60 * 1000;

const startTimeoutJob = () => {
  cron.schedule("* * * * *", async () => {
    try {
      const now = Date.now();
      const overdueBefore = new Date(now - OVERDUE_MS);
      const remindBefore = new Date(now - REMIND_EVERY_MS);

      // Hali "pending" va 5 daqiqadan oshgan, va (hali ogohlantirilmagan
      // YOKI oxirgi eslatmadan beri REMIND_EVERY_MS o'tgan) buyurtmalar.
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
        await Request.findByIdAndUpdate(req._id, {
          is_timeout_notified: true,
          last_timeout_notified_at: new Date(),
        });
        console.log(
          `⏰ Eslatma (qabul qilinmadi): hotel=${req.hotel_id} room=${req.room_number}`,
        );
      }
    } catch (err) {
      console.error("Timeout job xatosi:", err.message);
    }
  });

  console.log("✅ Timeout job ishga tushdi (takror eslatmalar yoqilgan)");
};

module.exports = { startTimeoutJob };
