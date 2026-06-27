// ════════════════════════════════════════════════════════════════════
// Haftalik to'liq yangilanish (3-FAZA)
//
// Har hafta oxirida (yakshanba 03:00) barcha aktiv hotellar uchun:
//   1. Narxlar (o'z kanallar + raqib narxlari)  — runInstantSnapshot
//   2. Faqat YANGI sharhlar                       — collectReviewsForHotel
//
// Kam token: sharhlar oyna (REVIEW_WINDOW_DAYS) + externalId dedup bilan
// ishlaydi — butun tarix emas, faqat yangilari yoziladi. Apify `reuseLastRun`
// keshi takror run'larni kamaytiradi.
//
// Onboarding orkestratori bilan AYNAN bir xil yadrolarni ishlatadi — shuning
// uchun "birinchi yig'ish" va "haftalik yangilanish" mantiqan bir xil.
// ════════════════════════════════════════════════════════════════════
import cron from 'node-cron';
import Hotel from '../models/Hotel.js';
import { collectReviewsForHotel } from './reviewMonitor.service.js';

async function refreshOneHotel(hotelId) {
  const hotel = await Hotel.findById(hotelId);
  if (!hotel || !hotel.isActive) return;

  // 1. Narxlar (o'z + raqib). Controller yadrosini dinamik import qilamiz.
  const { runInstantSnapshot } = await import('../controllers/hotel.controller.js');
  await runInstantSnapshot(hotel).catch((e) =>
    console.warn(`[weekly] narx "${hotel.name}": ${e.message}`),
  );

  // 2. Faqat yangi sharhlar (oyna + dedup ichida).
  await collectReviewsForHotel(hotel).catch((e) =>
    console.warn(`[weekly] sharh "${hotel.name}": ${e.message}`),
  );
}

export async function runWeeklyRefresh() {
  console.log('[cron] Haftalik to\'liq yangilanish boshlandi...');
  try {
    const hotels = await Hotel.find({ isActive: true }).select('_id name').lean();
    // Ketma-ket — API'larni bir vaqtda urmaslik uchun (rate limit / tannarx).
    for (const h of hotels) {
      try {
        await refreshOneHotel(h._id);
        console.log(`[cron] ${h.name}: haftalik yangilandi`);
      } catch (err) {
        console.error(`[cron] Haftalik "${h.name}" xato:`, err.message);
      }
    }
    console.log(`[cron] Haftalik yangilanish tugadi (${hotels.length} hotel)`);
  } catch (err) {
    console.error('[cron] Haftalik yangilanish xatosi:', err.message);
  }
}

// Har yakshanba 03:00 da (hafta oxiri).
export function startWeeklyRefresh() {
  cron.schedule('0 3 * * 0', runWeeklyRefresh);
  console.log('[cron] Haftalik to\'liq yangilanish yoqildi (har yakshanba 03:00)');
}
