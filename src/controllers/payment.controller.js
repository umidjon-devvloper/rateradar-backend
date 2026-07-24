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
 * Sotib olinadigan rejalar ro'yxati (narx so'mda + USD ko'rsatkich).
 */
export function listPlans(req, res) {
  res.json({
    plans: PURCHASABLE_PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      priceUzs: p.priceUzs,
      priceUsd: p.priceUsd,
      durationDays: p.durationDays,
    })),
    atmosReady: atmos.isAtmosConfigured(),
    // To'lov usullari holati — Humo (karta+OTP) va Visa/MC (invoice sahifasi) faol.
    methods: { humo: 'active', visa: 'active' },
    // Sandbox karta faqat developmentda ko'rsatiladi.
    ...(env.NODE_ENV !== 'production'
      ? { testCard: { pan: '9860090101014364', expiry: '02/28', otp: '111111' } }
      : {}),
  });
}

// Faqat sotib olinadigan reja qabul qilinadi (hozircha bitta — pro).
const purchasablePlan = z
  .string()
  .refine((p) => getPlan(p)?.purchasable, { message: "Bu reja sotib olinmaydi" });

const createSchema = z.object({ plan: purchasablePlan });

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
  plan: purchasablePlan,
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

    // To'lovdan keyin mijoz shu manzilga qaytadi. Kelgan successUrl'dagi HAR
    // QANDAY query'ni tashlaymiz va faqat bitta ?pay=<id> qo'yamiz — toza,
    // yagona-query URL (ATMOS query'li/buzuq manzilni -999999 bilan rad etadi).
    let base = successUrl || `${env.CLIENT_URL}/billing`;
    base = base.split('?')[0].split('#')[0].replace(/\/$/, '');
    const returnUrl = `${base}?pay=${payment._id}`;

    const { url, payment_id, token, raw } = await atmos.createInvoice({
      amount,
      account,
      requestId: account, // noyob
      successUrl: returnUrl,
      // ATMOS invoice item formati (jonli tekshiruvda aniqlangan):
      //   • item summasi = `amount` (tiyin), yig'indisi invoice amount'ga TENG bo'lishi shart
      //   • `details` — OBYEKT (massiv emas), snake_case kalitlar
      //   • package_code (ИКПУ) MAJBURIY — bo'lmasa -999999 System error
      items: [
        {
          items_id: '1',
          name: `TheHotelSaaS ${planCfg.name}`,
          amount,
          quantity: 1,
          details: { package_code: env.ATMOS_PACKAGE_CODE },
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
  saveCard: z.boolean().optional(), // kartani eslab qolish (avto-to'lov)
});

const mpsSchema = z.object({
  plan: purchasablePlan,
  cardNumber: z.string().min(12),
  expiry: z.string().min(4),
  cvc: z.string().min(3).max(4),
  cardName: z.string().optional(),
  saveCard: z.boolean().optional(),
});

/**
 * POST /api/payments/mps   { plan, cardNumber, expiry, cvc, cardName, saveCard? }
 * Visa/Mastercard — o'z formamiz orqali (/mps/pay). Karta bog'lanadi (card_id)
 * va 3DS uchun redirectUri qaytadi. saveCard=true bo'lsa 3DS'dan keyin card_id
 * saqlanadi (avto-to'lov). Mijoz redirectUri'ga yo'naltiriladi.
 */
export async function createMpsPayment(req, res, next) {
  try {
    const { plan, cardNumber, expiry, cvc, cardName, saveCard } = mpsSchema.parse(req.body);
    const amount = planAmountTiyin(plan);
    const account = genAccount();
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '0.0.0.0';

    const payment = await Payment.create({
      user: req.user._id, plan, amount, account,
      channel: 'mps', status: 'created', saveCard: Boolean(saveCard),
    });

    const pre = await atmos.mpsPreCreate({ amount, account, extId: account });
    const created = await atmos.mpsCreate({
      pan: cardNumber,
      expiry: atmos.normalizeExpiry(expiry),
      amount,
      transactionId: pre.transactionId,
      cardName: cardName || req.user.name || 'CARD HOLDER',
      cvc2: cvc,
      clientIp,
      extId: account,
    });

    payment.mpsTransactionId = pre.transactionId;
    payment.mpsCardId = created.cardId || null;
    payment.cardPan = created.maskedPan || null;
    payment.status = 'otp_sent'; // 3DS kutilmoqda
    payment.raw = { mpsPreCreate: pre.raw, mpsCreate: created.raw };
    await payment.save();

    res.status(201).json({
      paymentId: payment._id,
      redirectUri: created.redirectUri, // 3DS sahifasi — mijoz shu yerga o'tadi
      cardId: created.cardId,
      status: created.status,
    });
  } catch (err) {
    handleErr(err, next);
  }
}

// 3DS'dan qaytgach mps to'lovni yakunlaydi: apply + holat. paid bo'lsa obuna
// yoqiladi va saveCard bo'lsa karta (card_id) saqlanadi. getPayment ichidan chaqiriladi.
async function finalizeMpsPayment(payment, user) {
  if (payment.status === 'paid' || !payment.mpsTransactionId) return payment;
  let applied;
  try {
    applied = await atmos.mpsApply({ transactionId: payment.mpsTransactionId });
  } catch {
    // apply erta chaqirilgan bo'lishi mumkin — holatни get bilan tekshiramiz
    try {
      const g = await atmos.mpsGet(payment.mpsTransactionId);
      applied = { ok: /approv|success/i.test(String(g.payload?.result_code || '')), payload: g.payload };
    } catch { return payment; }
  }
  if (applied?.ok) {
    payment.status = 'paid';
    payment.paidAt = new Date();
    await payment.save();
    await activateSubscription(payment.user, payment.plan);

    if (payment.saveCard && payment.mpsCardId) {
      await User.findByIdAndUpdate(payment.user, {
        autoRenew: true,
        renewFailCount: 0,
        savedCard: {
          provider: detectCardProvider(payment.cardPan),
          token: null,
          cardId: payment.mpsCardId,
          pan: payment.cardPan || null,
          expiry: null,
          holder: null,
          boundAt: new Date(),
        },
      });
    }
  }
  return payment;
}

/**
 * POST /api/payments/card   { paymentId, cardNumber, expiry, saveCard? }
 * 2-qadam: karta ma'lumotini yuboradi → kartaga SMS-OTP keladi.
 *
 * saveCard=true bo'lsa BIND oqimi ishlatiladi (bir OTP ham kartani bog'laydi,
 * ham birinchi to'lovni amalga oshiradi) — keyingi oylar OTP'siz yechiladi.
 */
export async function submitCard(req, res, next) {
  try {
    const { paymentId, cardNumber, expiry, saveCard } = cardSchema.parse(req.body);
    const payment = await findOwnPayment(paymentId, req.user._id);

    if (!['created', 'otp_sent', 'failed'].includes(payment.status)) {
      return res.status(409).json({ error: `To'lov holati: ${payment.status} — karta yuborib bo'lmaydi` });
    }

    const expiryYYMM = atmos.normalizeExpiry(expiry);

    if (saveCard) {
      // BIND: kartani bog'lash boshlanadi — SMS-OTP shu yerda ketadi.
      const { transactionId, raw } = await atmos.bindCardInit({ cardNumber, expiry: expiryYYMM });
      payment.saveCard = true;
      payment.bindTransactionId = transactionId;
      payment.status = 'otp_sent';
      payment.raw = { ...(payment.raw || {}), bindInit: raw };
      await payment.save();
      return res.json({ paymentId: payment._id, status: payment.status, saveCard: true, message: 'SMS-kod kartaga yuborildi' });
    }

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

    if (payment.saveCard && payment.bindTransactionId) {
      // ── BIND oqimi: OTP kartani bog'laydi (token) + birinchi to'lov ──
      let bound;
      try {
        bound = await atmos.bindCardConfirm({ transactionId: payment.bindTransactionId, otp });
      } catch (err) {
        payment.errorCode = err.atmos?.code || null;
        payment.errorMessage = err.atmos?.description || err.message;
        await payment.save();
        throw err;
      }
      if (!bound.cardToken) {
        const e = new Error('Karta bog\'lanmadi — token kelmadi'); e.status = 502; throw e;
      }

      // Kartani foydalanuvchiga saqlaymiz + avto-to'lovni yoqamiz.
      const provider = detectCardProvider(bound.pan);
      await User.findByIdAndUpdate(payment.user, {
        autoRenew: true,
        renewFailCount: 0,
        savedCard: {
          provider,
          token: bound.cardToken,
          cardId: bound.cardId || null,
          pan: bound.pan || null,
          expiry: bound.expiry || null,
          holder: bound.holder || null,
          boundAt: new Date(),
        },
      });

      // Birinchi to'lovni saqlangan token bilan darhol yechamiz (OTP'siz).
      try {
        result = await atmos.chargeWithSavedCard({
          cardToken: bound.cardToken,
          amount: payment.amount,
          account: payment.account,
          lang: req.user.lang || 'uz',
        });
      } catch (err) {
        // Karta bog'landi, lekin yechish xato berdi — foydalanuvchi qayta urinishi mumkin.
        payment.errorCode = err.atmos?.code || null;
        payment.errorMessage = err.atmos?.description || err.message;
        await payment.save();
        throw err;
      }
      payment.cardPan = bound.pan || null;
      payment.raw = { ...(payment.raw || {}), bindConfirm: bound.raw, charge: result.raw };
    } else {
      // ── Oddiy oqim: karta+OTP bilan bir martalik to'lov ──
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
      payment.cardPan = result.card_id || null;
      payment.raw = { ...(payment.raw || {}), apply: result.raw };
    }

    payment.status = 'paid';
    payment.paidAt = new Date();
    payment.atmosSuccessTransId = result.success_trans_id;
    payment.ofdUrl = result.ofd_url || null;
    payment.errorCode = null;
    payment.errorMessage = null;
    await payment.save();

    await activateSubscription(payment.user, payment.plan);

    res.json({
      paymentId: payment._id,
      status: 'paid',
      plan: payment.plan,
      ofdUrl: payment.ofdUrl,
      saved: Boolean(payment.saveCard),
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

    // MPS kanali (Visa/MC) — 3DS'dan qaytgach yakunlaymiz.
    if (payment.channel === 'mps' && payment.status !== 'paid') {
      await finalizeMpsPayment(payment, req.user);
    }

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

/**
 * GET /api/payments/card — saqlangan karta (maskalangan) + avto-to'lov holati.
 */
export async function getSavedCard(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select('savedCard autoRenew planExpiresAt');
    const sc = user?.savedCard;
    const hasCard = Boolean(sc && sc.pan);
    res.json({
      autoRenew: Boolean(user?.autoRenew),
      planExpiresAt: user?.planExpiresAt || null,
      card: hasCard
        ? { provider: sc.provider, pan: sc.pan, expiry: sc.expiry, holder: sc.holder, boundAt: sc.boundAt }
        : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/payments/card — saqlangan kartani o'chirish + avto-to'lovni o'chirish.
 */
export async function removeSavedCard(req, res, next) {
  try {
    // Token bilan ATMOS tomonida ham o'chiramiz (xato bo'lsa ham davom etamiz).
    const user = await User.findById(req.user._id).select('+savedCard.token savedCard');
    const sc = user?.savedCard;
    if (sc?.token && sc?.cardId) {
      try {
        await atmos.removeCard({ id: sc.cardId, token: sc.token });
      } catch (e) {
        console.warn('[payment] ATMOS removeCard xato:', e.message);
      }
    }
    await User.findByIdAndUpdate(req.user._id, {
      autoRenew: false,
      renewFailCount: 0,
      savedCard: { provider: null, token: null, cardId: null, pan: null, expiry: null, holder: null, boundAt: null },
    });
    res.json({ ok: true, message: 'Karta o\'chirildi, avto-to\'lov o\'chirildi' });
  } catch (err) {
    next(err);
  }
}

const autoRenewSchema = z.object({ enabled: z.boolean() });

/**
 * PATCH /api/payments/auto-renew   { enabled }
 * Avto-to'lovni yoqish/o'chirish. Yoqish faqat saqlangan karta bo'lsa mumkin.
 */
export async function setAutoRenew(req, res, next) {
  try {
    const { enabled } = autoRenewSchema.parse(req.body);
    const user = await User.findById(req.user._id).select('savedCard autoRenew');
    if (enabled && !(user?.savedCard && user.savedCard.pan)) {
      return res.status(400).json({ error: 'Avval kartani saqlang — keyin avto-to\'lovni yoqing' });
    }
    user.autoRenew = enabled;
    if (enabled) user.renewFailCount = 0;
    await user.save();
    res.json({ ok: true, autoRenew: user.autoRenew });
  } catch (err) {
    handleErr(err, next);
  }
}

// ─── Yordamchi funksiyalar ───────────────────────────────────────────

// Karta PAN prefiksidan to'lov tizimini aniqlash.
function detectCardProvider(pan) {
  const d = String(pan || '').replace(/\D/g, '');
  if (d.startsWith('9860')) return 'humo';
  if (d.startsWith('8600')) return 'uzcard';
  if (d.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(d) || /^2[2-7]/.test(d)) return 'mastercard';
  return 'card';
}

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
export async function activateSubscription(userId, plan) {
  const cfg = getPlan(plan);
  const user = await User.findById(userId);
  if (!user) return;

  // Joriy obuna hali tugamagan bo'lsa, ustiga qo'shamiz; aks holda bugundan.
  const base =
    user.planExpiresAt && user.planExpiresAt > new Date() ? new Date(user.planExpiresAt) : new Date();
  base.setDate(base.getDate() + (cfg.durationDays || 30));

  // pro_yearly kabi variantlar ham User.plan'da 'pro' bo'lib saqlanadi
  // (User enumini kengaytirmaslik uchun) — farqi faqat muddatda.
  user.plan = cfg.userPlan || plan;
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
