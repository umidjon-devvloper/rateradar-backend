const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema({
  hotel_id:           { type: String, required: true, index: true },
  telegram_id:        { type: Number, required: true, unique: true, index: true },
  telegram_username:  { type: String, default: null },
  full_name:          { type: String, required: true },
  phone:              { type: String, required: true },

  // pending  → /start bosdi, admin hali rol bermadi
  // active   → faol, buyurtmalar keladi
  // inactive → vaqtincha to'xtatilgan
  status: {
    type: String,
    enum: ["pending", "active", "inactive"],
    default: "pending",
  },

  service_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "HsService" }],
  created_at:   { type: Date, default: Date.now },
  activated_at: { type: Date, default: null },
});

module.exports = mongoose.model("HsStaff", staffSchema, "hs_staff");
