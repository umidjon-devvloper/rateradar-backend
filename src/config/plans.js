/**
 * Obuna rejalari (subscription plans).
 *
 * Narxlar O'ZBEK SO'MIDA (UZS). ATMOS API summani TIYINDA qabul qiladi
 * (1 so'm = 100 tiyin), shuning uchun amountTiyin = priceUzs * 100.
 *
 * SIYOSAT (2026-07-25): UCHTA sotib olinadigan tarif —
 *   • starter  ($29 / 350 000)  — 1 hotel, 3 raqib, faqat Booking, Hotel Service YO'Q
 *   • pro      ($49 / 590 000)  — 1 hotel, 10 raqib, barcha OTA, AI, Hotel Service ✅
 *   • business ($119 / 1 400 000) — 5 hotel, cheksiz raqib, hammasi + shaxsiy menejer
 * Har tarifning YILLIK varianti (2 oy bepul): *_yearly (support/forma orqali).
 * `limits` — funksiya cheklovlari (gating uchun): planLimits(userPlan) o'qiydi.
 * `free` — ichki holat (ro'yxatdan o'tgan, hali to'lamagan).
 */

// Har tarifning funksiya cheklovlari. 0 = cheksiz. channels: null = barcha OTA;
// massiv = faqat shu kanallar KO'RSATILADI (baza baribir hammasini saqlaydi).
// reviewsAnalytics: sharhlar analitika dashboardi (Starter'da qulf).
const LIMITS = {
  free:     { maxCompetitors: 0,  maxHotels: 1, channels: ['booking'],            ai: false, reviewsReply: false, reviewsAnalytics: false, maxTv: 0, hotelService: false },
  starter:  { maxCompetitors: 3,  maxHotels: 1, channels: ['booking', 'expedia'], ai: false, reviewsReply: false, reviewsAnalytics: false, maxTv: 1, hotelService: false },
  pro:      { maxCompetitors: 10, maxHotels: 1, channels: null,                   ai: true,  reviewsReply: true,  reviewsAnalytics: true,  maxTv: 5, hotelService: true },
  business: { maxCompetitors: 0,  maxHotels: 5, channels: null,                   ai: true,  reviewsReply: true,  reviewsAnalytics: true,  maxTv: 0, hotelService: true },
};

export const PLANS = {
  free: {
    id: 'free', name: 'Free', priceUzs: 0, priceUsd: 0,
    durationDays: 0, purchasable: false, userPlan: 'free',
  },

  // ── Oylik tariflar ──
  starter: {
    id: 'starter', name: 'Starter', priceUzs: 350_000, priceUsd: 29,
    durationDays: 30, purchasable: true, userPlan: 'starter',
  },
  pro: {
    id: 'pro', name: 'Pro', priceUzs: 590_000, priceUsd: 49,
    durationDays: 30, purchasable: true, userPlan: 'pro',
  },
  business: {
    id: 'business', name: 'Business', priceUzs: 1_400_000, priceUsd: 119,
    durationDays: 30, purchasable: true, userPlan: 'business',
  },

  // ── Yillik tariflar (10 oy narxi — 2 oy bepul). Support/forma orqali. ──
  starter_yearly: {
    id: 'starter_yearly', name: 'Starter — 1 yil', priceUzs: 3_500_000, priceUsd: 290,
    durationDays: 365, purchasable: false, userPlan: 'starter',
  },
  pro_yearly: {
    id: 'pro_yearly', name: 'Pro — 1 yil', priceUzs: 5_900_000, priceUsd: 490,
    durationDays: 365, purchasable: false, userPlan: 'pro',
  },
  business_yearly: {
    id: 'business_yearly', name: 'Business — 1 yil', priceUzs: 14_000_000, priceUsd: 1190,
    durationDays: 365, purchasable: false, userPlan: 'business',
  },
};

export const PURCHASABLE_PLANS = Object.values(PLANS).filter((p) => p.purchasable);

export function getPlan(planId) {
  return PLANS[planId] || null;
}

// ATMOS uchun summa (tiyinda).
export function planAmountTiyin(planId) {
  const plan = getPlan(planId);
  if (!plan) return null;
  return plan.priceUzs * 100;
}

// Foydalanuvchi planiga (userPlan: free|starter|pro|business) mos cheklovlar.
export function planLimits(userPlan) {
  return LIMITS[userPlan] || LIMITS.free;
}

// Funksiya ruxsatini tekshirish (gating uchun qulay yordamchi).
export function planAllows(userPlan, feature) {
  const l = planLimits(userPlan);
  return Boolean(l[feature]);
}
