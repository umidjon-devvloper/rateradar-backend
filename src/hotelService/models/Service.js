const mongoose = require("mongoose");
const { nanoid } = require("nanoid");

const subOptionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  translations: { type: Map, of: String, default: {} },
}, { _id: true });

// Xizmat ichidagi mahsulotlar (menyu) — masalan "Ovqat" xizmati ichida
// taomlar, "Ichimliklar" ichida ichimliklar. Rasm va narx bilan.
const itemSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  price:     { type: Number, default: 0 },      // 0 = narx ko'rsatilmaydi
  image_url: { type: String, default: "" },      // /uploads/hs/... yoki tashqi URL
  is_active: { type: Boolean, default: true },
  translations: { type: Map, of: String, default: {} },
}, { _id: true });

const serviceSchema = new mongoose.Schema({
  hotel_id:  { type: String, required: true, index: true },
  name:      { type: String, required: true },
  icon:      { type: String, default: "🛎" },
  color:     { type: String, default: "#2563eb" },
  is_active: { type: Boolean, default: true },

  // Xodim shu xizmat uchun ro'yxatdan o'tishi uchun unikal kod
  // Bot: /start svc_XXXXXXXXXXXX
  invite_code: {
    type: String,
    unique: true,
    sparse: true,
    index: true,
    default: () => `svc_${nanoid(12)}`,
  },

  // Tarjima keshi: { 'en': '...', 'fr': '...' }
  translations: { type: Map, of: String, default: {} },

  sub_options: [subOptionSchema],
  items:       [itemSchema],
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("HsService", serviceSchema, "hs_services");
