const mongoose = require("mongoose");

// Mehmon mehmonxona haqida qoldirgan sharh (QR sahifasidagi "Sharh" kartasi).
const reviewSchema = new mongoose.Schema({
  hotel_id:    { type: String, required: true, index: true },
  room_number: { type: String, default: null, trim: true },

  // 1..5 yulduz
  rating: { type: Number, min: 1, max: 5, required: true },

  // Mehmon yozgan izoh (original tilda)
  comment: { type: String, default: null },
  // Mehmonxona tiliga tarjima (panelda ko'rsatish uchun)
  comment_translated: { type: String, default: null },

  // Mehmon tanlagan til kodi
  guest_lang: { type: String, default: "en" },

  created_at: { type: Date, default: Date.now },
});

reviewSchema.index({ hotel_id: 1, created_at: -1 });

module.exports = mongoose.model("HsReview", reviewSchema, "hs_reviews");
