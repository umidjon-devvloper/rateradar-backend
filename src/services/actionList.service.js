import mongoose from 'mongoose';
import PriceSnapshot from '../models/PriceSnapshot.js';
import { isControllable, channelDisplay } from '../config/channels.js';
import { dailyMetrics, resolveCapacity } from './metrics/ownMetrics.service.js';

// ════════════════════════════════════════════════════════════════════
// DIQQAT TALAB QILADIGAN KUNLAR
//
// Mahsulotdagi barcha tavsiya shu paytgacha KANAL bo'yicha edi:
// "Booking.com narxini $86 qiling". Lekin mehmonxona narxni kanalga emas,
// KUNGA qo'yadi — 10-sentyabr bilan 3-sentyabr butunlay boshqa kunlar.
//
// Bu ro'yxat sana bo'yicha ishlaydi va menejerga bitta savolga javob
// beradi: BUGUN QAYSI KUNLARGA QARASHIM KERAK.
//
// ⚠️ NEGA BU YERDA NARX TAQQOSLASH YO'Q.
// Boshida ro'yxat "12–15 sent: $79 → $86" ko'rinishida rejalashtirilgan
// edi. Ma'lumot buni ko'tarmadi: o'z e'lon narximiz skreypingdan atigi
// ~7 kun oldinga ma'lum, raqiblarniki undan ham kam. Sentyabr uchun narx
// tavsiya qilish o'sha narxlarni BILMASDAN taxmin qilish bo'lardi.
//
// O'lchangan talab esa 61 kun oldinga boradi (Exely bronlari). Shuning
// uchun ro'yxat TALABGA quriladi: qaysi kun to'lyapti, qaysi kun orqada.
// Narx faqat u ANIQ ma'lum bo'lgan kunlarga qo'shimcha sifatida ilashadi.
//
// Search API ochilsa (hozir 403) bu yerga kelajak narxlar ham qo'shiladi
// va ro'yxat asl ko'rinishiga — "sana + narx" ga o'tadi.
// ════════════════════════════════════════════════════════════════════

const DAY_MS = 86400_000;
// O'tgan yil bilan taqqoslashda 364 kun (52 hafta) ishlatiladi — shunda
// hafta kuni mos keladi. 365 kun bo'lsa shanba payshanba bilan solishtiriladi.
const YEAR_SHIFT = 364 * DAY_MS;

// ── Qoidalar ────────────────────────────────────────────────────────
// Har biri bitta aniq holatni tavsiflaydi. Tartib = ustuvorlik: bir kun
// bir nechta shartga tushsa, eng yuqoridagisi qo'llanadi (bir kun uchun
// bitta xabar — aks holda ro'yxat shovqinga aylanadi).
const RULES = [
  {
    // To'lib borayotgan kun — bu MUTLAQ signal: 70% band bo'lsa, bozor
    // qanday bo'lishidan qat'i nazar, qolgan xonalarni arzon bermaslik kerak.
    code: 'compression',
    severity: 'high',
    action: 'raise',
    test: ({ occ, daysOut }) => occ >= 70 && daysOut <= 21,
  },
  {
    // Yaqin va orqada — eng dolzarb holat: kun kelyapti, o'tgan yilgidan
    // sezilarli past. Aynan shu kunga bugun ta'sir qilish mumkin.
    code: 'behind_near',
    severity: 'high',
    action: 'act',
    test: ({ pace, daysOut, occ }) => pace != null && pace <= 0.7 && daysOut <= 10 && occ < 60,
  },
  {
    code: 'pace_ahead',
    severity: 'medium',
    action: 'raise',
    test: ({ occ, pace }) => pace != null && pace >= 1.3 && occ >= 35,
  },
  {
    code: 'pace_behind',
    severity: 'medium',
    action: 'watch',
    test: ({ occ, pace }) => pace != null && pace <= 0.7 && occ < 50,
  },
];

// ⚠️ MUTLAQ TO'LISH FOIZI BO'YICHA "bo'sh qolmoqda" QOIDASI ATAYIN YO'Q.
//
// Boshida `soft_near` degan qoida bor edi: "occ <= 25% va 10 kundan kam
// qoldi → bu kun bo'sh qolmoqda". Real ma'lumotda u deyarli HAR KUNGA
// tushdi va noto'g'ri ishladi — masalan 1-sentyabr 13.8% band bo'lgani
// uchun "bo'sh qolmoqda" deb belgilandi, holbuki o'tgan yili shu bosqichda
// 1 xona-tun edi, hozir 4 (ya'ni to'rt barobar oldinda).
//
// Sabab: bu mehmonxonada bronlarning 57% i KELGAN KUNI qilinadi. Bunday
// bozorda 6 kun oldin 13% band bo'lish muammo emas, normal egri chiziq.
// Mutlaq foiz bilan o'lchash bozorning odatdagi holatini "muammo" deb
// ko'rsatadi va ro'yxat shovqinga aylanadi.
//
// Shuning uchun signallar OG'ISHGA quriladi: o'tgan yilning AYNAN SHU
// bosqichi bilan taqqoslash. Mutlaq daraja esa umumiy to'lish
// ko\'rsatkichida ko'rinadi, kunlik ogohlantirishda emas.

