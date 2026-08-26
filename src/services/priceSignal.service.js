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
import DailyRate from '../models/DailyRate.js';
import Hotel from '../models/Hotel.js';
import { utcDayStart, getHistoryCoverage } from './rateHistory.service.js';
import { resolveOccupancy } from './occupancy.service.js';

const RISE_PCT = 5;   // shu %dan ortiq o'zgarish "harakat" hisoblanadi
const DAYS = 14;      // tahlil oynasi
const DAY_MS = 86400_000;
// 365 emas, 364 (52 hafta) — hafta kunini saqlaydi. Mehmonxonada juma va
// seshanba narxi tubdan farq qiladi; 365 kun bilan solishtirish hafta kunini
// siljitadi va taqqoslashni ma'nosiz qiladi.
const STLY_OFFSET_DAYS = 364;

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
 * Berilgan TUNASH oynasi uchun o'rtacha narx — o'z hoteli va bozor (raqiblar)
 * kesimida. Har (obyekt, tunash sanasi) juftligi uchun ENG SO'NGGI o'lchov
 * olinadi, shundan keyingina o'rtachalanadi — aks holda tez-tez skreyp
 * qilingan obyekt o'rtachani o'ziga tortadi.
 */
async function windowAverage(hotelId, fromStay, toStay) {
  const rows = await DailyRate.aggregate([
    { $match: { ownerHotelId: hotelId, stayDate: { $gte: fromStay, $lte: toStay }, minPrice: { $gt: 0 } } },
    { $sort: { captureDate: -1 } },
    {
      $group: {
        _id: { target: '$targetId', stay: '$stayDate' },
        targetType: { $first: '$targetType' },
        minPrice: { $first: '$minPrice' },
      },
    },
    { $group: { _id: '$targetType', avg: { $avg: '$minPrice' }, points: { $sum: 1 } } },
  ]);

  const own = rows.find((r) => r._id === 'own');
  const market = rows.find((r) => r._id === 'competitor');
  return {
    own: own ? { avg: Math.round(own.avg), points: own.points } : { avg: 0, points: 0 },
    market: market ? { avg: Math.round(market.avg), points: market.points } : { avg: 0, points: 0 },
  };
}

function pctChange(now, then) {
  if (!then || then <= 0 || !now || now <= 0) return null;
  return Math.round(((now - then) / then) * 100);
}

/**
 * STLY (Same Time Last Year) — o'tgan yil shu davr bilan solishtirish.
 *
 * Ma'lumot manbai `DailyRate` (abadiy agregat), `PriceSnapshot` EMAS — xom
 * qatlamda TTL bo'lishi mumkin va u tarixiy savolga javob bera olmaydi.
 *
 * Tarix yetmasa `available:false` qaytadi, LEKIN sababi va QACHON ishlashi
 * bilan birga — UI shuni halol ko'rsatsin ("tarix yig'ilmoqda: 90/364 kun"),
 * bo'sh joy emas.
 */
