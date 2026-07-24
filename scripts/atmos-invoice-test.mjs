/**
 * ATMOS Invoice — details format diagnostikasi (3-bosqich).
 * Har variant uchun ATMOS'ning TO'LIQ xom javobini chiqaradi.
 *   node scripts/atmos-invoice-test.mjs
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import axios from 'axios';

const BASE = env.ATMOS_BASE_URL || 'https://apigw.atmos.uz';
const STORE = Number(env.ATMOS_STORE_ID);
const AMOUNT = 100000;

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

const base = { items_id: '1', name: 'RateRadar Pro', amount: AMOUNT, quantity: 1 };
const variants = {
  // details ichida `value` (birlik)
  'J: details value (birlik)': [{ ...base, details: [{ name: 'package_code', value: '10305001001000000' }] }],
  // details ichida `values` massiv sifatida
  'K: values massiv': [{ ...base, details: [{ name: 'package_code', values: ['10305001001000000'] }] }],
  // details — obyekt (massiv emas)
  'L: details obyekt': [{ ...base, details: { package_code: '10305001001000000' } }],
  // details YO'Q, lekin expiration_time qo'shilgan (hujjat misolida bor)
  'M: details yo\'q + expiration_time': [{ ...base }],
  // faqat majburiy minimal: items_id + name + amount (quantity/details yo'q)
  'N: minimal items_id+name+amount': [{ items_id: '1', name: 'RateRadar Pro', amount: AMOUNT }],
};

let winner = null;
for (const [label, items] of Object.entries(variants)) {
  const rid = 'test' + String(process.hrtime.bigint()).slice(-9);
  const body = {
    request_id: rid, store_id: STORE, account: rid, amount: AMOUNT,
    expiration_time: 60,
    success_url: 'https://thehotelsaas.com/billing',
    expiration_date: localDate(60), items,
  };
  try {
    const { data } = await axios.post(`${BASE}/checkout/invoice/create`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000,
    });
    const code = data?.status?.code;
    const ok = code === undefined || code === 'OK' || String(code) === '0';
    console.log(`${ok ? '✅' : '❌'} ${label}`);
    console.log('   RAW:', JSON.stringify(data));
    if (ok && !winner) winner = { label, items };
  } catch (e) {
    console.log(`⚠️  ${label} → ${e.response ? JSON.stringify(e.response.data) : e.message}`);
  }
}

console.log('\n──────────────');
if (winner) {
  console.log('ISHLAYDIGAN FORMAT:', winner.label);
  console.log('items:', JSON.stringify(winner.items, null, 2));
} else {
  console.log('Hech biri ishlamadi — yuqoridagi RAW javoblarni menga yuboring.');
}
