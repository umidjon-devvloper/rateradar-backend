import { exelyRequest } from './client.js';

// ════════════════════════════════════════════════════════════════════
// READ RESERVATION API — mehmonxonaning O'Z bronlari
//
// Ikki bosqichli: avval SUMMARY (raqam + status + o'zgarish vaqti), keyin
// kerak bo'lganlarining DETALI. Shu tufayli har sinxronizatsiyada 3800 ta
// to'liq bron emas, faqat o'zgarganlari yuklanadi.
//
// Sahifalash `continueToken` orqali: javobdagi token KEYINGI so'rovda
// "shundan keyingi o'zgarganlarini ber" degani. Ya'ni token — bu kursor,
// uni saqlab qo'ysak inkremental sync o'zi kelib chiqadi.
//
// ⚠️ `lastModification` MAJBURIY UTC formatida bo'lishi kerak:
//    '2026-01-01T00:00:00Z'.  '2026-01-01T00:00:00' → 400 Invalid date format.
// ════════════════════════════════════════════════════════════════════

const BASE = '/api/read-reservation/v1';

// Exely ruxsat bergan eng erta sana — birinchi to'liq yuklashda shundan boshlaymiz.
export const EPOCH = '2009-01-01T00:00:00Z';

/** Date → Exely qabul qiladigan '2026-01-01T00:00:00Z' ko'rinishi. */
export function toExelyUtc(d) {
  return `${new Date(d).toISOString().slice(0, 19)}Z`;
}

/**
 * Bron qisqacha ro'yxati (sahifa).
 * @returns {{bookingSummaries:Array, continueToken:string, hasMoreData:boolean}}
 */
export async function fetchBookingSummaries(creds, propertyId, { continueToken, lastModification, count = 1000 } = {}) {
  const query = { count };
  // continueToken va lastModification BIRGA yuborilmaydi — token bo'lsa u ustun.
  if (continueToken) query.continueToken = continueToken;
  else query.lastModification = lastModification || EPOCH;

  const data = await exelyRequest({
    ...creds,
    path: `${BASE}/properties/${encodeURIComponent(propertyId)}/bookings`,
    query,
    timeout: 60_000,
  });

  return {
    bookingSummaries: data?.bookingSummaries || [],
    continueToken: data?.continueToken || '',
    hasMoreData: Boolean(data?.hasMoreData),
  };
}

/** Bitta bronning to'liq tarkibi. */
export async function fetchBookingDetail(creds, propertyId, number) {
  const data = await exelyRequest({
    ...creds,
    path: `${BASE}/properties/${encodeURIComponent(propertyId)}/bookings/${encodeURIComponent(number)}`,
  });
  return data?.booking || null;
}

// ── Normalizatsiya ──────────────────────────────────────────────────

const DAY_MS = 86400_000;

/**
 * 'YYYY-MM-DDTHH:mm' (yoki Date) → o'sha kunning UTC yarim tuni.
 *
 * Exely tunash sanalarini VAQT MINTAQASISIZ beradi ("2026-01-02T17:00") —
 * ular obyektning mahalliy sanasi. Biz ularni "sana" sifatida saqlaymiz,
 * shuning uchun mintaqaviy siljish qo'llanmaydi: 2-yanvar tuni har qanday
 * mintaqada 2-yanvar tuni bo'lib qolaveradi.
 */
function dayOf(v) {
  if (!v) return null;
  // Date kelsa String(date) "Tue Jan 02 2026..." beradi va slice(0,10) buziladi.
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * UTC lahzani OBYEKT MAHALLIY sanasiga o'giradi.
 *
 * Kerak, chunki Exely ikki xil vaqtni aralashtirib beradi:
 *   • createdDateTime  — UTC ("2026-01-02T11:46:16Z")
 *   • arrivalDateTime  — mahalliy, mintaqasiz ("2026-01-02T17:00")
 * Ularni to'g'ridan-to'g'ri ayirish lead time'ni buzadi: Toshkent (UTC+5)
 * da soat 01:00 da qilingan bron UTC'da hali OLDINGI kun bo'ladi va
 * "ertaga keladi" o'rniga "bugun keladi" bo'lib chiqadi.
 */
function localDayKey(instant, timeZone) {
  if (!instant) return null;
  try {
    // en-CA lokali 'YYYY-MM-DD' formatini beradi.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(instant));
  } catch {
    // Noto'g'ri mintaqa nomi — UTC'ga tushamiz (xato tashlamaymiz).
    return new Date(instant).toISOString().slice(0, 10);
  }
}

function nightsBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(Math.round((b.getTime() - a.getTime()) / DAY_MS), 0);
}

