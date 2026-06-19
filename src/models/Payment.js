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
    plan: { type: String, enum: ['starter', 'pro'], required: true },
    amount: { type: Number, required: true }, // tiyinda (1 so'm = 100 tiyin)
    currency: { type: String, default: 'UZS' },

    // To'lov kanali:
    //   card    — saytda karta + SMS-OTP (UzCard/Humo)
    //   invoice — ATMOS to'lov sahifasi (UzCard/Humo/Visa/Mastercard, 3DS)
    channel: { type: String, enum: ['card', 'invoice'], default: 'card' },

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
