import mongoose from 'mongoose';
import Hotel from '../../models/Hotel.js';
import Integration from '../../models/Integration.js';
import OwnBooking from '../../models/OwnBooking.js';
import { warmRates, getCachedRate, getRate } from '../fx.service.js';

// ════════════════════════════════════════════════════════════════════
// O'Z KO'RSATKICHLARIM — occupancy / ADR / RevPAR / pickup
//
// Manba: `OwnBooking` (Exely'dan kelgan haqiqiy bronlar). Bu raqiblar
// narxidan tubdan farq qiladi: bu yerda taxmin yo'q, sotilgan tun aniq.
//
// UCH TA TAMOYIL:
//
// 1) O'lchov birligi — XONA-TUN (room-night), bron emas. 2 xonali 3 tunlik
//    bron = 6 xona-tun. Occupancy va ADR faqat shu birlikda to'g'ri chiqadi.
//
// 2) Valyuta TUNASH SANASI kursida so'mga o'giriladi. Bugungi kurs bilan
//    o'tgan yilni hisoblash tarixni buzadi. Kursi topilmagan tun hisobga
//    UMUMAN olinmaydi va `coverage` da ochiq aytiladi — 0 deb yozib
//    tushumni sun'iy pasaytirmaymiz.
//
// 3) `asOf` (OTB — on the books) bronlar jurnalidan TIKLANADI, kunlik
//    snapshot saqlanmaydi: bron `asOf` sanasida kitobda bo'lgan, agar
//    o'shanda yaratilgan BO'LSA va hali bekor qilinMAGAN bo'lsa. Shu
//    tufayli "30 kun oldin qanday edi" savoliga orqaga qarab ham javob
//    beramiz — snapshot yig'ishni boshlashimizni kutmasdan.
// ════════════════════════════════════════════════════════════════════

const DAY_MS = 86400_000;

const dayStart = (d) => {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};
const ymd = (d) => d.toISOString().slice(0, 10);
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/**
 * Bron `asOf` sanasida kitobda bo'lganmi — shu shartni beradi.
 * asOf berilmasa: hozirgi holat (bekor qilinmaganlar).
 */
function booksFilter(asOf) {
  if (!asOf) return { isCancelled: false };
  const s = new Date(asOf);
  return {
    createdAt: { $lte: s },
    $or: [
      { isCancelled: false },
      { cancelledAt: null },        // bekor, lekin vaqti noma'lum → kitobda deb olamiz
      { cancelledAt: { $gt: s } },  // o'sha paytda hali bekor qilinmagan
    ],
  };
}

/**
 * Mehmonxona sig'imi (jami xona soni).
 *
 * Exely Content API JISMONIY xona sonini bermaydi (faqat xona TURLARI),
 * PMS API esa bu ulanishda yopiq. Shuning uchun:
 *   1) mijoz onboardingda kiritgan `Hotel.rooms` — ishonchli manba;
 *   2) bo'lmasa — tarixda BIR TUNDA kuzatilgan eng ko'p band xona.
 *      Bu pastki chegara: haqiqiy sig'im undan kam bo'lishi mumkin emas.
 *      Bunday holda occupancy YUQORI ko'rsatiladi va `estimated: true`
 *      bilan belgilanadi — foydalanuvchi buni bilib turishi shart.
 */
export async function resolveCapacity(hotelId) {
  const id = oid(hotelId);
  const hotel = await Hotel.findById(id).select('rooms').lean();
  if (hotel?.rooms > 0) return { rooms: hotel.rooms, source: 'hotel', estimated: false };

  const peak = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, isCancelled: false } },
    { $unwind: '$roomStays' },
    { $unwind: '$roomStays.dailyRates' },
    { $group: { _id: '$roomStays.dailyRates.date', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 1 },
  ]);
  const rooms = peak[0]?.n || 0;
  return {
    rooms,
    source: rooms ? 'observed' : 'unknown',
    estimated: true,
    note: rooms
      ? 'Xona soni kiritilmagan — tarixdagi eng band tun bo\'yicha taxmin. '
        + 'Aniq son uchun Sozlamalarda xona sonini kiriting.'
      : 'Xona soni noma\'lum — occupancy hisoblanmaydi.',
  };
}

