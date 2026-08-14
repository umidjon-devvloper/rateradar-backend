// ════════════════════════════════════════════════════════════════════
// NARX TAVSIYASI QOIDALARI — AI javobini tekshiruvdan o'tkazuvchi qatlam
//
// NEGA KERAK: Gemini prompt'ida "bozor signalini hisobga ol" va "keskin
// sakrash qilma" deb yozilgan. Lekin prompt — bu ILTIMOS, kafolat emas.
// Amalda model 12 kanalning hammasiga "raise" qaytardi, shu jumladan
// currentPrice = 0 bo'lganlarga ham (noma'lum narxdan "ko'tarish").
//
// Shuning uchun qaror MODELDA emas, SHU YERDA — oddiy, o'qiladigan, sinovdan
// o'tkaziladigan kodda qabul qilinadi. AI faqat taklif beradi; qabul qilish
// yoki rad etish — shu modulning ishi.
//
// Bu modul I/O qilmaydi (baza yo'q, tarmoq yo'q) — shuning uchun uni to'liq
// birlik testlari bilan qoplash mumkin.
// ════════════════════════════════════════════════════════════════════
import { CHANNEL_TYPES, channelType } from '../config/channels.js';

export const ACTIONS = {
  RAISE: 'raise',            // ko'tarish
  LOWER: 'lower',            // tushirish
  KEEP: 'keep',              // saqlash
  HOLD: 'hold',              // kutish — signal ko'tarishga qarshi
  NO_DATA: 'no_data',        // taqqoslash bazasi yo'q
  LOW_CONFIDENCE: 'low_confidence', // ma'lumot juda kam
  MONITOR_ONLY: 'monitor_only',     // bu kanalda narx belgilay olmaysiz
};

// To'lish darajasi ko'tarishga qanday ta'sir qiladi.
//   low  (<40%)  — bo'sh xona ko'p. Raqiblar qimmat bo'lsa ham ko'tarmaymiz:
//                  bo'sh xona sotilmagan xona, qimmat bo'sh xona esa ikki
//                  barobar yo'qotish. Bu revenue management asosi.
//   mid  (40-70%) — bozorga ergashamiz.
//   high (>70%)  — ko'tarish o'rinli, talab bor.
const OCCUPANCY_RULES = {
  low: { allowRaise: false, allowLower: true },
  mid: { allowRaise: true, allowLower: true },
  high: { allowRaise: true, allowLower: true },
};

// Shu sondan kam raqib nuqtasi bo'lsa — tavsiya berilmaydi. 2 ta raqib narxi
// "bozor" degani emas; median statistik ma'noga ega bo'lishi uchun minimum 3.
export const MIN_COMPETITOR_POINTS = 3;
// Shu sondan ko'p bo'lsa ishonch "yuqori" bo'la oladi.
const HIGH_CONFIDENCE_POINTS = 5;
// Bir qadamda ruxsat etilgan maksimal o'zgarish. Undan katta farq kerak bo'lsa
// bosqichma-bosqich boriladi (har hafta yangi ma'lumot bilan qayta baholanadi).
export const MAX_STEP_PCT = 15;

