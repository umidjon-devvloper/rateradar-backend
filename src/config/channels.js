// ════════════════════════════════════════════════════════════════════
// KANALLAR REGISTRI — qaysi kanalda narxni BOSHQARA OLASIZ, qaysisida yo'q
//
// Muammo: tizim 12+ kanalning HAMMASIGA narx tavsiya qilardi. Lekin
// mehmonxona ularning ko'pchiligida narx belgilay OLMAYDI:
//
//   • Kiwi, Vio.com, ZenHotels, goseek, HomeToGo, Clicktrip, Etrip —
//     bular WHOLESALER/qayta sotuvchi. Narxni Booking/Expedia/Hotelbeds'dan
//     olib qayta sotadi. Mehmonxona bilan to'g'ridan-to'g'ri shartnoma yo'q.
//   • Skyscanner, Trivago, Kayak, Google Hotels — METASEARCH. Ular narx
//     sotmaydi, boshqa saytlarnikini KO'RSATADI.
//
// Ya'ni 12 ta tavsiyaning ~8 tasi texnik jihatdan bajarib bo'lmasdi.
//
// VA MUHIMROG'I: wholesaler'dagi narx OTA narxingizdan sezilarli past bo'lsa —
// bu RATE PARITY BUZILISHI signali. Sizning inventaringiz kimdir tomonidan
// arzonroq sotilmoqda. Booking.com buni aniqlasa reyting pasayadi yoki
// Genius/Preferred dasturidan chiqarasiz. Bu mintaqada hech kim bermayotgan
// signal va u tavsiyadan ko'ra qimmatroq.
// ════════════════════════════════════════════════════════════════════

export const CHANNEL_TYPES = {
  DIRECT: 'direct',          // o'z sayti — narx to'liq sizda
  OTA: 'ota',                // Booking, Agoda, Expedia — shartnoma bor, narx boshqariladi
  METASEARCH: 'metasearch',  // Google, Skyscanner, Trivago — faqat ko'rsatadi
  WHOLESALER: 'wholesaler',  // Vio, ZenHotels, Kiwi — qayta sotadi
  UNKNOWN: 'unknown',
};

// Narx tavsiyasi FAQAT shu turlarga beriladi.
export const CONTROLLABLE = [CHANNEL_TYPES.DIRECT, CHANNEL_TYPES.OTA];

// OTA nomini bir xil kalitga keltirish ("Booking.com" → "bookingcom").
export const channelKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// kalit → { type, display }
const REGISTRY = {
  // ── DIRECT ──
  direct: { type: CHANNEL_TYPES.DIRECT, display: "O'z saytingiz" },
  ownwebsite: { type: CHANNEL_TYPES.DIRECT, display: "O'z saytingiz" },

  // ── OTA (shartnoma bor, narx boshqariladi) ──
  booking: { type: CHANNEL_TYPES.OTA, display: 'Booking.com' },
  bookingcom: { type: CHANNEL_TYPES.OTA, display: 'Booking.com' },
  agoda: { type: CHANNEL_TYPES.OTA, display: 'Agoda' },
  expedia: { type: CHANNEL_TYPES.OTA, display: 'Expedia' },
  hotelscom: { type: CHANNEL_TYPES.OTA, display: 'Hotels.com' },
  tripcom: { type: CHANNEL_TYPES.OTA, display: 'Trip.com' },
  ctrip: { type: CHANNEL_TYPES.OTA, display: 'Trip.com' },
  airbnb: { type: CHANNEL_TYPES.OTA, display: 'Airbnb' },
  ostrovok: { type: CHANNEL_TYPES.OTA, display: 'Ostrovok' },
  mybookinguz: { type: CHANNEL_TYPES.OTA, display: 'MyBooking.uz' },

  // ── METASEARCH (narx sotmaydi, ko'rsatadi) ──
  google: { type: CHANNEL_TYPES.METASEARCH, display: 'Google Hotels' },
  googlehotels: { type: CHANNEL_TYPES.METASEARCH, display: 'Google Hotels' },
  googletravel: { type: CHANNEL_TYPES.METASEARCH, display: 'Google Travel' },
  skyscanner: { type: CHANNEL_TYPES.METASEARCH, display: 'Skyscanner' },
  trivago: { type: CHANNEL_TYPES.METASEARCH, display: 'Trivago' },
  kayak: { type: CHANNEL_TYPES.METASEARCH, display: 'Kayak' },
  wego: { type: CHANNEL_TYPES.METASEARCH, display: 'Wego' },
  momondo: { type: CHANNEL_TYPES.METASEARCH, display: 'Momondo' },
  bluepillow: { type: CHANNEL_TYPES.METASEARCH, display: 'BluePillow' },
  dealbase: { type: CHANNEL_TYPES.METASEARCH, display: 'DealBase' },
  evendo: { type: CHANNEL_TYPES.METASEARCH, display: 'Evendo' },
  traveloka: { type: CHANNEL_TYPES.METASEARCH, display: 'Traveloka' },
  travelokacom: { type: CHANNEL_TYPES.METASEARCH, display: 'Traveloka' },

  // ── WHOLESALER / qayta sotuvchi (parity signali manbai) ──
  viocom: { type: CHANNEL_TYPES.WHOLESALER, display: 'Vio.com' },
  vio: { type: CHANNEL_TYPES.WHOLESALER, display: 'Vio.com' },
  zenhotels: { type: CHANNEL_TYPES.WHOLESALER, display: 'ZenHotels' },
  kiwihotels: { type: CHANNEL_TYPES.WHOLESALER, display: 'Kiwi Hotels' },
  kiwi: { type: CHANNEL_TYPES.WHOLESALER, display: 'Kiwi Hotels' },
  goseek: { type: CHANNEL_TYPES.WHOLESALER, display: 'goseek' },
  goseekcom: { type: CHANNEL_TYPES.WHOLESALER, display: 'goseek' },
  hometogo: { type: CHANNEL_TYPES.WHOLESALER, display: 'HomeToGo' },
  clicktrip: { type: CHANNEL_TYPES.WHOLESALER, display: 'Clicktrip' },
  etrip: { type: CHANNEL_TYPES.WHOLESALER, display: 'Etrip.net' },
  etripnet: { type: CHANNEL_TYPES.WHOLESALER, display: 'Etrip.net' },
  priceline: { type: CHANNEL_TYPES.WHOLESALER, display: 'Priceline' },
  leveltravel: { type: CHANNEL_TYPES.WHOLESALER, display: 'Level.Travel' },
  mvai: { type: CHANNEL_TYPES.WHOLESALER, display: 'MVA' },
  tripeninghotels: { type: CHANNEL_TYPES.WHOLESALER, display: 'Tripening' },
  rayyanhotelbukhara: { type: CHANNEL_TYPES.WHOLESALER, display: 'Rayyan' },
};

/** Kanal turi. Noma'lum kanal — UNKNOWN (tavsiya berilmaydi). */
export function channelType(name) {
  return REGISTRY[channelKey(name)]?.type || CHANNEL_TYPES.UNKNOWN;
}

/** Ko'rsatiladigan nom (registrda bo'lmasa — kelgan nom o'zgarishsiz). */
export function channelDisplay(name) {
  return REGISTRY[channelKey(name)]?.display || name;
}

/** Shu kanalda narx belgilay olasizmi (tavsiya berish mumkinmi)? */
export function isControllable(name) {
  return CONTROLLABLE.includes(channelType(name));
}