export async function analyzeSTLY(hotelId) {
  const today = utcDayStart(new Date());
  const winFrom = today;
  const winTo = new Date(today.getTime() + (DAYS - 1) * DAY_MS);
  const lyFrom = new Date(winFrom.getTime() - STLY_OFFSET_DAYS * DAY_MS);
  const lyTo = new Date(winTo.getTime() - STLY_OFFSET_DAYS * DAY_MS);

  const [now, lastYear] = await Promise.all([
    windowAverage(hotelId, winFrom, winTo),
    windowAverage(hotelId, lyFrom, lyTo),
  ]);

  // O'tgan yil shu oynada bozor ma'lumoti yo'q → taqqoslab bo'lmaydi.
  if (!lastYear.market.points && !lastYear.own.points) {
    const cov = await getHistoryCoverage(hotelId);
    return {
      available: false,
      reason: 'insufficient_history',
      historyDays: cov.days,
      requiredDays: STLY_OFFSET_DAYS,
      daysUntilStly: cov.daysUntilStly,
      stlyReadyAt: cov.stlyReadyAt,
      note: cov.days
        ? `Tarix yig'ilmoqda: ${cov.days} / ${STLY_OFFSET_DAYS} kun`
        : 'Narx tarixi hali yig\'ilmagan',
    };
  }

  const marketChangePct = pctChange(now.market.avg, lastYear.market.avg);
  const ownChangePct = pctChange(now.own.avg, lastYear.own.avg);

  // Asosiy xulosa: bozor o'tgan yilga nisbatan qayerda, va siz undan orqadamisiz.
  let note = '';
  if (marketChangePct != null && ownChangePct != null) {
    const gap = ownChangePct - marketChangePct;
    if (gap <= -5) {
      note = `Bozor o'tgan yilga nisbatan ${marketChangePct > 0 ? '+' : ''}${marketChangePct}%, siz ${ownChangePct > 0 ? '+' : ''}${ownChangePct}% — bozordan ${Math.abs(gap)}% orqadasiz.`;
    } else if (gap >= 5) {
      note = `Siz o'tgan yilga nisbatan ${ownChangePct > 0 ? '+' : ''}${ownChangePct}%, bozor ${marketChangePct > 0 ? '+' : ''}${marketChangePct}% — bozordan ${gap}% oldindasiz.`;
    } else {
      note = `Siz ham, bozor ham o'tgan yilga nisbatan taxminan bir xil harakatda (${marketChangePct > 0 ? '+' : ''}${marketChangePct}%).`;
    }
  } else if (marketChangePct != null) {
    note = `Bozor o'tgan yilning shu davriga nisbatan ${marketChangePct > 0 ? '+' : ''}${marketChangePct}%.`;
  }

  return {
    available: true,
    window: { from: winFrom, to: winTo },
    lastYearWindow: { from: lyFrom, to: lyTo },
    market: { now: now.market.avg, lastYear: lastYear.market.avg, changePct: marketChangePct, points: lastYear.market.points },
    own: { now: now.own.avg, lastYear: lastYear.own.avg, changePct: ownChangePct, points: lastYear.own.points },
    note,
  };
}

/**
 * Barcha signallarni birlashtirib, o'qiladigan xulosa bilan qaytaradi.
 */
export async function getPriceSignals(hotelId) {
  const [movements, occupancy, stly, hotel] = await Promise.all([
    analyzePriceMovements(hotelId),
    analyzeOccupancy(hotelId),
    analyzeSTLY(hotelId),
    Hotel.findById(hotelId).select('occupancyReports').lean(),
  ]);
  // Exely ulangan bo'lsa — o'lchangan to'lish, aks holda qo'lda hisobot.
  // `hotel` bu yerda .lean() bilan olingan, shuning uchun _id ni beramiz.
  const ownOccupancy = await resolveOccupancy(hotel ? { ...hotel, _id: hotelId } : null);

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
  // STLY tayyor bo'lsa — xulosaga qo'shamiz. Bu bozor harakatiga mavsumiy
  // kontekst beradi: "raqiblar ko'tardi" ≠ "o'tgan yildan qimmat".
  if (stly.available && stly.note) headline += ` ${stly.note}`;

  // ── O'Z TO'LISH DARAJANGIZ ────────────────────────────────────────
  // Tavsiya matni ilgari "o'z bo'sh xonalaringizni hisobga oling" derdi —
  // ya'ni javobni foydalanuvchiga tashlab qo'yardi. Endi tizim buni BILADI
  // (agar hisobot berilgan bo'lsa) va aniq gapiradi.
  if (ownOccupancy) {
    if (ownOccupancy.band === 'low') {
      recommendation = 'Sizda bo\'sh xona ko\'p (to\'lish 40% dan past) — raqiblar qimmat bo\'lsa ham narxni ko\'tarmang. Bu holatda bo\'sh xonani sotish qimmat sotishdan muhimroq.';
    } else if (ownOccupancy.band === 'high' && movements.market.rising) {
      recommendation = 'Siz ham to\'lib boryapsiz (70% dan yuqori), bozor ham ko\'tarilyapti — narxni ko\'tarish uchun eng qulay payt.';
    } else if (ownOccupancy.band === 'high') {
      recommendation = 'To\'lish darajangiz yuqori (70% dan ortiq) — bozor tinch bo\'lsa ham narxni ehtiyotkorlik bilan ko\'tarishingiz mumkin.';
    }
  } else {
    recommendation += ' To\'lish darajangizni kiritsangiz, tavsiya aniqroq bo\'ladi.';
  }

  return {
    movements,
    occupancy,          // raqiblardagi to'lish belgilari
    ownOccupancy,       // sizning to'lish darajangiz (null = hisobot yo'q)
    stly,
    headline,
    recommendation,
    updatedAt: new Date(),
  };
}