const MSG = {
  no_data: {
    uz: (m) => `Bu kanalda sizning narxingiz yig'ilmagan — taqqoslash bazasi yo'q. Bozor medianasi $${m}.`,
    ru: (m) => `Ваша цена на этом канале не собрана — не с чем сравнивать. Медиана рынка $${m}.`,
    en: (m) => `Your price on this channel hasn't been collected — nothing to compare against. Market median $${m}.`,
  },
  low_confidence: {
    uz: (n) => `Atigi ${n} ta raqib narxi ma'lum — tavsiya berish uchun kam. Ma'lumot yig'ilmoqda.`,
    ru: (n) => `Известны цены лишь ${n} конкурентов — мало для рекомендации. Данные собираются.`,
    en: (n) => `Only ${n} competitor prices known — too few for a recommendation. Still collecting.`,
  },
  hold: {
    uz: (names) => `Bozor tinch — narxni faqat ${names} ko'tardi. Bu ularning shaxsiy holati (to'lgan yoki guruh bron) bo'lishi mumkin; ko'r-ko'rona takrorlamang.`,
    ru: (names) => `Рынок спокоен — цену подняли только ${names}. Это может быть их частный случай (заполнены или групповая бронь); не копируйте вслепую.`,
    en: (names) => `Market is flat — only ${names} raised prices. That may be their own situation (sold out or a group booking); don't copy it blindly.`,
  },
  hold_occupancy: {
    uz: () => 'Kelasi hafta to\'lish darajangiz 40% dan past — bo\'sh xonalaringiz ko\'p. Raqiblar qimmat bo\'lsa ham narxni ko\'tarish sotuvni yanada sekinlashtiradi.',
    ru: () => 'Ваша заполняемость на следующую неделю ниже 40% — много свободных номеров. Даже если конкуренты дороже, повышение цены ещё сильнее замедлит продажи.',
    en: () => 'Your occupancy for next week is below 40% — you have plenty of empty rooms. Even if competitors are pricier, raising your rate will slow sales further.',
  },
  monitor_wholesaler: {
    uz: () => 'Bu qayta sotuvchi (wholesaler) — narxni Booking/Expedia\'dan olib qayta sotadi, siz bu yerda narx belgilay olmaysiz. Faqat kuzatiladi: bu yerdagi past narx parity buzilishini ko\'rsatadi.',
    ru: () => 'Это перекупщик (wholesaler) — берёт цену с Booking/Expedia и перепродаёт, вы не устанавливаете здесь цену. Только мониторинг: низкая цена тут указывает на нарушение паритета.',
    en: () => 'This is a wholesaler — it resells rates sourced from Booking/Expedia, so you cannot set a price here. Monitoring only: a low price here signals a parity breach.',
  },
  clamped: {
    uz: ({ target, step, pct, aiReason }) =>
      `${aiReason ? `${aiReason} ` : ''}Bozor $${target} ni ko'tarmoqda (${pct > 0 ? '+' : ''}${pct}%), lekin bir qadamda ${MAX_STEP_PCT}% dan ko'p o'zgartirish tavsiya etilmaydi — talab qanday javob berishini bilmaymiz. Bu hafta $${step} qiling, keyingi hafta yangi ma'lumot bilan qayta baholanadi.`,
    ru: ({ target, step, pct, aiReason }) =>
      `${aiReason ? `${aiReason} ` : ''}Рынок допускает $${target} (${pct > 0 ? '+' : ''}${pct}%), но менять цену больше чем на ${MAX_STEP_PCT}% за один шаг не стоит — неизвестно, как отреагирует спрос. На этой неделе поставьте $${step}, через неделю пересчитаем.`,
    en: ({ target, step, pct, aiReason }) =>
      `${aiReason ? `${aiReason} ` : ''}The market supports $${target} (${pct > 0 ? '+' : ''}${pct}%), but moving more than ${MAX_STEP_PCT}% in one step is risky — we don't yet know how demand responds. Set $${step} this week; we'll re-evaluate with fresh data next week.`,
  },
  monitor_metasearch: {
    uz: () => 'Bu metaqidiruv — o\'z narxi yo\'q, boshqa saytlarnikini ko\'rsatadi. Narxni shu yerda emas, manba OTA\'da o\'zgartirasiz.',
    ru: () => 'Это метапоиск — у него нет своих цен, он показывает цены других сайтов. Цену меняют в исходной OTA, а не здесь.',
    en: () => 'This is a metasearch site — it has no rates of its own, it displays other sites\' prices. You change the price at the source OTA, not here.',
  },
};

function t(key, lang, arg) {
  const pack = MSG[key];
  return (pack[lang] || pack.uz)(arg);
}

/**
 * Narx o'zgarishini bir qadamda ±MAX_STEP_PCT bilan cheklaydi.
 *
 * Maqsad narxni bekor qilmaydi — unga bosqichma-bosqich boriladi. Keyingi
 * hafta yangi ma'lumot bilan qayta hisoblanadi va agar maqsad hali ham
 * o'rinli bo'lsa, yana bir qadam tashlanadi.
 *
 * @returns {{price:number, clamped:boolean, originalPct:number}}
 */