/**
 * Kunlik ko'rsatkichlar: sotilgan tun, tushum (UZS), ADR, occupancy, RevPAR.
 *
 * @param {string} hotelId
 * @param {{from:Date|string, to:Date|string, asOf?:Date|string, capacity?:number}} opts
 */
export async function dailyMetrics(hotelId, { from, to, asOf, capacity } = {}) {
  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);

  const rows = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, ...booksFilter(asOf) } },
    { $unwind: '$roomStays' },
    { $unwind: '$roomStays.dailyRates' },
    { $match: { 'roomStays.dailyRates.date': { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { date: '$roomStays.dailyRates.date', currency: '$currency' },
        nights: { $sum: 1 },
        amount: { $sum: '$roomStays.dailyRates.price' },
      },
    },
  ]);

  // Kurslar — FAQAT keshdan. Tarmoqni kutmaymiz (fx.service.js izohi).
  await warmRates(
    rows.map((r) => ({ currency: r._id.currency, date: r._id.date })),
    { fetchMissing: false },
  );

  const cap = capacity ?? (await resolveCapacity(id)).rooms;

  const byDate = new Map();
  let skippedNights = 0;
  const missingCurrencies = new Set();

  for (const r of rows) {
    const { date, currency } = r._id;
    const rate = getCachedRate(currency, date);
    const k = ymd(date);
    if (!byDate.has(k)) byDate.set(k, { date: k, roomNights: 0, revenue: 0, revenueNights: 0 });
    const cell = byDate.get(k);

    // Tun har doim sanaladi (occupancy kursga bog'liq emas)...
    cell.roomNights += r.nights;
    if (rate > 0) {
      // ...tushum esa faqat kurs ma'lum bo'lganda (ADR buzilmasin).
      cell.revenue += r.amount * rate;
      cell.revenueNights += r.nights;
    } else {
      skippedNights += r.nights;
      missingCurrencies.add(currency);
    }
  }

  const days = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const k = ymd(new Date(t));
    const c = byDate.get(k) || { date: k, roomNights: 0, revenue: 0, revenueNights: 0 };
    days.push({
      date: c.date,
      roomNights: c.roomNights,
      revenue: Math.round(c.revenue),
      // ADR — tushumi ma'lum tunlar bo'yicha (kursi yo'q tunlar pasaytirmasin).
      adr: c.revenueNights ? Math.round(c.revenue / c.revenueNights) : 0,
      occupancy: cap ? Number(((c.roomNights / cap) * 100).toFixed(1)) : null,
      // RevPAR — mavjud xonaga tushum. Occupancy va ADR ni bitta raqamga
      // birlashtiradi: to'lish yuqori, lekin narx past bo'lsa ham ko'rinadi.
      revPar: cap ? Math.round(c.revenue / cap) : null,
    });
  }

  return {
    days,
    capacity: cap,
    coverage: {
      // Kursi topilmagani uchun tushumdan chiqarilgan tunlar.
      skippedNights,
      missingCurrencies: [...missingCurrencies],
      ok: skippedNights === 0,
    },
  };
}

/**
 * Davr bo'yicha jami: tun, tushum, ADR, occupancy, RevPAR, kanal kesimi,
 * bekor qilish foizi va o'rtacha lead time.
 */
