/**
 * Obuna rejalari (subscription plans).
 *
 * Narxlar O'ZBEK SO'MIDA (UZS). ATMOS API summani TIYINDA qabul qiladi
 * (1 so'm = 100 tiyin), shuning uchun amountTiyin = priceUzs * 100.
 *
 * `free` reja to'lov talab qilmaydi — faqat `starter` va `pro` sotib olinadi.
 */

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUzs: 0,
    durationDays: 0,
    purchasable: false,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUzs: 1_000, // TEST: vaqtincha 1000 so'm (ATMOS sinovi uchun). ASLI: 99_000
    durationDays: 30,
    purchasable: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUzs: 199_000,
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