export function clampStep(currentPrice, suggestedPrice, maxPct = MAX_STEP_PCT) {
  if (!(currentPrice > 0) || !(suggestedPrice > 0)) {
    return { price: suggestedPrice, clamped: false, originalPct: 0 };
  }
  const pct = ((suggestedPrice - currentPrice) / currentPrice) * 100;
  if (Math.abs(pct) <= maxPct) {
    return { price: suggestedPrice, clamped: false, originalPct: Math.round(pct) };
  }
  const bound = currentPrice * (1 + (pct > 0 ? maxPct : -maxPct) / 100);
  // Yaxlitlash chegaradan chiqib ketmasin: ko'tarishda pastga, tushirishda yuqoriga.
  const price = pct > 0 ? Math.floor(bound) : Math.ceil(bound);
  return { price, clamped: true, originalPct: Math.round(pct) };
}

/**
 * Ishonch darajasi — foydalanuvchi tavsiyaga qanchalik tayanishi mumkin.
 *
 * `hasOccupancy` — o'z to'lish darajangiz ma'lummi. Usiz tavsiya HECH QACHON
 * "yuqori" ishonch olmaydi, chunki occupancy'siz bu raqiblar medianasi, RMS
 * emas. Bu ataylab: mahsulot o'z cheklovini yashirmasin.
 */
export function computeConfidence({ competitorPoints, hasCurrentPrice, hasOccupancy = false }) {
  if (!hasCurrentPrice || competitorPoints < MIN_COMPETITOR_POINTS) return 'low';
  if (competitorPoints >= HIGH_CONFIDENCE_POINTS && hasOccupancy) return 'high';
  return 'medium';
}

/**
 * Bozor signali "ko'tarishga qarshi"mi?
 *
 * `/prices/signals` allaqachon to'g'ri javob beradi: "faqat 3 raqib ko'tardi,
 * bozor tinch → bu ularning shaxsiy holati". Lekin bu maslahat shu paytgacha
 * faqat prompt ichida iltimos sifatida yuborilardi. Endi u QATTIQ shart.
 *
 * @returns {{blocks:boolean, names:string}}
 */
export function signalBlocksRaise(signal) {
  const movements = signal?.movements;
  if (!movements) return { blocks: false, names: '' };
  const individual = movements.individual || [];
  // Bozor ko'tarmagan + ayrim raqiblar ko'targan = shaxsiy harakat.
  if (movements.market?.rising) return { blocks: false, names: '' };
  if (!individual.length) return { blocks: false, names: '' };
  const names = individual.slice(0, 3).map((m) => m.name).filter(Boolean).join(', ');
  return { blocks: Boolean(names), names };
}

/**
 * Bitta kanal uchun yakuniy qaror.
 *
 * @param {object}  p
 * @param {number}  p.currentPrice       o'z narxingiz shu kanalda (0 = noma'lum)
 * @param {number}  p.aiSuggestedPrice   AI taklifi
 * @param {string}  p.aiAction           AI harakati
 * @param {string}  p.aiReason           AI izohi
 * @param {object}  p.stats              { min, max, median, rank, total }
 * @param {object}  p.signal             getPriceSignals() natijasi
 * @param {string}  p.lang
 * @returns {{action, suggestedPrice, delta, confidence, reason, guard, marketReference}}
 */
