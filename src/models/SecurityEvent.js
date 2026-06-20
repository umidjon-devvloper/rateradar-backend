import mongoose from 'mongoose';

/**
 * Xavfsizlik hodisasi — shubhali yoki zararli faoliyat yozuvi.
 *
 * type:
 *   rate_abuse      — bitta IP'dan haddan tashqari ko'p so'rov (flood)
 *   brute_force     — ketma-ket noto'g'ri login urinishlari
 *   failed_login    — noto'g'ri login (alohida hodisa)
 *   suspicious_path — zararli yo'l/probe (/.env, /wp-admin, ../ va h.k.)
 *   injection       — SQL/NoSQL/XSS naqshi aniqlandi
 *   large_payload   — juda katta so'rov tanasi
 *   blocked         — bloklangan IP'ning urinishi
 *   ip_banned       — IP banlandi (avtomatik yoki qo'lda)
 *   ip_unbanned     — IP blokdan chiqarildi
 *
 * severity: low | medium | high | critical
 *
 * TTL: yozuvlar 30 kundan keyin avtomatik o'chadi.
 */
const securityEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
      index: true,
    },
    ip: { type: String, required: true, index: true },
    method: { type: String, default: null },
    path: { type: String, default: null },
    userAgent: { type: String, default: null },
    count: { type: Number, default: 1 }, // throttle oynasida nechta urinish
    detail: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
securityEventSchema.index({ type: 1, createdAt: -1 });
securityEventSchema.index({ ip: 1, createdAt: -1 });

export default mongoose.model('SecurityEvent', securityEventSchema);
