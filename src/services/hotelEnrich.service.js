import axios from 'axios';
import { env } from '../config/env.js';
import { hasApify, getBookingCitySearchApify, matchHotelByName } from './apify.service.js';

/**
 * Hotel ma'lumotlarini boyitadi:
 * - Narx: Apify Booking.com (shahar qidiruvi + nom mos qilish)
 * - Rating + photo: Google Places API
 * - Yulduzlar: OSM/Overpass fallback
 *
 * SerpAPI bu yerda ishlatilmaydi — u faqat Google sharhlari uchun (fetchHotelReviews).
 */
export async function enrichHotelData({ name, city = '', country = '', countryCode = '', lat, lng }) {
  const result = {
    rating: 0,
    reviewCount: 0,
    currentPrice: 0,
    stars: 0,
    photoUrl: '',
    otaPrices: [],
    description: '',
    cid: '',
    address: '',
    source: '',
  };

  // 1. Apify Booking — narx
  if (hasApify() && city) {
    try {
      const items = await getBookingCitySearchApify(city, { maxItems: 50 });
      const match = matchHotelByName(items, name, 0.4);
      if (match?.price > 0) {
        result.currentPrice = match.price;
        result.source = 'apify_booking';
      }
    } catch (err) {
      console.warn('Apify Booking enrich xato:', err.message);
    }
  }

  // 2. Google Places API — photo + rating
  if ((!result.rating || !result.photoUrl) && env.GOOGLE_PLACES_API_KEY) {
    try {
      const placesData = await googlePlacesEnrich(name, city, countryCode, { lat, lng });
      if (placesData) {
        result.rating      = result.rating      || placesData.rating;
        result.reviewCount = result.reviewCount  || placesData.reviewCount;
        result.photoUrl    = result.photoUrl     || placesData.photoUrl;
      }
    } catch (err) {
      console.warn('Google Places enrich xato:', err.message);
    }
  }

  // 4. OSM — yulduzlar uchun fallback (bepul)
  if (!result.stars && lat && lng) {
    try {
      const osmData = await osmEnrich(name, lat, lng);
      if (osmData?.stars) result.stars = osmData.stars;
    } catch (err) {
      console.warn('OSM enrich xato:', err.message);
    }
  }

  return result;
}

/**
 * Apify Booking.com (shahar qidiruvi + nom mos qilish) orqali raqib uchun
 * Booking.com narxini topadi. Boshqa OTA kanallar uchun PriceSnapshot eski
 * qiymatlardan emas, faqat Booking — bitta haqiqiy manba.
 *
 * Qaytarish formati eski (SerpAPI) bilan mos: { provider, hotel, lowestPrice, otaPrices }
 * — chaqiruvchilar refactor qilmasligi uchun.
 */
export async function getOtaPricesForHotel({ name, city = '', countryCode = '' }) {
  if (!hasApify()) {
    return { error: 'no_provider', reason: 'APIFY_API_KEY sozlanmagan' };
  }
  if (!city) {
    return { error: 'no_city', reason: 'Shahar nomi yo\'q — Apify uchun kerak' };
  }

  try {
    const items = await getBookingCitySearchApify(city, { maxItems: 50 });
    if (!items.length) {
      return { error: 'no_results', reason: 'Apify shahar qidiruvi natija qaytarmadi' };
    }
    const match = matchHotelByName(items, name, 0.4);
    if (!match?.price) {
      return {
        error: 'no_match',
        reason: `"${name}" Apify Booking.com natijalari orasidan topilmadi`,
        topResults: items.slice(0, 5).map((h) => h.name),
      };
    }
    return {
      provider: 'apify',
      hotel: { name: match.name, image: '' },
      lowestPrice: match.price,
      otaPrices: [{ source: 'Booking.com', price: match.price, via: 'apify' }],
    };
  } catch (err) {
    console.warn('Apify getOtaPricesForHotel xato:', err.message);
    return { error: 'api_error', reason: err.message };
  }
}

