// Tarif cheklovlari — birlik testlari.
//
// Bu testlarning maqsadi bitta: `0` HECH QACHON yana "cheksiz" ma'nosini
// olib qolmasin. Ilgari aynan shu chalkashlik tufayli Free tarif amalda
// cheksiz raqib berardi (Pro'da 10 ta bo'lgani holda).
import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLIMITED, planLimits, ADMIN_LIMITS } from '../src/config/plans.js';
import { userLimit, assertLimit, userAllows } from '../src/utils/planGate.js';

const u = (plan) => ({ plan, role: 'user' });
const ADMIN = { plan: 'free', role: 'admin' };

function limitError(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

test('narvon to\'g\'ri: free < starter < pro < business', () => {
  assert.equal(planLimits('free').maxCompetitors, 1);
  assert.equal(planLimits('starter').maxCompetitors, 3);
  assert.equal(planLimits('pro').maxCompetitors, 10);
  assert.equal(planLimits('business').maxCompetitors, UNLIMITED);
});

test('free tarif CHEKSIZ emas — 1 tadan keyin bloklanadi', () => {
  assert.equal(limitError(() => assertLimit(u('free'), 'maxCompetitors', 0)), null, '0 dan 1 ga o\'tish mumkin');
  const err = limitError(() => assertLimit(u('free'), 'maxCompetitors', 1));
  assert.ok(err, 'ikkinchi raqib bloklanishi kerak');
  assert.equal(err.status, 403);
  assert.equal(err.code, 'PLAN_LIMIT_REACHED');
  assert.equal(err.limit, 1);
});

test('`0` haqiqiy nolni anglatadi — cheksizlikni EMAS', () => {
  // maxTv: free = 0 → birorta TV qurilma qo'shib bo'lmaydi.
  assert.equal(planLimits('free').maxTv, 0);
  const err = limitError(() => assertLimit(u('free'), 'maxTv', 0));
  assert.ok(err, '0 limit darhol bloklashi kerak, cheksiz bo\'lib qolmasligi');
});

test('business cheksiz — katta sonda ham bloklanmaydi', () => {
  assert.equal(limitError(() => assertLimit(u('business'), 'maxCompetitors', 9999)), null);
  assert.equal(limitError(() => assertLimit(u('business'), 'maxTv', 9999)), null);
});

test('starter/pro aniq chegarada bloklaydi', () => {
  assert.equal(limitError(() => assertLimit(u('starter'), 'maxCompetitors', 2)), null);
  assert.ok(limitError(() => assertLimit(u('starter'), 'maxCompetitors', 3)));
  assert.equal(limitError(() => assertLimit(u('pro'), 'maxCompetitors', 9)), null);
  assert.ok(limitError(() => assertLimit(u('pro'), 'maxCompetitors', 10)));
});

test('admin barcha sonli cheklovdan ozod', () => {
  assert.equal(userLimit(ADMIN, 'maxCompetitors'), UNLIMITED);
  assert.equal(limitError(() => assertLimit(ADMIN, 'maxCompetitors', 9999)), null);
  assert.equal(ADMIN_LIMITS.maxHotels, UNLIMITED);
  assert.equal(userAllows(ADMIN, 'ai'), true, 'admin plan=free bo\'lsa ham AI ochiq');
});

test('noma\'lum kalit YOPIQ bo\'ladi (cheksiz emas)', () => {
  // Yangi cheklov qo'shilib LIMITS'ga yozilmasa — jimgina ochilib ketmasin.
  assert.equal(userLimit(u('pro'), 'maxWebhooks'), 0);
  assert.ok(limitError(() => assertLimit(u('pro'), 'maxWebhooks', 0)));
});

test('noma\'lum tarif free\'ga tushadi', () => {
  assert.equal(userLimit(u('platinum'), 'maxCompetitors'), 1);
  assert.equal(userLimit(undefined, 'maxCompetitors'), 1);
});

test('frontend planLimits backend bilan mos', async () => {
  // Ikki jadval qo'lda sinxronlanadi — farq qilsa UI noto'g'ri qulf ko'rsatadi.
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../../frontend/src/lib/planLimits.js', import.meta.url), 'utf8'));

  for (const plan of ['free', 'starter', 'pro', 'business']) {
    const backend = planLimits(plan).maxCompetitors;
    const row = src.match(new RegExp(`${plan}:\\s*\\{[^}]*maxCompetitors:\\s*([A-Za-z0-9_]+)`));
    assert.ok(row, `frontend planLimits.js da "${plan}" topilmadi`);
    const expected = backend === UNLIMITED ? 'UNLIMITED' : String(backend);
    assert.equal(row[1], expected, `${plan}: backend=${expected}, frontend=${row[1]}`);
  }
});
