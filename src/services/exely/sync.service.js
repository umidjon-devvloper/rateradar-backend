import cron from 'node-cron';
import { env } from '../../config/env.js';
import Integration from '../../models/Integration.js';
import OwnBooking from '../../models/OwnBooking.js';
import { decryptSecret } from './crypto.js';
import { fetchProperty, summarizeProperty } from './content.service.js';
import {
  fetchBookingSummaries,
  fetchBookingDetail,
  normalizeBooking,
  EPOCH,
} from './reservation.service.js';

// ════════════════════════════════════════════════════════════════════
// EXELY SINXRONIZATSIYA — ikki bosqichli, uzilishga chidamli
//
// 1-BOSQICH (summary): `continueToken` bilan sahifalab o'tamiz va har
//   bronni "stub" sifatida yozamiz (needsDetail: true). Bu arzon —
//   3800 ta bron atigi 4 ta so'rov. Kursor HAR SAHIFADA saqlanadi,
//   shuning uchun uzilish bo'lsa qayerda to'xtagan bo'lsa davom etadi.
//
// 2-BOSQICH (detail): needsDetail bo'lgan bronlarning tarkibi olinadi.
//   Bu qimmat (bron boshiga 1 so'rov), shuning uchun bir yugurishda
//   DETAIL_LIMIT tagacha. Qolgani keyingi cron'da — 3800 talik birinchi
//   yuklash bir necha yugurishga bo'linadi va serverni band qilmaydi.
//
// Nega ajratilgan: agar kursor faqat detallar tugagach saqlansa,
// birinchi yuklash o'rtasida uzilish HAMMASINI boshidan boshlatardi.
// ════════════════════════════════════════════════════════════════════

// Bir PARTIYADA nechta bron tarkibi olinadi.
const DETAIL_LIMIT = 400;
// BIRINCHI TO'LIQ YUKLASH (backfill) uchun vaqt byudjeti.
//
// Nega kerak: yangi mijozda 3800+ bron bo'ladi. Bitta partiya (400 ta)
// bilan cheklansak, 30 daqiqalik cron'da to'liq yuklash ~5 SOAT davom
// etadi — mijoz ulanib, dashboard'ida ma'lumot ko'rmay o'tiradi.
// Shuning uchun backfill tugamaguncha bir yugurishda partiyalar
// KETMA-KET davom etadi, shu byudjet tugagunicha (~15 daqiqada tugaydi).
// Backfill tugagach inkremental yugurish baribir kichik bo'ladi.
const BACKFILL_BUDGET_MS = 5 * 60_000;
// Detal so'rovlari parallelligi. Yuqori qilish Exely'ni 429 ga olib boradi.
const DETAIL_CONCURRENCY = 4;
// Bitta bron shuncha marta xato bersa — tashlab ketamiz (navbatni tiqmasin).
const MAX_DETAIL_ATTEMPTS = 5;
// Sync qulfi shuncha vaqtdan eski bo'lsa "qotib qolgan" deb hisoblanadi
// (masalan server sync o'rtasida qayta ishga tushgan).
const LOCK_STALE_MS = 30 * 60_000;
// Obyekt profili (xona turlari, tariflar) shuncha vaqtda bir yangilanadi.
const CONTENT_TTL_MS = 24 * 3_600_000;

/** Cheklangan parallellik bilan map (kutubxonasiz). */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Ulanishdan API kalitlarini ochadi. */
export function credsFor(integration) {
  const clientId = integration?.credentials?.clientId;
  const enc = integration?.credentials?.clientSecretEnc;
  if (!clientId || !enc) throw new Error('Exely kalitlari to\'liq emas');
  return { clientId, clientSecret: decryptSecret(enc) };
}

/** Secret bilan birga ulanishni o'qiydi (secret sxemada select:false). */
export function loadIntegration(query) {
  return Integration.findOne(query).select('+credentials.clientSecretEnc');
}

