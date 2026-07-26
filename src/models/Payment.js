import mongoose from 'mongoose';

/**
 * To'lov yozuvi — ATMOS orqali obuna (plan) sotib olish operatsiyasi.
 *
 * Holatlar (status):
 *   created     — ATMOS'da chernovik tranzaksiya yaratildi (/merchant/pay/create)
 *   otp_sent    — karta yuborildi, SMS-OTP ketdi (/merchant/pay/pre-apply)
 *   paid        — OTP tasdiqlandi, pul yechildi (/merchant/pay/apply)
 *   failed      — xatolik (rad etildi yoki muddati o'tdi)
 *   reversed    — to'lov bekor qilindi (qaytarildi)
 *
 * `account` — ATMOS sverkasida ishlatiladigan noyob to'lov identifikatori
 * (Callback ham shu account bo'yicha keladi).
 */
const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ['starter', 'pro', 'business', 'starter_yearly', 'pro_yearly', 'business_yearly'],
      required: true,
    },
    amount: { type: Number, required: true }, // tiyinda (1 so'm = 100 tiyin)
    currency: { type: String, default: 'UZS' },

    // To'lov kanali:
    //   card    — saytda karta + SMS-OTP (UzCard/Humo)
    //   invoice — ATMOS to'lov sahifasi (UzCard/Humo/Visa/Mastercard, 3DS)
    //   mps     — o'z formamiz Visa/MC + 3DS (/mps/pay) — karta bog'lanadi (card_id)
    channel: { type: String, enum: ['card', 'invoice', 'mps'], default: 'card' },

    // ATMOS tomoni (mps kanali — Visa/MC)
    mpsTransactionId: { type: Number, default: null, index: true },
    mpsCardId: { type: Number, default: null }, // bog'langan karta (recurring uchun)

    // ATMOS tomoni (card kanali)
    account: { type: String, required: true, unique: true, index: true },
    atmosTransactionId: { type: Number, default: null, index: true },
    atmosSuccessTransId: { type: Number, default: null }, // bekor qilish (reverse) uchun
    cardPan: { type: String, default: null }, // maskalangan, masalan 986009******1840
    ofdUrl: { type: String, default: null }, // fiskal chek havolasi

    // ATMOS tomoni (invoice kanali)
    invoicePaymentId: { type: Number, default: null, index: true }, // checkout payment_id
    invoiceToken: { type: String, default: null },
    checkoutUrl: { type: String, default: null }, // ATMOS to'lov sahifasi havolasi

    // Karta bog'lash (avto-to'lov). saveCard=true bo'lsa bind oqimi ishlaydi:
    // bind-card/init (OTP) → bind-card/confirm (token) → token bilan yechish.
    saveCard: { type: Boolean, default: false },
    bindTransactionId: { type: Number, default: null }, // /partner/bind-card transaction_id
    // Cron avto-yangilashi yaratgan to'lovni belgilaydi (qo'lda emas).
    isRenewal: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['created', 'otp_sent', 'paid', 'failed', 'reversed'],
      default: 'created',
      index: true,
    },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },

    paidAt: { type: Date, default: null },
    // ATMOS xom javoblari (debug/sverka uchun)
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

paymentSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Payment', paymentSchema);
