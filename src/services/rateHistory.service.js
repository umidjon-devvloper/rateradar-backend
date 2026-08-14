// ════════════════════════════════════════════════════════════════════
// NARX TARIXI ROLLUP — xom snapshotlarni abadiy kunlik agregatga yig'ish
//
// Nima uchun kerak:
//   `PriceSnapshot` xom qatlam — kuniga bir necha yozuv, tez kattalashadi.
//   `DailyRate` agregat qatlam — kuniga bitta yozuv, hech qachon o'chmaydi.
//   STLY (o'tgan yil shu davr) va booking-curve tahlili AYNAN shundan o'qiydi.
//
// Idempotent: bir kunni necha marta rollup qilsangiz ham natija bir xil
// (unique kalit bo'yicha upsert). Shuning uchun cron har safar oxirgi 3 kunni
// qayta yig'adi — server o'chib qolgan bo'lsa ham tarixda teshik qolmaydi.
// ════════════════════════════════════════════════════════════════════
import cron from 'node-cron';
import PriceSnapshot from '../models/PriceSnapshot.js';
import DailyRate from '../models/DailyRate.js';

const DAY_MS = 86400_000;
const SELF_HEAL_DAYS = 3; // cron har safar shuncha oxirgi kunni qayta yig'adi

/** Sanani UTC kun boshiga keltiradi (00:00:00.000Z). */
export function utcDayStart(d) {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/** 'YYYY-MM-DD' → UTC Date. */
function fromDayKey(key) {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * Bitta O'LCHOV KUNI (captureDate) uchun xom snapshotlarni agregatga yig'adi.
 *
 * Guruhlash ikki bosqichli:
 *   1) (obyekt, tunash sanasi, OTA) → o'sha OTA'dagi eng arzon narx
 *   2) (obyekt, tunash sanasi)      → OTA'lar kesimi + umumiy minimum
 *
 * @param {Date} captureDay  o'lchov kuni
 * @returns {Promise<{scanned:number, written:number}>}
 */
export async function rollupDay(captureDay) {
  const from = utcDayStart(captureDay);
  const to = new Date(from.getTime() + DAY_MS);

  const rows = await PriceSnapshot.aggregate([
    {
      $match: {
        snapshotAt: { $gte: from, $lt: to },
        price: { $gt: 0 },
        checkIn: { $ne: null },
      },
    },
    {
      $group: {
        _id: {
          owner: '$ownerHotelId',
          targetType: '$targetType',
          targetId: '$targetId',
          stay: { $dateToString: { format: '%Y-%m-%d', date: '$checkIn' } },
          ota: '$ota',
        },
        price: { $min: '$price' },
        currency: { $first: '$currency' },
        roomsLeft: { $min: '$roomsLeft' },
        source: { $first: '$source' },
      },
    },
    {
      $group: {
        _id: {
          owner: '$_id.owner',
          targetType: '$_id.targetType',
          targetId: '$_id.targetId',
          stay: '$_id.stay',
        },
        prices: { $push: { ota: '$_id.ota', price: '$price' } },
        currency: { $first: '$currency' },
        roomsLeft: { $min: '$roomsLeft' },
        sources: { $addToSet: '$source' },
      },
    },
  ]).allowDiskUse(true);

  if (!rows.length) return { scanned: 0, written: 0 };

  const ops = rows.map((r) => {
    // OTA → narx obyekti + eng arzoni.
    const prices = {};
    let minPrice = Infinity;
    let minOta = '';
    for (const p of r.prices) {
      if (!p.ota) continue;
      // Bitta OTA bir necha marta kelsa — eng arzoni qoladi.
      if (prices[p.ota] == null || p.price < prices[p.ota]) prices[p.ota] = p.price;
      if (p.price < minPrice) { minPrice = p.price; minOta = p.ota; }
    }
    if (!Number.isFinite(minPrice)) return null;

    return {
      updateOne: {
        filter: {
          targetId: r._id.targetId,
          targetType: r._id.targetType,
          stayDate: fromDayKey(r._id.stay),
          captureDate: from,
        },
        update: {
          $set: {
            ownerHotelId: r._id.owner,
            prices,
            minPrice,
            minOta,
            currency: r.currency || 'USD',
            roomsLeft: Number.isFinite(r.roomsLeft) ? r.roomsLeft : null,
            sources: (r.sources || []).filter(Boolean),
            otaCount: Object.keys(prices).length,
          },
        },
        upsert: true,
      },
    };
  }).filter(Boolean);

  // Bo'laklab yozamiz — bitta bulkWrite'da 100k hujjat bo'lib qolmasin.
  let written = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await DailyRate.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }
  return { scanned: rows.length, written };
}

