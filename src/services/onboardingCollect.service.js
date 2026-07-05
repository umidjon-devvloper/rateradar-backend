// ════════════════════════════════════════════════════════════════════
// Onboarding ma'lumot yig'ish orkestratori
//
// Hotel qo'shilgach fonda ishga tushadi va barcha ma'lumotni (raqobatchilar,
// narxlar, sharhlar) yig'adi. Dashboard `collectStatus === 'ready'` bo'lguncha
// bloklovchi modal ko'rsatadi.
//
// Holatlar (Hotel.collectStatus):
//   pending → collecting → ready | error
//
// Jonli progress socket orqali yuboriladi:
//   emitToUser(userId, 'collect:progress', { hotelId, step, pct, label })
//   emitToUser(userId, 'data:ready',       { hotelId })
//
// DIQQAT: bu funksiya `await` qilinmaydi — fonda ishlaydi (fire-and-forget).
//
// 1-FAZA: raqobatchilarni real topadi + gating/progress infratuzilmasi.
// 2-FAZA (keyin): narx (o'z + raqib) va sharhlarni shu yerga ulaymiz —
//   pastdagi `TODO 2-FAZA` belgilariga.
// ════════════════════════════════════════════════════════════════════
import Hotel from '../models/Hotel.js';
import { emitToUser } from './socket.service.js';

// Bitta yig'ish jarayoni — fonda ishga tushiradi (chaqiruvchi kutmaydi).
export function startCollect(hotelId, userId, { lat, lng } = {}) {
  runCollect(hotelId, userId, { lat, lng }).catch((err) => {
    console.error(`[collect] ${hotelId} xatosi:`, err.message);
  });
}

// Progressni Hotel hujjatiga yozadi (sahifa qayta yuklansa ham ko'rinadi)
// va socket orqali jonli yuboradi.
async function setProgress(hotelId, userId, patch) {
  const progress = { ...patch, at: Date.now() };
  await Hotel.updateOne({ _id: hotelId }, { $set: { collectProgress: progress } }).catch(() => {});
  emitToUser(userId, 'collect:progress', { hotelId: String(hotelId), ...progress });
}

async function runCollect(hotelId, userId, { lat, lng }) {
  await Hotel.updateOne({ _id: hotelId }, { $set: { collectStatus: 'collecting' } }).catch(() => {});
  await setProgress(hotelId, userId, { step: 'start', pct: 5, label: 'Ma\'lumotlar yig\'ilmoqda' });

  try {
    const hotel = await Hotel.findById(hotelId);
    if (!hotel) throw new Error('Hotel topilmadi');

    // ── 1. Raqobatchilar + narxlar (o'z + raqib) ─────────────────────
    // runInstantSnapshot: o'z kanallar (Xotelo) + raqib auto-topish + raqib
    // narxlari + PriceSnapshot yozish. Hammasini bitta yadro bajaradi.
    await setProgress(hotelId, userId, { step: 'competitors', pct: 30, label: 'Raqobatchilar aniqlanmoqda' });
    const { runInstantSnapshot } = await import('../controllers/hotel.controller.js');
    await setProgress(hotelId, userId, { step: 'prices', pct: 55, label: 'Narxlar yig\'ilmoqda' });
    await runInstantSnapshot(hotel).catch((e) =>
      console.warn(`[collect] narx/raqib: ${e.message}`),
    );

    // ── 2. Sharhlar (barcha kanal: Google/Apify/Yandex/TripAdvisor) ──
    await setProgress(hotelId, userId, { step: 'reviews', pct: 70, label: 'Sharhlar yig\'ilmoqda' });
    const { collectReviewsForHotel } = await import('./reviewMonitor.service.js');
    await collectReviewsForHotel(hotel).catch((e) =>
      console.warn(`[collect] sharh: ${e.message}`),
    );

    // ── 3. Xona turlari (Rate Shopper) — Booking property sahifasidan ──
    // Onboarding'da Rate Shopper ham to'lsin (foydalanuvchi alohida bosmasin).
    await setProgress(hotelId, userId, { step: 'rooms', pct: 90, label: 'Xona narxlari yig\'ilmoqda' });
    try {
      const { scraperEnabled, scraperRooms } = await import('./hotelScraper.service.js');
      if (scraperEnabled()) {
        const sr = await scraperRooms(hotel.name, hotel.city);
        if (sr.rooms?.length) {
          const roomTypes = sr.rooms.slice(0, 8).map((r) => ({
            name: r.name, guests: r.guests, sqm: 0, description: '', basePrice: r.price,
          }));
          const upd = { roomTypes };
          if (sr.minPrice > 0) { upd.currentPrice = sr.minPrice; upd.currency = sr.currency || 'USD'; }
          await Hotel.updateOne({ _id: hotelId }, { $set: upd }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn(`[collect] xona: ${e.message}`);
    }

    // ── Tayyor ───────────────────────────────────────────────────────
    await Hotel.updateOne(
      { _id: hotelId },
      { $set: { collectStatus: 'ready', collectedAt: new Date() } },
    ).catch(() => {});
    await setProgress(hotelId, userId, { step: 'done', pct: 100, label: 'Tayyor' });
    emitToUser(userId, 'data:ready', { hotelId: String(hotelId) });
  } catch (err) {
    console.error(`[collect] ${hotelId} jarayon xatosi:`, err.message);
    await Hotel.updateOne({ _id: hotelId }, { $set: { collectStatus: 'error' } }).catch(() => {});
    emitToUser(userId, 'collect:progress', {
      hotelId: String(hotelId),
      step: 'error',
      pct: 100,
      label: 'Xatolik yuz berdi',
    });
  }
}
