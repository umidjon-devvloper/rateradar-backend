import axios from 'axios';
import { env } from '../config/env.js';
import { recordApiUsage } from '../utils/apiUsageTracker.js';

/**
 * Scrape.do — Google Hotels plugin (STRUKTURAVIY narx API).
 * https://scrape.do → /plugin/google/hotels (listing) + /detail (per-vendor).
 *
 * SerpAPI google_hotels'ning to'liq ekvivalenti:
 *   • listing: shahar bo'yicha 20 mehmonxona (nom, reyting, sharh, narx,
 *     hotel_class, reviews_breakdown, detail_token)
 *   • detail:  bitta hotelning BARCHA OTA vendorlari (Booking, Agoda, Expedia,
 *     Hotels.com, Trip.com, Priceline, Vio...) jonli rate_per_night bilan
 *
 * Har so'rov = 10 kredit. `getScrapedoHotelData` SerpAPI'ning
 * getSerpApiHotelData bilan AYNAN BIR XIL shakl qaytaradi — shu tufayli
 * asosiy oqim uni birinchi, SerpAPI'ni fallback qilib ishlata oladi.
 */

const LISTING = 'https://api.scrape.do/plugin/google/hotels';
const DETAIL = 'https://api.scrape.do/plugin/google/hotels/detail';
const TIMEOUT = 90_000;

export const hasScrapedoHotels = () => Boolean(env.SCRAPEDO_API_KEY);

// ── SHAHAR LISTING KESHI (kredit tejash) ──────────────────────────────────
// listing so'rovi butun shaharni (20 hotel) qaytaradi va 10 kredit yeydi.
// Bir yangilashda o'z hotel + barcha raqiblar SHU BITTA listing'ni bo'lishadi
// — har biriga alohida so'rov qilmaymiz. 15 daqiqa keshlanadi.
const _cityCache = new Map(); // key → { data, ts }
const CITY_TTL = 15 * 60 * 1000;

