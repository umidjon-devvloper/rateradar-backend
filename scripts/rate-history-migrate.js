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
  console.log('');

  if (!APPLY) {
    console.log('ℹ️  Bu QURUQ ishga tushirish (dry run) — hech narsa o\'zgartirilmadi.');
    console.log('   Bajarish uchun:  node scripts/rate-history-migrate.js --apply\n');
    return done();
  }

  // ── 2. TTL indekslarini tuzatish ────────────────────────────────────
  console.log('── TUZATISH ───────────────────────────────────────');
  for (const i of psTtl) {
    await PriceSnapshot.collection.dropIndex(i.name);
    console.log(`  ✓ pricesnapshots.${i.name} o'chirildi — tarix endi saqlanadi`);
  }
  for (const i of rsTtl) {
    if (Math.round(i.expireAfterSeconds / 86400) >= 400) continue;
    // collMod indeksni qayta qurmasdan muddatni o'zgartiradi (tezroq).
    await mongoose.connection.db.command({
      collMod: RoomSnapshot.collection.collectionName,
      index: { name: i.name, expireAfterSeconds: 60 * 60 * 24 * 400 },
    });
    console.log(`  ✓ roomsnapshots.${i.name} → 400 kun`);
  }

  // Model fayllaridagi yangi indekslarni bazaga qo'llash.
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
