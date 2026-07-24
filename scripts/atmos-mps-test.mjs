/**
 * ATMOS /mps (Visa/Mastercard) — jonli tekshiruv.
 *
 * ISHLATISH (production serverda, backend papkadan) — karta env orqali:
 *   TEST_PAN=4231200090007831 TEST_EXPIRY=2912 TEST_CVC=123 TEST_NAME="UMIDJON GAFFOROV" \
 *   node scripts/atmos-mps-test.mjs
 *
 * expiry FORMAT: YYMM (masalan 12/29 → "2912").
 * Bu 1000 so'm (100000 tiyin) test to'lovini boshlaydi. `create` javobida
 * card_id + redirect_uri (3DS sahifasi) chiqishi kerak — o'sha bizga kerak.
 * 3DS'ni brauzerда tugatib, keyin apply/get bilan holatни tekshirsa bo'ladi.
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { mpsPreCreate, mpsCreate, mpsGet } from '../src/services/atmos.service.js';

const pan = process.env.TEST_PAN;
const expiry = process.env.TEST_EXPIRY;    // YYMM
const cvc = process.env.TEST_CVC;
const name = process.env.TEST_NAME || 'CARD HOLDER';

if (!pan || !expiry || !cvc) {
  console.log('❌ TEST_PAN, TEST_EXPIRY (YYMM), TEST_CVC env kerak.');
  console.log('Masalan: TEST_PAN=4231... TEST_EXPIRY=2912 TEST_CVC=123 node scripts/atmos-mps-test.mjs');
  process.exit(1);
}

console.log('STORE_ID:', env.ATMOS_STORE_ID, ' apikey set:', !!env.ATMOS_API_KEY, '\n');

const AMOUNT = 100000; // 1000 so'm tiyinda
const account = 'mpstest' + String(process.hrtime.bigint()).slice(-8);
const extId = account;

try {
  console.log('1) pre-create...');
  const pre = await mpsPreCreate({ amount: AMOUNT, account, extId });
  console.log('   transaction_id:', pre.transactionId);

  console.log('2) create (karta + 3DS)...');
  const created = await mpsCreate({
    pan, expiry, amount: AMOUNT, transactionId: pre.transactionId,
    cardName: name, cvc2: cvc, clientIp: '0.0.0.0', extId,
  });
  console.log('   ✅ card_id     :', created.cardId);
  console.log('   card_type      :', created.cardType);
  console.log('   masked_pan     :', created.maskedPan);
  console.log('   status         :', created.status, '| result:', created.resultCode);
  console.log('   redirect_uri   :', created.redirectUri);
  console.log('');
  if (created.redirectUri) {
    console.log('➡️  Shu URL\'ni brauzerда oching va 3DS (SMS-kod)\'ni tugating:');
    console.log('   ', created.redirectUri);
    console.log('');
    console.log('So\'ng holatни ko\'rish: node -e "..." yoki apply. transaction_id =', pre.transactionId);
  }
  console.log('\nTO\'LIQ create payload:', JSON.stringify(created.payload));

  // Holatni bir marta o'qiymiz (3DS'gacha odatda PENDING).
  const g = await mpsGet(pre.transactionId);
  console.log('\nget payload:', JSON.stringify(g.payload));
} catch (e) {
  console.log('❌ FAILED:', e.message);
  if (e.atmos?.raw) console.log('   ATMOS javobi:', JSON.stringify(e.atmos.raw));
}
