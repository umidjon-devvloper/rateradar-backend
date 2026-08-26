import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// VALYUTA KURSLARI KESHI (Markaziy bank — cbu.uz)
//
// Nima uchun baza kerak: bronlar UZS/USD/EUR aralash keladi va metrika
// (ADR, RevPAR) bitta valyutada bo'lishi shart. Kurs esa TUNASH SANASI
// bo'yicha olinadi — 2025-yil fevraldagi tunni bugungi kurs bilan
// hisoblash tarixni buzadi (USD: 2025-02 da 12 985 so'm, 2026-08 da
// 11 778 so'm — 9% farq).
//
// O'tmishdagi kurs HECH QACHON o'zgarmaydi, shuning uchun bir marta
// olingach abadiy keshda qoladi va cbu.uz'ga qayta so'rov ketmaydi.
// ════════════════════════════════════════════════════════════════════

const fxRateSchema = new mongoose.Schema(
  {
    // Qaysi valyuta (ISO: USD, EUR). UZS saqlanmaydi — u bazaviy valyuta.
    currency: { type: String, required: true, uppercase: true },
    // Kurs sanasi (UTC kun boshi).
    date: { type: Date, required: true },
    // 1 birlik uchun necha so'm.
    rate: { type: Number, required: true },
    // Kurs AYNAN shu sanaga topilmagan bo'lsa (dam olish kuni / bayram),
    // eng yaqin oldingi ish kunining kursi olinadi va manba sanasi shu
    // yerda qoladi — hisobot qaysi kunning kursi ekanini ko'rsata olsin.
    sourceDate: { type: Date, default: null },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

fxRateSchema.index({ currency: 1, date: 1 }, { unique: true });

export default mongoose.model('FxRate', fxRateSchema);
