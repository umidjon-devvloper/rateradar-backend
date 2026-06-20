import mongoose from 'mongoose';

/**
 * Bloklangan IP manzili.
 *
 *   • permanent = true  → muddatsiz blok (qo'lda admin tomonidan)
 *   • until             → vaqtinchalik blok tugash vaqti (avtomatik)
 *   • source            → 'auto' (tizim) yoki 'admin' (qo'lda)
 *
 * TTL yo'q — bloklar qo'lda yoki `until` tekshiruvi bilan boshqariladi
 * (vaqtinchalik bloklar service'da expire bo'ladi va tozalanadi).
 */
const bannedIpSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: '' },
    permanent: { type: Boolean, default: false },
    until: { type: Date, default: null }, // permanent=false bo'lsa
    source: { type: String, enum: ['auto', 'admin'], default: 'auto' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hits: { type: Number, default: 0 }, // blokdan keyin nechta urinish bo'ldi
  },
  { timestamps: true },
);

export default mongoose.model('BannedIp', bannedIpSchema);
