import Hotel from '../models/Hotel.js';

/**
 * Aktiv hotel'ni aniqlaydi va req.hotel'ga o'rnatadi.
 *
 *   1) X-Hotel-Id header — frontend localStorage'dan yuboradigan kalit
 *   2) ?hotelId= query — alternativa
 *   3) Fallback — user'ning birinchi hoteli (bitta hotel egasi uchun)
 *
 * Xavfsizlik: tanlangan hotel albatta req.user._id ga tegishli bo'lishi kerak.
 * Aks holda 403 qaytariladi.
 *
 * requireAuth dan keyin ulanishi shart (req.user mavjud bo'lishi uchun).
 */
export async function resolveHotel(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Avtorizatsiya kerak' });

    const requestedId = req.headers['x-hotel-id'] || req.query.hotelId || '';

    let hotel = null;
    if (requestedId) {
      // ObjectId noto'g'ri formatga ega bo'lsa, findOne 500 emas, null qaytaradi
      try {
        hotel = await Hotel.findOne({ _id: requestedId, userId: req.user._id });
      } catch {
        hotel = null;
      }
    }

    // Talab qilingan ID topilmadi (yoki yo'q) — userning birinchi hoteliga
    // tushamiz. Bu eski/eskirgan localStorage qiymatlari uchun ham ishlaydi
    // (masalan, yangi ro'yxatdan o'tgan foydalanuvchi).
    if (!hotel) {
      hotel = await Hotel.findOne({ userId: req.user._id }).sort({ createdAt: 1 });
    }

    req.hotel = hotel; // null bo'lishi mumkin (user'da hech hotel yo'q)
    next();
  } catch (err) {
    next(err);
  }
}
