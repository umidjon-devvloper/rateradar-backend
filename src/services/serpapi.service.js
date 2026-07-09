import axios from 'axios';
import { env } from '../config/env.js';

const BASE = 'https://serpapi.com/search';
const TIMEOUT = 20000;
const CACHE_TTL = 60 * 60 * 1000; // 1 soat

const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

export function hasSerpApi() {
  return Boolean(env.SERPAPI_API_KEY);
}

/**
 * google_hotels engine — 2 bosqichli:
 *   1) qidiruv (q + city)  → properties[] → eng mos hotel → property_token
 *   2) property_token bilan qayta so'rov → property details (prices[], featured_prices[])
 *
 * Bosqich-2 muhim: u barcha OTA partnerlarini qaytaradi (Booking, Agoda, Hotels.com,
 * Expedia, Trip.com, Priceline, Vio.com, eDreams va boshqalar). Birinchi bosqichda
 * faqat preview (1-3 ta partner) keladi.
 */
// SerpAPI Google Hotels qo'llab-quvvatlaydigan valyutalar (tasdiqlangan).
// Boshqalar (UZS, KZT, KGS, TJS …) 400 Bad Request qaytaradi.
const SERPAPI_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF',
  'INR', 'CNY', 'KRW', 'MXN', 'BRL', 'RUB', 'TRY',
  'PLN', 'SEK', 'NOK', 'DKK', 'CZK', 'HUF', 'AED',
  'SAR', 'SGD', 'HKD', 'THB', 'IDR', 'MYR', 'PHP',
  'ZAR', 'NZD', 'ILS',
]);

// Mehmonxona joylashgan davlatga ko'ra avtomatik valyuta tanlaymiz.
// SerpAPI'da bo'lmagan valyutalar uchun USD ishlatamiz (frontend keyin
// foydalanuvchi tiliga konvertatsiya qiladi).
const COUNTRY_CURRENCY = {
  RU: 'RUB',
  US: 'USD', GB: 'GBP',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
};

function currencyForCountry(countryCode) {
  const candidate = COUNTRY_CURRENCY[String(countryCode || '').toUpperCase()] || 'USD';
  return SERPAPI_CURRENCIES.has(candidate) ? candidate : 'USD';
}

