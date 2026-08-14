// Narx tavsiyasi qoidalari — birlik testlari (node:test, qo'shimcha paketsiz).
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  MAX_STEP_PCT,
  decideChannelAdvice,
  applyAdviceRules,
  signalBlocksRaise,
  computeConfidence,
  clampStep,
} from '../src/services/priceAdvice.rules.js';

// Bozor tinch + ayrim raqiblar ko'targan = shaxsiy harakat.
const SIGNAL_INDIVIDUAL = {
  movements: { market: { rising: false }, individual: [{ name: 'Hotel Bukhara Prestige', changePct: 12 }] },
};
// Bozor birgalikda ko'tarilgan (sezon/talab).
const SIGNAL_MARKET = {
  movements: { market: { rising: true }, individual: [] },
};

const STATS_OK = { min: 75, max: 138, median: 87, rank: 5, total: 5 }; // 4 raqib nuqtasi

test('currentPrice 0 bo\'lsa — "ko\'tarish" emas, "ma\'lumot yo\'q"', () => {
  const d = decideChannelAdvice({
    currentPrice: 0,          // Etrip.net holati: narx noma'lum
    aiSuggestedPrice: 95,
    aiAction: 'raise',        // AI baribir "ko'tarish" degan
    stats: { min: 75, max: 188, median: 87, rank: null, total: 4 },
  });
  assert.equal(d.action, ACTIONS.NO_DATA);
  assert.equal(d.suggestedPrice, 0);
  assert.equal(d.delta, null, 'delta 0 EMAS null bo\'lishi kerak — 0 "o\'zgarish yo\'q" degan yolg\'on ma\'no beradi');
  assert.equal(d.confidence, 'low');
  assert.match(d.reason, /bozor medianasi \$87/i);
});

test('3 tadan kam raqib nuqtasi bo\'lsa — tavsiya berilmaydi', () => {
  const d = decideChannelAdvice({
    currentPrice: 56,
    aiSuggestedPrice: 78,
    aiAction: 'raise',
    stats: { min: 75, max: 90, median: 82, rank: 1, total: 3 }, // 2 raqib
  });
  assert.equal(d.action, ACTIONS.LOW_CONFIDENCE);
  assert.equal(d.delta, null);
  assert.match(d.reason, /2 ta raqib/);
});

test('bozor birgalikda ko\'tarilgan — "ko\'tarish" o\'tadi', () => {
  // Chegara ichidagi taklif (+12.5%) o'zgarishsiz o'tadi.
  const d = decideChannelAdvice({
    currentPrice: 56, aiSuggestedPrice: 63, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_MARKET,
  });
  assert.equal(d.action, ACTIONS.RAISE);
  assert.equal(d.suggestedPrice, 63);
  assert.equal(d.delta, 7);
  assert.equal(d.guard, null, 'chegaraga tegmagan');
});

test('faqat ayrim raqiblar ko\'targan — "ko\'tarish" → "kutish"', () => {
  const d = decideChannelAdvice({
    currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_INDIVIDUAL,
  });
  assert.equal(d.action, ACTIONS.HOLD, 'mahsulot o\'zi bilan ziddiyatga kirmasligi kerak');
  assert.equal(d.guard, 'individual_movement');
  assert.equal(d.delta, null);
  assert.match(d.reason, /Hotel Bukhara Prestige/);
});

test('signal faqat ko\'tarishni bloklaydi — tushirishga to\'sqinlik qilmaydi', () => {
  const d = decideChannelAdvice({
    currentPrice: 120, aiSuggestedPrice: 110, aiAction: 'lower',
    stats: STATS_OK, signal: SIGNAL_INDIVIDUAL,
  });
  assert.equal(d.action, ACTIONS.LOWER, 'shaxsiy harakat signali tushirishni to\'xtatmasin');
  assert.equal(d.delta, -10);
});

test('AI harakati raqamlarga zid bo\'lsa — raqamlar ustun', () => {
  const d = decideChannelAdvice({
    currentPrice: 100, aiSuggestedPrice: 85, aiAction: 'raise', // zid: 85 < 100
    stats: STATS_OK, signal: SIGNAL_MARKET,
  });
  assert.equal(d.action, ACTIONS.LOWER);
});

test('occupancy yo\'q ekan — hech qanday tavsiya "yuqori" ishonch olmaydi', () => {
  assert.equal(computeConfidence({ competitorPoints: 20, hasCurrentPrice: true }), 'medium');
  assert.equal(computeConfidence({ competitorPoints: 20, hasCurrentPrice: true, hasOccupancy: true }), 'high');
  assert.equal(computeConfidence({ competitorPoints: 1, hasCurrentPrice: true }), 'low');
});

// ── T-17: to'lish darajasi darvozasi ──────────────────────────────────
test('to\'lish past — bozor ko\'tarilgan bo\'lsa ham ko\'tarilmaydi', () => {
  const d = decideChannelAdvice({
    currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS_OK,
    signal: SIGNAL_MARKET,      // bozor birgalikda ko'tarilgan
    occupancyBand: 'low',       // ...lekin sizda bo'sh xona ko'p
  });
  assert.equal(d.action, ACTIONS.HOLD, 'bo\'sh xona bozordan ustun turishi kerak');
  assert.equal(d.guard, 'low_occupancy');
  assert.equal(d.delta, null);
  assert.match(d.reason, /40%/);
});

