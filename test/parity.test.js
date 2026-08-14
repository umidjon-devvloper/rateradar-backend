// Kanal turlari + rate parity — T-18.
//
// Markaziy da'vo: mehmonxona wholesaler/metasearch kanallarda narx BELGILAY
// OLMAYDI, shuning uchun u yerda tavsiya berish xato. Lekin o'sha yerdagi past
// narx qimmatli signal — parity buzilishi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_TYPES, channelType, isControllable, channelDisplay } from '../src/config/channels.js';
import { detectParityBreaches } from '../src/services/parity.service.js';
import { ACTIONS, decideChannelAdvice, applyAdviceRules } from '../src/services/priceAdvice.rules.js';

const STATS = { min: 75, max: 138, median: 87, rank: 2, total: 5 };

test('kanal turlari to\'g\'ri tasniflanadi', () => {
  assert.equal(channelType('Booking.com'), CHANNEL_TYPES.OTA);
  assert.equal(channelType('booking'), CHANNEL_TYPES.OTA);
  assert.equal(channelType('Agoda'), CHANNEL_TYPES.OTA);
  assert.equal(channelType('Vio.com'), CHANNEL_TYPES.WHOLESALER);
  assert.equal(channelType('ZenHotels'), CHANNEL_TYPES.WHOLESALER);
  assert.equal(channelType('Kiwi Hotels'), CHANNEL_TYPES.WHOLESALER);
  assert.equal(channelType('Etrip.net'), CHANNEL_TYPES.WHOLESALER);
  assert.equal(channelType('Skyscanner'), CHANNEL_TYPES.METASEARCH);
  assert.equal(channelType('Google Hotels'), CHANNEL_TYPES.METASEARCH);
  assert.equal(channelType('Allaqachon yo\'q kanal'), CHANNEL_TYPES.UNKNOWN);
});

test('faqat OTA va o\'z sayti boshqariladi', () => {
  assert.equal(isControllable('Booking.com'), true);
  assert.equal(isControllable('Expedia'), true);
  assert.equal(isControllable('Vio.com'), false);
  assert.equal(isControllable('Skyscanner'), false);
  assert.equal(isControllable('noma\'lum'), false, 'noma\'lum kanal ham tavsiya olmasin');
});

test('nom registrdagi standart shaklga keladi', () => {
  assert.equal(channelDisplay('bookingcom'), 'Booking.com');
  assert.equal(channelDisplay('BOOKING.COM'), 'Booking.com');
  assert.equal(channelDisplay('viocom'), 'Vio.com');
  assert.equal(channelDisplay('Yangi Kanal'), 'Yangi Kanal', 'registrda yo\'q — o\'zgarishsiz');
});

test('wholesaler\'ga tavsiya berilmaydi, faqat kuzatiladi', () => {
  const d = decideChannelAdvice({
    channel: 'Kiwi Hotels', currentPrice: 125, aiSuggestedPrice: 140, aiAction: 'raise',
    stats: STATS,
  });
  assert.equal(d.action, ACTIONS.MONITOR_ONLY);
  assert.equal(d.guard, 'not_controllable');
  assert.equal(d.suggestedPrice, 0);
  assert.equal(d.delta, null);
  assert.equal(d.channelType, CHANNEL_TYPES.WHOLESALER);
});

test('metasearch\'ga ham tavsiya berilmaydi', () => {
  const d = decideChannelAdvice({
    channel: 'Skyscanner', currentPrice: 85, aiSuggestedPrice: 95, aiAction: 'raise', stats: STATS,
  });
  assert.equal(d.action, ACTIONS.MONITOR_ONLY);
  assert.match(d.reason, /metaqidiruv/i);
});

test('OTA kanalda tavsiya odatdagidek ishlaydi', () => {
  const d = decideChannelAdvice({
    channel: 'Booking.com', currentPrice: 56, aiSuggestedPrice: 78, aiAction: 'raise',
    stats: STATS, signal: { movements: { market: { rising: true }, individual: [] } },
  });
  assert.equal(d.action, ACTIONS.RAISE);
  assert.equal(d.channelType, CHANNEL_TYPES.OTA);
});

