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
