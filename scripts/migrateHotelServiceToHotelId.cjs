/**
 * Bir martalik migratsiya: Mehmonxona-xizmati ma'lumotlari ilgari
 * user._id ga bog'langan edi. Endi hotel._id ga bog'langan — shuning uchun
 * eski makonlarni (user._id) tegishli mehmonxona (hotel._id) makoniga ko'chiramiz.
 *
 * Har bir eski hs_hotels yozuvi uchun:
 *   • OLD  = hotel_id (user._id)
 *   • TARGET = o'sha user egalik qiladigan, nomi mos mehmonxona _id
 * Avval TARGET'dagi yangi avto-yaratilgan (4 default) ma'lumot tozalanadi,
 * keyin OLD → TARGET ko'chiriladi. QR kodlar tozalanadi (qayta yaratish oson,
 * eski rasm ichidagi URL eskirgan bo'ladi).
 *
 * Ishga tushirish (backend papkadan):  node scripts/migrateHotelServiceToHotelId.cjs
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const hotels = await db.collection("hotels").find({}).project({ name: 1, userId: 1 }).toArray();
  const hotelIdSet = new Set(hotels.map((h) => String(h._id)));

  const hsHotels = await db.collection("hs_hotels").find({}).toArray();

  let migrated = 0;
  for (const hs of hsHotels) {
    const OLD = String(hs.hotel_id);
    // Allaqachon hotel._id ga bog'langan bo'lsa — to'g'ri makon, tegmaymiz.
    if (hotelIdSet.has(OLD)) continue;

    // OLD = user._id deb taxmin qilamiz. Shu user egalik qiladigan, nomi mos hotel.
    const owned = hotels.filter((h) => String(h.userId) === OLD);
    if (!owned.length) {
      console.log(`⚠️  ${hs.hotel_name} (${OLD}): mos egasi topilmadi — o'tkazib yuborildi`);
      continue;
    }
    const target =
      owned.find((h) => (h.name || "").trim() === (hs.hotel_name || "").trim()) || owned[0];
    const TARGET = String(target._id);
    if (TARGET === OLD) continue;

    // 1. TARGET'dagi yangi avto-yaratilgan ma'lumotni o'chiramiz (dublikat bo'lmasin)
    await db.collection("hs_services").deleteMany({ hotel_id: TARGET });
    await db.collection("hs_staff").deleteMany({ hotel_id: TARGET });
    await db.collection("hs_requests").deleteMany({ hotel_id: TARGET });
    await db.collection("hs_hotels").deleteMany({ hotel_id: TARGET });

    // 2. QR kodlarni tozalaymiz (OLD va TARGET) — qayta yaratiladi
    await db.collection("hs_room_qrcodes").deleteMany({ hotel_id: { $in: [OLD, TARGET] } });

    // 3. OLD → TARGET ko'chiramiz
    for (const col of ["hs_hotels", "hs_services", "hs_staff", "hs_requests"]) {
      const r = await db.collection(col).updateMany({ hotel_id: OLD }, { $set: { hotel_id: TARGET } });
      if (r.modifiedCount) console.log(`   ${col}: ${r.modifiedCount} ta ko'chirildi`);
    }

    console.log(`✅ ${hs.hotel_name}: ${OLD} → ${TARGET}`);
    migrated += 1;
  }

  console.log(`\nTayyor — ${migrated} ta makon ko'chirildi.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Xato:", err.message);
  process.exit(1);
});
