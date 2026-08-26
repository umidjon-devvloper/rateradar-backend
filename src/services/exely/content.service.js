import { exelyRequest } from './client.js';

// ════════════════════════════════════════════════════════════════════
// CONTENT API — obyekt profili, xona turlari, tarif rejalari
//
// Bu ma'lumot KAM o'zgaradi (xona turi yiliga bir marta qo'shiladi), shuning
// uchun har sinxronizatsiyada emas, ulanishda va sutkada bir marta olinadi.
//
// Nima uchun kerak: occupancy = band xonalar / JAMI xonalar. Maxrajni
// bilmasak foizni hisoblab bo'lmaydi — u shu yerdan keladi.
// ════════════════════════════════════════════════════════════════════

const BASE = '/api/content/v1';

/** Ulanishga tegishli obyektlar ro'yxati (odatda bitta). */
export async function fetchProperties(creds, { count = 100 } = {}) {
  const data = await exelyRequest({
    ...creds,
    path: `${BASE}/properties`,
    query: { count },
  });
  return data?.properties || [];
}

/** Bitta obyektning to'liq tavsifi (xona turlari + tariflar bilan). */
export async function fetchProperty(creds, propertyId, { languageCode = 'en' } = {}) {
  return exelyRequest({
    ...creds,
    path: `${BASE}/properties/${encodeURIComponent(propertyId)}`,
    query: { languageCode },
  });
}

/** Bekor qilish qoidalari — bron riskini baholashda kerak bo'ladi. */
export async function fetchCancellationRules(creds, propertyId) {
  const data = await exelyRequest({
    ...creds,
    path: `${BASE}/properties/${encodeURIComponent(propertyId)}/cancellation-rules`,
  });
  return data?.cancellationRules || [];
}

/**
 * Xona turining nechta jismoniy xonasi borligi.
 *
 * ⚠️ Content API xonalar SONINI bermaydi — u faqat turlar ro'yxati va har
 * turdagi joylar sig'imini (adultBed/extraBed) beradi. Jismoniy xona soni
 * PMS API'da (`/v2/.../rooms`), u esa bu ulanishda yopiq (500).
 *
 * Shuning uchun sig'im hozircha Hotel.rooms (mijoz onboardingda kiritgan
 * umumiy xona soni) dan olinadi. PMS ochilgach shu funksiya almashtiriladi.
 */
export function roomTypeCapacityHint(roomType) {
  const c = roomType?.capacity || {};
  return (c.adultBed || 0) + (c.extraBed || 0);
}

/**
 * Integration.property uchun ixcham ko'rinish. To'liq javobni saqlamaymiz —
 * unda tarif tavsiflari HTML bilan keladi (o'nlab KB), bizga kerak emas.
 */
export function summarizeProperty(p) {
  const addr = p?.contactInfo?.address || {};
  return {
    name: p?.name || '',
    currency: p?.currency || '',
    timeZone: p?.timeZone?.id || '',
    stars: Number(p?.stars || 0),
    cityName: addr.cityName || '',
    countryCode: addr.countryCode || '',
    roomTypeCount: (p?.roomTypes || []).length,
    ratePlanCount: (p?.ratePlans || []).length,
    roomTypes: (p?.roomTypes || []).map((r) => ({
      id: String(r.id),
      name: r.name || '',
      capacity: roomTypeCapacityHint(r),
    })),
    ratePlans: (p?.ratePlans || []).map((r) => ({
      id: String(r.id),
      name: r.name || '',
      currency: r.currency || '',
    })),
    refreshedAt: new Date(),
  };
}
