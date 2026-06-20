import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { PURCHASABLE_PLANS, getPlan, planAmountTiyin } from '../config/plans.js';
import * as atmos from '../services/atmos.service.js';

// account — ATMOS sverkasi uchun noyob, faqat raqamli identifikator.
// ATMOS account maydoni odatda raqamli qiymat kutadi.
const genAccount = customAlphabet('0123456789', 12);

/**
 * GET /api/payments/plans
 * Sotib olinadigan rejalar ro'yxati (narx so'mda).
 */
export function listPlans(req, res) {
  res.json({
    plans: PURCHASABLE_PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      priceUzs: p.priceUzs,
      durationDays: p.durationDays,
    })),
    atmosReady: atmos.isAtmosConfigured(),
    // Sandbox uchun qulaylik — frontendda ko'rsatish mumkin.
    testCard: { pan: '9860090101014364', expiry: '02/28', otp: '111111' },
  });
}

const createSchema = z.object({ plan: z.enum(['starter', 'pro']) });

/**
 * POST /api/payments/create   { plan }
 * 1-qadam: ATMOS'da chernovik tranzaksiya yaratadi va Payment yozuvini qaytaradi.
 */
export async function createPayment(req, res, next) {
  try {
    const { plan } = createSchema.parse(req.body);
    const planCfg = getPlan(plan);
    const amount = planAmountTiyin(plan); // tiyinda

    const account = genAccount();
    const payment = await Payment.create({
      user: req.user._id,
      plan,
      amount,
      account,
      status: 'created',
    });

    const { transaction_id, raw } = await atmos.createTransaction({
      amount,
      account,
      lang: req.user.lang || 'uz',
    });

    payment.atmosTransactionId = transaction_id;
    payment.raw = { create: raw };
    await payment.save();

    res.status(201).json({
      paymentId: payment._id,
      plan,
      planName: planCfg.name,
      amountUzs: planCfg.priceUzs,
      transactionId: transaction_id,
      status: payment.status,
    });
  } catch (err) {
    handleErr(err, next);
  }
}

const invoiceSchema = z.object({
  plan: z.enum(['starter', 'pro']),
  successUrl: z.string().url().optional(), // qaytish manzili (frontend origin + /billing)
});

/**
 * POST /api/payments/invoice   { plan, successUrl? }
 * ATMOS to'lov sahifasini yaratadi — Visa/MC/UzCard/Humo, 3DS ATMOS tomonida.
 * Mijoz qaytgan `url`ga yo'naltiriladi.
 */
export async function createInvoice(req, res, next) {
  try {
    const { plan, successUrl } = invoiceSchema.parse(req.body);
    const planCfg = getPlan(plan);
    const amount = planAmountTiyin(plan);

    const account = genAccount();
    const payment = await Payment.create({
      user: req.user._id,
      plan,
      amount,
      account,
      channel: 'invoice',
      status: 'created',
    });

    // To'lovdan keyin mijoz shu manzilga qaytadi — qaysi to'lov ekanini ?pay bilan bildiramiz.
    const base = (successUrl || `${env.CLIENT_URL}/billing`).replace(/\/$/, '');
    const returnUrl = `${base}?pay=${payment._id}`;

    const { url, payment_id, token, raw } = await atmos.createInvoice({
      amount,
      account,
      requestId: account, // noyob
      successUrl: returnUrl,
      items: [
        {
          items_id: '1',
          name: `TheHotelSaaS ${planCfg.name}`,
          amount,
          quantity: 1,
        },
      ],
    });

    payment.invoicePaymentId = payment_id ?? null;
    payment.invoiceToken = token ?? null;
    payment.checkoutUrl = url ?? null;
    payment.raw = { invoiceCreate: raw };
    await payment.save();

    res.status(201).json({
      paymentId: payment._id,
      url,
      plan,
      amountUzs: planCfg.priceUzs,
    });
  } catch (err) {
    handleErr(err, next);
  }
}

const cardSchema = z.object({
  paymentId: z.string(),
  cardNumber: z.string().min(12),
  expiry: z.string().min(4), // "MM/YY", "MMYY" yoki "YYMM"
});

/**
 * POST /api/payments/card   { paymentId, cardNumber, expiry }
 * 2-qadam: karta ma'lumotini yuboradi → kartaga SMS-OTP keladi.
 */
