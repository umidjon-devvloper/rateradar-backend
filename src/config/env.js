import dotenv from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import path from 'path';

// .env yo'lini backend/ papkasiga nisbatan aniq belgilaymiz —
// shunda istalgan papkadan (cwd) skript ishga tushirilsa ham topiladi.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const schema = z.object({
  PORT: z.string().default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  ADMIN_URL: z.string().default('http://localhost:5174'),
  MONGODB_URI: z.string(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET kamida 16 belgidan iborat bo\'lishi kerak'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),
  APIFY_API_KEY: z.string().optional(),
  BOOKING_RAPIDAPI_KEY: z.string().optional(),
  EXPEDIA_RAPIDAPI_KEY: z.string().optional(),
  TRIP_RAPIDAPI_KEY: z.string().optional(),
  XOTELO_RAPIDAPI_KEY: z.string().optional(),
  HASDATA_API_KEY: z.string().optional(),
  // Yandex Maps Geosearch (Поиск по организациям) — mehmonxona org topish + URL.
  // https://yandex.com/maps-api/products/geosearch-api (JS API kalitidan alohida).
  YANDEX_GEOSEARCH_API_KEY: z.string().optional(),
  GEONAMES_USERNAME: z.string().default('demo'),
  // Shahar qidiruvi manbasi:
  //   'auto'  — lokal data/ fayli bo'lsa o'shani, bo'lmasa GeoNames API (default)
  //   'api'   — har doim api.geonames.org (lokal fayllar bo'lsa ham e'tiborsiz)
  //   'local' — faqat lokal fayllar (API'ga umuman bormaydi)
  // VPS'da 1.7GB dump yuklamaslik uchun 'api' qo'ying.
  CITIES_SOURCE: z.enum(['auto', 'api', 'local']).default('auto'),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  MAKCORPS_API_KEY: z.string().optional(),
  ADMIN_EMAIL: z.string().email().default('admin@rateradar.com'),
  ADMIN_PASSWORD: z.string().default('changeme123'),
  // API hujjatlari (/api/docs) uchun Basic Auth login. DOCS_PASSWORD
  // berilmasa, ADMIN_PASSWORD ishlatiladi.
  DOCS_USER: z.string().default('admin'),
  DOCS_PASSWORD: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // ─── ATMOS to'lov shlyuzi (UzCard / Humo) ────────────────────────────
  // Kalitlar ATMOS tomonidan merchant ro'yxatdan o'tgach beriladi.
  // Test (sandbox) kartalar ham shu kalitlar bilan ishlaydi.
  ATMOS_BASE_URL: z.string().default('https://apigw.atmos.uz'),
  ATMOS_CONSUMER_KEY: z.string().optional(),
  ATMOS_CONSUMER_SECRET: z.string().optional(),
  ATMOS_STORE_ID: z.string().optional(),       // merchant (store) id
  ATMOS_TERMINAL_ID: z.string().optional(),    // ixtiyoriy — 1 terminal bo'lsa shart emas
  ATMOS_API_KEY: z.string().optional(),        // Callback imzosini (sign) tekshirish uchun
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ .env xatosi:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isDev = env.NODE_ENV === 'development';
