import mongoose from 'mongoose';

// ════════════════════════════════════════════════════════════════════
// TASHQI TIZIM ULANISHI (multi-tenant integratsiya)
//
// HAR BIR MEHMONXONA o'z ulanishiga ega. Kalitlar .env'da EMAS — chunki
// SaaS'da 200 ta mijozning 200 xil Exely kaliti bo'ladi. Mijoz Settings
// orqali kiritadi, biz shifrlab shu yerda saqlaymiz.
//
// ⚠️ clientSecret HECH QACHON ochiq saqlanmaydi va API javobida
// qaytarilmaydi — faqat `services/exely/crypto.js` deshifrlaydi.
//
// `sync` bloki — kursor holati. Exely Read Reservation API `continueToken`
// bilan ishlaydi: token oldingi javobdan olinadi va KEYINGI so'rovda
// "shundan keyingi o'zgarganlarini ber" degani. Token yo'qolsa
// `lastModificationCursor` dan qayta boshlanadi (idempotent upsert
// bo'lgani uchun dublikat paydo bo'lmaydi).
// ════════════════════════════════════════════════════════════════════

const integrationSchema = new mongoose.Schema(
  {
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    provider: { type: String, enum: ['exely'], default: 'exely', index: true },

    // pending — kalit kiritildi, hali obyekt tanlanmadi
    // active  — ishlayapti
    // error   — ketma-ket xatolar (sync.lastError'ga qarang)
    // disabled— mijoz o'chirgan
    status: {
      type: String,
      enum: ['pending', 'active', 'error', 'disabled'],
      default: 'pending',
      index: true,
    },

    credentials: {
      clientId: { type: String, default: '' },
      // AES-256-GCM: "iv:authTag:ciphertext" (hex). crypto.js qarang.
      clientSecretEnc: { type: String, default: '', select: false },
    },

    // ── Exely tomonidagi obyekt (bitta ulanish bir nechta obyektni qamrashi
    //    mumkin — mijoz qaysi birini shu hotelga bog'lashini tanlaydi).
    propertyId: { type: String, default: '', index: true },
    property: {
      name: { type: String, default: '' },
      currency: { type: String, default: '' },
      timeZone: { type: String, default: '' },
      stars: { type: Number, default: 0 },
      cityName: { type: String, default: '' },
      countryCode: { type: String, default: '' },
      roomTypeCount: { type: Number, default: 0 },
      ratePlanCount: { type: Number, default: 0 },
      // Content API'dan olingan xona turlari — occupancy hisobida umumiy
      // xona sonini bilish uchun kerak (sig'im).
      roomTypes: { type: Array, default: [] },
      ratePlans: { type: Array, default: [] },
      refreshedAt: { type: Date, default: null },
    },

    // Token JWT'sidagi `api_accesses` — qaysi API'lar ochiqligini eslab
    // qolamiz, shunda yopiq API'ga behuda so'rov yubormaymiz.
    apiAccesses: { type: [String], default: [] },

    sync: {
      continueToken: { type: String, default: '' },
      lastModificationCursor: { type: Date, default: null },
      lastSyncAt: { type: Date, default: null },
      lastSyncDurationMs: { type: Number, default: 0 },
      backfillDone: { type: Boolean, default: false },
      totalBookings: { type: Number, default: 0 },
      lastError: { type: String, default: '' },
      lastErrorAt: { type: Date, default: null },
      consecutiveErrors: { type: Number, default: 0 },
      running: { type: Boolean, default: false },
      // Uzoq davom etgan sync serverni qayta ishga tushirishda "running"
      // holatida qotib qolmasin — shu vaqtdan eski bo'lsa bekor hisoblanadi.
      runningSince: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// Bitta hotel — bitta provider ulanishi.
integrationSchema.index({ hotelId: 1, provider: 1 }, { unique: true });

/** Kalitlar to'liq kiritilganmi (secret select:false — alohida so'raladi). */
integrationSchema.methods.isConfigured = function isConfigured() {
  return Boolean(this.credentials?.clientId && this.propertyId);
};

export default mongoose.model('Integration', integrationSchema);