export async function getSerpApiHotelData({
  name, city = '', countryCode = '', currency = '',
  // Saqlangan propertyToken — birinchi mos kelgan hotelni mahkamlaydi.
  // Keyingi yangilashlarda boshqa hotelga adashish bo'lmaydi.
  propertyToken: savedToken = '',
}) {
  if (!hasSerpApi()) return null;

  // Ertaga→tagiertasi rejimi (1 kun oldindan bron). Booking same-day
  // inventory yopilgan bo'lsa narx kelmaydi — +1 kun siljitish ishonchli.
  const checkIn = dateOffset(1);
  const checkOut = dateOffset(2);

  let resolvedCurrency = currency || currencyForCountry(countryCode);
  if (!SERPAPI_CURRENCIES.has(resolvedCurrency)) {
    resolvedCurrency = 'USD';
  }

  const cacheKey = `hotels:${(savedToken || name).toLowerCase()}:${city.toLowerCase()}:${checkIn}:${resolvedCurrency}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const commonParams = {
    gl: (countryCode || 'us').toLowerCase(),
    hl: 'en',
    check_in_date: checkIn,
    check_out_date: checkOut,
    currency: resolvedCurrency,
    // 2 odam — ko'pchilik OTA (Booking, Agoda, Expedia) 2 kishilik
    // narxlarni mukammalroq qaytaradi; 1 odam uchun Booking ba'zan
    // narxlarni o'tkazib yuboradi (Google Hotels carousel'ida ko'rinmaydi).
    adults: 1,
    api_key: env.SERPAPI_API_KEY,
  };

  // Mehmonxona nomi Google indeksida boshqacha yozilgan bo'lishi mumkin
  // (masalan "DENDI PLAZA HOTEL" → "Dendy Plaza"). Bir nechta variant sinaymiz.
  const cleanedName = name.replace(/\bhotel\b/gi, '').replace(/\s+/g, ' ').trim();
  const queryVariants = Array.from(new Set([
    city ? `${name} ${city}` : name,
    name,
    city && cleanedName ? `${cleanedName} ${city}` : null,
    cleanedName && cleanedName !== name ? cleanedName : null,
  ].filter(Boolean)));

  try {
    let match = null;
    let propertyToken = '';

    // Tezkor yo'l: saqlangan propertyToken bo'lsa, search bosqichini
    // o'tkazib yuboramiz — har safar bir xil mehmonxona olinadi.
    if (savedToken) {
      propertyToken = savedToken;
      match = { name }; // metadata bosqich-2 dan kelganda yangilanadi
    } else {
      let properties = [];
      let usedQuery = '';

      for (const q of queryVariants) {
        const searchRes = await axios.get(BASE, {
          params: { ...commonParams, engine: 'google_hotels', q },
          timeout: TIMEOUT,
        });
        const found = searchRes.data?.properties || searchRes.data?.hotels_results || [];
        if (found.length) {
          properties = found;
          usedQuery = q;
          break;
        }
      }

      if (!properties.length) {
        console.warn(`[SerpAPI] google_hotels: "${name}" topilmadi — google search fallback`);
        const fallback = await getGoogleSearchHotelPrices({ name, city, countryCode });
        if (fallback?.otaPrices?.length) {
          cacheSet(cacheKey, fallback);
          return fallback;
        }
        return null;
      }

      match = findBestMatch(name, properties);
      if (!match) {
        console.warn(`[SerpAPI] google_hotels: "${name}" — natijalar topildi ("${usedQuery}"), lekin nom mos kelmadi`);
        return null;
      }

      const tokenFromUrl = match.serpapi_property_details_link?.match(/[?&]property_token=([^&]+)/)?.[1];
      propertyToken = match.property_token || tokenFromUrl || '';
    }

    // Bazaviy ma'lumotlar — bosqich-1 dan
    let result = {
      propertyToken,
      currency: resolvedCurrency,
      name: match.name || name,
      rating: match.overall_rating || match.rating || 0,
      reviewCount: match.reviews || match.review_count || 0,
      lowestPrice: extractPrice(match),
      otaPrices: extractOtaPrices(match).map((o) => ({ ...o, currency: o.currency || resolvedCurrency })),
      image: match.images?.[0]?.original_image || match.images?.[0]?.thumbnail || match.thumbnail || null,
      link: match.link || null,
    };

    // ─── Bosqich 2: property details (token bilan) ───────────────────
    if (propertyToken) {
      try {
        const detailsRes = await axios.get(BASE, {
          params: {
            ...commonParams,
            engine: 'google_hotels',
            q: city ? `${name} ${city}` : name,
            property_token: propertyToken,
          },
          timeout: TIMEOUT,
        });

        const d = detailsRes.data || {};
        const fullOtaPrices = extractOtaPrices(d);

        // featured_prices + prices birlashtirish (manba bo'yicha takror chiqarib tashlash)
        const merged = mergeOtaPrices([...(result.otaPrices || []), ...fullOtaPrices]);

        result = {
          ...result,
          currency: resolvedCurrency,
          name: d.name || result.name,
          rating: d.overall_rating || d.rating || result.rating,
          reviewCount: d.reviews || d.review_count || result.reviewCount,
          lowestPrice: extractPrice(d) || result.lowestPrice,
          otaPrices: merged.map((o) => ({ ...o, currency: o.currency || resolvedCurrency })),
          image: d.images?.[0]?.original_image || d.images?.[0]?.thumbnail || d.featured_image || result.image,
          link: d.link || result.link,
          address: d.address || '',
          amenities: d.amenities || [],
          hotelClass: d.hotel_class || d.extracted_hotel_class || 0,
          // Kategoriya reytinglari — shu javobning o'zida keladi (qo'shimcha
          // so'rovsiz). getSerpApiCategoryRatings shu maydonni ishlatadi.
          categoryRatings: parseReviewsBreakdown(d),
        };
      } catch (err) {
        // Bosqich-2 muvaffaqiyatsiz bo'lsa, bosqich-1 ma'lumotini qaytaramiz
        console.warn('SerpAPI property details xato:', err.response?.status || '', err.message);
      }
    }

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) console.warn('SerpAPI: kvota tugagan (429)');
    else console.warn('SerpAPI google_hotels xato:', status || '', err.message);
    return null;
  }
}

/**
 * Google Hotels `reviews_breakdown` → 10 ballik kategoriya baholari.
 * Google har kategoriya bo'yicha eslatmalar sonini beradi (positive/negative/
 * neutral), rasmiy subscore emas — shuning uchun ballni o'zimiz hisoblaymiz:
 *   ball = positive / total_mentioned × 10
 * Umumiy reyting 5 ballik keladi → ×2 (10 ballik shkala, frontend'ga mos).
 */
function parseReviewsBreakdown(d) {
  const rows = Array.isArray(d?.reviews_breakdown) ? d.reviews_breakdown : [];
  const scores = {};
  for (const r of rows) {
    const label = String(r?.name || r?.description || '').trim();
    const total = Number(r?.total_mentioned) || 0;
    const positive = Number(r?.positive) || 0;
    // 3 tadan kam eslatma — statistik ishonchsiz, tashlab yuboramiz.
    if (!label || total < 3) continue;
    scores[label] = Math.round((positive / total) * 100) / 10;
  }
  if (!Object.keys(scores).length) return null;
  const overall5 = Number(d?.overall_rating || d?.rating) || 0;
  return { overall: Math.round(overall5 * 20) / 10, scores };
}

/**
 * Kategoriya reytinglari — google_hotels property details'dagi
 * reviews_breakdown'dan. getSerpApiHotelData bilan bir xil kesh (1 soat):
 * narx yangilanishi yaqinda o'tgan bo'lsa, qo'shimcha SerpAPI so'rovi ketmaydi.
 *
 * @returns {Promise<{overall:number, scores:Record<string,number>, propertyToken:string} | null>}
 */
export async function getSerpApiCategoryRatings({ name, city = '', countryCode = '', propertyToken = '' }) {
  const data = await getSerpApiHotelData({ name, city, countryCode, propertyToken });
  if (!data?.categoryRatings) return null;
  return { ...data.categoryRatings, propertyToken: data.propertyToken || '' };
}

/**
 * google_hotels_reviews engine — mehmon sharhlarini olish.
 * Google Hotels o'zi sharhlarini Booking.com, Agoda, Hotels.com, Expedia,
 * TripAdvisor va boshqa OTA'lardan aggregatsiya qiladi. Har bir review'da
 * `source` maydoni asl manbani ko'rsatadi.
 *
 * Opsiyalar:
 *   propertyToken (majburiy)
 *   sortBy: 'newestFirst' | 'ratingHigh' | 'ratingLow' | 'mostRelevant' (default)
 *   maxPages: necha sahifa olib kelish (default 1; har sahifa ~10 review)
 */
export async function getSerpApiReviews({ propertyToken, sortBy = 'newestFirst', maxPages = 1 }) {
  if (!hasSerpApi() || !propertyToken) return null;

  const cacheKey = `reviews:${propertyToken}:${sortBy || 'default'}:${maxPages}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const sortMap = {
    newestFirst: 'newestFirst',
    ratingHigh: 'ratingHigh',
    ratingLow: 'ratingLow',
    mostRelevant: 'qualityScore',
  };

  try {
    let allReviews = [];
    let overallRating = 0;
    let totalReviews = 0;
    let breakdown = {};
    let nextPageToken = null;

    for (let page = 0; page < maxPages; page += 1) {
      const params = {
        engine: 'google_hotels_reviews',
        property_token: propertyToken,
        hl: 'en',
        api_key: env.SERPAPI_API_KEY,
      };
      if (sortBy && sortMap[sortBy]) params.sort_by = sortMap[sortBy];
      if (nextPageToken) params.next_page_token = nextPageToken;

      const r = await axios.get(BASE, { params, timeout: TIMEOUT });
      const data = r.data || {};

      if (page === 0) {
        overallRating = data.overall_rating || data.rating || 0;
        totalReviews = data.total_reviews || data.reviews_count || (data.user_reviews?.total_count) || 0;
        breakdown = normalizeBreakdown(data.rating_breakdown || data.reviews_breakdown || {});
      }

      const pageReviews = (data.reviews || data.user_reviews?.reviews || []).map((rv) => ({
        source: normalizeReviewSource(rv.source || rv.provider || 'Google'),
        rating: Number(rv.rating) || 0,
        text: rv.description || rv.text || rv.snippet || rv.comment || '',
        author: rv.username || rv.author || rv.user?.name || rv.name || 'Anonymous',
        date: rv.date || rv.published_date || rv.published_at || '',
        language: rv.language || 'en',
        link: rv.link || null,
      }));
      allReviews = allReviews.concat(pageReviews);

      nextPageToken = data.serpapi_pagination?.next_page_token || data.next_page_token || null;
      if (!nextPageToken) break;
    }

    const result = {
      overallRating,
      totalReviews,
      breakdown,
      reviews: allReviews,
      bySource: groupReviewsBySource(allReviews),
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) console.warn('SerpAPI reviews: kvota tugagan (429)');
    else console.warn('SerpAPI google_hotels_reviews xato:', status || '', err.message);
    return null;
  }
}