// ── Parity ────────────────────────────────────────────────────────────
test('parity buzilishi aniqlanadi (auditdagi real raqamlar)', () => {
  const channels = [
    { channel: 'Booking.com', currentPrice: 96 },
    { channel: 'Agoda', currentPrice: 99 },
    { channel: 'Vio.com', currentPrice: 75 },       // 22% past → severe
    { channel: 'ZenHotels', currentPrice: 88 },     // 8% → chegaradan past, e'tibor berilmaydi
  ];
  const { breaches, baseline, checked } = detectParityBreaches(channels);

  assert.equal(baseline.channel, 'Booking.com');
  assert.equal(baseline.price, 96, 'baza — eng arzon BOSHQARILADIGAN narx');
  assert.equal(checked, 2);
  assert.equal(breaches.length, 1, 'faqat 10% dan ortiq farq hisobga olinadi');
  assert.equal(breaches[0].channel, 'Vio.com');
  assert.equal(breaches[0].diffPct, 22);
  assert.equal(breaches[0].severity, 'severe');
  assert.match(breaches[0].message, /Vio\.com/);
  assert.match(breaches[0].message, /parity/i);
});

test('wholesaler qimmatroq bo\'lsa — buzilish emas', () => {
  const { breaches } = detectParityBreaches([
    { channel: 'Booking.com', currentPrice: 80 },
    { channel: 'Vio.com', currentPrice: 120 },
  ]);
  assert.equal(breaches.length, 0, 'qayta sotuvchi ustama qo\'ysa bu muammo emas');
});

test('boshqariladigan kanal narxi yo\'q — taqqoslash bazasi yo\'q', () => {
  const { breaches, baseline } = detectParityBreaches([{ channel: 'Vio.com', currentPrice: 75 }]);
  assert.equal(baseline, null);
  assert.equal(breaches.length, 0, 'bazasiz ogohlantirish chiqarmaymiz');
});

test('bir nechta buzilish — eng jiddiysi birinchi', () => {
  const { breaches } = detectParityBreaches([
    { channel: 'Booking.com', currentPrice: 100 },
    { channel: 'Vio.com', currentPrice: 85 },     // 15%
    { channel: 'Kiwi Hotels', currentPrice: 60 }, // 40%
  ]);
  assert.equal(breaches.length, 2);
  assert.equal(breaches[0].channel, 'Kiwi Hotels');
  assert.equal(breaches[0].diffPct, 40);
});

test('to\'liq dashboard holati: 12 kanaldan nechtasi tavsiya oladi', () => {
  const raw = [
    { channel: 'Booking.com', currentPrice: 56, suggestedPrice: 78, action: 'raise', stats: STATS },
    { channel: 'Agoda', currentPrice: 61, suggestedPrice: 70, action: 'raise', stats: STATS },
    { channel: 'Skyscanner', currentPrice: 85, suggestedPrice: 95, action: 'raise', stats: STATS },
    { channel: 'Vio.com', currentPrice: 105, suggestedPrice: 110, action: 'raise', stats: STATS },
    { channel: 'ZenHotels', currentPrice: 105, suggestedPrice: 110, action: 'raise', stats: STATS },
    { channel: 'Kiwi Hotels', currentPrice: 125, suggestedPrice: 130, action: 'raise', stats: STATS },
    { channel: 'Clicktrip', currentPrice: 129, suggestedPrice: 135, action: 'raise', stats: STATS },
    { channel: 'HomeToGo', currentPrice: 85, suggestedPrice: 90, action: 'raise', stats: STATS },
  ];
  const { channels, coverage } = applyAdviceRules(raw, {
    signal: { movements: { market: { rising: true }, individual: [] } },
    occupancyBand: 'high',
  });

  assert.equal(coverage.monitorOnly, 6, '6 tasida narx belgilab bo\'lmaydi');
  assert.equal(coverage.actionable, 2, 'faqat Booking va Agoda');
  const monitored = channels.filter((c) => c.action === ACTIONS.MONITOR_ONLY).map((c) => c.channel);
  assert.ok(monitored.includes('Vio.com') && monitored.includes('Skyscanner'));
});
