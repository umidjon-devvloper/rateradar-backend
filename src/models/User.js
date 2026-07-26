import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    country: { type: String, default: "" },
    countryCode: { type: String, default: "" },
    city: { type: String, default: "" },
    lang: { type: String, enum: ["uz", "en", "ru"], default: "uz" },
    plan: { type: String, enum: ["free", "starter", "pro", "business"], default: "free" },
    planExpiresAt: { type: Date, default: null },
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotel",
      default: null,
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    onboardingCompleted: { type: Boolean, default: false },

    // ─── Avto-to'lov (recurring) — saqlangan karta bilan oylik yangilash ──
    // Foydalanuvchi to'lov paytida "kartani eslab qol" katakchasini belgilasa
    // yoqiladi. Kunlik cron obunasi tugayotgan autoRenew mijozlarni topib,
    // saqlangan token/card_id orqali OTP'siz yechadi.
    autoRenew: { type: Boolean, default: false },
    savedCard: {
      // 'humo' | 'uzcard' — token orqali (/merchant/pay + card_token)
      // 'visa' | 'mastercard' — cardId orqali (/mps/pay template)
      provider: { type: String, default: null },
      // ATMOS card_token (Humo/UzCard). MAXFIY — select:false, toJSON'da yashiriladi.
      token: { type: String, default: null, select: false },
      cardId: { type: Number, default: null }, // Visa/MC (mps) card_id
      pan: { type: String, default: null },    // maskalangan: 986009******1840
      expiry: { type: String, default: null }, // YYMM
      holder: { type: String, default: null },
      boundAt: { type: Date, default: null },
    },
    // Oxirgi avto-yangilash urinishi (cron holati/monitoring uchun)
    lastRenewAttemptAt: { type: Date, default: null },
    renewFailCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  // Karta tokeni hech qachon tashqariga chiqmaydi.
  if (obj.savedCard) delete obj.savedCard.token;
  return obj;
};

export default mongoose.model("User", userSchema);
