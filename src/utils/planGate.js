import { planLimits, planAllows } from '../config/plans.js';

/**
 * Tarif (obuna) cheklovlarini tekshirish yordamchilari.
 * Admin (role='admin') barcha cheklovlardan ozod.
 */

// Foydalanuvchi biror funksiyaga (hotelService, ai, otaAll, reviewsReply)
// ruxsatga egami? Admin doim true.
export function userAllows(user, feature) {
  if (user?.role === 'admin') return true;
  return planAllows(user?.plan, feature);
}

// Sonli cheklov (maxCompetitors, maxHotels, maxTv). 0 = cheksiz.
// Admin uchun 0 (cheksiz) qaytadi.
export function userLimit(user, key) {
  if (user?.role === 'admin') return 0;
  return planLimits(user?.plan)[key] ?? 0;
}

// Funksiya ruxsati yo'q bo'lsa 403 xato tashlaydi (controller ichida try/catch tutadi).
export function assertFeature(user, feature, message) {
  if (!userAllows(user, feature)) {
    const e = new Error(message || 'Bu funksiya tarifingizda mavjud emas — tarifni ko\'taring.');
    e.status = 403;
    e.code = 'PLAN_FEATURE_REQUIRED';
    throw e;
  }
}

// Express middleware — funksiya ruxsatini talab qiladi (requireAuth'dan KEYIN).
export function requireFeature(feature, message) {
  return (req, res, next) => {
    if (userAllows(req.user, feature)) return next();
    res.status(403).json({
      error: message || 'Bu funksiya tarifingizda mavjud emas — tarifni ko\'taring.',
      code: 'PLAN_FEATURE_REQUIRED',
    });
  };
}

// Sonli limitdan oshib ketmaslikni tekshiradi (current — hozirgi son).
// limit 0 (cheksiz) bo'lsa hech qachon bloklamaydi.
export function assertLimit(user, key, current, message) {
  const limit = userLimit(user, key);
  if (limit > 0 && current >= limit) {
    const e = new Error(message || `Tarif chegarasi: ${limit} tadan ko'p qo'shib bo'lmaydi. Tarifni ko'taring.`);
    e.status = 403;
    e.code = 'PLAN_LIMIT_REACHED';
    e.limit = limit;
    throw e;
  }
}