/**
 * Hotel sharhlari — SerpAPI google_hotels_reviews orqali. Google Hotels
 * Booking.com, Agoda, Hotels.com, Expedia, TripAdvisor va boshqa OTA'lardan
 * sharhlarni aggregatsiya qilib qaytaradi (har birida `source` ko'rsatilgan).
 *
 * propertyToken — oldindan saqlangan SerpAPI property_token (dedup kaliti).
 * maxPages — necha sahifa sharh olib kelish (har sahifa ~10 review; default 5 = ~50)
 */
export async function fetchHotelReviews({
  name, city = '', countryCode = '', propertyToken = '', maxPages = 5,
} = {}) {
  const {
    getSerpApiHotelData, getSerpApiReviews,
    findGoogleMapsPlace, getGoogleMapsReviews,
    hasSerpApi,
  } = await import('./serpapi.service.js');

  if (!hasSerpApi()) return { reviews: [], propertyToken: '', matchedPlace: null, bySource: {} };

  try {
    let token = propertyToken;
    let matchedName = name;

    // ─── Asosiy yo'l: google_hotels engine ────────────────────────────────
    if (!token) {
      const hotelData = await getSerpApiHotelData({ name, city, countryCode });
      if (hotelData?.propertyToken) {
        token = hotelData.propertyToken;
        matchedName = hotelData.name || name;
      }
    }

    if (token) {
      const data = await getSerpApiReviews({ propertyToken: token, maxPages });
      if (data && data.reviews.length) {
        return {
          reviews: data.reviews.map((r) => ({
            author: r.author,
            rating: r.rating,
            text: r.text,
            date: r.date,
            source: r.source || 'Google',
            link: r.link || null,
          })),
          propertyToken: token,
          matchedPlace: { name: matchedName },
          bySource: data.bySource || {},
          overallRating: data.overallRating,
          totalReviews: data.totalReviews,
        };
      }
    }

    // ─── Fallback: google_maps + google_maps_reviews ──────────────────────
    // Google Hotels indeksida bo'lmagan mehmonxonalar uchun (kichik mehmonxonalar,
    // yangi ochilganlari, mahalliylari).
    console.log(`[Reviews] "${name}" google_hotels'da topilmadi — Google Maps fallback`);
    const place = await findGoogleMapsPlace({ name, city, countryCode });
    if (!place?.dataId) {
      return { reviews: [], propertyToken: '', matchedPlace: null, bySource: {} };
    }

    const mapsData = await getGoogleMapsReviews({ dataId: place.dataId, maxPages });
    if (!mapsData) {
      return { reviews: [], propertyToken: '', matchedPlace: { name: place.name }, bySource: {} };
    }

    return {
      reviews: mapsData.reviews.map((r) => ({
        author: r.author,
        rating: r.rating,
        text: r.text,
        date: r.date,
        source: r.source || 'Google',
        link: r.link || null,
      })),
      // Google Maps reviews dedup uchun data_id ishlatamiz (token o'rnida)
      propertyToken: `maps:${place.dataId}`,
      matchedPlace: { name: place.name, via: 'google_maps' },
      bySource: mapsData.bySource || {},
      overallRating: mapsData.overallRating,
      totalReviews: mapsData.totalReviews,
    };
  } catch (err) {
    console.warn('fetchHotelReviews xato:', err.message);
    return { reviews: [], propertyToken: '', matchedPlace: null, bySource: {} };
  }
}