export function decideChannelAdvice({
  channel = '',
  currentPrice = 0,
  aiSuggestedPrice = 0,
  aiAction = '',
  aiReason = '',
  stats = {},
  signal = null,
  occupancyBand = null,   // 'low' | 'mid' | 'high' | null (hisobot yo'q)
  lang = 'uz',
}) {
  const median = Number(stats.median) || 0;
  // `stats.total` ichida o'z narximiz ham bor — sof raqib nuqtalarini ajratamiz.
  const competitorPoints = Math.max(0, (Number(stats.total) || 0) - (currentPrice > 0 ? 1 : 0));
  const hasCurrentPrice = currentPrice > 0;
  const suggested = Number(aiSuggestedPrice) > 0 ? Math.round(aiSuggestedPrice) : 0;
  const confidence = computeConfidence({
    competitorPoints,
    hasCurrentPrice,
    hasOccupancy: Boolean(occupancyBand),
  });

  const chType = channelType(channel);
  // `source` — matn qayerdan keldi. Darvoza holatlarida u HAR DOIM qoidadan,
  // ya'ni uni "AI tavsiyasi" deb atash noto'g'ri bo'lardi. UI shu maydonni
  // o'qib har qatorni halol belgilaydi.
  const base = {
    confidence, marketReference: median || null, occupancyBand,
    channelType: chType, source: 'rules',
  };

  // ── 0. BOSHQARIB BO'LMAYDIGAN KANAL ──────────────────────────────────
  // Eng birinchi darvoza: bu kanalda narx belgilay olmasangiz, qolgan hamma
  // hisob-kitob ma'nosiz. Ilgari tizim wholesaler'larga ham "Ko'tarish" derdi —
  // 12 tavsiyaning ~8 tasi shunday bajarib bo'lmaydigan edi.
  if (chType === CHANNEL_TYPES.WHOLESALER || chType === CHANNEL_TYPES.METASEARCH) {
    return {
      ...base,
      action: ACTIONS.MONITOR_ONLY,
      suggestedPrice: 0,
      delta: null,
      reason: t(chType === CHANNEL_TYPES.WHOLESALER ? 'monitor_wholesaler' : 'monitor_metasearch', lang),
      guard: 'not_controllable',
    };
  }

  // ── 1. Taqqoslash bazasi yo'q ────────────────────────────────────────
  // Noma'lum narxdan "ko'tarish" mumkin emas. `delta` HAM ko'rsatilmaydi:
  // `0` foydalanuvchiga "o'zgarish yo'q" degan NOTO'G'RI ma'no beradi.
  if (!hasCurrentPrice) {
    return {
      ...base,
      action: ACTIONS.NO_DATA,
      suggestedPrice: 0,
      delta: null,
      reason: t('no_data', lang, median || '—'),
      guard: 'no_current_price',
    };
  }

  // ── 2. Raqib nuqtalari juda kam ──────────────────────────────────────
  if (competitorPoints < MIN_COMPETITOR_POINTS) {
    return {
      ...base,
      action: ACTIONS.LOW_CONFIDENCE,
      suggestedPrice: 0,
      delta: null,
      reason: t('low_confidence', lang, competitorPoints),
      guard: 'insufficient_competitors',
    };
  }

  // ── 3. AI harakatini narxlar bilan tekshirish ────────────────────────
  // AI "raise" desa-yu taklifi joriy narxdan past bo'lsa — raqamga ishonamiz.
  let action = [ACTIONS.RAISE, ACTIONS.LOWER, ACTIONS.KEEP].includes(aiAction) ? aiAction : ACTIONS.KEEP;
  if (suggested > 0) {
    const implied = suggested > currentPrice ? ACTIONS.RAISE
      : suggested < currentPrice ? ACTIONS.LOWER
      : ACTIONS.KEEP;
    if (implied !== action) action = implied;
  } else {
    action = ACTIONS.KEEP;
  }

  // ── 4. TO'LISH DARAJASI darvozasi ────────────────────────────────────
  // Eng muhim darvoza va u boshqa hammasidan OLDIN keladi: bo'sh xonalaringiz
  // ko'p bo'lsa, raqiblar nima qilayotgani ahamiyatsiz. Bu mahsulotni "narx
  // kuzatuvchi"dan revenue management vositasiga aylantiradigan qoida.
  if (action === ACTIONS.RAISE && occupancyBand) {
    const rule = OCCUPANCY_RULES[occupancyBand];
    if (rule && !rule.allowRaise) {
      return {
        ...base,
        action: ACTIONS.HOLD,
        suggestedPrice: 0,
        delta: null,
        reason: t('hold_occupancy', lang),
        guard: 'low_occupancy',
      };
    }
  }

  // ── 5. Bozor signali darvozasi ───────────────────────────────────────
  // Mahsulotning o'zi bilan ziddiyati aynan shu yerda tugaydi: `/prices/signals`
  // "ko'r-ko'rona takrorlamang" deganda, `/ai/ota-advice` endi "Ko'tarish"
  // deya olmaydi.
  if (action === ACTIONS.RAISE) {
    const gate = signalBlocksRaise(signal);
    if (gate.blocks) {
      return {
        ...base,
        action: ACTIONS.HOLD,
        suggestedPrice: 0,
        delta: null,
        reason: t('hold', lang, gate.names),
        guard: 'individual_movement',
      };
    }
  }

  // ── 6. QADAM CHEGARASI (±15%) ────────────────────────────────────────
  // Auditda topilgan holat: $56 → $78 (+39%). Bunday sakrash raqiblar
  // medianasiga asoslangan, lekin booking pace, lead time va mavsumiylik
  // hisobga olinmagan. Mehmonxona narxni ko'tarib bo'sh qolsa — aybni
  // mahsulotga qo'yadi va ketadi.
  //
  // Yechim maqsadni bekor qilish emas, unga BOSQICHMA-BOSQICH borish:
  // bu hafta +15%, keyingi hafta yangi ma'lumot bilan qayta baholanadi.
  const capped = clampStep(currentPrice, suggested);
  if (capped.clamped) {
    return {
      ...base,
      action,
      suggestedPrice: capped.price,
      delta: capped.price - currentPrice,
      reason: t('clamped', lang, {
        target: suggested,
        step: capped.price,
        pct: capped.originalPct,
        aiReason: aiReason || '',
      }),
      guard: 'step_capped',
      targetPrice: suggested,   // AI aslida nimani taklif qilgani (shaffoflik)
      source: aiReason ? 'ai' : 'rules',
    };
  }

  return {
    ...base,
    action,
    suggestedPrice: suggested,
    delta: suggested > 0 ? suggested - currentPrice : null,
    reason: aiReason || '',
    guard: null,
    source: aiReason ? 'ai' : 'rules',
  };
}