const TXT = {
  compression: {
    uz: ({ occ, sold, cap }) => `${sold}/${cap} xona band (${occ}%) — kun to'lib boryapti, narxni ko'tarish uchun asos bor.`,
    ru: ({ occ, sold, cap }) => `Занято ${sold}/${cap} (${occ}%) — день заполняется, есть основание поднять цену.`,
    en: ({ occ, sold, cap }) => `${sold}/${cap} rooms booked (${occ}%) — the date is filling, room to raise.`,
  },
  behind_near: {
    uz: ({ sold, ly, daysOut, pct }) => `${daysOut} kun qoldi: ${sold} xona-tun band, o'tgan yili shu bosqichda ${ly} edi (${pct}%). Yaqin va orqada — bugun ta'sir qilish mumkin.`,
    ru: ({ sold, ly, daysOut, pct }) => `Осталось ${daysOut} дн.: занято ${sold}, год назад на этом этапе ${ly} (${pct}%). Близко и отстаёт — ещё можно повлиять.`,
    en: ({ sold, ly, daysOut, pct }) => `${daysOut} days out: ${sold} room-nights on the books vs ${ly} last year at this point (${pct}%). Close and behind — still actionable.`,
  },
  pace_ahead: {
    uz: ({ sold, ly, pct }) => `O'tgan yili shu bosqichda ${ly} xona-tun edi, hozir ${sold} (+${pct}%) — talab kuchli.`,
    ru: ({ sold, ly, pct }) => `Год назад на этом этапе было ${ly}, сейчас ${sold} (+${pct}%) — спрос сильный.`,
    en: ({ sold, ly, pct }) => `Last year at this point ${ly} room-nights, now ${sold} (+${pct}%) — demand is strong.`,
  },
  pace_behind: {
    uz: ({ sold, ly, pct }) => `O'tgan yili shu bosqichda ${ly} xona-tun edi, hozir ${sold} (${pct}%) — sur'at orqada.`,
    ru: ({ sold, ly, pct }) => `Год назад на этом этапе было ${ly}, сейчас ${sold} (${pct}%) — темп отстаёт.`,
    en: ({ sold, ly, pct }) => `Last year at this point ${ly} room-nights, now ${sold} (${pct}%) — pace is behind.`,
  },
};

function ymd(d) { return d.toISOString().slice(0, 10); }

/**
 * Kelajak kunlar uchun o'z e'lon narxim (skreypingdan).
 * Faqat narx BELGILAY OLADIGAN kanallar — wholesaler/metasearch'da
 * tavsiya berishning ma'nosi yo'q (channels.js izohiga qarang).
 */
async function forwardOwnPrices(hotelId, from, to) {
  // ⚠️ Aggregation `$match` matn ID'ni ObjectId maydoniga MOSLAMAYDI va
  // jimgina bo'sh natija qaytaradi (xato ham bermaydi). Mongoose'ning
  // find() usuli o'zi o'giradi, aggregate esa yo'q.
  const id = new mongoose.Types.ObjectId(String(hotelId));
  const rows = await PriceSnapshot.aggregate([
    {
      $match: {
        ownerHotelId: id, targetType: 'own',
        price: { $gt: 0 }, checkIn: { $gte: from, $lte: new Date(to.getTime() + DAY_MS) },
      },
    },
    { $sort: { snapshotAt: -1 } },
    {
      $group: {
        // checkIn'da vaqt qismi bo'lishi mumkin — kunga keltiramiz.
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$checkIn' } }, ota: '$ota' },
        price: { $first: '$price' },
        currency: { $first: '$currency' },
      },
    },
  ]);

  const byDay = new Map();
  for (const r of rows) {
    if (!isControllable(r._id.ota)) continue;
    if (!byDay.has(r._id.day)) byDay.set(r._id.day, []);
    byDay.get(r._id.day).push({
      channel: channelDisplay(r._id.ota),
      price: Math.round(r.price),
      currency: r.currency || 'USD',
    });
  }
  for (const list of byDay.values()) list.sort((a, b) => a.channel.localeCompare(b.channel));
  return byDay;
}

