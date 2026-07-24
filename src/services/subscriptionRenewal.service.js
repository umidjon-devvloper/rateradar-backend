import cron from 'node-cron';
import { customAlphabet } from 'nanoid';
import User from '../models/User.js';
import Payment from '../models/Payment.js';
import { getPlan, planAmountTiyin } from '../config/plans.js';
import * as atmos from '../services/atmos.service.js';
import { activateSubscription } from '../controllers/payment.controller.js';

/**
 * Obunani AVTO-YANGILASH (recurring) — saqlangan karta bilan.
 *
 * Kunlik cron obunasi tugayotgan (yoki yaqinda tugagan) va avto-to'lov yoqilgan
 * mijozlarni topib, saqlangan token orqali OTP'siz yechadi va obunani uzaytiradi.
 *
 * Xato bo'lsa (mablag' yetarli emas, karta muddati o'tgan): renewFailCount oshadi,
 * 3 marta ketma-ket muvaffaqiyatsiz bo'lsa avto-to'lov o'chiriladi (mijoz qo'lda
 * to'lashi kerak). Har urinishda kuniga bir marta (lastRenewAttemptAt bilan
 * throttle) — bir kunda takror yechilmasligi uchun.
 */

const genAccount = customAlphabet('0123456789', 12);

const RENEW_BEFORE_MS = 1 * 24 * 3600 * 1000;   // muddat tugashiga 1 kun qolganda
const GRACE_AFTER_MS = 3 * 24 * 3600 * 1000;    // tugagandan keyin 3 kungача urinamiz
const MAX_FAILS = 3;                             // ketma-ket muvaffaqiyatsizlik chegarasi
const ATTEMPT_THROTTLE_MS = 20 * 3600 * 1000;   // bir kunda bitta urinish

/**
 * Bitta foydalanuvchini yangilash. Muvaffaqiyatda true qaytaradi.
 */
async function renewOne(user) {
  // Yangilanadigan plan: joriy pro (oylik). userPlan 'pro' → 'pro' plan konfigi.
  const planId = 'pro';
  const planCfg = getPlan(planId);
  if (!planCfg) return false;
  const amount = planAmountTiyin(planId);
  const account = genAccount();

  // To'lov yozuvi (avto-yangilash sifatida belgilangan).
  const payment = await Payment.create({
    user: user._id, plan: planId, amount, account,
    channel: 'card', status: 'created', isRenewal: true,
  });

  user.lastRenewAttemptAt = new Date();

  try {
    const provider = user.savedCard.provider;
    const isMps = provider === 'visa' || provider === 'mastercard';
    let result;

    if (isMps) {
      // Visa/MC — bog'langan card_id bilan 3DS'siz yechish (/mps template).
      if (!user.savedCard.cardId) throw new Error('card_id yo\'q (Visa recurring)');
      payment.channel = 'mps';
      const r = await atmos.mpsChargeTemplate({
        cardId: user.savedCard.cardId, amount, extId: account, clientIp: '0.0.0.0',
      });
      if (!r.ok) { const e = new Error(`mps template rad: ${r.resultCode}`); e.atmos = { code: r.resultCode }; throw e; }
      result = { success_trans_id: r.transactionId, ofd_url: null };
      payment.mpsCardId = user.savedCard.cardId;
      payment.mpsTransactionId = r.transactionId || null;
    } else {
      // Humo/UzCard — card_token bilan (OTP'siz).
      result = await atmos.chargeWithSavedCard({
        cardToken: user.savedCard.token, amount, account, lang: user.lang || 'uz',
      });
    }

    payment.status = 'paid';
    payment.paidAt = new Date();
    payment.atmosSuccessTransId = result.success_trans_id ?? null;
    payment.cardPan = user.savedCard.pan || null;
    payment.ofdUrl = result.ofd_url || null;
    await payment.save();

    await activateSubscription(user._id, planId);
    user.renewFailCount = 0;
    await user.save();
    console.log(`[renew] ✅ ${user.email} — obuna avto-yangilandi (${planCfg.priceUzs} so'm)`);
    return true;
  } catch (err) {
    payment.status = 'failed';
    payment.errorCode = err.atmos?.code || null;
    payment.errorMessage = err.atmos?.description || err.message;
    await payment.save();

    user.renewFailCount = (user.renewFailCount || 0) + 1;
    if (user.renewFailCount >= MAX_FAILS) {
      user.autoRenew = false; // qo'lda to'lashga o'tkazamiz
      console.warn(`[renew] ⛔ ${user.email} — ${MAX_FAILS} marta muvaffaqiyatsiz, avto-to'lov o'chirildi`);
    } else {
      console.warn(`[renew] ⚠️ ${user.email} — urinish ${user.renewFailCount}/${MAX_FAILS} xato: ${payment.errorMessage}`);
    }
    await user.save();
    return false;
  }
}

/**
 * Yangilanishga tayyor mijozlarni topib, birma-bir yangilaydi.
 */
export async function runRenewals() {
  if (!atmos.isAtmosConfigured()) return;
  const now = Date.now();
  const windowStart = new Date(now - GRACE_AFTER_MS); // tugaganiga 3 kundan oshmagan
  const windowEnd = new Date(now + RENEW_BEFORE_MS);  // 1 kun ichida tugaydi

  // token select:false — shuning uchun aniq so'raymiz.
  const users = await User.find({
    autoRenew: true,
    // Humo/UzCard → token; Visa/MC → cardId. Ikkalasidan biri bo'lsa yetadi.
    $or: [{ 'savedCard.token': { $ne: null } }, { 'savedCard.cardId': { $ne: null } }],
    planExpiresAt: { $gte: windowStart, $lte: windowEnd },
  }).select('+savedCard.token email lang savedCard autoRenew planExpiresAt renewFailCount lastRenewAttemptAt');

  if (!users.length) return;
  console.log(`[renew] ${users.length} ta obuna yangilashga tekshirilmoqda...`);

  for (const user of users) {
    // Kunlik throttle — bir kunda bitta urinish.
    const last = user.lastRenewAttemptAt ? new Date(user.lastRenewAttemptAt).getTime() : 0;
    if (last && now - last < ATTEMPT_THROTTLE_MS) continue;
    try {
      await renewOne(user);
    } catch (e) {
      console.error(`[renew] ${user.email} kutilmagan xato:`, e.message);
    }
  }
}

/**
 * Cron'ni ishga tushiradi — har kuni 09:00 (Toshkent) da tekshiradi.
 * (Server UTC bo'lsa 04:00 UTC ≈ 09:00 UTC+5.)
 */
export function startSubscriptionRenewal() {
  cron.schedule('0 4 * * *', runRenewals);
  console.log('[cron] Obuna avto-yangilash yoqildi (har kuni 09:00 Toshkent)');
}
