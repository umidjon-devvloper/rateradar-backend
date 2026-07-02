/**
 * Bloklangan IP'larni qo'lda tozalash (DB darajasida).
 *
 * Admin ham bloklanib qolsa, /admin/security/unban UI'si ishlamaydi (403).
 * Shu skript to'g'ridan-to'g'ri DB'dagi `bannedips` yozuvlarini o'chiradi.
 *
 * Ishlatish (backend/ papkasidan):
 *   node scripts/unban.js               → bloklangan IP'lar ro'yxatini ko'rsatadi
 *   node scripts/unban.js 1.2.3.4 5.6.7.8   → berilgan IP(lar)ni blokdan chiqaradi
 *   node scripts/unban.js --auto        → faqat AVTOMATIK bloklarni tozalaydi (qo'lda qo'yilganlari qoladi)
 *   node scripts/unban.js --all         → BARCHA bloklarni tozalaydi
 *
 * DIQQAT: DB tozalangach, xotiradagi bloklar ham ketishi uchun serverni
 * qayta ishga tushiring:  pm2 restart rateradar
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import BannedIp from '../src/models/BannedIp.js';

async function main() {
  const args = process.argv.slice(2);
  await mongoose.connect(env.MONGODB_URI);
  console.log('✓ MongoDB ulandi\n');

  const active = { $or: [{ permanent: true }, { until: { $gt: new Date() } }] };

  if (args.length === 0) {
    const rows = await BannedIp.find().sort({ createdAt: -1 }).lean();
    if (!rows.length) {
      console.log('Bloklangan IP yo\'q.');
    } else {
      console.log(`Jami ${rows.length} ta yozuv:\n`);
      for (const b of rows) {
        const state = b.permanent ? 'PERMANENT' : b.until && new Date(b.until) > new Date() ? `until ${new Date(b.until).toISOString()}` : 'expired';
        console.log(`  ${b.ip.padEnd(24)} [${b.source}] ${state}  — ${b.reason || ''}`);
      }
      console.log('\nTozalash uchun:  node scripts/unban.js --auto   (yoki --all / <ip>)');
    }
    await done();
    return;
  }

  let filter;
  if (args.includes('--all')) {
    filter = {};
    console.log('BARCHA bloklar tozalanmoqda...');
  } else if (args.includes('--auto')) {
    filter = { source: 'auto' };
    console.log('AVTOMATIK bloklar tozalanmoqda (qo\'lda qo\'yilganlari qoladi)...');
  } else {
    filter = { ip: { $in: args } };
    console.log(`Blokdan chiqarilmoqda: ${args.join(', ')}`);
  }

  const res = await BannedIp.deleteMany(filter);
  console.log(`\n✓ ${res.deletedCount} ta yozuv o'chirildi.`);
  console.log('\n⚠️  Xotiradagi bloklar ham ketishi uchun:  pm2 restart rateradar');
  await done();
}

async function done() {
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Xato:', e.message);
  process.exit(1);
});
