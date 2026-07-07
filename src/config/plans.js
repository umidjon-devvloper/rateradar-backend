/**
 * Obuna rejalari (subscription plans).
 *
 * Narxlar O'ZBEK SO'MIDA (UZS). ATMOS API summani TIYINDA qabul qiladi
 * (1 so'm = 100 tiyin), shuning uchun amountTiyin = priceUzs * 100.
 *
 * HOZIRGI SIYOSAT: ikkita sotib olinadigan variant — `pro` (oylik, $49 ≈
 * 590 000 so'm) va `pro_yearly` (yillik, $490 ≈ 5 900 000 so'm — 10 oy narxi,
 * 2 oy bepul). Ikkalasi ham foydalanuvchiga `pro` planini beradi (userPlan).
 * `starter` legacy (eski to'lov yozuvlari uchun enumda qoladi, sotilmaydi).
 * `free` faqat ichki holat — ro'yxatdan o'tgan, hali to'lamagan foydalanuvchi.
 */

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUzs: 0,
    priceUsd: 0,
    durationDays: 0,
    purchasable: false,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUzs: 590_000, // legacy — sotilmaydi
    priceUsd: 49,
    durationDays: 30,
    purchasable: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUzs: 590_000, // $49 — Humo karta orqali so'mda yechiladi
    priceUsd: 49,
    durationDays: 30,
    purchasable: true,
    userPlan: 'pro',
  },
  pro_yearly: {
    id: 'pro_yearly',
    name: 'Pro — 1 yil',
    priceUzs: 5_900_000, // $490 — 10 oy narxi (2 oy bepul)
    priceUsd: 490,
    durationDays: 365,
    purchasable: false, // Yillik to'lov support orqali amalga oshiriladi
    userPlan: 'pro', // User.plan'da 'pro' bo'lib turadi, faqat muddati 1 yil
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
