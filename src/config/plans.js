/**
 * Obuna rejalari (subscription plans).
 *
 * Narxlar O'ZBEK SO'MIDA (UZS). ATMOS API summani TIYINDA qabul qiladi
 * (1 so'm = 100 tiyin), shuning uchun amountTiyin = priceUzs * 100.
 *
 * HOZIRGI SIYOSAT: bitta sotib olinadigan reja — `pro` ($49 ≈ 590 000 so'm/oy).
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