test('to\'lish past bo\'lsa ham TUSHIRISH bloklanmaydi', () => {
  const d = decideChannelAdvice({
    currentPrice: 120, aiSuggestedPrice: 95, aiAction: 'lower',
    stats: STATS_OK, signal: SIGNAL_MARKET, occupancyBand: 'low',
  });
  assert.equal(d.action, ACTIONS.LOWER, 'bo\'sh xonada narx tushirish aynan to\'g\'ri harakat');
});

test('to\'lish yuqori + bozor ko\'tarilgan — ko\'tarish o\'tadi', () => {
  const d = decideChannelAdvice({
    currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_MARKET, occupancyBand: 'high',
  });
  assert.equal(d.action, ACTIONS.RAISE);
  assert.equal(d.occupancyBand, 'high');
});

test('"yuqori" ishonch UCHUN occupancy ham, yetarli raqib ham kerak', () => {
  const rich = { min: 75, max: 138, median: 87, rank: 5, total: 6 }; // 5 raqib nuqtasi
  const base = { currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise', signal: SIGNAL_MARKET };

  // Ikkalasi ham bor → yuqori
  assert.equal(decideChannelAdvice({ ...base, stats: rich, occupancyBand: 'high' }).confidence, 'high');
  // Occupancy bor, lekin raqib kam (4 ta) → o'rta
  assert.equal(decideChannelAdvice({ ...base, stats: STATS_OK, occupancyBand: 'high' }).confidence, 'medium');
  // Raqib yetarli, lekin occupancy yo'q → o'rta
  assert.equal(decideChannelAdvice({ ...base, stats: rich }).confidence, 'medium');
});

test('to\'lish yuqori bo\'lsa ham SIGNAL darvozasi ishlaydi', () => {
  // Ikki darvoza mustaqil: occupancy ruxsat bersa ham, "shaxsiy harakat"
  // signali ko'tarishni to'xtatadi.
  const d = decideChannelAdvice({
    currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_INDIVIDUAL, occupancyBand: 'high',
  });
  assert.equal(d.action, ACTIONS.HOLD);
  assert.equal(d.guard, 'individual_movement');
});

// ── T-19: qadam chegarasi (±15%) ──────────────────────────────────────
test('clampStep — chegara ichidagi o\'zgarish tegilmaydi', () => {
  assert.deepEqual(clampStep(100, 110), { price: 110, clamped: false, originalPct: 10 });
  assert.deepEqual(clampStep(100, 90), { price: 90, clamped: false, originalPct: -10 });
  // Aynan chegara — hali ruxsat.
  assert.equal(clampStep(100, 115).clamped, false);
  assert.equal(clampStep(100, 85).clamped, false);
});

test('clampStep — yaxlitlash HECH QACHON chegaradan chiqmaydi', () => {
  // Ko'tarishda pastga, tushirishda yuqoriga yaxlitlanadi. Aks holda
  // "maksimal 15%" va'dasi 15.4% bo'lib chiqishi mumkin edi.
  for (const cur of [7, 13, 29, 56, 97, 133, 249]) {
    const up = clampStep(cur, cur * 10);
    const down = clampStep(cur, 1);
    assert.ok(up.clamped && down.clamped, `${cur} uchun chegara ishlashi kerak`);
    const upPct = ((up.price - cur) / cur) * 100;
    const downPct = ((down.price - cur) / cur) * 100;
    assert.ok(upPct <= MAX_STEP_PCT, `${cur}: ko'tarish ${upPct.toFixed(2)}% > ${MAX_STEP_PCT}%`);
    assert.ok(downPct >= -MAX_STEP_PCT, `${cur}: tushirish ${downPct.toFixed(2)}% < -${MAX_STEP_PCT}%`);
  }
});

test('clampStep — narx yo\'q bo\'lsa hisoblamaydi', () => {
  assert.equal(clampStep(0, 90).clamped, false);
  assert.equal(clampStep(90, 0).clamped, false);
});

test('auditdagi +39% sakrash bosqichga bo\'linadi', () => {
  // Real holat: Booking $56 → AI $78 taklif qilgan (+39%).
  const d = decideChannelAdvice({
    channel: 'Booking.com', currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_MARKET, occupancyBand: 'high',
    aiReason: 'Raqiblar $75-$138 oralig\'ida.',
  });
  assert.equal(d.action, ACTIONS.RAISE, 'maqsad bekor qilinmaydi — unga qadam bilan boriladi');
  assert.equal(d.suggestedPrice, 64, '56 × 1.15 = 64.4 → 64');
  assert.equal(d.delta, 8);
  assert.equal(d.guard, 'step_capped');
  assert.equal(d.targetPrice, 78, 'asl maqsad shaffof ko\'rsatiladi');
  assert.match(d.reason, /\$78/);
  assert.match(d.reason, /\$64/);
  assert.match(d.reason, /Raqiblar \$75/, 'AI izohi saqlanadi');
});

test('katta TUSHIRISH ham cheklanadi', () => {
  const d = decideChannelAdvice({
    channel: 'Booking.com', currentPrice: 200, aiSuggestedPrice: 100, aiAction: 'lower',
    stats: STATS_OK, signal: SIGNAL_MARKET,
  });
  assert.equal(d.action, ACTIONS.LOWER);
  assert.equal(d.suggestedPrice, 170, '200 × 0.85 = 170');
  assert.equal(d.guard, 'step_capped');
});

test('source — qaysi qator AI, qaysisi qoida', () => {
  const ai = decideChannelAdvice({
    channel: 'Booking.com', currentPrice: 100, aiSuggestedPrice: 105, aiAction: 'raise',
    aiReason: 'Raqiblar $104 atrofida.', stats: STATS_OK, signal: SIGNAL_MARKET,
  });
  assert.equal(ai.source, 'ai');

  const ruled = decideChannelAdvice({
    channel: 'Vio.com', currentPrice: 100, aiSuggestedPrice: 105, aiAction: 'raise', stats: STATS_OK,
  });
  assert.equal(ruled.source, 'rules', 'darvoza matni AI emas — shunday deb atalmasin');

  const noReason = decideChannelAdvice({
    channel: 'Booking.com', currentPrice: 100, aiSuggestedPrice: 105, aiAction: 'raise',
    stats: STATS_OK, signal: SIGNAL_MARKET,
  });
  assert.equal(noReason.source, 'rules', 'AI izoh bermagan — "AI tavsiyasi" deb atamaymiz');
});

test('applyAdviceRules qamrovda occupancy holatini qaytaradi', () => {
  const raw = [{ channel: 'Booking.com', currentPrice: 56, suggestedPrice: 78, action: 'raise', stats: STATS_OK }];
  const withOcc = applyAdviceRules(raw, { signal: SIGNAL_MARKET, occupancyBand: 'mid' });
  assert.equal(withOcc.coverage.hasOccupancy, true);
  assert.equal(withOcc.coverage.occupancyBand, 'mid');
  assert.equal(withOcc.channels[0].action, ACTIONS.RAISE);

  const without = applyAdviceRules(raw, { signal: SIGNAL_MARKET });
  assert.equal(without.coverage.hasOccupancy, false);
  assert.equal(without.channels[0].confidence, 'medium', 'occupancy yo\'q → yuqori bo\'lmaydi');
});

test('signalBlocksRaise — signal yo\'q bo\'lsa bloklamaydi', () => {
  assert.equal(signalBlocksRaise(null).blocks, false);
  assert.equal(signalBlocksRaise({}).blocks, false);
  assert.equal(signalBlocksRaise(SIGNAL_MARKET).blocks, false);
  assert.equal(signalBlocksRaise(SIGNAL_INDIVIDUAL).blocks, true);
});

test('applyAdviceRules — dashboard holatini takrorlaydi (auditdagi real javob)', () => {
  // Audit topgan real shakl: bir nechta kanalda currentPrice 0, AI hammasiga "raise".
  const raw = [
    { channel: 'Booking.com', currentPrice: 56, suggestedPrice: 78, action: 'raise', stats: STATS_OK },
    { channel: 'Etrip.net', currentPrice: 0, suggestedPrice: 95, action: 'raise', stats: { median: 87, total: 4 } },
    { channel: 'Kiwi Hotels', currentPrice: 0, suggestedPrice: 125, action: 'raise', stats: { median: 110, total: 4 } },
    { channel: 'Vio.com', currentPrice: 0, suggestedPrice: 105, action: 'raise', stats: { median: 100, total: 4 } },
    { channel: 'MyBooking.uz', currentPrice: 99, suggestedPrice: 99, action: 'keep', stats: { median: 99, total: 3 } },
  ];
  const { channels, coverage } = applyAdviceRules(raw, { signal: SIGNAL_INDIVIDUAL });

  assert.equal(coverage.total, 5);
  // Etrip/Kiwi/Vio — wholesaler. Ularda narx belgilab BO'LMAYDI, shuning uchun
  // "narxingiz noma'lum" emas, "kuzatiladi" holatiga tushadi: narx qo'ya
  // olmaydigan kanalda narxingiz yo'qligi ahamiyatsiz.
  assert.equal(coverage.monitorOnly, 3);
  assert.equal(coverage.noData, 0);
  assert.equal(coverage.held, 1, 'Booking "ko\'tarish" → "kutish"');
  assert.equal(coverage.lowConfidence, 1, 'MyBooking\'da atigi 2 raqib');
  assert.equal(coverage.actionable, 0);

  // Eng muhimi: birorta kanalda ham "raise" qolmagan.
  assert.equal(channels.filter((c) => c.action === ACTIONS.RAISE).length, 0);
  // Va hech qaysi kanal `delta: 0` ko'rsatmaydi.
  assert.equal(channels.filter((c) => c.delta === 0).length, 0);
});
