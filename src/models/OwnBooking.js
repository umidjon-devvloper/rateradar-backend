import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// O'Z BRONLARIM — PMS/Channel Manager'dan kelgan haqiqiy bronlar
//
// `DailyRate` = RAQIBLAR narxi (tashqaridan skreyping bilan ko'rilgan).
// `OwnBooking` = O'Z sotuvim (ichkaridan, aniq, taxminsiz).
//
// Ikkalasi birga mahsulotni narx kuzatuvchidan RMS'ga aylantiradi:
//   • occupancy — band room-night'lar / jami xona-tun
//   • ADR       — tushum / band room-night
//   • RevPAR    — tushum / mavjud room-night
//   • pickup    — createdAt vs arrivalDate (booking curve)
//   • STLY      — o'tgan yil shu davr bilan solishtirish
//
// ⛔ MEHMON MA'LUMOTI (ism, telefon, email, hujjat) BU YERDA YO'Q va
//    hech qachon qo'shilmasin. Kesish `reservation.service.js`
//    normalizeBooking() da bajariladi — sabablari o'sha yerda yozilgan.
//
// ⚠️ TTL indeksi QO'YMANG: bron tarixi qayta yig'ilmaydi va STLY tahlili
//    aynan o'tgan yilgi yozuvlarga tayanadi.
// ════════════════════════════════════════════════════════════════════

const roomStaySchema = new mongoose.Schema(
  {
    arrivalDate: { type: Date, default: null },
    departureDate: { type: Date, default: null },
    nights: { type: Number, default: 0 },

    roomTypeId: { type: String, default: '' },
    roomTypeName: { type: String, default: '' },
    ratePlanId: { type: String, default: '' },
    ratePlanName: { type: String, default: '' },

    adults: { type: Number, default: 0 },
    childAges: { type: [Number], default: [] },

    beforeTax: { type: Number, default: 0 },
    afterTax: { type: Number, default: 0 },

    // Har tun uchun alohida narx — occupancy va ADR'ni AYNAN tunash sanasi
    // bo'yicha hisoblash uchun yagona to'g'ri manba (bronning umumiy
    // summasini tunlarga bo'lish noto'g'ri: narx kunma-kun farq qiladi).
    dailyRates: {
      type: [{ date: Date, price: Number, _id: false }],
      default: [],
    },
    mealPlanCodes: { type: [String], default: [] },
  },
  { _id: false },
);

const ownBookingSchema = new mongoose.Schema(
  {
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    integrationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Integration', required: true },
    propertyId: { type: String, default: '' },

    number: { type: String, required: true },

    status: { type: String, default: '' },
    isCancelled: { type: Boolean, default: false, index: true },

    createdAt: { type: Date, default: null },
    modifiedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    // Bekor qilish jarimasi — "bekor qilish bizga qancha turdi" hisobiga.
    cancellationPenalty: { type: Number, default: 0 },

    currency: { type: String, default: '' },
    sourceType: { type: String, default: '' },  // PMS | Channel | BookingEngine
    sourceCode: { type: String, default: '' },  // xom qisqartma (BGC, EXP, ...)
    channel: { type: String, default: '' },     // ko'rsatiladigan nom (o'zgaruvchan)
    // Guruhlash/hisobot kaliti — `source.code` ga tayanadi, tarif qayta
    // nomlansa ham o'zgarmaydi. Kanal kesimidagi barcha hisob shundan.
    channelKey: { type: String, default: '', index: true },

    arrivalDate: { type: Date, default: null },
    departureDate: { type: Date, default: null },
    roomNights: { type: Number, default: 0 },
    roomCount: { type: Number, default: 0 },
    adults: { type: Number, default: 0 },
    children: { type: Number, default: 0 },
    leadTimeDays: { type: Number, default: null },

    totalBeforeTax: { type: Number, default: 0 },
    totalAfterTax: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    prepaid: { type: Number, default: 0 },

    roomStays: { type: [roomStaySchema], default: [] },

    syncedAt: { type: Date, default: Date.now },

    // Sinxronizatsiya IKKI BOSQICHLI (sync.service.js ga qarang):
    //   1) summary — arzon (3800 bron = 4 so'rov), kursorni suradi va shu
    //      yerda yozuv "stub" holida paydo bo'ladi: needsDetail = true
    //   2) detail  — tunlar, narx, xona turi, kanal to'ldiriladi → false
    //
    // Nega ajratilgan: agar kursor faqat detallar tugagach saqlansa, 3800
    // ta bronlik birinchi yuklash o'rtasida uzilsa hammasi boshidan
    // boshlanardi. Endi kursor har sahifada saqlanadi, detallar esa
    // mustaqil to'ldiriladi va xato bo'lganda o'sha bron qayta uriniladi.
    //
    // ⚠️ METRIKA (occupancy/ADR/RevPAR) FAQAT `needsDetail: false` yozuvlarni
    //    hisoblasin — to'lmagan stub'da roomStays bo'sh va u to'lishni
    //    sun'iy past ko'rsatadi.
    needsDetail: { type: Boolean, default: true, index: true },
    // Muvaffaqiyatsiz urinishlar soni — bitta buzuq bron cheksiz qayta
    // so'ralib, har sync'ni band qilib qo'ymasligi uchun.
    detailAttempts: { type: Number, default: 0 },
  },
  {
    // createdAt/modifiedAt — EXELY tomonidagi vaqtlar, mongoose ularni
    // o'zinikiga almashtirmasin. Bizning yozuv vaqti = syncedAt.
    timestamps: false,
  },
);

// Idempotentlik: sync qayta ishlaganda dublikat yaratmaydi (upsert kaliti).
ownBookingSchema.index({ hotelId: 1, number: 1 }, { unique: true });

// Occupancy: "shu tunda band bo'lgan bronlar" → arrival <= kun < departure.
ownBookingSchema.index({ hotelId: 1, needsDetail: 1, arrivalDate: 1, departureDate: 1 });
// Pickup / booking curve: qachon bron qilingan.
ownBookingSchema.index({ hotelId: 1, createdAt: -1 });
// Kanal kesimi.
ownBookingSchema.index({ hotelId: 1, channelKey: 1, arrivalDate: 1 });

export default mongoose.model('OwnBooking', ownBookingSchema);