export async function submitCard(req, res, next) {
  try {
    const { paymentId, cardNumber, expiry } = cardSchema.parse(req.body);
    const payment = await findOwnPayment(paymentId, req.user._id);

    if (!['created', 'otp_sent', 'failed'].includes(payment.status)) {
      return res.status(409).json({ error: `To'lov holati: ${payment.status} — karta yuborib bo'lmaydi` });
    }

    const expiryYYMM = atmos.normalizeExpiry(expiry);
    const { raw } = await atmos.preApply({
      transactionId: payment.atmosTransactionId,
      cardNumber,
      expiry: expiryYYMM,
    });

    payment.status = 'otp_sent';
    payment.raw = { ...(payment.raw || {}), preApply: raw };
    await payment.save();

    res.json({ paymentId: payment._id, status: payment.status, message: 'SMS-kod kartaga yuborildi' });
  } catch (err) {
    handleErr(err, next);
  }
}

const confirmSchema = z.object({
  paymentId: z.string(),
  otp: z.string().min(4),
});

/**
 * POST /api/payments/confirm   { paymentId, otp }
 * 3-qadam: OTP bilan tasdiqlaydi, pul yechiladi va obuna faollashadi.
 * Test kartalar uchun otp = "111111".
 */
export async function confirmPayment(req, res, next) {
  try {
    const { paymentId, otp } = confirmSchema.parse(req.body);
    const payment = await findOwnPayment(paymentId, req.user._id);

    if (payment.status === 'paid') {
      return res.json({ paymentId: payment._id, status: 'paid', message: 'Allaqachon to\'langan' });
    }
    if (payment.status !== 'otp_sent') {
      return res.status(409).json({ error: `To'lov holati: ${payment.status} — tasdiqlab bo'lmaydi` });
    }

    let result;
    try {
      result = await atmos.apply({ transactionId: payment.atmosTransactionId, otp });
    } catch (err) {
      // ATMOS rad etdi (OTP xato, mablag' yetarli emas, ...) — failed deb belgilamaymiz,
      // foydalanuvchi qayta urinishi mumkin. Faqat xatoni qaytaramiz.
      payment.errorCode = err.atmos?.code || null;
      payment.errorMessage = err.atmos?.description || err.message;
      await payment.save();
      throw err;
    }

    payment.status = 'paid';
    payment.paidAt = new Date();
    payment.atmosSuccessTransId = result.success_trans_id;
    payment.cardPan = result.card_id || null;
    payment.ofdUrl = result.ofd_url || null;
    payment.errorCode = null;
    payment.errorMessage = null;
    payment.raw = { ...(payment.raw || {}), apply: result.raw };
    await payment.save();

    await activateSubscription(payment.user, payment.plan);

    res.json({
      paymentId: payment._id,
      status: 'paid',
      plan: payment.plan,
      ofdUrl: payment.ofdUrl,
      message: 'To\'lov muvaffaqiyatli — obuna faollashtirildi',
    });
  } catch (err) {
    handleErr(err, next);
  }
}

/**
 * POST /api/payments/:id/resend-otp
 * SMS-kodni qayta yuborish.
 */
export async function resendOtp(req, res, next) {
  try {
    const payment = await findOwnPayment(req.params.id, req.user._id);
    if (payment.status !== 'otp_sent') {
      return res.status(409).json({ error: 'Bu to\'lov uchun OTP yuborilmagan' });
    }
    await atmos.retryOtp({ transactionId: payment.atmosTransactionId });
    res.json({ paymentId: payment._id, message: 'SMS-kod qayta yuborildi' });
  } catch (err) {
    handleErr(err, next);
  }
}

/**
 * GET /api/payments  — foydalanuvchi to'lovlari tarixi.
 */
export async function listMyPayments(req, res, next) {
  try {
    const items = await Payment.find({ user: req.user._id })
      .select('-raw')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ payments: items });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/payments/:id — bitta to'lov holati.
 * Agar holat noaniq bo'lsa (otp_sent), ATMOS'dan haqiqiy statusni so'raydi.
 */