/**
 * Google qidiruv (engine=google) orqali mehmonxonaning hotel knowledge panel'idan
 * OTA narxlarini chiqaradi. Bu screenshotdagi "Booking.com 762762 UZS, Trip.com ..."
 * panelining ma'lumotidir.
 *
 * google_hotels engine ba'zi mehmonxonalarni topmaydi (yangi yoki mahalliylari).
 * Lekin ular oddiy Google qidiruvda hotel knowledge panel bilan paydo bo'ladi.
 */
export async function getGoogleSearchHotelPrices({ name, city = '', countryCode = '' }) {
  if (!hasSerpApi()) return null;
  try {
    const r = await axios.get(BASE, {
      params: {
        engine: 'google',
        q: city ? `${name} ${city} hotel` : `${name} hotel`,
        gl: (countryCode || 'us').toLowerCase(),
        hl: 'en',
        currency: 'USD',
        api_key: env.SERPAPI_API_KEY,
      },
      timeout: TIMEOUT,
    });
    const data = r.data || {};

    // Hotel knowledge panel — narxlar inline_hotels'da yoki knowledge_graph'da bo'lishi mumkin
    const otaPricesRaw = [];

    // 1) inline_hotels (SerpAPI returns this when Google shows hotel pricing carousel)
    const inlineHotels = data.inline_hotels?.hotels || data.inline_hotels?.results || [];
    for (const h of inlineHotels) {
      if (h.source && (h.price || h.rate_per_night)) {
        otaPricesRaw.push({
          source: h.source,
          price: h.rate_per_night?.extracted_lowest || h.extracted_price || extractPrice(h) || 0,
          link: h.link || null,
          official: Boolean(h.official),
        });
      }
    }

    // 2) knowledge_graph.hotel_prices / prices
    const kg = data.knowledge_graph || {};
    const kgPrices = kg.hotel_prices || kg.prices || kg.pricing || [];
    for (const p of (Array.isArray(kgPrices) ? kgPrices : [])) {
      if ((p.source || p.partner || p.name) && (p.price || p.rate)) {
        otaPricesRaw.push({
          source: p.source || p.partner || p.name,
          price: typeof p.price === 'number' ? p.price : extractPrice(p) || 0,
          link: p.link || null,
          official: Boolean(p.official),
        });
      }
    }

    // 3) hotels_results (boshqa format)
    for (const h of (data.hotels_results || [])) {
      for (const part of (h.partners || [])) {
        if (part.name && part.rate) {
          const m = String(part.rate).match(/(\d+(?:[.,]\d+)?)/);
          const price = m ? Math.round(parseFloat(m[1].replace(',', '.'))) : 0;
          if (price > 0) {
            otaPricesRaw.push({
              source: part.name,
              price,
              link: part.link || null,
              official: Boolean(part.official),
            });
          }
        }
      }
    }

    const normalized = otaPricesRaw
      .map((p) => ({
        source: normalizeSourceName(p.source),
        price: Math.round(Number(p.price) || 0),
        link: p.link,
        official: p.official,
      }))
      .filter((p) => p.source && p.price > 0);

    if (!normalized.length) {
      console.warn(`[SerpAPI] google search "${name}" — hotel knowledge panel topilmadi yoki narxlar yo'q`);
      return null;
    }

    const merged = mergeOtaPrices(normalized);
    const lowest = merged.length ? Math.min(...merged.map((p) => p.price)) : 0;

    console.log(`[SerpAPI] google search "${name}" → ${merged.length} kanal narx topildi (lowest $${lowest})`);

    return {
      propertyToken: '',
      name: kg.name || name,
      rating: Number(kg.rating) || 0,
      reviewCount: Number(kg.review_count || kg.reviews) || 0,
      lowestPrice: lowest,
      otaPrices: merged,
      image: kg.image || null,
      link: kg.website || null,
    };
  } catch (err) {
    console.warn('[SerpAPI] google search hotel xato:', err.response?.status || '', err.message);
    return null;
  }
}