/**
 * Bron kanalini aniqlaydi.
 *
 * Exely modelida OTA kanali = ALOHIDA TARIF REJASI ("Booking.com", "Expedia",
 * "tiket.com"). `source.code` esa qisqartma ("BGC", "EXP") va uning rasmiy
 * lug'ati hujjatda yo'q — shuning uchun uni TAXMIN QILMAYMIZ, xom holda
 * saqlaymiz, ko'rsatiladigan nomni esa tarif nomidan olamiz.
 */
function deriveChannel(sourceType, ratePlanNames) {
  const rp = ratePlanNames.find(Boolean) || '';
  switch (sourceType) {
    case 'BookingEngine': return "O'z sayti";
    case 'PMS': return 'PMS / Walk-in';
    case 'Channel': return rp || 'OTA';
    default: return rp || sourceType || 'Noma\'lum';
  }
}

/**
 * Xom Exely bronini bizning saqlash ko'rinishimizga o'giradi.
 *
 * ⚠️ MEHMON MA'LUMOTI (PII) SHU YERDA KESILADI.
 * Xom javobda `guests[]` (ism, familiya) va `customer` (ism, telefon, email,
 * hujjat) bor. Ular:
 *   • mahsulotga KERAK EMAS — occupancy/ADR/pace faqat sana va narxdan
 *     hisoblanadi;
 *   • saqlansa — 200 mijozning mehmon bazasi bizda to'planadi, bu jiddiy
 *     huquqiy va xavfsizlik yuki.
 * Shuning uchun ular baza yozuviga UMUMAN TUSHMAYDI.
 */
