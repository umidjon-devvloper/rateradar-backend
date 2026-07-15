const mongoose = require("mongoose");

// Mehmonxona xonasidagi Android TV qurilmasi.
// Oqim: TV ilova ochilganda /tv/register → pair_code ko'rsatadi → admin panelda
// kodni kiritadi → qurilma hotelga bog'lanadi va doimiy token oladi.
// APK tarqalib ketsa ham foydasiz: kontent faqat token + faol obuna bilan keladi.
const tvDeviceSchema = new mongoose.Schema({
  // Bog'langan mehmonxona (pair qilinmaguncha null)
  hotel_id: { type: String, default: null, index: true },

  // Juftlash kodi — TV ekranida ko'rinadi, 15 daqiqa yashaydi
  pair_code:         { type: String, default: null, index: true },
  pair_code_expires: { type: Date, default: null },

  // TV polling uchun vaqtinchalik kalit (token berilgunga qadar)
  device_key: { type: String, required: true, unique: true },

  // Doimiy kontent tokeni (pair qilingandan keyin)
  token: { type: String, default: null, index: true },

  name:        { type: String, default: "TV" },
  room_number: { type: String, default: "" },

  status: {
    type: String,
    enum: ["unpaired", "active", "revoked"],
    default: "unpaired",
  },

  last_seen:  { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
  paired_at:  { type: Date, default: null },
});

module.exports = mongoose.model("HsTvDevice", tvDeviceSchema, "hs_tv_devices");
