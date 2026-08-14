import mongoose from 'mongoose';

const priceSnapshotSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ['own', 'competitor'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerHotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    ota: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    available: { type: Boolean, default: true },
    roomsLeft: { type: Number, default: null },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    snapshotAt: { type: Date, default: Date.now, index: true },
    source: { type: String, default: 'unknown' },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: false }
);

priceSnapshotSchema.index({ ownerHotelId: 1, snapshotAt: -1 });
priceSnapshotSchema.index({ targetId: 1, ota: 1, snapshotAt: -1 });
priceSnapshotSchema.index({ ownerHotelId: 1, ota: 1, snapshotAt: -1 });

// ⚠️ TTL INDEKSI ATAYLAB OLIB TASHLANDI (2026-08-12).
//
// Ilgari shu yerda `expireAfterSeconds: 60*60*24*90` turardi — narx tarixi
// 90 kunda o'chib ketardi. Lekin STLY (Same Time Last Year) tahlili 358-366
// kun oldingi ma'lumotni so'raydi → natija HAR DOIM bo'sh bo'lardi, server
// necha yil ishlashidan qat'i nazar.
//
// Bu jadval endi XOM (raw) qatlam: har bir scrape natijasi to'liq saqlanadi.
// Undan kunlik agregat `DailyRate` ga yig'iladi (rateHistory.service.js) —
// tarixiy tahlil AYNAN o'sha jadvaldan o'qiydi.
//
// Xom qatlam kattalashsa, TTL'ni QAYTA QO'YISH mumkin — LEKIN faqat kunlik
// rollup ishlayotganiga ishonch hosil qilgandan keyin va TTL rollup
// oynasidan (3 kun) sezilarli uzun bo'lsin (masalan 180 kun).

export default mongoose.model('PriceSnapshot', priceSnapshotSchema);
