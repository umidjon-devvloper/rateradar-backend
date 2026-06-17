import cron from 'node-cron';
import Hotel from '../models/Hotel.js';
import PriceSnapshot from '../models/PriceSnapshot.js';
import { getXoteloMergedRates, extractXoteloHotelKey } from './xotelo.service.js';

/**
 * Har kuni yarim tunda (00:00) ishlaydigan Xotelo narx monitori.
 *
 * Har bir aktiv hotel uchun ERTAGA (+1) va INDIN (+2) sanalardagi Xotelo
 * narxlarini oladi va 'own' PriceSnapshot sifatida saqlaydi. Shunday qilib
 * narx oynasi har kuni avtomatik oldinga suriladi (bugun 31 → ertaga 1, 2;
 * ertasi kuni → 2, 3 va h.k.).
 */

async function fetchXoteloForHotel(hotel) {
  const taUrl = hotel.otaUrls?.TripAdvisor || hotel.tripAdvisorUrl || '';
  const hotelKey = hotel.xoteloHotelKey || extractXoteloHotelKey(taUrl);
  if (!hotelKey) return 0;

  const data = await getXoteloMergedRates({ hotelKey, tripAdvisorUrl: taUrl });
  const rates = (data?.rates || []).filter((r) => r.price > 0);
  if (!rates.length) return 0;

  let saved = 0;
  for (const r of rates) {
    const checkIn = r.checkIn ? new Date(r.checkIn) : new Date();
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    try {
      await PriceSnapshot.create({
        targetType: 'own', targetId: hotel._id, ownerHotelId: hotel._id,
        ota: r.source, price: r.price, currency: 'USD',
        checkIn, checkOut, source: 'xotelo',
      });
      saved += 1;
    } catch {
      // dublikat yoki validatsiya xatosi — o'tkazib yuboramiz
    }
  }
  return saved;
}

export async function runXoteloMonitor() {
  console.log('[cron] Xotelo narx yangilash boshlandi (ertaga + indin)...');
  try {
    const hotels = await Hotel.find({ isActive: true })
      .select('_id name otaUrls tripAdvisorUrl xoteloHotelKey')
      .lean();
    for (const hotel of hotels) {
      try {
        const n = await fetchXoteloForHotel(hotel);
        if (n > 0) console.log(`[cron] Xotelo ${hotel.name}: +${n} kanal narxi`);
      } catch (err) {
        console.warn(`[cron] Xotelo "${hotel.name}" xatosi:`, err.message);
      }
    }
    console.log('[cron] Xotelo narx yangilash tugadi');
  } catch (err) {
    console.error('[cron] Xotelo monitoring xatosi:', err.message);
  }
}

// Har kuni 00:00 (yarim tun) da
export function startXoteloMonitor() {
  cron.schedule('0 0 * * *', runXoteloMonitor);
  console.log('[cron] Xotelo monitoring yoqildi (har kuni 00:00)');
}
