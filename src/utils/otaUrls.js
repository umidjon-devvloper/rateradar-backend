import Hotel from '../models/Hotel.js';

/**
 * otaUrls'ni tekislaydi (normalizatsiya).
 *
 * Muammo tarixi: Mongo'da `$set: {'otaUrls.Booking.com': url}` qilinsa, nuqta
 * nested path deb olinadi va `{Booking: {com: url}}` buzuq shakl paydo bo'ladi.
 * Bu funksiya ikkala shaklni ham o'qiy oladi.
 *
 * MUHIM: to'g'ri (string) kalitlar buzuq nested qiymatlardan USTUN turadi —
 * aks holda foydalanuvchi qo'lda kiritgan URL eski avto-topilgan nested
 * qiymat bilan qayta yozilib ketardi ("saqlamayapti" bug'ining sababi).
 */
export function normalizeOtaUrls(raw) {
  const src = raw || {};
  const out = {};
  // 1-o'tish: to'g'ri string qiymatlar — ustuvor
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  // 2-o'tish: buzuq nested yozuvlar ({Booking:{com:url}}) — faqat bo'sh joyga
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    for (const [sk, sv] of Object.entries(v)) {
      if (typeof sv === 'string' && sv && out[`${k}.${sk}`] === undefined) {
        out[`${k}.${sk}`] = sv;
      }
    }
  }
  return out;
}

/**
 * Hotelga BITTA OTA URL'ni xavfsiz saqlaydi — dotted-path `$set`
 * ISHLATMAYDI (nested buzilish bo'lmasligi uchun butun otaUrls qayta yoziladi),
 * saqlashdan oldin mavjud yozuvlarni ham tekislab oladi.
 */
export async function saveHotelOtaUrl(hotelId, otaName, url) {
  if (!otaName || !url) return null;
  const doc = await Hotel.findById(hotelId).select('otaUrls').lean();
  const merged = { ...normalizeOtaUrls(doc?.otaUrls), [otaName]: url };
  await Hotel.updateOne({ _id: hotelId }, { $set: { otaUrls: merged } });
  return merged;
}
