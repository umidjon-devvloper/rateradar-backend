const mongoose = require("mongoose");
const { nanoid } = require("nanoid");

const hotelSchema = new mongoose.Schema({
  hotel_id: { type: String, required: true, unique: true, index: true },
  hotel_name: { type: String, required: true },

  // Xodimlarga barcha xabarlar shu tilda yuboriladi
  language: { type: String, default: "ru" },

  // Xodimlar ro'yxatdan o'tishi uchun unikal taklif kodi
  // Bot: /start inv_XXXXXX
  invite_code: {
    type: String,
    unique: true,
    default: () => `inv_${nanoid(10)}`,
  },

  // Obuna ma'lumotlari (asosiy tizimdan SSO orqali keladi)
  subscription: {
    active: { type: Boolean, default: true },
    expires_at: { type: Date, default: null },
  },

  // Default 4 xizmat bir marta qo'shilganini belgilaydi (qayta qo'shilmasin)
  defaults_seeded: { type: Boolean, default: false },

  // Telegram GURUH integratsiyasi: bot guruhga qo'shilib, guruhda
  // /ulash inv_XXXX yuborilsa, barcha buyurtmalar shu guruhga ham tushadi.
  group_chat_id: { type: Number, default: null },
  group_title:   { type: String, default: "" },

  // ADMIN shaxsiy Telegram'i: bot bilan shaxsiy chatda /ulash inv_XXXX
  // yuborilsa ulanadi. Unga barcha buyurtmalar + nazorat ogohlantirishlari
  // (5 daqiqada olinmadi / 2.5 soatda bajarilmadi) keladi.
  admin_telegram_id: { type: Number, default: null },
  admin_name:        { type: String, default: "" },

  // Mehmon webapp sahifasi dizayni (admin o'zgartiradi)
  branding: {
    theme:        { type: String, default: "blue" },     // tayyor mavzu kaliti
    template:     { type: String, default: "" },          // tayyor shablon kaliti (bezak)
    primary_color:{ type: String, default: "#2563eb" },  // asosiy rang (hex)
    logo_url:     { type: String, default: "" },          // logo rasm havolasi
    welcome_text: { type: String, default: "" },          // salomlashuv matni
    bg_style:     { type: String, default: "light" },     // light | soft | dark
  },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

hotelSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

// Namespaced model + explicit collection — RateRadar'ning "Hotel" modeli va
// "hotels" kolleksiyasi bilan to'qnashmasligi uchun.
module.exports = mongoose.model("HsHotel", hotelSchema, "hs_hotels");
