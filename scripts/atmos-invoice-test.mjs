/**
 * ATMOS Invoice/Checkout (Visa/Mastercard) — item-format aniqlash testi.
 *
 * ISHLATISH (production serverda, backend papkadan):
 *   node scripts/atmos-invoice-test.mjs
 *
 * Bir necha item-format variantini ketma-ket sinaydi va qaysi biri
 * SUCCESS (url qaytaradi) berishini ko'rsatadi. -4 = "amount != items"
 * (item monetar maydoni ATMOS kutgan nom bilan mos emas).
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import axios from 'axios';

const BASE = env.ATMOS_BASE_URL || 'https://apigw.atmos.uz';
const STORE = Number(env.ATMOS_STORE_ID);
const AMOUNT = 100000; // 1 000 so'm tiyinda

console.log('STORE_ID :', STORE, ' BASE:', BASE, '\n');

// ── token ──
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

// Sinaladigan item-format variantlari:
const variants = {
  'A: {items_id,name,amount,quantity} (joriy kod)': [{ items_id: '1', name: 'RateRadar', amount: AMOUNT, quantity: 1 }],
  'B: {item_id,name,price,count}': [{ item_id: '1', name: 'RateRadar', price: AMOUNT, count: 1 }],
  'C: {name,price,quantity}': [{ name: 'RateRadar', price: AMOUNT, quantity: 1 }],
  'D: {name,amount} (quantitysiz)': [{ name: 'RateRadar', amount: AMOUNT }],
  'E: items=[] (bo\'sh)': [],
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
      if (!winner) winner = label;
    } else {
      const desc = data?.status?.locale?.uz || data?.status?.description || '';
      console.log(`❌ ${label} → code ${code} ${desc}`);
    }
  } catch (e) {
    console.log(`⚠️  ${label} → ${e.response ? JSON.stringify(e.response.data) : e.message}`);
  }
}

console.log('\n──────────────');
if (winner) console.log('ISHLAYDIGAN FORMAT:', winner, '\n→ payment.controller.js shu formatda bo\'lsin.');
else console.log('Hech biri ishlamadi — ATMOS item-schema hujjatini so\'rash kerak.');
