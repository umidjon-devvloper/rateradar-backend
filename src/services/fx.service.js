import axios from 'axios';
import FxRate from '../models/FxRate.js';

// ════════════════════════════════════════════════════════════════════
// VALYUTA KONVERSIYASI — O'zbekiston Markaziy banki (cbu.uz)
//
// Bazaviy valyuta — UZS. Barcha metrika so'mda hisoblanadi, chunki
// mijozlarimiz O'zbekistonda va ular narxni so'mda o'ylaydi.
//
// API bepul, kalit talab qilmaydi:
//   https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/2025-02-04/
//
// MB kursi faqat ISH KUNLARIDA e'lon qilinadi. Dam olish kuni yoki
// bayramda so'ralsa API bo'sh qaytaradi — bunday holda eng yaqin
// OLDINGI kunning kursini olamiz (7 kungacha orqaga qaraymiz).
// ════════════════════════════════════════════════════════════════════

const BASE = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json';
const BASE_CURRENCY = 'UZS';
const MAX_LOOKBACK_DAYS = 7;
const DAY_MS = 86400_000;

// Jarayon ichidagi kesh — bitta hisobotda yuzlab tun bir xil kursni
// so'raydi, ularning har biri uchun bazaga bormaymiz.
const memo = new Map(); // "USD:2025-02-04" → number

const dayStart = (d) => {
  const t = new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};
const key = (ccy, date) => `${ccy}:${date.toISOString().slice(0, 10)}`;

/** cbu.uz'dan bitta sanaga kurs. Topilmasa null. */
async function fetchFromCbu(currency, date) {
  const ymd = date.toISOString().slice(0, 10);
  const { data } = await axios.get(`${BASE}/${currency}/${ymd}/`, { timeout: 20_000 });
  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.Rate) return null;
  const rate = Number(row.Rate) / Number(row.Nominal || 1);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * 1 birlik `currency` necha so'm turishini qaytaradi (berilgan sanada).
 * UZS uchun har doim 1.
 *
 * @param {string} currency  ISO kod (USD, EUR, ...)
 * @param {Date|string} when tunash sanasi
 * @returns {Promise<number>} kurs (topilmasa 0)
 */
export async function getRate(currency, when) {
  const ccy = String(currency || '').toUpperCase();
  if (!ccy || ccy === BASE_CURRENCY) return 1;

  const date = dayStart(when);
  const k = key(ccy, date);
  if (memo.has(k)) return memo.get(k);

  const cached = await FxRate.findOne({ currency: ccy, date }).lean();
  if (cached) {
    memo.set(k, cached.rate);
    return cached.rate;
  }

  // Dam olish kunlari uchun orqaga qadam-baqadam qaraymiz.
  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back += 1) {
    const probe = new Date(date.getTime() - back * DAY_MS);
    let rate = null;
    try {
      rate = await fetchFromCbu(ccy, probe);
    } catch {
      // Tarmoq xatosi — keyingi kunga o'tmaymiz, chunki muammo sanada emas.
      break;
    }
    if (rate) {
      // So'ralgan SANA bo'yicha yozamiz (probe emas) — keyingi safar
      // qidiruv takrorlanmasin.
      await FxRate.updateOne(
        { currency: ccy, date },
        { $set: { rate, sourceDate: probe, fetchedAt: new Date() } },
        { upsert: true },
      ).catch(() => {});
      memo.set(k, rate);
      return rate;
    }
  }

  // Kurs topilmadi — 0 qaytaramiz. Chaqiruvchi bunday yozuvni metrikadan
  // CHIQARIB tashlashi kerak, 0 bilan ko'paytirib "tushum yo'q" demasin.
  memo.set(k, 0);
  return 0;
}

/**
 * Summani so'mga o'giradi.
 * @returns {Promise<number|null>} kurs topilmasa null (jimgina 0 emas)
 */
export async function toUzs(amount, currency, when) {
  const a = Number(amount || 0);
  if (!a) return 0;
  const rate = await getRate(currency, when);
  return rate > 0 ? a * rate : null;
}

/** Faqat KESHDAN o'qiydi — tarmoqqa chiqmaydi. Topilmasa 0. */
export function getCachedRate(currency, when) {
  const ccy = String(currency || '').toUpperCase();
  if (!ccy || ccy === BASE_CURRENCY) return 1;
  return memo.get(key(ccy, dayStart(when))) || 0;
}

/**
 * Ko'p sanali hisobot uchun kurslarni oldindan yuklaydi.
 *
 * ⚠️ `fetchMissing` ATAYIN sozlanadi. cbu.uz sekin (so'rov ~2.5 sek) va
 * 18 oylik tarix uchun yuzlab sana kerak. Agar metrika endpointi shuni
 * jonli kutsa, foydalanuvchi dashboardni 15 daqiqa ochib o'tiradi.
 * Shuning uchun:
 *   • METRIKA  → { fetchMissing: false } — faqat keshdan, darhol javob;
 *                topilmagan kunlar hisobdan chiqariladi va `coverage`
 *                maydonida ochiq aytiladi.
 *   • CRON/fon → { fetchMissing: true } — bo'shliqlarni to'ldiradi.
 *
 * @param {Array<{currency:string, date:Date}>} pairs
 * @param {{fetchMissing?:boolean}} [opts]
 */
export async function warmRates(pairs, { fetchMissing = true } = {}) {
  const uniq = new Map();
  for (const p of pairs) {
    const ccy = String(p.currency || '').toUpperCase();
    if (!ccy || ccy === BASE_CURRENCY) continue;
    const d = dayStart(p.date);
    uniq.set(key(ccy, d), { ccy, date: d });
  }
  if (!uniq.size) return { loaded: 0, missing: 0 };

  // Avval bazadan hammasini bittada olamiz.
  const items = [...uniq.values()];
  const cached = await FxRate.find({
    $or: items.map((i) => ({ currency: i.ccy, date: i.date })),
  }).lean();
  cached.forEach((c) => memo.set(key(c.currency, c.date), c.rate));

  const todo = items.filter((i) => !memo.has(key(i.ccy, i.date)));
  if (!fetchMissing) {
    return { loaded: items.length - todo.length, missing: todo.length, total: items.length };
  }

  // Cheklangan parallellik: cbu.uz ommaviy bepul xizmat — uni bosmaymiz,
  // lekin ketma-ket yurish 550 kunlik tarixni ~25 daqiqaga cho'zadi.
  // 4 ta oqim — muvozanat.
  let loaded = 0;
  let missing = 0;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (idx < todo.length) {
      const i = todo[idx];
      idx += 1;
      const r = await getRate(i.ccy, i.date);
      if (r > 0) loaded += 1; else missing += 1;
    }
  }));
  return { loaded: loaded + (items.length - todo.length), missing, total: items.length };
}

/** Testlar va uzoq ishlaydigan jarayonlar uchun. */
export function clearFxMemo() {
  memo.clear();
}
