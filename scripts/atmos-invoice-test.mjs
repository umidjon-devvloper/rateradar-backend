/**
 * ATMOS Invoice — DETAILS bilan item-format aniqlash (2-bosqich).
 *
 * ISHLATISH (production serverda, backend papkadan):
 *   node scripts/atmos-invoice-test.mjs
 *
 * 1-bosqichda aniqlandi: item monetar maydoni = `amount`, va `details`
 * massivi MAJBURIY (yo'q bo'lsa -999999). Bu bosqich `details`'ning
 * qaysi minimal ko'rinishi ishlashini topadi.
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import axios from 'axios';

const BASE = env.ATMOS_BASE_URL || 'https://apigw.atmos.uz';
const STORE = Number(env.ATMOS_STORE_ID);
const AMOUNT = 100000; // 1 000 so'm tiyinda

console.log('STORE_ID :', STORE, ' BASE:', BASE, '\n');

const basic = Buffer.from(`${env.ATMOS_CONSUMER_KEY}:${env.ATMOS_CONSUMER_SECRET}`).toString('base64');
const { data: tok } = await axios.post(`${BASE}/token`, 'grant_type=client_credentials', {
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  timeout: 30000,
});
const token = tok.access_token;

function localDate(min = 60) {
  const d = new Date(Date.now() + 5 * 3600e3 + min * 60e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Hammasida amount summasi = invoice AMOUNT. Faqat `details` ko'rinishi farq qiladi.
const base = { items_id: '1', name: 'RateRadar Pro', amount: AMOUNT, quantity: 1 };
const variants = {
  'F: details=[] (bo\'sh massiv)': [{ ...base, details: [] }],
  'G: details=[{name:package_code}]': [{ ...base, details: [{ name: 'package_code', values: '10305001001000000' }] }],
  'H: to\'liq details (hujjat misoli)': [{
    ...base, code: 'RRPRO',
    details: [
      { name: 'package_code', values: '10305001001000000' },
      { name: 'mark_code', values: '' },
      { name: 'tin', values: '' },
      { name: 'discount', values: '0' },
      { name: 'quantity', values: '1' },
    ],
  }],
  'I: details=[{name:quantity,values:1}]': [{ ...base, details: [{ name: 'quantity', values: '1' }] }],
};

let winner = null;
for (const [label, items] of Object.entries(variants)) {
  const rid = 'test' + String(process.hrtime.bigint()).slice(-9);
  const body = {
    request_id: rid, store_id: STORE, account: rid, amount: AMOUNT,
    success_url: 'https://thehotelsaas.com/billing',
    expiration_date: localDate(60), items,
  };
  try {
    const { data } = await axios.post(`${BASE}/checkout/invoice/create`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000,
    });
    const code = data?.status?.code;
    if (code === undefined || code === 'OK' || String(code) === '0') {
      console.log(`✅ ${label}\n   url: ${data.url}\n   payment_id: ${data.payment_id}`);
      if (!winner) winner = { label, items };
    } else {
      const desc = data?.status?.locale?.uz || data?.status?.description || '';
      console.log(`❌ ${label} → code ${code} ${desc}`);
    }
  } catch (e) {
    console.log(`⚠️  ${label} → ${e.response ? JSON.stringify(e.response.data) : e.message}`);
  }
}

console.log('\n──────────────');
if (winner) {
  console.log('ISHLAYDIGAN FORMAT:', winner.label);
  console.log('items namunasi:', JSON.stringify(winner.items, null, 2));
} else {
  console.log('Hech biri ishlamadi — natijani menga yuboring.');
}