/**
 * Kanal ro'yxatini to'liq qayta baholaydi + yig'ma statistika qaytaradi
 * (nechta kanalga haqiqatan tavsiya berildi — UI'da halol ko'rsatish uchun).
 */
export function applyAdviceRules(channels, { signal = null, occupancyBand = null, lang = 'uz' } = {}) {
  const decided = channels.map((c) => {
    const d = decideChannelAdvice({
      channel: c.channel,
      currentPrice: c.currentPrice,
      aiSuggestedPrice: c.suggestedPrice,
      aiAction: c.action,
      aiReason: c.reason,
      stats: c.stats,
      signal,
      occupancyBand,
      lang,
    });
    return { ...c, ...d };
  });

  const actionable = decided.filter((c) =>
    [ACTIONS.RAISE, ACTIONS.LOWER, ACTIONS.KEEP].includes(c.action)).length;

  return {
    channels: decided,
    coverage: {
      total: decided.length,
      actionable,
      noData: decided.filter((c) => c.action === ACTIONS.NO_DATA).length,
      lowConfidence: decided.filter((c) => c.action === ACTIONS.LOW_CONFIDENCE).length,
      held: decided.filter((c) => c.action === ACTIONS.HOLD).length,
      // Boshqarib bo'lmaydigan kanallar — ular "tavsiya berilmadi" emas,
      // "tavsiya berilishi MUMKIN emas". UI buni farqlashi kerak.
      monitorOnly: decided.filter((c) => c.action === ACTIONS.MONITOR_ONLY).length,
      // UI shuni o'qib "to'lish darajangizni kiriting" taklifini ko'rsatadi.
      hasOccupancy: Boolean(occupancyBand),
      occupancyBand,
    },
  };
}