// ── 1-BOSQICH: summary ──────────────────────────────────────────────

async function syncSummaries(integration, creds) {
  const { hotelId, propertyId, _id: integrationId } = integration;
  let continueToken = integration.sync?.continueToken || '';
  let pages = 0;
  let seen = 0;
  let queued = 0;

  // 20 sahifa × 1000 = 20 000 bron — bir yugurish uchun yetarli shift.
  while (pages < 20) {
    const res = await fetchBookingSummaries(creds, propertyId, {
      continueToken,
      lastModification: continueToken
        ? undefined
        : (integration.sync?.lastModificationCursor
          ? new Date(integration.sync.lastModificationCursor).toISOString().slice(0, 19) + 'Z'
          : EPOCH),
      count: 1000,
    });
    pages += 1;

    const list = res.bookingSummaries || [];
    seen += list.length;

    if (list.length) {
      const numbers = list.map((b) => String(b.number));
      const existing = await OwnBooking
        .find({ hotelId, number: { $in: numbers } })
        .select('number modifiedAt needsDetail')
        .lean();
      const byNumber = new Map(existing.map((e) => [e.number, e]));

      const ops = [];
      for (const b of list) {
        const number = String(b.number);
        const modifiedAt = b.modifiedDateTime ? new Date(b.modifiedDateTime) : null;
        const prev = byNumber.get(number);

        // O'zgarmagan va allaqachon to'ldirilgan bron — teginmaymiz.
        const unchanged = prev
          && !prev.needsDetail
          && prev.modifiedAt
          && modifiedAt
          && prev.modifiedAt.getTime() === modifiedAt.getTime();
        if (unchanged) continue;

        ops.push({
          updateOne: {
            filter: { hotelId, number },
            update: {
              $set: {
                integrationId,
                propertyId: String(b.propertyId || propertyId),
                status: b.status || '',
                isCancelled: b.status === 'Cancelled',
                createdAt: b.createdDateTime ? new Date(b.createdDateTime) : null,
                modifiedAt,
                // O'zgargan bron — tarkibi qaytadan olinishi kerak.
                needsDetail: true,
                detailAttempts: 0,
              },
            },
            upsert: true,
          },
        });
        queued += 1;
      }
      if (ops.length) await OwnBooking.bulkWrite(ops, { ordered: false });
    }

    // Kursorni DARHOL saqlaymiz — keyingi yugurish shu yerdan davom etsin.
    continueToken = res.continueToken || continueToken;
    const lastMod = list.reduce((max, b) => {
      const t = b.modifiedDateTime ? new Date(b.modifiedDateTime).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    await Integration.updateOne(
      { _id: integrationId },
      {
        $set: {
          'sync.continueToken': continueToken,
          ...(lastMod ? { 'sync.lastModificationCursor': new Date(lastMod) } : {}),
        },
      },
    );

    if (!res.hasMoreData) break;
  }

  return { pages, seen, queued };
}

// ── 2-BOSQICH: detail ───────────────────────────────────────────────

async function syncDetails(integration, creds, { limit = DETAIL_LIMIT } = {}) {
  const { hotelId, propertyId, _id: integrationId } = integration;

  const pending = await OwnBooking
    .find({ hotelId, needsDetail: true, detailAttempts: { $lt: MAX_DETAIL_ATTEMPTS } })
    .select('number')
    .sort({ modifiedAt: -1 }) // yangilari birinchi — joriy metrikaga eng kerakli
    .limit(limit)
    .lean();

  if (!pending.length) return { filled: 0, failed: 0, remaining: 0 };

  let filled = 0;
  let failed = 0;
  const ops = [];

  await mapPool(pending, DETAIL_CONCURRENCY, async (row) => {
    try {
      const raw = await fetchBookingDetail(creds, propertyId, row.number);
      // Vaqt mintaqasi lead time'ni to'g'ri hisoblash uchun — sabab
      // reservation.service.js localDayKey() izohida.
      const doc = raw && normalizeBooking(raw, {
        hotelId, integrationId, timeZone: integration.property?.timeZone || 'UTC',
      });
      if (!doc) throw new Error('bo\'sh javob');
      // number/hotelId filtrda — ularni $set'da takrorlamaymiz.
      const { number, ...rest } = doc;
      ops.push({
        updateOne: {
          filter: { hotelId, number },
          update: { $set: { ...rest, needsDetail: false, detailAttempts: 0 } },
        },
      });
      filled += 1;
    } catch (err) {
      failed += 1;
      ops.push({
        updateOne: {
          filter: { hotelId, number: row.number },
          update: { $inc: { detailAttempts: 1 } },
        },
      });
    }
  });

  if (ops.length) await OwnBooking.bulkWrite(ops, { ordered: false });

  const remaining = await OwnBooking.countDocuments({
    hotelId, needsDetail: true, detailAttempts: { $lt: MAX_DETAIL_ATTEMPTS },
  });

  return { filled, failed, remaining };
}

// ── Obyekt profili ──────────────────────────────────────────────────

async function refreshContentIfStale(integration, creds) {
  const at = integration.property?.refreshedAt;
  if (at && Date.now() - new Date(at).getTime() < CONTENT_TTL_MS) return false;
  const p = await fetchProperty(creds, integration.propertyId);
  await Integration.updateOne(
    { _id: integration._id },
    { $set: { property: summarizeProperty(p) } },
  );
  return true;
}

// ── Asosiy yugurish ─────────────────────────────────────────────────

/**
 * Bitta ulanishni sinxronlaydi.
 * @param {string} integrationId
 * @param {{detailLimit?:number}} [opts]
 */
export async function runSync(integrationId, { detailLimit = DETAIL_LIMIT } = {}) {
  // Qulfni ATOMAR olamiz: bir vaqtda ikkita sync (cron + qo'lda tugma)
  // bir ulanishga tushsa, Exely limitini ikki barobar yeydi.
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const locked = await Integration.findOneAndUpdate(
    {
      _id: integrationId,
      status: { $in: ['active', 'pending'] },
      $or: [
        { 'sync.running': { $ne: true } },
        { 'sync.runningSince': { $lt: staleBefore } },
      ],
    },
    { $set: { 'sync.running': true, 'sync.runningSince': new Date() } },
    { new: true },
  ).select('+credentials.clientSecretEnc');

  if (!locked) return { skipped: true, reason: 'band yoki faol emas' };

  const started = Date.now();
  try {
    if (!locked.propertyId) throw new Error('propertyId tanlanmagan');
    const creds = credsFor(locked);

    await refreshContentIfStale(locked, creds);
    const s = await syncSummaries(locked, creds);

    // Detallarni partiyalab olamiz. Birinchi to'liq yuklashda byudjet
    // tugagunicha davom etamiz, keyingi (inkremental) yugurishlarda esa
    // bitta partiya yetarli — yangi bronlar kam bo'ladi.
    let d = await syncDetails(locked, creds, { limit: detailLimit });
    if (!locked.sync?.backfillDone) {
      while (d.remaining > 0 && Date.now() - started < BACKFILL_BUDGET_MS) {
        const next = await syncDetails(locked, creds, { limit: detailLimit });
        if (next.filled === 0 && next.failed === 0) break; // siljish yo'q — to'xtaymiz
        d = {
          filled: d.filled + next.filled,
          failed: d.failed + next.failed,
          remaining: next.remaining,
        };
      }
    }

    const total = await OwnBooking.countDocuments({ hotelId: locked.hotelId });

    await Integration.updateOne({ _id: integrationId }, {
      $set: {
        status: 'active',
        'sync.running': false,
        'sync.runningSince': null,
        'sync.lastSyncAt': new Date(),
        'sync.lastSyncDurationMs': Date.now() - started,
        'sync.totalBookings': total,
        'sync.backfillDone': d.remaining === 0,
        'sync.lastError': '',
        'sync.consecutiveErrors': 0,
      },
    });

    // Yangi bronlar chet valyutada bo'lishi mumkin — o'sha tunlar uchun
    // kurs kerak bo'ladi. Fonda to'ldiramiz: cbu.uz sekin va bu sync'ni
    // ushlab turmasligi kerak. Xato bo'lsa metrika `coverage` da ko'rsatadi.
    import('../metrics/ownMetrics.service.js')
      .then((m) => m.warmFxCoverage(locked.hotelId))
      .then((r) => { if (r?.loaded) console.log('[fx] +' + r.loaded + ' kurs'); })
      .catch((e) => console.warn('[fx] warm:', e.message));

    return {
      skipped: false,
      pages: s.pages,
      seen: s.seen,
      queued: s.queued,
      detailsFilled: d.filled,
      detailsFailed: d.failed,
      detailsRemaining: d.remaining,
      totalBookings: total,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const errs = (locked.sync?.consecutiveErrors || 0) + 1;
    await Integration.updateOne({ _id: integrationId }, {
      $set: {
        'sync.running': false,
        'sync.runningSince': null,
        'sync.lastError': String(err.message || err).slice(0, 500),
        'sync.lastErrorAt': new Date(),
        'sync.consecutiveErrors': errs,
        // 5 marta ketma-ket xato — mijozga ko'rsatiladigan holat.
        // Kalit bekor qilingan yoki ruxsat olingan bo'lishi mumkin.
        ...(errs >= 5 ? { status: 'error' } : {}),
      },
    });
    throw err;
  }
}

/** Barcha faol ulanishlarni navbat bilan sinxronlaydi (cron). */
export async function syncAllIntegrations() {
  const list = await Integration
    .find({ provider: 'exely', status: { $in: ['active', 'pending'] } })
    .select('_id hotelId')
    .lean();

  if (!list.length) return { total: 0 };

  console.log(`[cron] Exely sync: ${list.length} ta ulanish`);
  let ok = 0;
  let fail = 0;

  // KETMA-KET (parallel emas): auth endpointi IP bo'yicha 300/soat bilan
  // cheklangan — 50 ta ulanishni bir vaqtda urish darhol chegaraga olib
  // boradi. Ketma-ket yurish sync'ni vaqt bo'yicha tabiiy yoyadi.
  for (const it of list) {
    try {
      const r = await runSync(it._id);
      if (!r.skipped) {
        ok += 1;
        if (r.queued || r.detailsFilled) {
          console.log(
            `[cron] Exely ${it._id}: +${r.queued} yangi/o'zgargan, ` +
            `${r.detailsFilled} tarkib to'ldi, ${r.detailsRemaining} qoldi`,
          );
        }
      }
    } catch (err) {
      fail += 1;
      console.warn(`[cron] Exely sync xatosi (${it._id}):`, err.message);
    }
  }

  return { total: list.length, ok, fail };
}

/**
 * Tugallanmagan birinchi yuklashlarni davom ettiradi.
 *
 * Asosiy cron 30 daqiqada bir ishlaydi — bu INKREMENTAL yangilanish uchun
 * to'g'ri, lekin BIRINCHI yuklash uchun juda sekin: 3800 ta bron 5 daqiqalik
 * byudjetga sig'maydi va mijoz bir soat kutadi.
 *
 * Shuning uchun backfill tugamagan ulanishlar alohida, tez-tez (2 daqiqada)
 * davom ettiriladi. Backfill tugagach bu funksiya ularni ko'rmay qo'yadi va
 * yuk yo'qoladi — ya'ni tez cron faqat yangi mijoz ulanganda ishlaydi.
 */
export async function continueBackfills() {
  const list = await Integration
    .find({
      provider: 'exely',
      status: { $in: ['active', 'pending'] },
      'sync.backfillDone': false,
      // ⚠️ Shunchaki `running: false` deb filtrlash MUMKIN EMAS. Baza bilan
      // aloqa uzilsa (real hodisa: noutbuk uyquga ketdi, Atlas yo'qoldi)
      // sync xato beradi, lekin qulfni bo'shatish ham DB'ga YOZISHNI talab
      // qiladi va u ham bajarilmaydi — natijada `running` abadiy `true`
      // bo'lib qoladi. Faqat `running: false` ni olsak, bunday ulanish
      // tezkor backfill cron'iga umuman ko'rinmaydi va yuklash to'xtab
      // qoladi. Shuning uchun eskirgan qulfni ham qamrab olamiz —
      // haqiqiy egalikni runSync o'zi atomar tekshiradi.
      $or: [
        { 'sync.running': { $ne: true } },
        { 'sync.runningSince': { $lt: new Date(Date.now() - LOCK_STALE_MS) } },
      ],
    })
    .select('_id')
    .lean();

  for (const it of list) {
    try {
      const r = await runSync(it._id);
      if (!r.skipped) {
        console.log(
          `[exely] backfill ${it._id}: +${r.detailsFilled} to'ldi, ${r.detailsRemaining} qoldi`,
        );
      }
    } catch (err) {
      console.warn(`[exely] backfill xatosi (${it._id}):`, err.message);
    }
  }
  return { total: list.length };
}

/**
 * Ishga tushishda qolib ketgan qulflarni ochadi.
 *
 * `sync.running` bayrog'ini faqat TIRIK jarayon ushlab turadi. Server
 * sync o'rtasida o'lsa (pm2 restart, deploy, SIGKILL) bayroq bazada
 * `true` bo'lib qoladi va ulanish LOCK_STALE_MS (30 daqiqa) davomida
 * bloklanadi — bu vaqt ichida hech qanday sync ishlamaydi.
 *
 * Boot paytida esa ta'rifga ko'ra hech qanday sync ketmayapti, shuning
 * uchun barcha qulfni bemalol ochsa bo'ladi. (Bir nechta nusxa ishlatilsa
 * bu yetarli emas — o'shanda qulf umumiy Redis'ga ko'chirilishi kerak.)
 */
async function releaseStaleLocks() {
  const r = await Integration.updateOne(
    { provider: 'exely', 'sync.running': true },
    { $set: { 'sync.running': false, 'sync.runningSince': null } },
  ).catch(() => null);
  if (r?.modifiedCount) {
    console.log(`[exely] ${r.modifiedCount} ta qolib ketgan sync qulfi ochildi`);
  }
}

/** Har 30 daqiqada sinxronizatsiya. */
export function startExelySync() {
  if (env.EXELY_SYNC_ENABLED !== 'true') {
    console.log('[cron] Exely sync O\'CHIQ (EXELY_SYNC_ENABLED=false)');
    return;
  }
  // Avvalgi jarayondan qolgan qulflarni ochamiz, so'ng birinchi sync'ni
  // darhol boshlaymiz — restart'dan keyin 30 daqiqa kutib turmasin.
  releaseStaleLocks()
    .then(() => syncAllIntegrations())
    .catch((e) => console.warn('[exely] boot sync:', e.message));

  cron.schedule('*/30 * * * *', () => {
    syncAllIntegrations().catch((e) => console.error('[cron] Exely sync:', e.message));
  });
  // Tugallanmagan birinchi yuklashlar — tez-tez, lekin faqat o'shalar uchun.
  cron.schedule('*/2 * * * *', () => {
    continueBackfills().catch((e) => console.warn('[cron] Exely backfill:', e.message));
  });
  console.log('[cron] Exely sinxronizatsiya yoqildi (sync 30 daq · backfill 2 daq)');
}