export async function periodSummary(hotelId, { from, to, asOf } = {}) {
  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);

  const capInfo = await resolveCapacity(id);
  const { days, coverage } = await dailyMetrics(id, { from: start, to: end, asOf, capacity: capInfo.rooms });

  const roomNights = days.reduce((s, d) => s + d.roomNights, 0);
  const revenue = days.reduce((s, d) => s + d.revenue, 0);
  const dayCount = days.length;
  const available = capInfo.rooms * dayCount;

  // Kanal kesimi — `channelKey` bo'yicha (barqaror kalit, tarif nomi emas).
  const channels = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, ...booksFilter(asOf) } },
    { $unwind: '$roomStays' },
    { $unwind: '$roomStays.dailyRates' },
    { $match: { 'roomStays.dailyRates.date': { $gte: start, $lte: end } } },
    {
      $group: {
        _id: { key: '$channelKey', label: '$channel' },
        roomNights: { $sum: 1 },
      },
    },
    { $sort: { roomNights: -1 } },
  ]);

  // Bekor qilish va lead time — KELISH sanasi bo'yicha (tunash emas):
  // "shu davrda kelishi kerak bo'lgan bronlarning nechtasi bekor bo'ldi".
  const [beh] = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, arrivalDate: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: null,
        bookings: { $sum: 1 },
        cancelled: { $sum: { $cond: ['$isCancelled', 1, 0] } },
        leadSum: { $sum: { $cond: [{ $gte: ['$leadTimeDays', 0] }, '$leadTimeDays', 0] } },
        leadCount: { $sum: { $cond: [{ $gte: ['$leadTimeDays', 0] }, 1, 0] } },
        losSum: { $sum: '$roomNights' },
        roomsSum: { $sum: '$roomCount' },
      },
    },
  ]);

  return {
    period: { from: ymd(start), to: ymd(end), days: dayCount, asOf: asOf ? ymd(dayStart(asOf)) : null },
    capacity: capInfo,
    roomNights,
    availableRoomNights: available,
    occupancy: available ? Number(((roomNights / available) * 100).toFixed(1)) : null,
    revenue,
    adr: roomNights ? Math.round(revenue / roomNights) : 0,
    revPar: available ? Math.round(revenue / available) : null,
    channels: channels.map((c) => ({
      key: c._id.key || 'unknown',
      label: c._id.label || c._id.key || 'Noma\'lum',
      roomNights: c.roomNights,
      share: roomNights ? Number(((c.roomNights / roomNights) * 100).toFixed(1)) : 0,
    })),
    behaviour: {
      bookings: beh?.bookings || 0,
      cancelled: beh?.cancelled || 0,
      cancellationRate: beh?.bookings
        ? Number(((beh.cancelled / beh.bookings) * 100).toFixed(1)) : 0,
      avgLeadTimeDays: beh?.leadCount ? Number((beh.leadSum / beh.leadCount).toFixed(1)) : null,
      avgLos: beh?.roomsSum ? Number((beh.losSum / beh.roomsSum).toFixed(2)) : null,
    },
    coverage,
  };
}

/**
 * PICKUP (booking curve) — kitob QANDAY to'ladi, kelishga qancha qolganda.
 *
 * ⚠️ "Kelishdan N kun oldin" HAR BIR TUNGA ALOHIDA hisoblanadi, davr
 * boshiga emas. Bu shunchaki aniqlik masalasi emas — davrga bog'lasak,
 * 30 kunlik oynaning oxirgi tuni aslida 60 kun narida bo'ladi va davr
 * ICHIDA qilingan bronlar (bu mehmonxonada ularning ko'pchiligi!)
 * hisobga umuman tushmaydi.
 *
 * KUZATILADIGANLIK: kelasi tunlar uchun `D - N` sanasi kelajakda
 * bo'lishi mumkin — u paytda kitobda nima bo'lishini BILMAYMIZ. Bunday
 * (tun, nuqta) juftliklari hisobdan chiqariladi va nechta tun qamrab
 * olingani `datesCovered` da ochiq ko'rsatiladi. Aks holda kelasi davr
 * har doim "orqada" bo'lib ko'rinardi — bu soxta signal.
 *
 * STLY uchun "bugun" ham 364 kunga suriladi, shunda qamrov bir xil
 * bo'ladi va taqqoslash halol chiqadi.
 */