/**
 * google_maps fallback — google_hotels topmasa, Google Maps'dan qidiramiz.
 * Returns { dataId, name, address, rating, reviewCount } yoki null.
 */
export async function findGoogleMapsPlace({ name, city = '', countryCode = '' }) {
  if (!hasSerpApi()) return null;

  // Bir nechta query variantini sinab ko'ramiz
  const cleaned = name.replace(/\bhotel\b/gi, '').replace(/\s+/g, ' ').trim();
  const variants = Array.from(new Set([
    city ? `${name} ${city}` : name,
    name,
    city && cleaned ? `${cleaned} ${city}` : null,
    cleaned && cleaned !== name ? cleaned : null,
  ].filter(Boolean)));

  for (const q of variants) {
    try {
      const r = await axios.get(BASE, {
        params: {
          engine: 'google_maps',
          q,
          type: 'search',
          gl: (countryCode || 'us').toLowerCase(),
          hl: 'en',
          api_key: env.SERPAPI_API_KEY,
        },
        timeout: TIMEOUT,
      });
      const results = r.data?.local_results || (r.data?.place_results ? [r.data.place_results] : []);
      if (!results.length) {
        console.log(`[SerpAPI] google_maps "${q}" — 0 ta natija`);
        continue;
      }
      const match = findBestMatch(name, results) || results[0];
      const dataId = match.data_id || match.place_id || null;
      if (!dataId) {
        console.log(`[SerpAPI] google_maps "${q}" — match topildi lekin data_id yo'q`);
        continue;
      }
      console.log(`[SerpAPI] google_maps "${q}" → "${match.title || match.name}" (${dataId})`);
      return {
        dataId,
        name: match.title || match.name || name,
        address: match.address || '',
        rating: Number(match.rating) || 0,
        reviewCount: Number(match.reviews) || 0,
      };
    } catch (err) {
      console.warn(`[SerpAPI] google_maps "${q}" xato:`, err.response?.status || '', err.message);
    }
  }
  return null;
}

