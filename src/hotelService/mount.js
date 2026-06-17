// ════════════════════════════════════════════════════════════════════
// Mehmonxona-xizmati (Hotel Service) moduli — RateRadar'ga ulash nuqtasi
//
// Bu modul CommonJS (qarang: hotelService/package.json "type":"commonjs").
// RateRadar backend'i ESM bo'lgani uchun, app.js / server.js bu yerni
// createRequire orqali yuklaydi.
//
// • mountRoutes(app)   — Express marshrutlarini ulaydi (notFound'dan OLDIN).
// • initRealtime(io)   — Socket.IO namespace, Telegram bot va cron'ni
//                        ishga tushiradi (server.js'da, io tayyor bo'lgach).
//
// MongoDB ulanishi RateRadar'ning connectDB() orqali allaqachon ochilgan —
// modellar o'sha umumiy mongoose ulanishida ro'yxatdan o'tadi (hs_* kolleksiyalar).
// ════════════════════════════════════════════════════════════════════

const guestRoutes = require("./routes/guest");
const hotelRoutes = require("./routes/hotel");
const socketManager = require("./socket");
const { initBot } = require("./bot");
const { startTimeoutJob } = require("./jobs/timeoutJob");

function mountRoutes(app) {
  app.use("/api/hotel-service/guest", guestRoutes);
  app.use("/api/hotel-service/hotel", hotelRoutes);
  console.log("✅ Hotel Service marshrutlari ulandi (/api/hotel-service/*)");
}

function initRealtime(io) {
  socketManager.init(io); // "/hotel-service" namespace
  initBot(); // BOT_TOKEN yo'q bo'lsa o'zi o'tkazib yuboradi
  startTimeoutJob();
  console.log("✅ Hotel Service realtime (socket + bot + cron) ishga tushdi");
}

module.exports = { mountRoutes, initRealtime };