/**
 * Diqqat talab qiladigan kunlar ro'yxati.
 *
 * @param {string} hotelId
 * @param {{days?:number, lang?:string}} [opts]
 */
export async function buildActionList(hotelId, { days = 21, lang = 'uz' } = {}) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const to = new Date(today.getTime() + (days - 1) * DAY_MS);

  const cap = await resolveCapacity(hotelId);
  if (!cap.rooms) {
    return { days: [], groups: [], capacity: cap, reason: 'no_capacity' };
  }

  // Bu yil — hozirgi holat. O'tgan yil — AYNAN SHU BOSQICHDA nima bo'lgan
  // (asOf), ya'ni "o'tgan yil yakuni" bilan emas, teng sharoitda solishtiramiz.
  const lyFrom = new Date(today.getTime() - YEAR_SHIFT);
  const lyTo = new Date(to.getTime() - YEAR_SHIFT);
  const [cur, ly, prices] = await Promise.all([
    dailyMetrics(hotelId, { from: today, to, capacity: cap.rooms }),
    dailyMetrics(hotelId, { from: lyFrom, to: lyTo, asOf: lyFrom, capacity: cap.rooms }),
    forwardOwnPrices(hotelId, today, to),
  ]);

  const lyByDay = new Map(ly.days.map((d) => [d.date, d]));

  const out = [];
  for (const d of cur.days) {
    const date = new Date(`${d.date}T00:00:00.000Z`);
    const daysOut = Math.round((date.getTime() - today.getTime()) / DAY_MS);
    const lyRow = lyByDay.get(ymd(new Date(date.getTime() - YEAR_SHIFT)));
    const lyNights = lyRow ? lyRow.roomNights : null;
    // O'tgan yil noldan boshlangan kunni nisbatga aylantirib bo'lmaydi
    // (0 ga bo'linish) — bunday kunda sur'at signali berilmaydi.
    const pace = lyNights ? d.roomNights / lyNights : null;

    const facts = {
      occ: d.occupancy ?? 0,
      sold: d.roomNights,
      cap: cap.rooms,
      daysOut,
      ly: lyNights,
      pct: pace != null ? Math.round((pace - 1) * 100) : null,
      pace,
    };

    const rule = RULES.find((r) => r.test(facts));
    out.push({
      date: d.date,
      daysOut,
      roomNights: d.roomNights,
      occupancy: d.occupancy,
      adr: d.adr,
      lastYearRoomNights: lyNights,
      paceRatio: pace != null ? Number(pace.toFixed(2)) : null,
      prices: prices.get(d.date) || [],
      action: rule?.action || null,
      code: rule?.code || null,
      severity: rule?.severity || null,
      reason: rule ? (TXT[rule.code][lang] || TXT[rule.code].en)(facts) : '',
    });
  }

  // Ketma-ket kelgan bir xil kodli kunlarni bitta oraliqqa yig'amiz:
  // menejerga 4 ta alohida qator emas, "12–15 sentyabr" ko'rinishi kerak.
  const groups = [];
  for (const row of out) {
    if (!row.code) continue;
    const last = groups[groups.length - 1];
    const consecutive = last
      && last.code === row.code
      && Math.round((new Date(`${row.date}T00:00:00Z`) - new Date(`${last.to}T00:00:00Z`)) / DAY_MS) === 1;
    if (consecutive) {
      last.to = row.date;
      last.dates.push(row.date);
      last.roomNights += row.roomNights;
      last.reason = row.reason; // oxirgi kun raqamlari — oraliqning eng dolzarbi
    } else {
      groups.push({
        code: row.code, action: row.action, severity: row.severity,
        from: row.date, to: row.date, dates: [row.date],
        daysOut: row.daysOut, roomNights: row.roomNights,
        occupancy: row.occupancy, lastYearRoomNights: row.lastYearRoomNights,
        paceRatio: row.paceRatio, prices: row.prices, reason: row.reason,
      });
    }
  }

  // Shoshilinchlik: avval jiddiylik, keyin yaqinlik.
  const rank = { high: 0, medium: 1 };
  groups.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.daysOut - b.daysOut));

  return {
    period: { from: ymd(today), to: ymd(to) },
    capacity: cap,
    days: out,
    groups,
    // Halollik: narx faqat shuncha kunga ma'lum. UI shuni aytadi.
    priceCoverageDays: prices.size,
  };
}