export async function pickupCurve(hotelId, { from, to, offsets = [60, 30, 14, 7, 3, 1, 0], stly = false } = {}) {
  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);
  const today = dayStart(new Date());

  async function pointFor(s, e, off, asOfCeiling) {
    const shift = off * DAY_MS;
    const rows = await OwnBooking.aggregate([
      { $match: { hotelId: id, needsDetail: false } },
      { $unwind: '$roomStays' },
      { $unwind: '$roomStays.dailyRates' },
      { $match: { 'roomStays.dailyRates.date': { $gte: s, $lte: e } } },
      {
        $addFields: {
          // Shu tun uchun kesim sanasi: tunash sanasidan N kun oldin.
          _asOf: { $subtract: ['$roomStays.dailyRates.date', shift] },
        },
      },
      // Faqat kuzatish MUMKIN bo'lgan nuqtalar (kelajakka qaramaymiz).
      { $match: { _asOf: { $lte: asOfCeiling } } },
      {
        $match: {
          $expr: {
            $and: [
              { $lte: ['$createdAt', '$_asOf'] },
              {
                $or: [
                  { $eq: ['$isCancelled', false] },
                  { $eq: ['$cancelledAt', null] },
                  { $gt: ['$cancelledAt', '$_asOf'] },
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          roomNights: { $sum: 1 },
          dates: { $addToSet: '$roomStays.dailyRates.date' },
        },
      },
    ]);
    const r = rows[0];

    // KUZATILADIGAN tunlar soni — kelajakka qaramaslik cheklovi tufayli
    // shu nuqtada oynaning nechta tuni umuman o'lchanadi.
    //
    // ⚠️ Bu "bron bo'lgan tunlar" bilan ADASHTIRILMASIN. Ikkalasi ham
    // kerak: STLY taqqoslash faqat `datesObservable` ikkala yilda TENG
    // bo'lgandagina halol bo'ladi. Teng bo'lmasa, farq foizi bozor
    // signali emas — shunchaki turli sondagi tunlarni qiyoslash bo'ladi.
    const lastObservable = new Date(asOfCeiling.getTime() + shift);
    const obsEnd = lastObservable < e ? lastObservable : e;
    const datesObservable = obsEnd >= s
      ? Math.floor((obsEnd.getTime() - s.getTime()) / DAY_MS) + 1
      : 0;

    return {
      daysBefore: off,
      roomNights: r?.roomNights || 0,
      datesObservable,
      datesWithBookings: r?.dates?.length || 0,
    };
  }

  async function curveFor(s, e, ceiling) {
    const out = [];
    for (const off of offsets) out.push(await pointFor(s, e, off, ceiling));
    return out;
  }

  const current = await curveFor(start, end, today);
  if (!stly) return { current, period: { from: ymd(start), to: ymd(end) } };

  // O'tgan yil shu davr — 364 kun (52 hafta) oldin, hafta kunlari mos
  // tushishi uchun (365 emas: shanba shanbaga to'g'ri kelsin).
  const sLy = new Date(start.getTime() - 364 * DAY_MS);
  const eLy = new Date(end.getTime() - 364 * DAY_MS);
  const lastYear = await curveFor(sLy, eLy, new Date(today.getTime() - 364 * DAY_MS));

  return {
    current,
    lastYear,
    period: { from: ymd(start), to: ymd(end) },
    lastYearPeriod: { from: ymd(sLy), to: ymd(eLy) },
  };
}

/**
 * SUR'AT — hozirgi kitob o'tgan yilgi shu bosqichga nisbatan qanday.
 *
 * Xom to'lish foizi last-minute bozorda yaroqsiz signal: kelasi hafta
 * har doim bo'sh ko'rinadi, chunki tunlar hali sotilmagan. Bu funksiya
 * shu savolga javob beradi: "bir yil oldin, kelishga xuddi shuncha kun
 * qolganda, kitobda qancha bor edi?"
 *
 * Taqqoslash TENG sharoitda: o'tgan yil oynasi ham 364 kun suriladi
 * (52 hafta — hafta kunlari mos tushsin) va o'sha paytdagi holat
 * bronlar jurnalidan tiklanadi.
 *
 * @returns {Promise<{ratio:number, roomNights:number, lastYearRoomNights:number}|null>}
 *          o'tgan yil ma'lumoti bo'lmasa null (yangi mijoz — solishtirish yo'q)
 */
export async function paceVsLastYear(hotelId, { from, to } = {}) {
  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);
  const today = dayStart(new Date());

  const shift = 364 * DAY_MS;
  const sLy = new Date(start.getTime() - shift);
  const eLy = new Date(end.getTime() - shift);
  const asOfLy = new Date(today.getTime() - shift);

  async function onBooks(s, e, asOf) {
    const rows = await OwnBooking.aggregate([
      { $match: { hotelId: id, needsDetail: false, ...booksFilter(asOf) } },
      { $unwind: '$roomStays' },
      { $unwind: '$roomStays.dailyRates' },
      { $match: { 'roomStays.dailyRates.date': { $gte: s, $lte: e } } },
      { $group: { _id: null, n: { $sum: 1 } } },
    ]);
    return rows[0]?.n || 0;
  }

  const [now, ly] = await Promise.all([
    onBooks(start, end, null),      // hozirgi holat
    onBooks(sLy, eLy, asOfLy),      // o'tgan yil, shu bosqichda
  ]);

  // O'tgan yil bu davrda umuman ma'lumot yo'q (mijoz yangi yoki
  // integratsiya keyin ulangan) — sur'at hisoblanmaydi.
  if (!ly) return null;

  return {
    ratio: Number((now / ly).toFixed(2)),
    roomNights: now,
    lastYearRoomNights: ly,
    lastYearPeriod: { from: ymd(sLy), to: ymd(eLy), asOf: ymd(asOfLy) },
  };
}

/**
 * AI PROMPTI UCHUN KO'RSATKICHLAR KONTEKSTI.
 *
 * AI'ga shu paytgacha faqat `low/mid/high` bandi borar edi — ya'ni uch
 * xil holatdan biri. Endi aniq raqamlar boradi va tavsiya sifati
 * "raqiblar medianasi"dan haqiqiy revenue qaroriga yaqinlashadi.
 *
 * ⚠️ VALYUTA. Prompt ichidagi kanal narxlari DOLLARDA ($79, $104), bizning
 * ko'rsatkichlar esa SO'MDA (534 000). Ularni bir promptga aralash yuborish
 * modelni chalg'itadi — u "suggestedPrice: 534000" deb qaytarishi mumkin.
 * Shuning uchun bu yerda hammasi DOLLARGA o'giriladi va maydon nomlarida
 * ham `Usd` deb belgilanadi.
 *
 * @returns {Promise<object|null>} Exely ulanmagan yoki ma'lumot yetarli
 *          bo'lmasa null — chaqiruvchi promptni o'zgarishsiz qoldiradi.
 */
export async function aiPerformanceContext(hotelId) {
  const id = oid(hotelId);
  const today = dayStart(new Date());

  const cap = await resolveCapacity(id);
  if (!cap.rooms) return null;   // sig'imsiz foiz ham, RevPAR ham yolg'on bo'ladi

  const from30 = new Date(today.getTime() - 29 * DAY_MS);
  const fwdTo = new Date(today.getTime() + 6 * DAY_MS);

  const [trailing, forward, pace] = await Promise.all([
    periodSummary(id, { from: from30, to: today }),
    dailyMetrics(id, { from: today, to: fwdTo, capacity: cap.rooms }),
    paceVsLastYear(id, { from: today, to: fwdTo }),
  ]);

  if (!trailing.roomNights) return null;  // hali ma'lumot yig'ilmagan

  // So'm → dollar. Bitta kurs yetarli (bugungi), chunki bu raqamlar
  // "hozir qanday turibsiz" savoliga javob beradi, tarixiy hisobot emas.
  const rate = await getRate('USD', today);
  if (!rate) return null;                 // kursni bilmasak dollarga o'girmaymiz
  const toUsd = (uzs) => Math.round((uzs / rate) * 10) / 10;

  const fwdSold = forward.days.reduce((s, d) => s + d.roomNights, 0);
  const fwdAvail = cap.rooms * forward.days.length;

  return {
    rooms: cap.rooms,
    capacityEstimated: cap.estimated,
    trailing30: {
      occupancyPct: trailing.occupancy,
      adrUsd: toUsd(trailing.adr),
      revParUsd: toUsd(trailing.revPar),
      roomNights: trailing.roomNights,
    },
    forward7: {
      occupancyPct: fwdAvail ? Number(((fwdSold / fwdAvail) * 100).toFixed(1)) : null,
      roomNights: fwdSold,
      availableRoomNights: fwdAvail,
    },
    pace: pace ? {
      ratio: pace.ratio,
      lastYearRoomNights: pace.lastYearRoomNights,
      pctVsLastYear: Math.round((pace.ratio - 1) * 100),
    } : null,
    avgLeadTimeDays: trailing.behaviour?.avgLeadTimeDays ?? null,
    cancellationRate: trailing.behaviour?.cancellationRate ?? null,
  };
}

// ════════════════════════════════════════════════════════════════════
// KESIMLAR — "qaysi kanal / xona turi / tarif qancha pul keltiradi"
//
// Bir necha o'lcham bitta funksiyada, chunki hisob mantiqi bir xil va
// faqat guruhlash kaliti farq qiladi. Ikki bosqichli:
//   1) TUN darajasi — xona-tun va tushum (dailyRates bo'yicha)
//   2) BRON darajasi — bronlar soni va bekor qilish
// Ularni bitta aggregatsiyada birlashtirib bo'lmaydi: bekor qilish
// bronga tegishli, tun esa har kecha uchun alohida yozuv.
// ════════════════════════════════════════════════════════════════════

// O'lcham → (guruhlash ifodasi, u bron darajasidami yoki tun darajasidami)
//
// ⚠️ XONA TURI va TARIF — NOM bo'yicha emas, ID bo'yicha guruhlanadi.
//    Bron nomni O'ZI QILINGAN PAYTDAGI tilda saqlaydi, shuning uchun
//    bitta xona turi bazada ikki xil nom bilan yotadi:
//      "Стандартный номер с двумя отдельными кроватями" (1222 tun)
//      "Standard Twin Room"                              (109 tun)
//    Nom bo'yicha guruhlansa ular ikki alohida qator bo'lib chiqadi va
//    tahlil buziladi (ulush ikkiga bo'linadi, ADR ham noto'g'ri).
//    ID barqaror; ko'rsatiladigan nom esa obyekt profilidan olinadi
//    (u bitta tilda) — `labelMapFor()` ga qarang.
const DIMENSIONS = {
  // Kanal — `channelKey` barqaror (tarif qayta nomlansa ham o'zgarmaydi),
  // ko'rsatiladigan nom esa `channel`.
  channel:  { night: '$channelKey',            label: '$channel',              booking: '$channelKey' },
  roomType: { night: '$roomStays.roomTypeId',  label: '$roomStays.roomTypeName', booking: null, profile: 'roomTypes' },
  ratePlan: { night: '$roomStays.ratePlanId',  label: '$roomStays.ratePlanName', booking: null, profile: 'ratePlans' },
  // Hafta kuni: 1=yakshanba … 7=shanba (Mongo $dayOfWeek).
  dow:      { night: { $dayOfWeek: '$roomStays.dailyRates.date' }, label: null, booking: null },
  month:    { night: { $dateToString: { format: '%Y-%m', date: '$roomStays.dailyRates.date' } }, label: null, booking: null },
};

export const BREAKDOWN_DIMENSIONS = Object.keys(DIMENSIONS);

/**
 * Bitta o'lcham bo'yicha kesim.
 *
 * @param {string} hotelId
 * @param {{dim:string, from:Date|string, to:Date|string}} opts
 */
/**
 * ID → ko'rsatiladigan nom. Manba — Integration.property (Content API'dan
 * bitta tilda olingan), ya'ni bir xil xona turi har doim bitta nom bilan
 * chiqadi. Profilda topilmasa bronda yozilgan nom ishlatiladi.
 */
async function labelMapFor(hotelId, profileKey) {
  if (!profileKey) return null;
  const integ = await Integration
    .findOne({ hotelId, provider: 'exely' })
    .select(`property.${profileKey}`)
    .lean();
  const list = integ?.property?.[profileKey] || [];
  return new Map(list.map((x) => [String(x.id), x.name]));
}

export async function breakdown(hotelId, { dim = 'channel', from, to } = {}) {
  const spec = DIMENSIONS[dim];
  if (!spec) throw Object.assign(new Error(`Noma'lum o'lcham: ${dim}`), { status: 400 });

  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);

  // ── 1) Tun darajasi: xona-tun + tushum (valyuta bo'yicha ajratilgan) ──
  const nightRows = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, isCancelled: false } },
    { $unwind: '$roomStays' },
    { $unwind: '$roomStays.dailyRates' },
    { $match: { 'roomStays.dailyRates.date': { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          key: spec.night,
          ...(spec.label ? { label: spec.label } : {}),
          currency: '$currency',
          date: '$roomStays.dailyRates.date',
        },
        nights: { $sum: 1 },
        amount: { $sum: '$roomStays.dailyRates.price' },
      },
    },
  ]);

  // Kurslar — faqat keshdan (fx.service.js izohiga qarang).
  await warmRates(
    nightRows.map((r) => ({ currency: r._id.currency, date: r._id.date })),
    { fetchMissing: false },
  );

  const acc = new Map();
  let skippedNights = 0;
  for (const r of nightRows) {
    const k = String(r._id.key ?? '—');
    if (!acc.has(k)) {
      acc.set(k, { key: k, label: r._id.label || k, roomNights: 0, revenue: 0, revenueNights: 0, bookings: 0, cancelled: 0 });
    }
    const cell = acc.get(k);
    if (r._id.label) cell.label = r._id.label;
    cell.roomNights += r.nights;
    const rate = getCachedRate(r._id.currency, r._id.date);
    if (rate > 0) {
      cell.revenue += r.amount * rate;
      cell.revenueNights += r.nights;
    } else {
      skippedNights += r.nights;
    }
  }

  // ── 2) Bron darajasi: bronlar soni + bekor qilish ──
  // KELISH sanasi bo'yicha: "shu davrga kelishi kerak bo'lgan bronlarning
  // nechtasi bekor bo'ldi". Bekor qilingan bronda tun yo'q, shuning uchun
  // uni tun aggregatsiyasidan hisoblab bo'lmaydi.
  if (spec.booking) {
    const bookingRows = await OwnBooking.aggregate([
      { $match: { hotelId: id, needsDetail: false, arrivalDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: spec.booking,
          bookings: { $sum: 1 },
          cancelled: { $sum: { $cond: ['$isCancelled', 1, 0] } },
        },
      },
    ]);
    for (const b of bookingRows) {
      const k = String(b._id ?? '—');
      if (!acc.has(k)) acc.set(k, { key: k, label: k, roomNights: 0, revenue: 0, revenueNights: 0, bookings: 0, cancelled: 0 });
      const cell = acc.get(k);
      cell.bookings = b.bookings;
      cell.cancelled = b.cancelled;
    }
  }

  const nameById = await labelMapFor(id, spec.profile);

  const rows = [...acc.values()].map((c) => ({
    key: c.key,
    // Profil nomi ustun: u bitta tilda va joriy. Bronda yozilgani —
    // eskirgan yoki boshqa tildagi nusxa bo'lishi mumkin.
    label: nameById?.get(c.key) || c.label,
    roomNights: c.roomNights,
    revenue: Math.round(c.revenue),
    adr: c.revenueNights ? Math.round(c.revenue / c.revenueNights) : 0,
    bookings: c.bookings || null,
    cancelled: c.cancelled || null,
    cancellationRate: c.bookings ? Number(((c.cancelled / c.bookings) * 100).toFixed(1)) : null,
  }));

  const totalNights = rows.reduce((s, r) => s + r.roomNights, 0);
  rows.forEach((r) => { r.share = totalNights ? Number(((r.roomNights / totalNights) * 100).toFixed(1)) : 0; });

  // Vaqt o'lchamlari tabiiy tartibda, qolganlari hajm bo'yicha.
  if (dim === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
  else if (dim === 'dow') rows.sort((a, b) => Number(a.key) - Number(b.key));
  else rows.sort((a, b) => b.roomNights - a.roomNights);

  return {
    dim,
    period: { from: ymd(start), to: ymd(end) },
    rows,
    totals: { roomNights: totalNights, revenue: rows.reduce((s, r) => s + r.revenue, 0) },
    coverage: { skippedNights, ok: skippedNights === 0 },
  };
}

