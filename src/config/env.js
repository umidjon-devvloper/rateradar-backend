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
  // SerpAPI oylik so'rov limiti (pullik obunaga mos qiymat qo'ying).
  SERPAPI_MONTHLY_LIMIT: z.string().default('5000'),
  APIFY_API_KEY: z.string().optional(),
  BOOKING_RAPIDAPI_KEY: z.string().optional(),
  EXPEDIA_RAPIDAPI_KEY: z.string().optional(),
  TRIP_RAPIDAPI_KEY: z.string().optional(),
  XOTELO_RAPIDAPI_KEY: z.string().optional(),
  HASDATA_API_KEY: z.string().optional(),
  // Scrape.do — universal sahifa-tortish (Booking identity/kategoriya baholari
  // fallback'i). Bepul 1000 kredit/oy. https://scrape.do
  SCRAPEDO_API_KEY: z.string().optional(),
  // TripAdvisor rasmiy Content API — reyting, ranking, sharhlar (5 ta), rasmlar.
  // https://www.tripadvisor.com/developers — kalit IP whitelist talab qiladi.
  TRIPADVISOR_API_KEY: z.string().optional(),
  // Content API kaliti referer bilan cheklangan bo'lsa, shu domen yuboriladi.
  TRIPADVISOR_REFERER: z.string().optional(),
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
  // Places kaliti "HTTP referrers" cheklovli bo'lsa, serverdan yuboriladigan
  // Referer sarlavhasi (masalan https://rateradar.uz). Aks holda Google
  // 403 API_KEY_HTTP_REFERRER_BLOCKED qaytaradi. IP-cheklovli kalitda shart emas.
  GOOGLE_PLACES_REFERER: z.string().optional(),
  MAKCORPS_API_KEY: z.string().optional(),

  // ─── EXELY (Connect API) — mehmonxonaning O'Z bron ma'lumoti ──────────
  // Multi-tenant: har mijoz o'z client_id/secret'ini Settings orqali kiritadi
  // va u `Integration` hujjatida SHIFRLANGAN holda saqlanadi. Bu yerdagi
  // qiymatlar faqat umumiy (barcha ijarachilar uchun bir xil) sozlamalar.
  //
  //   • EXELY_BASE_URL — production: https://connect.hopenapi.com
  //                      test:       https://connect.test.hopenapi.com
  //   • EXELY_ENC_KEY  — mijoz secret'larini shifrlash kaliti (AES-256-GCM).
  //       Berilmasa JWT_SECRET'dan scrypt bilan hosil qilinadi — lokalda
  //       hech narsa sozlamasdan ishlaydi. PRODUCTIONDA ALOHIDA QO'YING:
  //       kalit almashsa, saqlangan secret'lar o'qib bo'lmaydigan bo'ladi.
  //   • EXELY_SYNC_ENABLED — cron sinxronizatsiyani o'chirish uchun 'false'.
  EXELY_BASE_URL: z.string().default('https://connect.hopenapi.com'),
  EXELY_ENC_KEY: z.string().optional(),
  EXELY_SYNC_ENABLED: z.enum(['true', 'false']).default('true'),

  // ─── Hotels scraper MIKROSERVISI (alohida puppeteer server) ────────────
  // Boshqa BARCHA manba (Google Places, SERP, OSM/Overpass) hotelni topmasa,
  // oxirgi chora sifatida shu skreyper serveriga HTTP so'rov yuboriladi va u
  // Booking.com'ni real vaqtda skreyp qilib aniq ma'lumot (nom, manzil, narx,
  // reyting, rasm) qaytaradi. Skreyper `hotels-scraper-js` papkasida alohida
  // ishlaydi: `npm run dev` (fastify API, default port 3000).
  //   • HOTEL_SCRAPER_ENABLED  — 'true' (default) yoki 'false' bilan o'chiriladi.
  //   • HOTEL_SCRAPER_URL      — skreyper server manzili (default http://localhost:3000).
  //   • HOTEL_SCRAPER_API_KEY  — skreyper .env dagi API_KEYS kalitlaridan biri.
  //       Default 'dev-key-123' — skreyperning bootstrap kaliti bilan bir xil,
  //       shunda lokalda hech narsa sozlamasdan ishlaydi. Productionda almashtiring.
  HOTEL_SCRAPER_ENABLED: z.enum(['true', 'false']).default('true'),
  HOTEL_SCRAPER_URL: z.string().default('http://localhost:3000'),
  HOTEL_SCRAPER_API_KEY: z.string().default('dev-key-123'),
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
  // Landing formasidagi bog'lanish so'rovlari (lead) shu pochtaga keladi.
  LEADS_EMAIL: z.string().default('info@thehotelsaas.com'),

  // ─── ATMOS to'lov shlyuzi (UzCard / Humo) ────────────────────────────
  // Kalitlar ATMOS tomonidan merchant ro'yxatdan o'tgach beriladi.
  // Test (sandbox) kartalar ham shu kalitlar bilan ishlaydi.
  ATMOS_BASE_URL: z.string().default('https://apigw.atmos.uz'),
  ATMOS_CONSUMER_KEY: z.string().optional(),
  ATMOS_CONSUMER_SECRET: z.string().optional(),
  ATMOS_STORE_ID: z.string().optional(),       // merchant (store) id
  ATMOS_TERMINAL_ID: z.string().optional(),    // ixtiyoriy — 1 terminal bo'lsa shart emas
  ATMOS_API_KEY: z.string().optional(),        // Callback imzosini (sign) tekshirish uchun
  // Invoice/Checkout (Visa/MC) uchun ИКПУ — soliq fiskal mahsulot kodi.
  // ATMOS items[].details.package_code sifatida yuboriladi (MAJBURIY).
  // To'g'ri ИКПУ merchant soliq ro'yxatiga bog'liq — buxgalter/ATMOS bilan tasdiqlang.
  ATMOS_PACKAGE_CODE: z.string().default('10305001001000000'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ .env xatosi:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isDev = env.NODE_ENV === 'development';
