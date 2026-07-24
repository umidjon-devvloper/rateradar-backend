/**
 * ATMOS Invoice — YAKUNIY tasdiqlash testi.
 *
 * Real to'lov kodidagi (payment.controller.js) AYNAN o'sha formatni yuboradi:
 *   items[].details = OBYEKT { package_code }, item.amount summasi = invoice amount.
 *
 * ISHLATISH (production serverda, backend papkadan):
 *   node scripts/atmos-invoice-test.mjs
 *
 * ✅ SUCCESS + checkout.atmos.uz url  →  Visa/MC to'lovi to'liq ishlaydi.
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { createInvoice, isAtmosConfigured } from '../src/services/atmos.service.js';

console.log('ATMOS configured :', isAtmosConfigured());
console.log('STORE_ID         :', env.ATMOS_STORE_ID);
console.log('PACKAGE_CODE     :', env.ATMOS_PACKAGE_CODE);
console.log('');

const AMOUNT = 100000; // 1 000 so'm (tiyin) — test summa
const account = 'atmostest' + String(process.hrtime.bigint()).slice(-9);

try {
  const r = await createInvoice({
    amount: AMOUNT,
    account,
    requestId: account,
    successUrl: `https://thehotelsaas.com/billing?pay=${account}`,
    items: [
      {
        items_id: '1',
        name: 'TheHotelSaaS Pro',
        amount: AMOUNT,
        quantity: 1,
        details: { package_code: env.ATMOS_PACKAGE_CODE },
      },
    ],
  });
  console.log('✅ SUCCESS — Visa/MC invoice YARATILDI.');
  console.log('   url        :', r.url);
  console.log('   payment_id :', r.payment_id);
  console.log('   token      :', r.token);
  console.log('\nShu url\'ni brauzerda ochib Visa karta bilan sinab ko\'rsangiz bo\'ladi.');
} catch (e) {
  console.log('❌ FAILED:', e.message);
  if (e.atmos?.raw) console.log('   ATMOS javobi:', JSON.stringify(e.atmos.raw));
}