/**
 * google_maps_reviews — Google Maps place_id orqali sharhlar.
 * Returns { reviews: [], totalReviews, overallRating } yoki null.
 */
export async function getGoogleMapsReviews({ dataId, maxPages = 5, sortBy = 'newestFirst' }) {
  if (!hasSerpApi() || !dataId) return null;
  const cacheKey = `maps_reviews:${dataId}:${sortBy}:${maxPages}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let allReviews = [];
    let nextPageToken = null;
    let overallRating = 0;
    let totalReviews = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const params = {
        engine: 'google_maps_reviews',
        data_id: dataId,
        hl: 'en',
        sort_by: sortBy, // newestFirst — eng yangi sharhlar birinchi
        api_key: env.SERPAPI_API_KEY,
      };
      if (nextPageToken) params.next_page_token = nextPageToken;

      const r = await axios.get(BASE, { params, timeout: TIMEOUT });
      const data = r.data || {};

      if (page === 0) {
        overallRating = data.place_info?.rating || 0;
        totalReviews = data.place_info?.reviews || 0;
      }

      const pageReviews = (data.reviews || []).map((rv) => ({
        source: 'Google',
        rating: Number(rv.rating) || 0,
        text: rv.snippet || rv.extracted_snippet?.original || '',
        author: rv.user?.name || 'Anonymous',
        date: rv.iso_date || rv.date || '',
        language: 'en',
        link: rv.link || null,
      }));
      allReviews = allReviews.concat(pageReviews);

      nextPageToken = data.serpapi_pagination?.next_page_token || null;
      if (!nextPageToken) break;
    }

    console.log(`[SerpAPI] google_maps_reviews ${dataId} — ${allReviews.length} sharh olindi (${maxPages} sahifagacha)`);

    const result = {
      overallRating,
      totalReviews,
      reviews: allReviews,
      bySource: { Google: allReviews },
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[SerpAPI] google_maps_reviews xato:', err.response?.status || '', err.message);
    return null;
  }
}

/**
 * Berilgan OTA uchun sharhlarni qaytaradi. SerpAPI'dan barcha sharhlarni olib,
 * source bo'yicha filtrlaydi.
 *
 *   otaName: 'Booking.com' | 'Agoda' | 'Hotels.com' | 'Expedia' | 'TripAdvisor' | 'Google' …
 */
export async function getSerpApiReviewsForOta({ propertyToken, otaName, maxPages = 2 }) {
  const data = await getSerpApiReviews({ propertyToken, maxPages });
  if (!data) return null;
  const normalized = normalizeReviewSource(otaName);
  const filtered = data.reviews.filter((r) => r.source === normalized);
  return {
    overallRating: data.overallRating,
    totalReviews: data.totalReviews,
    source: normalized,
    reviews: filtered,
    available: filtered.length > 0,
    allSources: Object.keys(data.bySource),
  };
}

function groupReviewsBySource(reviews) {
  const grouped = {};
  for (const r of reviews) {
    const key = r.source || 'Google';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }
  return grouped;
}

// Review source nomi: 'booking', 'Booking', 'booking.com' → 'Booking.com'
function normalizeReviewSource(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Google';
  const lower = s.toLowerCase();
  const map = {
    'google': 'Google',
    'booking': 'Booking.com',
    'booking.com': 'Booking.com',
    'agoda': 'Agoda',
    'agoda.com': 'Agoda',
    'hotels.com': 'Hotels.com',
    'hotels': 'Hotels.com',
    'expedia': 'Expedia',
    'expedia.com': 'Expedia',
    'trip.com': 'Trip.com',
    'trip': 'Trip.com',
    'priceline': 'Priceline',
    'tripadvisor': 'TripAdvisor',
    'orbitz': 'Orbitz',
    'travelocity': 'Travelocity',
    'hotwire': 'Hotwire',
    'vio.com': 'Vio.com',
    'vio': 'Vio.com',
    'edreams': 'eDreams',
  };
  if (map[lower]) return map[lower];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findBestMatch(targetName, items) {
  if (!items?.length) return null;
  const target = normStr(targetName);
  const words = target.split(/\s+/).filter((w) => w.length > 2);

  let best = null;
  let bestScore = -1;

  for (const item of items) {
    const n = normStr(item.name || '');
    let score = 0;
    if (n === target) score = 100;
    else if (n.includes(target) || target.includes(n)) score = 80;
    else for (const w of words) if (n.includes(w)) score += 15;

    if (score > bestScore) { bestScore = score; best = item; }
  }

  return best;
}

// Sof narx (soliqsiz) — OTA sahifasida ko'rinadigan asosiy narx.
// SerpAPI har bir kanal uchun `before_taxes_fees` qaytaradi — bu Booking/Agoda/Expedia
// sahifasidagi narx bilan teng. `lowest` esa soliqlar + sborlar bilan to'liq summa
// (Google Hotels o'zining "total" rejimida ko'rsatadigan).
function extractCleanPrice(node) {
  if (!node || typeof node !== 'object') return { price: 0, priceType: 'total' };
  const rpn = node.rate_per_night || node.rate || {};

  // 1) Sof narx (soliqsiz) — TAVSIYA
  const beforeTax =
    rpn.extracted_before_taxes_fees ??
    node.extracted_before_taxes_fees ??
    null;
  if (typeof beforeTax === 'number' && beforeTax > 0) {
    return { price: Math.round(beforeTax), priceType: 'base' };
  }
  // String "$35" formatida
  const beforeTaxStr = rpn.before_taxes_fees || node.before_taxes_fees || '';
  if (beforeTaxStr) {
    const m = String(beforeTaxStr).match(/(\d+(?:[.,]\d+)?)/);
    if (m) return { price: Math.round(parseFloat(m[1].replace(',', '.'))), priceType: 'base' };
  }

  // 2) Fallback: total narx (soliq bilan)
  const totalExtracted =
    rpn.extracted_lowest ??
    node.extracted_price ??
    (typeof node.price === 'number' ? node.price : null);
  if (typeof totalExtracted === 'number' && totalExtracted > 0) {
    return { price: Math.round(totalExtracted), priceType: 'total' };
  }
  const totalStr = rpn.lowest || node.price_str || node.price || '';
  if (totalStr) {
    const m = String(totalStr).match(/(\d+(?:[.,]\d+)?)/);
    if (m) return { price: Math.round(parseFloat(m[1].replace(',', '.'))), priceType: 'total' };
  }
  return { price: 0, priceType: 'total' };
}

function extractPrice(p) {
  return extractCleanPrice(p).price;
}

function extractOtaPrices(p) {
  // SerpAPI property details: prices[] (asosiy), featured_prices[] (highlight), partners[] (legacy)
  const all = [
    ...(Array.isArray(p.prices) ? p.prices : []),
    ...(Array.isArray(p.featured_prices) ? p.featured_prices : []),
    ...(Array.isArray(p.partners) ? p.partners : []),
  ];
  if (!all.length) return [];
  return all
    .map((pr) => {
      const { price, priceType } = extractCleanPrice(pr);
      return {
        source: normalizeSourceName(pr.source || pr.partner || pr.name || ''),
        price,
        priceType,
        link: pr.link || pr.official_link || null,
        logo: pr.logo || pr.thumbnail || null,
        official: Boolean(pr.official),
        currency: pr.rate_per_night?.currency || 'USD',
      };
    })
    .filter((x) => x.source && x.price > 0);
}

// Bir manba ikki bor kelishi mumkin (featured + prices) — eng arzonini qoldiramiz.
// `base` (soliqsiz) narx `total` dan ustun — soliqlar bo'lmasa Booking sahifasidagi
// raqam aynan keladi.
function mergeOtaPrices(list) {
  const map = new Map();
  for (const it of list) {
    if (!it.source || !it.price) continue;
    const key = it.source.toLowerCase();
    const cur = map.get(key);
    if (!cur) {
      map.set(key, it);
      continue;
    }
    // base > total prioritet
    const curIsBase = cur.priceType === 'base';
    const itIsBase = it.priceType === 'base';
    if (itIsBase && !curIsBase) {
      map.set(key, it);
    } else if (itIsBase === curIsBase && it.price < cur.price) {
      map.set(key, it);
    } else if (cur && !cur.logo && it.logo) {
      cur.logo = it.logo;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.price - b.price);
}

// SerpAPI ba'zan "Booking", "Booking.com", "booking.com" deb yuboradi — yagona shaklga
function normalizeSourceName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const map = {
    'booking': 'Booking.com',
    'booking.com': 'Booking.com',
    'agoda': 'Agoda',
    'agoda.com': 'Agoda',
    'hotels.com': 'Hotels.com',
    'hotels': 'Hotels.com',
    'expedia': 'Expedia',
    'expedia.com': 'Expedia',
    'trip.com': 'Trip.com',
    'trip': 'Trip.com',
    'ctrip': 'Trip.com',
    'priceline': 'Priceline',
    'priceline.com': 'Priceline',
    'tripadvisor': 'TripAdvisor',
    'vio': 'Vio.com',
    'vio.com': 'Vio.com',
    'edreams': 'eDreams',
    'orbitz': 'Orbitz',
    'travelocity': 'Travelocity',
    'hotwire': 'Hotwire',
    'kayak': 'Kayak',
    'destinia': 'Destinia',
    'ostrovok': 'Ostrovok',
    'ostrovok.ru': 'Ostrovok',
    'yandex': 'Yandex Travel',
    'yandex travel': 'Yandex Travel',
    'travel.yandex.ru': 'Yandex Travel',
    'amari.com': 'Amari.com',
    'airbnb': 'Airbnb',
    'google': 'Google Hotels',
    'google hotels': 'Google Hotels',
  };
  if (map[lower]) return map[lower];
  // Domen ko'rinishida bo'lsa (e.g. "MakeMyTrip.com") — birinchi harfini katta qilamiz
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeBreakdown(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === 'object' ? (Number(v.rating) || 0) : Number(v) || 0;
  }
  return out;
}

function normStr(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