export function normalizeBooking(raw, { hotelId, integrationId, timeZone = 'UTC' }) {
  if (!raw?.number) return null;

  const createdAt = raw.createdDateTime ? new Date(raw.createdDateTime) : null;
  const stays = Array.isArray(raw.roomStays) ? raw.roomStays : [];
  const ratePlanNames = [];

  const roomStays = stays.map((rs) => {
    const arrival = dayOf(rs?.stayDates?.arrivalDateTime);
    const departure = dayOf(rs?.stayDates?.departureDateTime);
    const plans = Array.isArray(rs.ratePlans) ? rs.ratePlans : [];
    plans.forEach((p) => p?.name && ratePlanNames.push(p.name));

    const daily = (Array.isArray(rs.dailyRates) ? rs.dailyRates : [])
      .map((d) => ({ date: dayOf(d.date), price: Number(d.priceBeforeTax || 0) }))
      .filter((d) => d.date);

    // dailyRates bo'sh bo'lsa sanalardan hisoblaymiz — occupancy uchun tunlar
    // soni har doim kerak, hatto narx ko'rsatilmagan bronda ham.
    const n = nightsBetween(arrival, departure) || (daily.length ? daily.length : 0);

    return {
      arrivalDate: arrival,
      departureDate: departure,
      nights: n,
      roomTypeId: String(rs?.roomType?.id || ''),
      roomTypeName: rs?.roomType?.name || '',
      ratePlanId: String(plans[0]?.id || ''),
      ratePlanName: plans[0]?.name || '',
      adults: Number(rs?.guestCount?.adultCount || 0),
      childAges: Array.isArray(rs?.guestCount?.childAges) ? rs.guestCount.childAges : [],
      beforeTax: Number(rs?.total?.priceBeforeTax || 0),
      afterTax: Number(rs?.total?.priceAfterTax || 0),
      dailyRates: daily,
      mealPlanCodes: (Array.isArray(rs.services) ? rs.services : [])
        .map((s) => s?.mealPlanCode)
        .filter((c) => c && c !== 'Unknown'),
    };
  });

  const arrivals = roomStays.map((r) => r.arrivalDate).filter(Boolean);
  const departures = roomStays.map((r) => r.departureDate).filter(Boolean);
  const arrivalDate = arrivals.length ? new Date(Math.min(...arrivals)) : null;
  const departureDate = departures.length ? new Date(Math.max(...departures)) : null;

  const sourceType = raw?.source?.type || '';

  return {
    hotelId,
    integrationId,
    propertyId: String(raw.propertyId || ''),
    number: String(raw.number),

    status: raw.status || '',
    isCancelled: raw.status === 'Cancelled',

    createdAt,
    modifiedAt: raw.modifiedDateTime ? new Date(raw.modifiedDateTime) : null,
    // ⚠️ Maydon nomi `cancelledDateTime` (`dateTime` EMAS). Bu qiymat
    // pace/OTB tahlili uchun shart: "30 kun oldin kitobda nima bor edi"
    // savoliga javob berish uchun bronning O'SHANDA bekor qilinganmi yoki
    // yo'qligini bilish kerak.
    cancelledAt: raw?.cancellation?.cancelledDateTime
      ? new Date(raw.cancellation.cancelledDateTime)
      : null,
    cancellationPenalty: Number(raw?.cancellation?.penaltyAmount || 0),

    currency: raw.currencyCode || '',
    sourceType,
    sourceCode: raw?.source?.code || '',   // xom holda — lug'ati tasdiqlanmagan
    // `channel` — odam o'qiydigan nom, O'ZGARISHI MUMKIN: u tarif nomidan
    // olinadi va mehmonxona tarifni istalgan vaqt qayta nomlashi mumkin
    // (real misol: BGC kanalidagi bron "Online tariff" deb yozilgan).
    // Shuning uchun HISOBOT/GURUHLASH `channelKey` bo'yicha qilinsin —
    // u `source.code` ga tayanadi va vaqt o'tishi bilan o'zgarmaydi.
    channel: deriveChannel(sourceType, ratePlanNames),
    channelKey: sourceType === 'Channel'
      ? (raw?.source?.code || 'OTA')
      : (sourceType || 'Unknown'),

    arrivalDate,
    departureDate,
    // Jami tunlar = xonalar × tunlar (2 xona × 3 tun = 6 room-night).
    // Occupancy AYNAN shu birlikda hisoblanadi.
    roomNights: roomStays.reduce((s, r) => s + r.nights, 0),
    roomCount: roomStays.length,
    adults: roomStays.reduce((s, r) => s + r.adults, 0),
    children: roomStays.reduce((s, r) => s + r.childAges.length, 0),

    // Bron qilingandan kelishgacha necha kun — bu mehmonxonada median 1 kun,
    // ya'ni last-minute bozor. Narx strategiyasi shunga qarab quriladi.
    //
    // ⚠️ MANFIY BO'LISHI MUMKIN va bu XATO EMAS. Ikki sabab:
    //   1) PMS'ga ko'chirish — mehmonxona Exely'ga ulangan kuni (bu obyektda
    //      2025-02-04) undan OLDINGI bronlar o'sha kun "yaratilgan" bo'lib
    //      import qilingan, kelish sanasi esa o'tmishda qolgan;
    //   2) mehmon kelib bo'lgach xodim bronni qo'lda kiritgan (walk-in).
    // Xom qiymatni saqlaymiz — "tuzatib" yozsak ko'chirish izi yo'qoladi va
    // pace tahlili birinchi kunlarda soxta ko'rsatkich beradi. Filtrlash
    // metrika qatlamining ishi (Faza 3).
    leadTimeDays: (createdAt && arrivalDate)
      ? Math.round(
        (arrivalDate.getTime() - dayOf(localDayKey(createdAt, timeZone)).getTime()) / DAY_MS,
      )
      : null,

    totalBeforeTax: Number(raw?.total?.priceBeforeTax || 0),
    totalAfterTax: Number(raw?.total?.priceAfterTax || 0),
    taxAmount: Number(raw?.total?.taxAmount || 0),
    prepaid: Number(raw?.guaranteeInfo?.totalPrepaid || 0),

    roomStays,
    syncedAt: new Date(),
  };
}
