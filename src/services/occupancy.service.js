// ════════════════════════════════════════════════════════════════════
// TO'LISH DARAJASI (occupancy) — narx tavsiyasining yetishmagan yarmi
//
// Shu paytgacha tavsiya faqat RAQIBLAR narxiga qarab berilardi. Bu revenue
// management emas — bu raqiblar medianasi. Haqiqiy qaror ikki narsaga bog'liq:
//   1) raqiblar qancha so'rayapti  (bor edi)
//   2) SIZDA qancha bo'sh xona bor (yo'q edi)
//
// Ikkinchisisiz mahsulot xavfli maslahat beradi: raqiblar qimmat bo'lgani
// uchun narxni ko'tarasiz, xonalaringiz esa bo'sh qoladi.
//
// PMS integratsiyasi shart emas — haftada bitta savol yetarli.
//
// ⬆ YUQORIDAGI IZOH ENDI YARIM TARIX. 2026-08 dan boshlab Exely (PMS/
// Channel Manager) integratsiyasi ulangan mijozda to'lish darajasi
// SO'RALMAYDI — u haqiqiy bronlardan aniq hisoblanadi. Qo'lda so'rov
// endi FALLBACK: Exely ulanmagan mijozlar uchun qoladi.
// Yagona kirish nuqtasi — `resolveOccupancy()` (fayl oxirida).
// ════════════════════════════════════════════════════════════════════

export const BANDS = {
  LOW: 'low',    // < 40%  — bo'sh xona ko'p
  MID: 'mid',    // 40-70% — normal
  HIGH: 'high',  // > 70%  — to'lib boryapti
};

const DAY_MS = 86400_000;
// Hisobot shu muddatdan eski bo'lsa — "yo'q" hisoblanadi. Occupancy tez
// eskiradi: o'tgan haftaning to'lishi bugungi qarorga asos bo'lolmaydi.
const REPORT_MAX_AGE_DAYS = 10;

/** Berilgan sananing UTC dushanbasi (hafta boshi). */
export function weekStartOf(date = new Date()) {
  const d = new Date(date);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: 0=yakshanba. Dushanbani hafta boshi qilamiz.
  const shift = (utc.getUTCDay() + 6) % 7;
  return new Date(utc.getTime() - shift * DAY_MS);
}

/**
 * Hozirgi (yoki eng so'nggi yaroqli) occupancy hisoboti.
 * @returns {{band:string, weekStart:Date, reportedAt:Date, ageDays:number}|null}
 */
export function currentOccupancy(hotel) {
  const reports = hotel?.occupancyReports;
  if (!Array.isArray(reports) || !reports.length) return null;

  const latest = reports.reduce((a, b) =>
    (new Date(b.weekStart) > new Date(a.weekStart) ? b : a));
  const ageDays = Math.floor((Date.now() - new Date(latest.weekStart).getTime()) / DAY_MS);
  if (ageDays > REPORT_MAX_AGE_DAYS) return null; // eskirgan — yo'q deb hisoblaymiz

  return {
    band: latest.band,
    weekStart: latest.weekStart,
    reportedAt: latest.reportedAt,
    ageDays,
  };
}

/** Shu hafta uchun hisobot berilganmi (UI'da so'ramaslik uchun). */
export function hasReportedThisWeek(hotel) {
  const ws = weekStartOf().getTime();
  return (hotel?.occupancyReports || []).some(
    (r) => new Date(r.weekStart).getTime() === ws,
  );
}

/**
 * Hisobotni yozadi (shu hafta uchun bo'lsa — ustiga yozadi, dublikat qilmaydi).
 * Massiv cheksiz o'smasin: oxirgi 60 hafta saqlanadi (~14 oy, STLY uchun yetarli).
 */
export function upsertReport(hotel, band) {
  if (!Object.values(BANDS).includes(band)) {
    const e = new Error('band noto\'g\'ri — low | mid | high bo\'lishi kerak');
    e.status = 400;
    throw e;
  }
  const ws = weekStartOf();
  const reports = (hotel.occupancyReports || []).filter(
    (r) => new Date(r.weekStart).getTime() !== ws.getTime(),
  );
  reports.push({ weekStart: ws, band, reportedAt: new Date() });
  reports.sort((a, b) => new Date(a.weekStart) - new Date(b.weekStart));
  hotel.occupancyReports = reports.slice(-60);
  return hotel.occupancyReports;
}


// ════════════════════════════════════════════════════════════════════
// REAL TO'LISH DARAJASI (Exely) — qo'lda so'rovning o'rnini bosadi
// ════════════════════════════════════════════════════════════════════

