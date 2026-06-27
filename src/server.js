import http from 'http';
import { createRequire } from 'module';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { initSecurity } from './services/security.service.js';
import { startCompetitorMonitor } from './services/competitorMonitor.service.js';
import { startWeeklyRefresh } from './services/weeklyRefresh.service.js';
import { startXoteloMonitor } from './services/xoteloMonitor.service.js';
import { initSocket } from './services/socket.service.js';

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
  });
}

start().catch((err) => {
  console.error("Server ishga tushishda xato:", err);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
