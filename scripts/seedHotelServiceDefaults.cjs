/**
 * Bir martalik tuzatish: barcha mavjud mehmonxonalarga yetishmayotgan
 * 4 ta default xizmatni qo'shadi (nomi bo'yicha). Yangi mehmonxonalar
 * uchun bu avtomatik verifySSO ichida bo'ladi — bu skript faqat eski
 * yozuvlarni to'g'rilash uchun.
 *
 * Ishga tushirish (backend papkasidan):
 *   node scripts/seedHotelServiceDefaults.cjs
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");

const DEFAULT_SERVICES = [
  { name: "Room service", icon: "🍽" },
  { name: "Kir yuvish", icon: "🧺" },
  { name: "Tozalash", icon: "🧹" },
  { name: "Texnik yordam", icon: "🔧" },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Hotel = require("../src/hotelService/models/Hotel");
  const Service = require("../src/hotelService/models/Service");

  const hotels = await Hotel.find();
  for (const h of hotels) {
    const existing = await Service.find({ hotel_id: h.hotel_id }).select("name").lean();
    const have = new Set(existing.map((s) => (s.name || "").trim().toLowerCase()));
    const toAdd = DEFAULT_SERVICES.filter((s) => !have.has(s.name.toLowerCase()));
    if (toAdd.length) {
      await Service.create(toAdd.map((s) => ({ ...s, hotel_id: h.hotel_id })));
    }
    if (!h.defaults_seeded) {
      h.defaults_seeded = true;
      await h.save();
    }
    console.log(`• ${h.hotel_name} (${h.hotel_id}): +${toAdd.length} xizmat`);
  }

  console.log(`✅ Tayyor — ${hotels.length} ta mehmonxona tekshirildi`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Xato:", err.message);
  process.exit(1);
});