// Foizni bandga o'giradi — chegaralar yuqoridagi BANDS izohi bilan bir xil.
export function bandFromPct(pct) {
  if (pct < 40) return BANDS.LOW;
  if (pct <= 70) return BANDS.MID;
  return BANDS.HIGH;
}

/**
 * Sur'at nisbatini bandga o'giradi.
 *
 * 1.0 = o'tgan yilgi shu bosqich bilan bir xil. Chegaralar ±15% —
 * undan kichik farq mavsumiy shovqin, unga qarab narx o'zgartirilmaydi.
 */
export function bandFromPace(ratio) {
  if (ratio < 0.85) return BANDS.LOW;   // orqada — bo'sh xona xavfi
  if (ratio <= 1.15) return BANDS.MID;  // odatdagidek
  return BANDS.HIGH;                    // oldinda — narx ko'tarish imkoni
}

// Kelasi shuncha kun bo'yicha o'rtacha to'lish olinadi. 7 kun tanlandi:
// qo'lda so'rov ham "kelasi 7 kun" edi, ya'ni band'lar taqqoslanadi
// qoladi va quyi oqimdagi mantiq (AI prompt, priceSignal) o'zgarmaydi.
const FORWARD_DAYS = 7;

/**
 * To'lish darajasi — imkon bo'lsa REAL, bo'lmasa qo'lda hisobotdan.
 *
 * Qaytadigan shakl `currentOccupancy()` bilan MOS: `{ band, ... }`.
 * Shuning uchun chaqiruvchi kod (AI prompt, narx signali) o'zgarishsiz
 * ishlaydi — faqat endi band taxmin emas, o'lchov.
 *
 * @param {object} hotel  Hotel hujjati (occupancyReports bilan)
 * @returns {Promise<{band:string, source:'exely'|'manual', occupancyPct?:number}|null>}
 */
export async function resolveOccupancy(hotel) {
  if (!hotel?._id) return null;

  try {
    const [{ default: Integration }, metrics] = await Promise.all([
      import('../models/Integration.js'),
      import('./metrics/ownMetrics.service.js'),
    ]);

    const integ = await Integration
      .findOne({ hotelId: hotel._id, status: 'active' })
      .select('_id')
      .lean();

    if (integ) {
      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + (FORWARD_DAYS - 1) * 86400_000);
      const { days, capacity } = await metrics.dailyMetrics(hotel._id, { from, to });

      // Sig'im noma'lum bo'lsa foiz hisoblab bo'lmaydi — qo'lda hisobotga
      // tushamiz. Soxta raqam ko'rsatgandan ko'ra rost fallback yaxshi.
      if (capacity > 0 && days.length) {
        const sold = days.reduce((s, d) => s + d.roomNights, 0);
        const pct = (sold / (capacity * days.length)) * 100;

        // ⚠️ XOM FOIZNI TO'G'RIDAN-TO'G'RI BANDGA AYLANTIRIB BO'LMAYDI.
        //
        // Bu mehmonxonada bronning yarmi KELGAN KUNI qilinadi (median
        // lead time — 1 kun). Ya'ni "kelasi 7 kun" oynasi har doim bo'sh
        // ko'rinadi: tunlar hali sotilmagan, chunki sotilish vaqti
        // kelmagan. Xom foizga qarasak band DOIM `low` chiqadi va AI
        // to'xtovsiz "narxni tushiring" deb turadi — bu zararli maslahat.
        //
        // To'g'ri o'lchov — O'Z TARIXIGA NISBATAN SUR'AT: shu bosqichda
        // (bir yil oldin, xuddi shu kunlar qolganda) kitobda qancha bor
        // edi? Undan orqada bo'lsak — haqiqatan sekin ketyapmiz.
        const pace = await metrics.paceVsLastYear(hotel._id, { from, to });

        return {
          band: pace?.ratio != null ? bandFromPace(pace.ratio) : bandFromPct(pct),
          source: 'exely',
          basis: pace?.ratio != null ? 'pace' : 'absolute',
          occupancyPct: Number(pct.toFixed(1)),
          pace,                       // { ratio, lastYearRoomNights, ... } yoki null
          roomNights: sold,
          capacity,
          forwardDays: days.length,
          reportedAt: new Date(),
          ageDays: 0,
        };
      }
    }
  } catch {
    // Integratsiya yoki metrika xatosi narx tavsiyasini TO'XTATMASLIGI kerak —
    // jimgina qo'lda hisobotga tushamiz.
  }

  const manual = currentOccupancy(hotel);
  return manual ? { ...manual, source: 'manual' } : null;
}