/**
 * Taqsimotlar — bron xulqi: qancha oldin bron qilinadi, necha tun qolinadi.
 *
 * Bu ikkisi narx strategiyasini belgilaydi: median lead time 1 kun bo'lgan
 * mehmonxonada "30 kun oldin aksiya" ma'nosiz, LOS 2 tun bo'lsa "3 tun
 * qolsang chegirma" ham ishlamaydi.
 */
export async function distributions(hotelId, { from, to } = {}) {
  const id = oid(hotelId);
  const start = dayStart(from);
  const end = dayStart(to);
  const match = { hotelId: id, needsDetail: false, isCancelled: false, arrivalDate: { $gte: start, $lte: end } };

  const [lead, los, pax] = await Promise.all([
    OwnBooking.aggregate([
      { $match: { ...match, leadTimeDays: { $ne: null } } },
      {
        $bucket: {
          groupBy: '$leadTimeDays',
          boundaries: [-99999, 0, 1, 4, 8, 15, 31, 91, 99999],
          default: 'other',
          output: { bookings: { $sum: 1 }, roomNights: { $sum: '$roomNights' } },
        },
      },
    ]),
    OwnBooking.aggregate([
      { $match: match },
      { $unwind: '$roomStays' },
      {
        $bucket: {
          groupBy: '$roomStays.nights',
          boundaries: [1, 2, 3, 4, 6, 8, 15, 99999],
          default: 'other',
          output: { stays: { $sum: 1 } },
        },
      },
    ]),
    OwnBooking.aggregate([
      { $match: match },
      { $unwind: '$roomStays' },
      {
        $group: {
          _id: { adults: '$roomStays.adults', kids: { $size: { $ifNull: ['$roomStays.childAges', []] } } },
          stays: { $sum: 1 },
        },
      },
      { $sort: { stays: -1 } },
      { $limit: 8 },
    ]),
  ]);

  // Chegara qiymatini o'qiladigan yorliqqa aylantiramiz. `-99999` — manfiy
  // lead time, ya'ni PMS'ga ko'chirish izi yoki walk-in (izohi
  // reservation.service.js normalizeBooking ichida).
  const LEAD_LABEL = {
    '-99999': 'past', 0: 'same_day', 1: '1_3', 4: '4_7', 8: '8_14', 15: '15_30', 31: '31_90', 91: '90_plus',
  };
  const LOS_LABEL = { 1: '1', 2: '2', 3: '3', 4: '4_5', 6: '6_7', 8: '8_14', 15: '15_plus' };

  return {
    period: { from: ymd(start), to: ymd(end) },
    leadTime: lead.map((b) => ({ bucket: LEAD_LABEL[String(b._id)] || String(b._id), bookings: b.bookings, roomNights: b.roomNights })),
    lengthOfStay: los.map((b) => ({ bucket: LOS_LABEL[String(b._id)] || String(b._id), stays: b.stays })),
    partySize: pax.map((p) => ({ adults: p._id.adults, children: p._id.kids, stays: p.stays })),
  };
}

/**
 * Metrika uchun kerak bo'ladigan BARCHA kurslarni oldindan to'ldiradi.
 *
 * Mijozning chet valyutadagi bronlari qaysi tunlarga tegishli bo'lsa,
 * o'sha sanalar uchun kurs yig'iladi. Bu SEKIN (cbu.uz so'rovi ~2.5 sek),
 * shuning uchun faqat fonda — cron yoki backfill tugagach — ishlaydi,
 * hech qachon foydalanuvchi so'roviga ulanmaydi.
 */
export async function warmFxCoverage(hotelId) {
  const id = oid(hotelId);
  const pairs = await OwnBooking.aggregate([
    { $match: { hotelId: id, needsDetail: false, currency: { $nin: ['UZS', ''] } } },
    { $unwind: '$roomStays' },
    { $unwind: '$roomStays.dailyRates' },
    { $group: { _id: { c: '$currency', d: '$roomStays.dailyRates.date' } } },
  ]);
  if (!pairs.length) return { total: 0, loaded: 0, missing: 0 };
  return warmRates(
    pairs.map((p) => ({ currency: p._id.c, date: p._id.d })),
    { fetchMissing: true },
  );
}
