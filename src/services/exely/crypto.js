import crypto from 'crypto';
import { env } from '../../config/env.js';

// ════════════════════════════════════════════════════════════════════
// MIJOZ SECRET'LARINI SHIFRLASH (AES-256-GCM)
//
// Multi-tenant'da har mijozning Exely `client_secret`i bazada yotadi.
// Ochiq saqlash mumkin emas: baza dumpi sizsa — 200 ta mehmonxonaning
// bron ma'lumoti (mehmon ismlari bilan) ochiq qoladi.
//
// GCM tanlandi (CBC emas): u ham shifrlaydi, ham BUZILISHNI aniqlaydi —
// authTag mos kelmasa deshifrlash xato beradi. Ya'ni bazadagi qiymatni
// kimdir qo'lda o'zgartirsa, biz buni bilamiz.
//
// ⚠️ KALIT O'ZGARSA — eski secret'lar O'QILMAYDI. Shuning uchun
// EXELY_ENC_KEY productionda bir marta qo'yiladi va tegilmaydi.
// ════════════════════════════════════════════════════════════════════

const ALGO = 'aes-256-gcm';

// Kalitni bir marta hosil qilamiz (scrypt qimmat — har chaqiruvda emas).
// EXELY_ENC_KEY bo'lmasa JWT_SECRET'dan olinadi: lokalda hech narsa
// sozlamasdan ishlashi uchun. Salt statik — bu yerda uning vazifasi
// tasodifiylik emas, kalitni boshqa maqsaddagi kalitdan ajratish.
let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  const material = env.EXELY_ENC_KEY || env.JWT_SECRET;
  cachedKey = crypto.scryptSync(material, 'rateradar:exely:v1', 32);
  return cachedKey;
}

/** Ochiq matnni "iv:authTag:ciphertext" (hex) ko'rinishida shifrlaydi. */
export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12); // GCM uchun tavsiya etilgan uzunlik
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

/**
 * Shifrni ochadi. Kalit noto'g'ri yoki qiymat buzilgan bo'lsa xato beradi —
 * jimgina bo'sh qaytarmaydi, chunki bu holatda mijozga "ulanish buzilgan,
 * kalitni qayta kiriting" deyish kerak.
 */
export function decryptSecret(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  if (parts.length !== 3) throw new Error('Shifrlangan secret formati noto\'g\'ri');
  const [ivHex, tagHex, dataHex] = parts;
  const d = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  try {
    return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Secret deshifrlanmadi — EXELY_ENC_KEY o\'zgargan bo\'lishi mumkin');
  }
}

/** UI'da ko'rsatish uchun: "hO2O…9svM" (secret hech qachon to'liq chiqmaydi). */
export function maskSecret(plain) {
  const s = String(plain || '');
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
