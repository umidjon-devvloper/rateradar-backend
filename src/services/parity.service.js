// ════════════════════════════════════════════════════════════════════
// RATE PARITY DETEKTORI
//
// Ilgari tizim wholesaler kanallardagi past narxni ko'rib "narxni ko'taring"
// deb tavsiya berardi — ya'ni bajarib bo'lmaydigan maslahat. Aslida o'sha
// raqam butunlay boshqa narsani anglatadi:
//
//   Sizning OTA narxingiz $96, Vio.com'da esa $75.
//   → Kimdir sizning inventaringizni 22% arzonroq sotmoqda.
//
// Bu RATE PARITY buzilishi. Oqibati mehmonxona uchun jiddiy: Booking.com
// shartnomasida parity bandi bor, buzilish aniqlansa reyting pasayadi yoki
// Genius/Preferred dasturidan chiqariladi. Ko'p mehmonxona buni umuman
// bilmaydi, chunki wholesaler saytlarni hech kim kuzatmaydi.
//
// Mahsulot bu ma'lumotni ALLAQACHON yig'yapti. Uni "tavsiya" o'rniga
// "ogohlantirish" sifatida qadoqlash — mintaqada hech kim bermayotgan qiymat.
// ════════════════════════════════════════════════════════════════════
import { CHANNEL_TYPES, channelType, channelDisplay } from '../config/channels.js';

// Shu foizdan ortiq farq — ogohlantirishga arziydi. Kichik farqlar valyuta
// kursi, soliq/xizmat haqi va yaxlitlashdan ham kelib chiqishi mumkin.
const PARITY_THRESHOLD_PCT = 10;
// Jiddiy buzilish — darhol tekshirish kerak.
const SEVERE_THRESHOLD_PCT = 20;

const MSG = {
  uz: (c, pct, ota, otaPrice, price) =>
    `Inventaringiz ${c} da $${price} ga sotilmoqda — ${ota} dagi narxingizdan ($${otaPrice}) ${pct}% past. Bu rate parity buzilishi bo'lishi mumkin, tekshiring.`,
  ru: (c, pct, ota, otaPrice, price) =>
    `Ваш номер продаётся на ${c} за $${price} — это на ${pct}% ниже вашей цены на ${ota} ($${otaPrice}). Возможно нарушение паритета цен, проверьте.`,
  en: (c, pct, ota, otaPrice, price) =>
    `Your inventory is selling on ${c} at $${price} — ${pct}% below your ${ota} rate ($${otaPrice}). This may be a rate parity breach; worth checking.`,
};

/**
 * Parity buzilishlarini aniqlaydi.
 *
 * Taqqoslash bazasi — sizning ENG ARZON OTA narxingiz. Sabab: parity odatda
 * "hech qayerda mening eng arzon narximdan past bo'lmasin" degani. Agar
 * wholesaler undan ham past bo'lsa — muammo.
 *
 * @param {Array} channels [{channel, currentPrice, ...}] — o'z narxlaringiz
 * @param {string} lang
 * @returns {{breaches: Array, baseline: {channel, price}|null, checked: number}}
 */
export function detectParityBreaches(channels = [], lang = 'uz') {
  // 1. Baza: boshqariladigan (OTA/direct) kanallardagi eng arzon o'z narxingiz.
  const controlled = channels.filter(
    (c) => c.currentPrice > 0
      && [CHANNEL_TYPES.OTA, CHANNEL_TYPES.DIRECT].includes(channelType(c.channel)),
  );
  if (!controlled.length) return { breaches: [], baseline: null, checked: 0 };

  const baseline = controlled.reduce((a, b) => (b.currentPrice < a.currentPrice ? b : a));
  const basePrice = baseline.currentPrice;

  // 2. Wholesaler kanallarda o'z narxingiz bazadan sezilarli pastmi?
  const resellers = channels.filter(
    (c) => c.currentPrice > 0 && channelType(c.channel) === CHANNEL_TYPES.WHOLESALER,
  );

  const breaches = [];
  for (const r of resellers) {
    const diffPct = Math.round(((basePrice - r.currentPrice) / basePrice) * 100);
    if (diffPct < PARITY_THRESHOLD_PCT) continue;

    const display = channelDisplay(r.channel);
    const t = MSG[lang] || MSG.uz;
    breaches.push({
      channel: display,
      price: r.currentPrice,
      baselineChannel: channelDisplay(baseline.channel),
      baselinePrice: basePrice,
      diffPct,
      severity: diffPct >= SEVERE_THRESHOLD_PCT ? 'severe' : 'warning',
      message: t(display, diffPct, channelDisplay(baseline.channel), basePrice, r.currentPrice),
    });
  }

  breaches.sort((a, b) => b.diffPct - a.diffPct);
  return { breaches, baseline: { channel: channelDisplay(baseline.channel), price: basePrice }, checked: resellers.length };
}