/**
 * Oxirgi N kunni qayta yig'adi (idempotent, o'zini-o'zi tuzatuvchi).
 */
export async function rollupRecent(days = SELF_HEAL_DAYS) {
  const today = utcDayStart(new Date());
  let scanned = 0;
  let written = 0;
  for (let i = 0; i < days; i += 1) {
    const day = new Date(today.getTime() - i * DAY_MS);
    try {
      const r = await rollupDay(day);
      scanned += r.scanned;
      written += r.written;
    } catch (err) {
      console.error(`[rollup] ${day.toISOString().slice(0, 10)} xato:`, err.message);
    }
  }
  return { scanned, written };
}

/**
 * BACKFILL — bazadagi BARCHA mavjud xom snapshotlarni agregatga ko'chiradi.
 *
 * Bu bir martalik (lekin qayta ishga tushirsa xavfsiz) operatsiya. Ilgari TTL
 * indeksi tarixni 90 kunda o'chirar edi — shuning uchun buni imkon qadar TEZ
 * bajarish kerak: har kechiktirilgan kun bazadagi eng eski kunni yo'qotadi.
 */
export async function backfillAll({ onProgress } = {}) {
  const oldest = await PriceSnapshot.findOne().sort({ snapshotAt: 1 }).select('snapshotAt').lean();
  if (!oldest) return { days: 0, scanned: 0, written: 0 };

  const start = utcDayStart(oldest.snapshotAt);
  const today = utcDayStart(new Date());
  const totalDays = Math.floor((today - start) / DAY_MS) + 1;

  let scanned = 0;
  let written = 0;
  for (let i = 0; i < totalDays; i += 1) {
    const day = new Date(start.getTime() + i * DAY_MS);
    const r = await rollupDay(day);
    scanned += r.scanned;
    written += r.written;
    onProgress?.({ day, index: i + 1, totalDays, ...r });
  }
  return { days: totalDays, scanned, written, from: start, to: today };
}

/**
 * Tarix qamrovi — UI'da halol ko'rsatish uchun ("STLY 2027-avgustdan ishlaydi,
 * hozir 90 kunlik tarix yig'ilgan").
 *
 * @returns {Promise<{days:number, firstCapture:Date|null, lastCapture:Date|null,
 *                    stlyReadyAt:Date|null, daysUntilStly:number}>}
 */
export async function getHistoryCoverage(hotelId) {
  const [agg] = await DailyRate.aggregate([
    { $match: { ownerHotelId: hotelId } },
    {
      $group: {
        _id: null,
        first: { $min: '$captureDate' },
        last: { $max: '$captureDate' },
        days: { $addToSet: '$captureDate' },
      },
    },
    { $project: { first: 1, last: 1, days: { $size: '$days' } } },
  ]);

  if (!agg?.first) {
    return { days: 0, firstCapture: null, lastCapture: null, stlyReadyAt: null, daysUntilStly: 364 };
  }
  // STLY 364 kun (52 hafta) tarix bo'lganda ishlay boshlaydi.
  const stlyReadyAt = new Date(new Date(agg.first).getTime() + 364 * DAY_MS);
  const daysUntilStly = Math.max(0, Math.ceil((stlyReadyAt - Date.now()) / DAY_MS));
  return {
    days: agg.days,
    firstCapture: agg.first,
    lastCapture: agg.last,
    stlyReadyAt,
    daysUntilStly,
  };
}

/** Har kuni 04:00 — kechagi (va oxirgi 3 kunlik) xom narxni agregatga yig'adi. */
export function startRateHistoryRollup() {
  cron.schedule('0 4 * * *', async () => {
    const r = await rollupRecent();
    console.log(`[cron] Narx tarixi rollup: ${r.written} yozuv (${r.scanned} guruh)`);
  });
  console.log('[cron] Narx tarixi rollup yoqildi (har kuni 04:00)');
}
