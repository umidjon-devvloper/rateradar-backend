// ════════════════════════════════════════════════════════════════════
// NARX SIGNALLARI — raqib narxi NEGA o'zgardi (bozor/sezon vs shaxsiy to'lish)
//
// To'g'ridan-to'g'ri raqib occupancy'sini bilib bo'lmaydi (yopiq ma'lumot),
// lekin ikki signaldan bilvosita chiqaramiz:
//   • BOZOR/SEZON  — bir nechta raqib bir vaqtda narx ko'tardi (talab/sezon).
//   • SHAXSIY      — faqat bitta raqib ko'tardi (uning o'z holati: to'ldi/guruh).
//   • OCCUPANCY    — eng arzon xona yo'qoldi (arzon xonalar sotilib bitdi).
//   • STLY         — o'tgan yil shu davr bilan solishtirish (yil tarix kerak).
// ════════════════════════════════════════════════════════════════════
import Competitor from '../models/Competitor.js';
import PriceSnapshot from '../models/PriceSnapshot.js';
import RoomSnapshot from '../models/RoomSnapshot.js';

const RISE_PCT = 5;   // shu %dan ortiq o'zgarish "harakat" hisoblanadi
const DAYS = 14;      // tahlil oynasi

// Bitta raqibning kunlik ENG ARZON narx qatori (OTA'lar bo'yicha min).
async function competitorDailyLowest(competitorId, days = DAYS) {
  const since = new Date(Date.now() - days * 86400_000);
  const snaps = await PriceSnapshot.find({
    targetType: 'competitor', targetId: competitorId, snapshotAt: { $gte: since },
    price: { $gt: 0 },
  }).select('price snapshotAt').sort({ snapshotAt: 1 }).lean();

  const byDay = new Map();
  for (const s of snaps) {
    const day = new Date(s.snapshotAt).toISOString().slice(0, 10);
    const cur = byDay.get(day);
    if (cur == null || s.price < cur) byDay.set(day, s.price);
  }
  return [...byDay.entries()].map(([day, price]) => ({ day, price }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// Qatordan: eng so'nggi narx va ~7 kun oldingi bazaviy narx bo'yicha o'zgarish %.
function movementFromSeries(series) {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  // Bazaviy: 5-9 kun oldingi eng yaqin nuqta, bo'lmasa eng birinchi.
  const latestT = new Date(latest.day).getTime();
  let base = series[0];
  for (const p of series) {
    const ageDays = (latestT - new Date(p.day).getTime()) / 86400_000;
    if (ageDays >= 4) base = p; // eng so'nggi 4+ kun oldingi
  }
  if (!base || base.price <= 0 || base.day === latest.day) return null;
  const changePct = Math.round(((latest.price - base.price) / base.price) * 100);
  return { latestPrice: latest.price, basePrice: base.price, changePct };
}

/**
 * Bozor vs shaxsiy signal.
 * @returns {{ market, individual, moves, comps }}
 */
export async function analyzePriceMovements(hotelId) {
  const comps = await Competitor.find({ ownerHotelId: hotelId, isActive: true })
    .select('name').limit(20).lean();

  const moves = [];
  for (const c of comps) {
    const series = await competitorDailyLowest(c._id);
    const mv = movementFromSeries(series);
    if (mv) moves.push({ name: c.name, ...mv });
  }

  const risers = moves.filter((m) => m.changePct >= RISE_PCT);
  const fallers = moves.filter((m) => m.changePct <= -RISE_PCT);
  // Bozor ko'targanmi: ko'pchilik (yarmi yoki 2+) bir vaqtda ko'tardi.
  const threshold = Math.max(2, Math.ceil(comps.length / 2));
  const marketRising = risers.length >= threshold;
  const avgRise = risers.length
    ? Math.round(risers.reduce((s, m) => s + m.changePct, 0) / risers.length)
    : 0;

  return {
    comps: comps.length,
    market: {
      rising: marketRising,
      risers: risers.length,
      fallers: fallers.length,
      total: comps.length,
      avgRise,
    },
    // Bozor ko'tarmagan bo'lsa, ko'targan raqiblar = shaxsiy harakat.
    individual: marketRising ? [] : risers.map((m) => ({ name: m.name, changePct: m.changePct, latestPrice: m.latestPrice })),
    moves: moves.sort((a, b) => b.changePct - a.changePct),
  };
}

/**
 * Occupancy (to'lish) signali — eng arzon xona yo'qolgan raqiblar.
 * @returns {Array<{name, from, to, note}>}
 */
export async function analyzeOccupancy(hotelId) {
  const comps = await Competitor.find({ ownerHotelId: hotelId, isActive: true })
    .select('name').limit(20).lean();

  const signals = [];
  for (const c of comps) {
    const snaps = await RoomSnapshot.find({ competitorId: c._id })
      .select('minPrice minRoomName roomsLeft snapshotAt').sort({ snapshotAt: -1 }).limit(2).lean();
    if (snaps.length < 1) continue;
    const latest = snaps[0];

    // 1) Eng arzon xonada "faqat X qoldi" (to'g'ridan-to'g'ri proksi).
    if (Number.isFinite(latest.roomsLeft) && latest.roomsLeft > 0 && latest.roomsLeft <= 3) {
      signals.push({ name: c.name, type: 'rooms_left', roomsLeft: latest.roomsLeft, note: `eng arzon xonada faqat ${latest.roomsLeft} ta qoldi` });
      continue;
    }
    // 2) Eng arzon xona nomi o'zgarib, narx oshdi → arzon xona sotilib bitdi.
    if (snaps.length === 2) {
      const prev = snaps[1];
      if (latest.minRoomName && prev.minRoomName
        && latest.minRoomName !== prev.minRoomName
        && latest.minPrice > prev.minPrice) {
        signals.push({
          name: c.name, type: 'cheapest_gone',
          from: prev.minRoomName, to: latest.minRoomName,
          note: `"${prev.minRoomName}" tugadi → endi "${latest.minRoomName}"`,
        });
      }
    }
  }
  return signals;
}

/**
 * STLY (Same Time Last Year) — o'tgan yil shu davr bilan solishtirish.
 * Yil tarix bo'lmaguncha bo'sh qaytadi (TAYYOR, lekin hozircha uxlagan).
 */
export async function analyzeSTLY(hotelId) {
  const yearAgoStart = new Date(Date.now() - 366 * 86400_000);
  const yearAgoEnd = new Date(Date.now() - 358 * 86400_000);
  const cnt = await PriceSnapshot.countDocuments({
    ownerHotelId: hotelId, snapshotAt: { $gte: yearAgoStart, $lte: yearAgoEnd },
  });
  if (cnt === 0) return { available: false };
  // Yil tarix bo'lsa — o'rtacha narxni solishtiramiz (kelajakda kengaytiriladi).
  return { available: true, note: 'STLY tahlili uchun yetarli tarix mavjud' };
}

/**
 * Barcha signallarni birlashtirib, o'qiladigan xulosa bilan qaytaradi.
 */
export async function getPriceSignals(hotelId) {
  const [movements, occupancy, stly] = await Promise.all([
    analyzePriceMovements(hotelId),
    analyzeOccupancy(hotelId),
    analyzeSTLY(hotelId),
  ]);

  // O'qiladigan xulosa (AI kontekst + UI uchun).
  let headline = '';
  let recommendation = '';
  if (movements.market.rising) {
    headline = `Bozor ko'tarilyapti — ${movements.market.risers}/${movements.market.total} raqib narxni ~${movements.market.avgRise}% oshirdi.`;
    recommendation = 'Bu sezon/talab signali (bir nechta raqib birga oshirdi) — siz ham narxni ko\'tarishni ko\'rib chiqing.';
  } else if (movements.individual.length) {
    const names = movements.individual.map((m) => m.name).slice(0, 3).join(', ');
    headline = `Faqat ${movements.individual.length} raqib (${names}) narx oshirdi, bozor tinch.`;
    recommendation = 'Bu ularning SHAXSIY holati (to\'lgan/guruh bron) — ko\'r-ko\'rona takrorlamang, o\'z bo\'sh xonalaringizni hisobga oling.';
  } else {
    headline = 'Bozorda sezilarli narx harakati yo\'q.';
    recommendation = 'Narxni o\'zgartirishga shoshilmang.';
  }
  if (occupancy.length) {
    headline += ` ${occupancy.length} raqibda arzon xonalar tugayapti (to'lish belgisi).`;
  }

  return { movements, occupancy, stly, headline, recommendation, updatedAt: new Date() };
}