// Eski nomi (orqaga moslik) — yangi kod fetchHotelReviews dan foydalansin
export const fetchGoogleReviews = async (opts = {}) => {
  const r = await fetchHotelReviews({ ...opts, propertyToken: opts.cid || opts.propertyToken });
  return { ...r, cid: r.propertyToken };
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function googlePlacesEnrich(name, city, countryCode, coords = {}) {
  const body = {
    textQuery: `${name}${city ? ` ${city}` : ''}`,
    ...(countryCode && { regionCode: countryCode.toLowerCase() }),
    pageSize: 5,
  };
  if (Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    body.locationBias = {
      circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: 25000 },
    };
  }
  const r = await axios.post(
    'https://places.googleapis.com/v1/places:searchText',
    body,
    {
      headers: {
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.photos',
      },
      timeout: 10000,
    }
  );
  const places = r.data?.places || [];
  const match = findBestMatch(name, places.map((p) => ({ ...p, name: p.displayName?.text })));
  if (!match) return null;
  let photoUrl = '';
  const photoRef = match.photos?.[0]?.name;
  if (photoRef) {
    photoUrl = `https://places.googleapis.com/v1/${photoRef}/media?maxHeightPx=400&maxWidthPx=600&key=${env.GOOGLE_PLACES_API_KEY}`;
  }
  return { rating: match.rating || 0, reviewCount: match.userRatingCount || 0, photoUrl };
}

async function osmEnrich(name, lat, lng) {
  const query = `[out:json][timeout:10];(
    node["tourism"~"hotel|hostel|guest_house|motel|apartment"](around:2000,${lat},${lng});
    way["tourism"~"hotel|hostel|guest_house|motel|apartment"](around:2000,${lat},${lng});
    way["building"="hotel"](around:2000,${lat},${lng});
  );out center tags 30;`;
  const r = await axios.post(
    'https://overpass-api.de/api/interpreter',
    `data=${encodeURIComponent(query)}`,
    {
      timeout: 12000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'RateRadar/1.0',
      },
    }
  );
  const elements = r.data?.elements || [];
  const target = normalizeName(name);
  const match = elements.find((el) => {
    const elName = (el.tags?.name || el.tags?.['name:en'] || '').toLowerCase();
    return elName.includes(target) || target.includes(elName);
  });
  if (!match) return null;
  return { stars: parseInt(match.tags?.stars) || 0 };
}

// ─── Hotel name matching ──────────────────────────────────────────────────────

const GENERIC_HOTEL_WORDS = new Set([
  'hotel', 'plaza', 'inn', 'resort', 'suites', 'suite', 'palace',
  'grand', 'royal', 'park', 'house', 'guest', 'lodge', 'apart',
  'aparts', 'apartment', 'apartments', 'boutique', 'mehmonxona',
  'отель', 'гостиница', 'hostel', 'motel', 'club', 'and', 'the',
  'spa', 'tower', 'towers', 'city', 'business',
]);

function findBestMatch(targetName, items, opts = {}) {
  if (!items.length) return null;
  const minScore = opts.minScore ?? 60;
  const target = normalizeName(targetName);
  const targetTokens = target.split(/\s+/).filter(Boolean);
  const brandTokens = targetTokens.filter((t) => !GENERIC_HOTEL_WORDS.has(t) && t.length >= 3);
  const requiredTokens = brandTokens.length
    ? brandTokens
    : [targetTokens.slice().sort((a, b) => b.length - a.length)[0]].filter(Boolean);

  const scored = items
    .map((item) => {
      const name = normalizeName(item.name || '');
      const nameTokens = name.split(/\s+/).filter(Boolean);
      const allBrandsPresent = requiredTokens.every((tok) =>
        nameTokens.some((nt) => nt === tok || nt.includes(tok) || tok.includes(nt))
      );
      if (!allBrandsPresent) return { item, score: 0 };
      let score;
      if (name === target) score = 100;
      else if (name.includes(target)) score = 95;
      else if (target.includes(name) && name.length >= 5) score = 85;
      else {
        const matched = targetTokens.filter((tok) =>
          nameTokens.some((nt) => nt === tok || nt.includes(tok))
        ).length;
        score = 60 + (matched / targetTokens.length) * 30;
      }
      return { item, score };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.item || null;
}

function normalizeName(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

