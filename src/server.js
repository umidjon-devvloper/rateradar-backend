import http from 'http';
import { createRequire } from 'module';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { initSecurity } from './services/security.service.js';
import { startCompetitorMonitor } from './services/competitorMonitor.service.js';
import { startWeeklyRefresh } from './services/weeklyRefresh.service.js';
import { startXoteloMonitor } from './services/xoteloMonitor.service.js';
import { startSubscriptionRenewal } from './services/subscriptionRenewal.service.js';
import { startRateHistoryRollup, rollupRecent } from './services/rateHistory.service.js';
import { initSocket } from './services/socket.service.js';
import { startExelySync } from './services/exely/sync.service.js';

const require = createRequire(import.meta.url);
const { initRealtime: initHotelService } = require('./hotelService/mount.js');

async function start() {
  await connectDB();
  await initSecurity(); // bloklangan IP'larni yuklash + davriy tozalash

  const httpServer = http.createServer(app);
  const io = initSocket(httpServer);

  // Mehmonxona-xizmati: socket namespace + Telegram bot + cron
  initHotelService(io);

  httpServer.listen(env.PORT, () => {
    console.log(`\n🚀 RateRadar API`);
    console.log(`   ↳ http://localhost:${env.PORT}`);
    console.log(`   ↳ Muhit: ${env.NODE_ENV}`);
    console.log(
      `   ↳ Mongo: ${env.MONGODB_URI.replace(/\/\/[^@]+@/, "//***@")}\n`,
    );
    // startCompetitorMonitor(); // O'chirilgan — Apify Booking shahar qidiruvi
    //   har 6 soatda ishlardi (~$0.18 har bir hotel). Foydalanuvchi
    //   so'roviga ko'ra olib tashlandi. Endi narxlar faqat foydalanuvchi
    //   "SerpAPI yangilash" tugmasini bosganda yangilanadi.
    // Haftalik to'liq yangilanish (yakshanba 03:00): narx (o'z+raqib) + yangi
    // sharhlar. Eski alohida sharh cron'i (dushanba) shu bilan birlashtirildi —
    // sharh haftada bir marta olinadi (kam token).
    startWeeklyRefresh();
    startXoteloMonitor(); // Har kuni 00:00 — ertaga+indin Xotelo narxlari
    startSubscriptionRenewal(); // Har kuni 09:00 — saqlangan karta bilan avto-to'lov
    // Har kuni 04:00 — xom narx snapshotlarini abadiy kunlik tarixga (DailyRate)
    // yig'ish. Bu STLY va booking-curve tahlilining yagona manbai.
    startRateHistoryRollup();
    // Har 30 daqiqada — mijozlarning Exely (PMS/Channel Manager) bronlarini
    // olib kelish. Occupancy/ADR/RevPAR AYNAN shu ma'lumotdan hisoblanadi:
    // raqiblar narxi tashqaridan ko'rinadi, o'z sotuvim esa faqat shundan.
    startExelySync();
    // Server ishga tushganda ham bir marta — pm2 restart yoki uzilish bo'lsa
    // 04:00 cron'i o'tkazib yuborilgan bo'lishi mumkin (rollup idempotent).
    rollupRecent().then((r) => {
      if (r.written) console.log(`[boot] Narx tarixi rollup: ${r.written} yozuv`);
    }).catch((e) => console.warn('[boot] rollup xato:', e.message));
  });
}

start().catch((err) => {
  console.error("Server ishga tushishda xato:", err);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// ── GLOBAL XATO HIMOYASI (server yiqilmasin) ─────────────────────────
// Node 24'da ushlanmagan promise rejection / xato jarayonni O'LDIRADI.
// Ko'p fonда async ish bor (sekin scraper, Scrape.do, cron, background
// refresh) — bittasi ushlanmasa BUTUN backend qulab, pm2 qayta ishga
// tushirar edi (o'sha oynada barcha so'rov 502/CORS + WebSocket 502).
// Bu yerda LOG qilamiz, lekin serverni tirik qoldiramiz.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.stack || reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err?.message || err);
});
