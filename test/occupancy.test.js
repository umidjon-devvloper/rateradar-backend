// To'lish darajasi (occupancy) — hafta hisobi va hisobot mantiqi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS, weekStartOf, currentOccupancy, hasReportedThisWeek, upsertReport,
} from '../src/services/occupancy.service.js';

const DAY = 86400_000;

test('weekStartOf har doim UTC dushanbani qaytaradi', () => {
  // 2026-08-12 — chorshanba. Hafta boshi 2026-08-10 (dushanba).
  assert.equal(weekStartOf(new Date('2026-08-12T15:00:00Z')).toISOString(), '2026-08-10T00:00:00.000Z');
  // Yakshanba — o'sha haftaga tegishli (dushanbadan boshlanadi), keyingisiga emas.
  assert.equal(weekStartOf(new Date('2026-08-16T23:59:00Z')).toISOString(), '2026-08-10T00:00:00.000Z');
  // Dushanbaning o'zi — o'zgarmaydi.
  assert.equal(weekStartOf(new Date('2026-08-10T00:00:00Z')).toISOString(), '2026-08-10T00:00:00.000Z');
  // Dushanbadan bir soniya oldin — oldingi hafta.
  assert.equal(weekStartOf(new Date('2026-08-09T23:59:59Z')).toISOString(), '2026-08-03T00:00:00.000Z');
});

test('hisobot yo\'q — null (0 emas)', () => {
  assert.equal(currentOccupancy({}), null);
  assert.equal(currentOccupancy({ occupancyReports: [] }), null);
  assert.equal(currentOccupancy(null), null);
});

test('eskirgan hisobot yo\'q deb hisoblanadi', () => {
  const old = { occupancyReports: [{ weekStart: new Date(Date.now() - 30 * DAY), band: 'high' }] };
  assert.equal(currentOccupancy(old), null, '30 kunlik to\'lish bugungi qarorga asos emas');

  const fresh = { occupancyReports: [{ weekStart: weekStartOf(), band: 'high' }] };
  assert.equal(currentOccupancy(fresh)?.band, 'high');
});

test('bir haftada ikki marta yozilsa — ustiga yoziladi, dublikat bo\'lmaydi', () => {
  const hotel = { occupancyReports: [] };
  upsertReport(hotel, BANDS.LOW);
  upsertReport(hotel, BANDS.HIGH);
  assert.equal(hotel.occupancyReports.length, 1);
  assert.equal(hotel.occupancyReports[0].band, 'high');
  assert.equal(currentOccupancy(hotel).band, 'high');
});

test('eski haftalar tarix uchun saqlanadi', () => {
  const hotel = {
    occupancyReports: [{ weekStart: new Date(weekStartOf().getTime() - 7 * DAY), band: 'low' }],
  };
  upsertReport(hotel, BANDS.HIGH);
  assert.equal(hotel.occupancyReports.length, 2, 'o\'tgan hafta o\'chirilmasin — STLY uchun kerak');
  assert.equal(currentOccupancy(hotel).band, 'high', 'eng so\'nggisi olinadi');
});

test('tarix 60 hafta bilan cheklanadi', () => {
  const hotel = {
    occupancyReports: Array.from({ length: 80 }, (_, i) => ({
      weekStart: new Date(weekStartOf().getTime() - (80 - i) * 7 * DAY),
      band: 'mid',
    })),
  };
  upsertReport(hotel, BANDS.LOW);
  assert.equal(hotel.occupancyReports.length, 60);
  assert.equal(hotel.occupancyReports.at(-1).band, 'low', 'eng yangisi saqlanadi');
});

test('noto\'g\'ri band 400 xato beradi', () => {
  const hotel = { occupancyReports: [] };
  assert.throws(() => upsertReport(hotel, 'toliq'), (e) => e.status === 400);
  assert.throws(() => upsertReport(hotel, ''), (e) => e.status === 400);
  assert.throws(() => upsertReport(hotel, '80%'), (e) => e.status === 400);
  assert.equal(hotel.occupancyReports.length, 0, 'xato holatda hech narsa yozilmasin');
});

test('hasReportedThisWeek — UI shu haftada qayta so\'ramaydi', () => {
  const hotel = { occupancyReports: [] };
  assert.equal(hasReportedThisWeek(hotel), false);
  upsertReport(hotel, BANDS.MID);
  assert.equal(hasReportedThisWeek(hotel), true);

  // O'tgan haftagi hisobot bu haftani qoplamaydi.
  const stale = { occupancyReports: [{ weekStart: new Date(weekStartOf().getTime() - 7 * DAY), band: 'mid' }] };
  assert.equal(hasReportedThisWeek(stale), false);
});
