// To'lish darajasining SUR'AT mantiqi — xom foiz emas, o'z tarixiga nisbat.
//
// Nega alohida test: last-minute bozorda (bu mijozlarda median lead time
// 1 kun) xom foiz har doim past chiqadi va band doim `low` bo'lib qoladi.
// Bunda AI to'xtovsiz "narxni tushiring" deydi — mahsulot zarar keltiradi.
// Chegaralar shu sababdan qat'iy: ular narx qarorini belgilaydi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, bandFromPct, bandFromPace } from '../src/services/occupancy.service.js';

test('xom foiz chegaralari o\'zgarmagan (eski qo\'lda hisobot bilan mos)', () => {
  assert.equal(bandFromPct(0), BANDS.LOW);
  assert.equal(bandFromPct(39.9), BANDS.LOW);
  assert.equal(bandFromPct(40), BANDS.MID);
  assert.equal(bandFromPct(70), BANDS.MID);
  assert.equal(bandFromPct(70.1), BANDS.HIGH);
  assert.equal(bandFromPct(100), BANDS.HIGH);
});

test('sur\'at 1.0 atrofidagi kichik farq MID — mavsumiy shovqinga narx o\'zgartirilmaydi', () => {
  assert.equal(bandFromPace(0.85), BANDS.MID, '15% orqada — hali signal emas');
  assert.equal(bandFromPace(1.0), BANDS.MID);
  assert.equal(bandFromPace(1.15), BANDS.MID, '15% oldinda — hali signal emas');
});

test('sur\'at sezilarli orqada — LOW (bo\'sh xona xavfi)', () => {
  assert.equal(bandFromPace(0.84), BANDS.LOW);
  assert.equal(bandFromPace(0.5), BANDS.LOW);
  assert.equal(bandFromPace(0), BANDS.LOW, 'kitob bo\'m-bo\'sh');
});

test('sur\'at sezilarli oldinda — HIGH (narx ko\'tarish imkoni)', () => {
  assert.equal(bandFromPace(1.16), BANDS.HIGH);
  assert.equal(bandFromPace(1.74), BANDS.HIGH, 'Dendi Plaza real holati: 33 tun vs o\'tgan yil 19');
  assert.equal(bandFromPace(5), BANDS.HIGH);
});

test('AYNAN SHU HOLAT uchun quriladi: past foiz + yuqori sur\'at = HIGH', () => {
  // Real o'lchov (2026-08-26): kelasi 7 kunda 33/203 xona-tun = 16.3%.
  // Xom foizga qarasak — LOW, ya'ni "narxni tushiring".
  // Lekin o'tgan yili shu bosqichda atigi 19 tun bor edi → 1.74x oldinda.
  const rawPct = (33 / (29 * 7)) * 100;
  assert.equal(bandFromPct(rawPct), BANDS.LOW, 'xom foiz chalg\'itadi');
  assert.equal(bandFromPace(33 / 19), BANDS.HIGH, 'sur\'at to\'g\'ri javob beradi');
});