export async function getPayment(req, res, next) {
  try {
    const payment = await findOwnPayment(req.params.id, req.user._id);

    // Invoice kanali — ATMOS to'lov sahifasidan qaytgach holatni so'raymiz.
    if (payment.channel === 'invoice' && payment.status !== 'paid' && payment.invoicePaymentId) {
      try {
        const inv = await atmos.getInvoice({ paymentId: payment.invoicePaymentId });
        if (inv.success && payment.status !== 'paid') {
          payment.status = 'paid';
          payment.paidAt = new Date();
          await payment.save();
          await activateSubscription(payment.user, payment.plan);
        } else if (inv.final && !inv.success) {
          payment.status = 'failed';
          await payment.save();
        }
      } catch {
        /* status so'rovi xato bersa, mavjud holatni qaytaveramiz */
      }
    }

    // Timeout / noaniq holatda ATMOS'dan tekshirib, holatni sinxronlaymiz.
    if (payment.status === 'otp_sent' && payment.atmosTransactionId) {
      try {
        const { store_transaction } = await atmos.getTransaction({
          transactionId: payment.atmosTransactionId,
        });
        if (store_transaction?.confirmed === true && payment.status !== 'paid') {
          payment.status = 'paid';
          payment.paidAt = new Date();
          payment.atmosSuccessTransId = store_transaction.success_trans_id ?? null;
          payment.cardPan = store_transaction.card_id ?? null;
          await payment.save();
          await activateSubscription(payment.user, payment.plan);
        }
      } catch {
        /* status so'rovi xato bersa, mavjud holatni qaytaveramiz */
      }
    }

    const obj = payment.toObject();
    delete obj.raw;
    res.json({ payment: obj });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/callback — ATMOS Callback API.
 * Imzo (sign) tekshiriladi. Muvaffaqiyatli bo'lsa { status: 1 } qaytariladi,
 * shundagina ATMOS pulni yakuniy yechadi.
 * Bu endpoint AUTHsiz (ATMOS chaqiradi), lekin sign bilan himoyalangan.
 */
export async function atmosCallback(req, res) {
  try {
    const { store_id, transaction_id, account, amount, sign } = req.body || {};

    const valid = atmos.verifyCallbackSign({ store_id, transaction_id, account, amount, sign });
    if (!valid) {
      return res.status(200).json({ status: 0, message: 'Imzo (sign) noto\'g\'ri' });
    }

    const payment = await Payment.findOne({ account: String(account) });
    if (!payment) {
      return res.status(200).json({ status: 0, message: `Account ${account} topilmadi` });
    }

    // Summa mosligini tekshiramiz (tiyinda).
    if (Number(amount) !== Number(payment.amount)) {
      return res.status(200).json({ status: 0, message: 'Summa mos kelmadi' });
    }

    // Obunani faollashtiramiz (agar hali bo'lmasa).
    if (payment.status !== 'paid') {
      payment.status = 'paid';
      payment.paidAt = new Date();
      payment.atmosTransactionId = payment.atmosTransactionId || Number(transaction_id);
      await payment.save();
      await activateSubscription(payment.user, payment.plan);
    }

    return res.status(200).json({ status: 1, message: 'Успешно' });
  } catch (err) {
    console.error('[ATMOS callback]', err);
    return res.status(200).json({ status: 0, message: 'Ichki xato' });
  }
}

// ─── Yordamchi funksiyalar ───────────────────────────────────────────

async function findOwnPayment(id, userId) {
  const payment = await Payment.findOne({ _id: id, user: userId });
  if (!payment) {
    const e = new Error('To\'lov topilmadi');
    e.status = 404;
    throw e;
  }
  return payment;
}

// Obunani faollashtirish: planni o'rnatish va muddatni uzaytirish.
async function activateSubscription(userId, plan) {
  const cfg = getPlan(plan);
  const user = await User.findById(userId);
  if (!user) return;

  // Joriy obuna hali tugamagan bo'lsa, ustiga qo'shamiz; aks holda bugundan.
  const base =
    user.planExpiresAt && user.planExpiresAt > new Date() ? new Date(user.planExpiresAt) : new Date();
  base.setDate(base.getDate() + (cfg.durationDays || 30));

  user.plan = plan;
  user.planExpiresAt = base;
  await user.save();
}

function handleErr(err, next) {
  if (err.name === 'ZodError') {
    const e = new Error('Validatsiya xatosi');
    e.status = 400;
    e.details = err.flatten();
    return next(e);
  }
  next(err);
}