function cityKey(city, checkIn, checkOut, cur, gl) {
  return `${String(city).toLowerCase()}|${checkIn}|${checkOut}|${cur}|${gl}`;
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Nom mosligini baholash (SerpAPI'dagi bilan bir xil mantiq) ──
function normStr(s) {
  return String(s || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function findBestMatch(targetName, items) {
  if (!items?.length) return null;
  const target = normStr(targetName);
  const words = target.split(/\s+/).filter((w) => w.length > 2);
  let best = null, bestScore = -1;
  for (const it of items) {
    const n = normStr(it.name || '');
    let score = 0;
    if (n === target) score = 100;
    else if (n.includes(target) || target.includes(n)) score = 80;
    else for (const w of words) if (n.includes(w)) score += 15;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return { best, score: bestScore };
}

// OTA nom normalizatsiyasi (Booking.com, Hotels.com... standart)
function normalizeSourceName(s) {
  const t = String(s || '').trim();
  const map = {
    'booking.com': 'Booking.com', 'hotels.com': 'Hotels.com',
    'trip.com': 'Trip.com', 'agoda': 'Agoda', 'expedia.com': 'Expedia',
    'expedia': 'Expedia', 'priceline': 'Priceline', 'vio.com': 'Vio.com',
    'edreams': 'eDreams', 'travelocity.com': 'Travelocity',
  };
  return map[t.toLowerCase()] || t;
}

// EslATMA: Scrape.do'ning reviews_breakdown'idagi positive/negative maydonlari
// ishonchsiz (positive doim 1 keladi) — shuning uchun BU YERDAN kategoriya
// baholari OLINMAYDI. Kategoriya reytinglari getMyCategoryRatings zanjirida
// alohida, ishonchli manbalardan olinadi (Booking-direct subscore: 8.7, 9.1...).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scrape.do 502/500 = O'TKINCHI xato (ularning hujjati: "Transient. Retry").
// 3 martagacha qayta urinamiz — shusiz detail so'rovi ~1/3 hollarda yiqiladi.
async function sdoGet(url, params, attempt = 1) {
  const MAX = 3;
  try {
    const r = await axios.get(url, {
      params: { ...params, token: env.SCRAPEDO_API_KEY },
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    const status = err.response?.status;
    const retriable = status === 502 || status === 500 || err.code === 'ECONNABORTED';
    if (retriable && attempt < MAX) {
      await sleep(800 * attempt); // 0.8s, 1.6s backoff
      return sdoGet(url, params, attempt + 1);
    }
    throw err;
  }
}

// Shahar listing'ini oladi — avval keshdan, bo'lmasa API'dan (10 kredit).
async function getCityListing(city, countryCode, checkIn, checkOut, cur) {
  const gl = (countryCode || 'us').toLowerCase();
  const key = cityKey(city, checkIn, checkOut, cur, gl);
  const hit = _cityCache.get(key);
  if (hit && Date.now() - hit.ts < CITY_TTL) return hit.data;

  try {
    const data = await sdoGet(LISTING, {
      q: `${city} hotels`.trim(),
      check_in_date: checkIn, check_out_date: checkOut,
      currency: cur, gl, hl: 'en', limit: 20,
    });
    recordApiUsage('scrapedo', true, null, 'hotels_listing');
    const props = Array.isArray(data?.properties) ? data.properties : [];
    _cityCache.set(key, { data: props, ts: Date.now() });
    return props;
  } catch (err) {
    recordApiUsage('scrapedo', false, err.message, 'hotels_listing');
    console.warn('Scrape.do hotels listing xato:', err.response?.status || '', err.message);
    return null;
  }
}

/**
 * Hotel narx + OTA kanallar + reyting — SerpAPI shaklida.
 *
 * @param opts.detail  true (default) = per-vendor OTA shelf (detail, +10 kredit).
 *   false = faqat listing'dagi bazaviy narx (raqiblar uchun — kredit tejaydi,
 *   detail so'rovi qilinmaydi).
 * @returns SerpAPI getSerpApiHotelData bilan bir xil obyekt yoki null.
 */
export async function getScrapedoHotelData({ name, city = '', countryCode = '', currency = 'USD', detail = true }) {
  if (!hasScrapedoHotels() || !name) return null;

  const checkIn = dateOffset(1);
  const checkOut = dateOffset(2);
  const cur = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';

  // Shahar listing (keshlangan — bir yangilashda barcha hotel bo'lishadi)
  const props = await getCityListing(city || name, countryCode, checkIn, checkOut, cur);
  let match = null, score = -1;
  if (props?.length) ({ best: match, score } = findBestMatch(name, props));

  // KICHIK HOTEL fallback: shahar top-20'sida yo'q bo'lsa (SULEYMAN kabi),
  // nom bo'yicha aniq qidiruv qilamiz ("Suleyman Hotel Bukhara"). +10 kredit,
  // lekin faqat topilmaganda va keshlanadi.
  if ((!match || score < 30) && name) {
    const nameProps = await getCityListing(
      `${name} ${city}`.trim(), countryCode, checkIn, checkOut, cur);
    if (nameProps?.length) {
      const r = findBestMatch(name, nameProps);
      if (r.best && r.score >= 30) { match = r.best; score = r.score; }
    }
  }
  if (!match || score < 30) return null;

  const result = {
    propertyToken: '', // Scrape.do detail_token barqaror emas — saqlamaymiz
    currency: cur,
    name: match.name || name,
    rating: Number(match.overall_rating) || 0,
    reviewCount: Number(match.reviews) || 0,
    lowestPrice: match.price?.amount ? Math.round(match.price.amount) : 0,
    otaPrices: [],
    image: match.images?.[0]?.original_image || match.images?.[0]?.thumbnail || null,
    link: null,
    address: '',
    amenities: match.amenities || [],
    hotelClass: match.extracted_hotel_class || 0,
    categoryRatings: null, // kategoriya alohida zanjirda (ishonchliroq manbadan)
    source: 'scrapedo',
  };

  // ── Detail: per-vendor OTA narxlari (faqat detail=true bo'lsa, +10 kredit) ──
  // Raqiblar uchun detail=false — listing'dagi bazaviy narx yetadi (tejamkorlik).
  if (detail && match.detail_token) {
    try {
      const detail = await sdoGet(DETAIL, {
        detail_token: match.detail_token,
        check_in_date: checkIn,
        check_out_date: checkOut,
        currency: cur,
        gl: (countryCode || 'us').toLowerCase(),
        hl: 'en',
      });
      recordApiUsage('scrapedo', true, null, 'hotels_detail');

      const sources = detail?.property?.booking_sources || [];
      const merged = new Map(); // manba → eng arzon
      for (const s of sources) {
        const source = normalizeSourceName(s.name);
        const price = Math.round(Number(s.rate_per_night?.amount) || 0);
        if (!source || price <= 0) continue;
        const cur2 = merged.get(source);
        if (!cur2 || price < cur2.price) {
          merged.set(source, {
            source, price, priceType: 'total',
            link: s.click ? `https://www.google.com${s.click}` : null,
            logo: s.icon ? `https:${s.icon}` : null,
            official: Boolean(s.sponsored),
            currency: cur,
          });
        }
      }
      result.otaPrices = [...merged.values()];
      if (!result.lowestPrice && result.otaPrices.length) {
        result.lowestPrice = Math.min(...result.otaPrices.map((o) => o.price));
      }
    } catch (err) {
      recordApiUsage('scrapedo', false, err.message, 'hotels_detail');
      console.warn('Scrape.do hotels detail xato:', err.response?.status || '', err.message);
      // Detail bo'lmasa ham listing narxi bor — result qaytaramiz
    }
  }

  return result;
}
