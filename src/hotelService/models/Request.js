const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema({
  hotel_id:    { type: String, required: true, index: true },
  room_number: { type: String, required: true, trim: true },
  service_id:  { type: mongoose.Schema.Types.ObjectId, ref: "HsService", required: true },

  // Tanlangan ichki variant (mehmon tilida)
  sub_option: { type: String, default: null },
  // Tarjima qilingan variant (mehmonxona tilida)
  sub_option_translated: { type: String, default: null },

  // Mehmon yozgan izoh (original tilda)
  description: { type: String, default: null },
  // Xodimga yuborilgan tarjima (mehmonxona tilida)
  description_translated: { type: String, default: null },

  // Mehmon tanlagan til kodi
  guest_lang: { type: String, default: "en" },

  status: {
    type: String,
    enum: ["pending", "accepted", "completed"],
    default: "pending",
  },

  // { "telegram_id": message_id } — edit uchun
  msg_ids: { type: Map, of: Number, default: {} },

  accepted_by:          { type: Number, default: null },
  is_timeout_notified:  { type: Boolean, default: false },
  // Oxirgi "qabul qilinmadi" eslatmasi yuborilgan vaqt (takror eslatma uchun)
  last_timeout_notified_at: { type: Date, default: null },
  // "Qabul qilindi lekin bajarilmadi" ogohlantirishi yuborilgan vaqt (admin)
  accepted_overdue_notified_at: { type: Date, default: null },

  created_at:   { type: Date, default: Date.now },
  accepted_at:  { type: Date, default: null },
  completed_at: { type: Date, default: null },
});

requestSchema.index({ status: 1, created_at: 1 });
requestSchema.index({ accepted_by: 1 });

module.exports = mongoose.model("HsRequest", requestSchema, "hs_requests");
