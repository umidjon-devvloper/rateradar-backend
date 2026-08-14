import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// KUNLIK NARX TARIXI — mahsulotning yagona qaytarib bo'lmaydigan aktivi.
//
// `PriceSnapshot` = XOM qatlam (har scrape natijasi, kuniga bir necha marta).
// `DailyRate`     = AGREGAT qatlam (bitta obyekt × bitta tunash sanasi ×
//                   bitta o'lchov kuni = bitta hujjat). HECH QACHON o'chmaydi.
//
// Ikki sana bor va ular ARALASHTIRILMASIN:
//   • stayDate    — narx QAYSI TUN uchun (mehmon qachon keladi)
//   • captureDate — narx QACHON o'lchandi (biz qachon ko'rdik)
// Ikkalasi birga "booking curve" beradi: masalan 12-sentabr tuni uchun narx
// 30 kun oldin $60, 7 kun oldin $85 edi → talab oshgan. Bitta sana bilan bu
// savolga javob berib bo'lmaydi.
//
// Hajm: 10 raqib × 14 tunash sanasi × 1 o'lchov/kun ≈ 140 hujjat/kun/hotel
//       ≈ 15 MB/yil/hotel. 200 mijozda ~3 GB/yil — arzon.
//
// ⚠️ BU JADVALGA TTL INDEKSI QO'YMANG. O'tgan yilni qayta yig'ib bo'lmaydi.
// ════════════════════════════════════════════════════════════════════
const dailyRateSchema = new mongoose.Schema(
  {
    ownerHotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    targetType: { type: String, enum: ['own', 'competitor'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },

    stayDate: { type: Date, required: true },    // UTC kun boshi
    captureDate: { type: Date, required: true }, // UTC kun boshi

    // OTA → o'sha kundagi eng arzon narx. Masalan { booking: 56, agoda: 61 }.
    prices: { type: mongoose.Schema.Types.Mixed, default: {} },

    minPrice: { type: Number, required: true },
    minOta: { type: String, default: '' },
    currency: { type: String, default: 'USD' },
    roomsLeft: { type: Number, default: null },
    sources: { type: [String], default: [] }, // serpapi / apify / xotelo ...
    otaCount: { type: Number, default: 0 },
  },
  { timestamps: false },
);

// Idempotentlik: rollup qayta ishga tushsa dublikat yaratmaydi (upsert kaliti).
dailyRateSchema.index(
  { targetId: 1, targetType: 1, stayDate: 1, captureDate: 1 },
  { unique: true },
);
// STLY va booking-curve so'rovlari uchun.
dailyRateSchema.index({ ownerHotelId: 1, stayDate: 1, captureDate: -1 });
dailyRateSchema.index({ ownerHotelId: 1, captureDate: -1 });

export default mongoose.model('DailyRate', dailyRateSchema);
