/**
 * NARX TARIXINI QUTQARISH — bir martalik migratsiya (qayta ishga tushirsa xavfsiz).
 *
 * MUAMMO: `pricesnapshots` da TTL indeksi bor edi (90 kun) — MongoDB narx
 * tarixini jimgina o'chirib turardi. STLY tahlili esa 358-366 kun oldingi
 * ma'lumotni so'raydi → natija HAR DOIM bo'sh edi. Model faylidagi TTL olib
 * tashlandi, LEKIN mongoose MAVJUD indeksni o'zgartirmaydi — uni bazadan
 * qo'lda tushirish kerak. Shu skript aynan shuni qiladi.
 *
 * ⚠️ SHOSHILINCH: bazada hozir ~90 kunlik tarix bor. Har o'tgan kun eng eski
 * kunni o'chiradi. Bugun ishga tushirsangiz — 90 kunlik tarixni qutqarasiz,
 * ya'ni STLY 3 oy oldinroq ishlay boshlaydi.
 *
 * Ishlatish (backend/ papkasidan):
 *   node scripts/rate-history-migrate.js           → HOLATNI KO'RSATADI (hech narsa o'zgarmaydi)
 *   node scripts/rate-history-migrate.js --apply   → TTL'ni tuzatadi + backfill qiladi
 *   node scripts/rate-history-migrate.js --apply --skip-backfill  → faqat indeks
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import PriceSnapshot from '../src/models/PriceSnapshot.js';
import RoomSnapshot from '../src/models/RoomSnapshot.js';
import DailyRate from '../src/models/DailyRate.js';
import { backfillAll } from '../src/services/rateHistory.service.js';

const DAY_MS = 86400_000;
const APPLY = process.argv.includes('--apply');
const SKIP_BACKFILL = process.argv.includes('--skip-backfill');

/** Kolleksiyadagi TTL indekslarini topadi. */
async function ttlIndexes(model) {
  const idx = await model.collection.indexes();
  return idx.filter((i) => i.expireAfterSeconds != null);
}

/**
 * Indeksni KERAKLI holatga keltiradi.
 *
 * `createIndexes()` mavjud indeksni O'ZGARTIRA OLMAYDI — nomi bir xil, opsiyasi
 * boshqa bo'lsa `IndexOptionsConflict` tashlaydi. Shuning uchun farq bo'lsa
 * eskisini tushirib, qaytadan yaratamiz.
 *
 * @param {number|null} ttlDays  null = TTL bo'lmasin
 */
