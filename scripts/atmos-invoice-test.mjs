/**
 * ATMOS Invoice/Checkout (Visa/Mastercard) — jonli tekshiruv.
 *
 * ISHLATISH (production serverda, backend papkadan):
 *   node scripts/atmos-invoice-test.mjs
 *
 * MUHIM: ATMOS shlyuzi (apigw.atmos.uz) odatda IP-whitelist qiladi —
 * shuning uchun bu FAQAT whitelistlangan serverdan (Humo ishlayotgan
 * joydan) ishlaydi. Lokal kompyuterdan ETIMEDOUT beradi.
 *
 * Muvaffaqiyat: "SUCCESS! url: https://checkout.atmos.uz/..." — Visa yoqilgan.
 * -999999 System error: mahsulot yoqilmagan / store noto'g'ri / domen ro'yxatda yo'q.
 */
import 'dotenv/config';
import { createInvoice, isAtmosConfigured } from '../src/services/atmos.service.js';

console.log('ATMOS configured :', isAtmosConfigured());
console.log('STORE_ID (.env)  :', process.env.ATMOS_STORE_ID);
console.log('BASE_URL         :', process.env.ATMOS_BASE_URL || 'https://apigw.atmos.uz');
console.log('');

const requestId = 'test' + String(process.hrtime.bigint()).slice(-9);
try {
  const r = await createInvoice({
    amount: 100000, // 1 000 so'm (tiyinda) — eng kichik test summa
    account: 'atmos-selftest',
    requestId,
    successUrl: 'https://thehotelsaas.com/billing',
    items: [{ name: 'RateRadar test', quantity: 1, price: 100000 }],
  });
  console.log('✅ SUCCESS — Visa/Checkout YOQILGAN.');
  console.log('   url        :', r.url);
  console.log('   payment_id :', r.payment_id);
  console.log('   token      :', r.token);
} catch (e) {
  console.log('❌ FAILED:', e.message);
  if (e.atmos?.raw) console.log('   ATMOS javobi:', JSON.stringify(e.atmos.raw));
  console.log('');
  console.log('Tekshiring:');
  console.log('  1) ATMOS store raqami .env ATMOS_STORE_ID bilan bir xilmi?');
  console.log('  2) Invoice/Checkout mahsuloti SHU store uchun yoqilganmi?');
  console.log('  3) success_url domeni (thehotelsaas.com) ATMOS ro\'yxatida bormi?');
}