async function ensureIndex(model, key, ttlDays, label) {
  const coll = model.collection;
  const name = Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_');
  const existing = (await coll.indexes()).find((i) => i.name === name);

  const want = ttlDays == null ? null : 60 * 60 * 24 * ttlDays;
  const have = existing?.expireAfterSeconds ?? null;

  if (existing && have === want) {
    console.log(`  ✓ ${label}.${name} — allaqachon to'g'ri (${want == null ? 'TTL yo\'q' : `${ttlDays} kun`})`);
    return;
  }
  if (existing) {
    await coll.dropIndex(name);
    console.log(`  · ${label}.${name} tushirildi (eski: ${have == null ? 'TTL yo\'q' : `${Math.round(have / 86400)} kun`})`);
  }
  await coll.createIndex(key, want == null ? { name } : { name, expireAfterSeconds: want });
  console.log(`  ✓ ${label}.${name} yaratildi → ${want == null ? 'TTL yo\'q (tarix saqlanadi)' : `${ttlDays} kun`}`);
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  console.log('✓ MongoDB ulandi\n');

  // ── 1. Hozirgi holat ────────────────────────────────────────────────
  const oldest = await PriceSnapshot.findOne().sort({ snapshotAt: 1 }).select('snapshotAt').lean();
  const total = await PriceSnapshot.estimatedDocumentCount();
  const already = await DailyRate.estimatedDocumentCount();

  console.log('── HOZIRGI HOLAT ──────────────────────────────────');
  console.log(`  pricesnapshots:  ${total.toLocaleString()} hujjat`);
  if (oldest) {
    const ageDays = Math.floor((Date.now() - new Date(oldest.snapshotAt)) / DAY_MS);
    console.log(`  eng eski yozuv:  ${new Date(oldest.snapshotAt).toISOString().slice(0, 10)}  (${ageDays} kun oldin)`);
    console.log(`  ya'ni qutqariladigan tarix: ${ageDays} kun`);
  } else {
    console.log('  eng eski yozuv:  yo\'q (baza bo\'sh)');
  }
  console.log(`  dailyrates:      ${already.toLocaleString()} hujjat\n`);

  const psTtl = await ttlIndexes(PriceSnapshot);
  const rsTtl = await ttlIndexes(RoomSnapshot);

  console.log('── TTL INDEKSLARI ─────────────────────────────────');
  for (const i of psTtl) {
    console.log(`  🔴 pricesnapshots.${i.name} → ${Math.round(i.expireAfterSeconds / 86400)} kun  (O'CHIRILISHI KERAK)`);
  }
  if (!psTtl.length) console.log('  ✓ pricesnapshots — TTL yo\'q (to\'g\'ri)');
  for (const i of rsTtl) {
    const days = Math.round(i.expireAfterSeconds / 86400);
    const ok = days >= 400;
    console.log(`  ${ok ? '✓' : '🟠'} roomsnapshots.${i.name} → ${days} kun${ok ? '' : '  (400 kunga UZAYTIRILADI)'}`);
  }
  if (!rsTtl.length) console.log('  🟠 roomsnapshots — TTL yo\'q (400 kunlik TTL QO\'SHILADI)');
  console.log('');

  if (!APPLY) {
    console.log('ℹ️  Bu QURUQ ishga tushirish (dry run) — hech narsa o\'zgartirilmadi.');
    console.log('   Bajarish uchun:  node scripts/rate-history-migrate.js --apply\n');
    return done();
  }

  // ── 2. Indekslarni kerakli holatga keltirish ────────────────────────
  console.log('── TUZATISH ───────────────────────────────────────');

  // Narx tarixi HECH QACHON o'chmasin → TTL bo'lmasin.
  await ensureIndex(PriceSnapshot, { snapshotAt: 1 }, null, 'pricesnapshots');
  // Xona tarixi 400 kun (1 yil + zaxira) — mavsumiy taqqoslash uchun.
  await ensureIndex(RoomSnapshot, { snapshotAt: 1 }, 400, 'roomsnapshots');

  // Qolgan (kompozit) indekslar — bularda to'qnashuv bo'lmaydi.
  await PriceSnapshot.createIndexes();
  await RoomSnapshot.createIndexes();
  await DailyRate.createIndexes();
  console.log('  ✓ indekslar sinxronlandi\n');

  if (SKIP_BACKFILL) {
    console.log('ℹ️  --skip-backfill berilgan, agregatga ko\'chirish o\'tkazib yuborildi.\n');
    return done();
  }

  // ── 3. Backfill ─────────────────────────────────────────────────────
  console.log('── BACKFILL (xom → kunlik agregat) ────────────────');
  const t0 = Date.now();
  const res = await backfillAll({
    onProgress: ({ day, index, totalDays, written }) => {
      if (written > 0 || index % 10 === 0 || index === totalDays) {
        console.log(`  [${String(index).padStart(3)}/${totalDays}] ${day.toISOString().slice(0, 10)} → ${written} yozuv`);
      }
    },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('── NATIJA ─────────────────────────────────────────');
  console.log(`  ✓ ${res.days} kun ishlandi (${secs}s)`);
  console.log(`  ✓ ${res.written.toLocaleString()} kunlik yozuv saqlandi`);
  if (res.from) {
    console.log(`  ✓ tarix oynasi: ${res.from.toISOString().slice(0, 10)} … ${res.to.toISOString().slice(0, 10)}`);
    const stlyAt = new Date(res.from.getTime() + 364 * DAY_MS);
    console.log(`  ✓ STLY ishlay boshlaydi: ${stlyAt.toISOString().slice(0, 10)}`);
  }
  console.log('\n⚠️  Serverni qayta ishga tushiring (kunlik rollup cron\'i uchun):  pm2 restart rateradar\n');
  return done();
}

async function done() {
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Xato:', e.stack || e.message);
  process.exit(1);
});
