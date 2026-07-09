import axios from 'axios';
import { env } from '../config/env.js';
import rotator from './apiRotator.js';
import { allProviders } from './serpProviders.js';

const CITY_SEARCH_RADIUS_KM = 25;

// Places API sarlavhalari. Kalit "HTTP referrers" cheklovli bo'lsa, serverdan
// referer bo'sh ketadi va Google 403 API_KEY_HTTP_REFERRER_BLOCKED qaytaradi —
// GOOGLE_PLACES_REFERER env'ida ruxsat etilgan domen berilsa, shu yuboriladi.
function placesHeaders(fieldMask) {
  return {
    'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
    'X-Goog-FieldMask': fieldMask,
    ...(env.GOOGLE_PLACES_REFERER && { Referer: env.GOOGLE_PLACES_REFERER }),
  };
}

export async function searchHotels(query, countryCode = '', cityContext = {}) {
  // 1. Google Places
  if (env.GOOGLE_PLACES_API_KEY) {
    try {
      const gpResults = filterByCityContext(
        await googlePlacesSearch(query, countryCode, cityContext),
        cityContext
      );
      if (gpResults.length) return gpResults;
    } catch (err) {
      console.warn('Google Places xato, keyingisiga o\'tildi:', describeAxiosError(err));
    }
  }

  // 2. SERP providers
  const serpResults = await serpMapsHotelSearch(query, countryCode, cityContext);
  if (serpResults.length) return filterByCityContext(serpResults, cityContext);

  // 3. Nominatim (OSM)
  const osmResults = await osmSearch(query, countryCode, cityContext);
  if (osmResults.length) return filterByCityContext(osmResults, cityContext);

  // 4. Overpass — butun shahar bo'yicha nom qidirish
  const overpassResults = await osmNearbyNameSearch(query, cityContext);
  if (overpassResults.length) return overpassResults;

  // 5. Booking.com JONLI SKREYPER (oxirgi chora) — yuqoridagi hech qaysi manba
  //    mehmonxonani topmasa, Booking.com'ni real vaqtda skreyp qilib aniq
  //    ma'lumot (nom, manzil, narx, reyting, rasm, koordinata) olib kelamiz.
  //    Shu tufayli foydalanuvchi izlagan mehmonxona deyarli har doim topiladi.
  try {
    const { scraperEnabled, scraperSearchHotels } = await import('./hotelScraper.service.js');
    if (scraperEnabled()) {
      const scraped = await scraperSearchHotels(query, cityContext);
      if (scraped.length) return scraped;
    }
  } catch (err) {
    console.warn('Booking skreyper fallback xato:', err.message);
  }

  return [];
}

// ─── Shahar bo'yicha BARCHA hotellar (onboarding ro'yxati) ───────────
// Overpass (OSM, to'liq) + SERP (Google Maps) birlashtirilib, dedupe qilinadi.
// Shahar bo'yicha 1 soat keshlanadi — har harfda emas, bir marta yuklanadi.
const cityHotelsCache = new Map(); // "lat,lng" → { at, hotels }
const CITY_HOTELS_TTL = 60 * 60 * 1000;

export async function listCityHotels(cityContext = {}) {
  if (!Number.isFinite(cityContext.lat) || !Number.isFinite(cityContext.lng)) return [];
  const key = `${cityContext.lat.toFixed(2)},${cityContext.lng.toFixed(2)}`;
  const cached = cityHotelsCache.get(key);
  if (cached && Date.now() - cached.at < CITY_HOTELS_TTL) return cached.hotels;

  // 3 manba parallel:
  //   • Google Places — eng sifatli (kalit bo'lsa). Kredit tugasa/xato bersa
  //     bu bo'sh qaytadi va bepul manbalar ishlayveradi (avtomatik fallback).
  //   • Overpass (OSM) + SERP — bepul, doim ishlaydi.
  const [google, overpass, serp] = await Promise.all([
    googlePlacesCityHotels(cityContext).catch((e) => {
      console.warn('Google Places city xato (bepulga o\'tildi):', describeAxiosError(e));
      return [];
    }),
    overpassAllCityHotels(cityContext).catch((e) => {
      console.warn('Overpass city hotels xato:', describeAxiosError(e));
      return [];
    }),
    serpMapsHotelSearch('', '', cityContext).catch(() => []),
  ]);

  // Tartib: Google birinchi (dedupe sifatlisini saqlaydi) → SERP → Overpass.
  // Axlat nomlar (1-2 belgi, takror) olib tashlanadi. Mashhurlar (sharhi ko'p) tepada.
  const merged = dedupeHotels([...google, ...serp, ...overpass])
    .filter(
      (h) => h.name && !isJunkName(h.name) && Number.isFinite(h.lat) && Number.isFinite(h.lng),
    )
    .sort((a, b) => (b.reviews || 0) - (a.reviews || 0) || a.name.localeCompare(b.name));

  cityHotelsCache.set(key, { at: Date.now(), hotels: merged });
  return merged;
}

// Google Places — shahardagi hotellar (searchText, 3 sahifagacha ~60 ta sifatli).
async function googlePlacesCityHotels(cityContext) {
  if (!env.GOOGLE_PLACES_API_KEY) return [];
  const hasCoords = Number.isFinite(cityContext.lat) && Number.isFinite(cityContext.lng);
  const all = [];
  let pageToken;

  for (let page = 0; page < 3; page++) {
    const body = {
      textQuery: `hotels in ${cityContext.city || ''}`.trim(),
      includedType: 'lodging',
      pageSize: 20,
      ...(hasCoords && {
        locationBias: {
          circle: {
            center: { latitude: cityContext.lat, longitude: cityContext.lng },
            radius: CITY_SEARCH_RADIUS_KM * 1000,
          },
        },
      }),
      ...(pageToken && { pageToken }),
    };
    const r = await axios.post('https://places.googleapis.com/v1/places:searchText', body, {
      headers: placesHeaders('places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,nextPageToken'),
      timeout: 12000,
    });
    for (const p of r.data?.places || []) {
      all.push({
        placeId: p.id,
        osmId: '',
        name: p.displayName?.text,
        address: p.formattedAddress,
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        rating: p.rating || 0,
        reviews: p.userRatingCount || 0,
        source: 'google_places',
      });
    }
    pageToken = r.data?.nextPageToken;
    if (!pageToken) break;
  }
  return all.filter((h) => h.name);
}

// Axlat/bema'ni nomlarni aniqlaydi (OSM'da uchraydi: "Аа", "ааа", 1-2 belgi).
function isJunkName(name) {
  const n = String(name).trim();
  if (n.length < 3) return true;
  const uniqChars = new Set(n.toLowerCase().replace(/\s/g, '')).size;
  if (uniqChars <= 1) return true; // bir xil belgidan iborat
  return false;
}

async function overpassAllCityHotels(cityContext) {
  const radius = CITY_SEARCH_RADIUS_KM * 1000;
  const { lat, lng } = cityContext;
  const q = `[out:json][timeout:25];(
    node["tourism"~"^(hotel|hostel|guest_house|motel|apartment|resort|chalet)$"](around:${radius},${lat},${lng});
    way["tourism"~"^(hotel|hostel|guest_house|motel|apartment|resort|chalet)$"](around:${radius},${lat},${lng});
    node["building"="hotel"](around:${radius},${lat},${lng});
    way["building"="hotel"](around:${radius},${lat},${lng});
  );out center tags 300;`;

  const r = await axios.post(
    'https://overpass-api.de/api/interpreter',
    `data=${encodeURIComponent(q)}`,
    {
      timeout: 25000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'RateRadar/1.0 (hotel-monitoring)',
      },
    },
  );

  return (r.data?.elements || [])
    .map((el) => {
      const tags = el.tags || {};
      const name =
        tags.name || tags['name:en'] || tags['name:uz'] || tags['name:ru'] || '';
      return {
        placeId: '',
        osmId: `${el.type}:${el.id}`,
        name,
        address:
          [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'] || cityContext.city]
            .filter(Boolean)
            .join(', ') || cityContext.city || '',
        lat: el.lat ?? el.center?.lat,
        lng: el.lon ?? el.center?.lon,
        stars: parseInt(tags.stars) || 0,
        rating: 0,
        reviews: 0,
        source: 'osm_overpass',
      };
    })
    .filter((h) => h.name); // faqat nomi borlar
}

// Bir xil nomdagi (va boy ma'lumotli) yozuvlarni birlashtiradi.
function dedupeHotels(list) {
  const byName = new Map();
  for (const h of list) {
    const k = normalizeText(h.name);
    if (!k) continue;
    const existing = byName.get(k);
    if (!existing) {
      byName.set(k, h);
    } else if ((h.reviews || 0) > (existing.reviews || 0)) {
      // sharhi ko'proq manbani afzal ko'ramiz, lekin osmId'ni yo'qotmaymiz
      byName.set(k, { ...existing, ...h, osmId: existing.osmId || h.osmId });
    }
  }
  return [...byName.values()];
}

export async function searchNearby(coords, radiusKm = 2) {
  const [lng, lat] = coords;
  if (env.GOOGLE_PLACES_API_KEY) {
    try {
      return await googlePlacesNearby(lat, lng, radiusKm);
    } catch (err) {
      console.warn('Google Places nearby xato:', describeAxiosError(err));
    }
  }
  return await osmNearby(lat, lng, radiusKm);
}

async function googlePlacesSearch(query, countryCode, cityContext = {}) {
  const hasCityCoords = Number.isFinite(cityContext.lat) && Number.isFinite(cityContext.lng);
  const r = await axios.post(
    'https://places.googleapis.com/v1/places:searchText',
    {
      textQuery: `${query} hotel mehmonxona${cityContext.city ? ` ${cityContext.city}` : ''}`,
      ...(countryCode && { regionCode: countryCode.toLowerCase() }),
      ...(hasCityCoords && {
        locationBias: {
          circle: {
            center: { latitude: cityContext.lat, longitude: cityContext.lng },
            radius: CITY_SEARCH_RADIUS_KM * 1000,
          },
        },
      }),
    },
    {
      headers: placesHeaders('places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.photos'),
      timeout: 10000,
    }
  );
  return (r.data?.places || []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating || 0,
    reviews: p.userRatingCount || 0,
    photoRef: p.photos?.[0]?.name,
    source: 'google_places',
  }));
}

async function googlePlacesNearby(lat, lng, radiusKm) {
  const r = await axios.post(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      includedTypes: ['lodging'],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusKm * 1000 },
      },
    },
    {
      headers: placesHeaders('places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount'),
      timeout: 10000,
    }
  );
  return (r.data?.places || []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating || 0,
    reviews: p.userRatingCount || 0,
    source: 'google_places',
  }));
}

async function osmSearch(query, countryCode, cityContext = {}) {
  const queries = [
    `${query} hotel${cityContext.city ? `, ${cityContext.city}` : ''}`,
    `${query}${cityContext.city ? `, ${cityContext.city}` : ''}`,
    `${query} hotel`,
  ];
  const seen = new Set();
  const hotels = [];

  for (const q of queries) {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q,
        format: 'json',
        limit: 15,
        countrycodes: countryCode ? countryCode.toLowerCase() : undefined,
        addressdetails: 1,
        namedetails: 1,
      },
      headers: { 'User-Agent': 'RateRadar/1.0' },
      timeout: 10000,
    });

    for (const p of r.data || []) {
      const key = `${p.osm_type}:${p.osm_id}`;
      if (seen.has(key)) continue;
      const typeStr = `${p.type || ''} ${p.class || ''}`.toLowerCase();
      const isAccommodation =
        /hotel|hostel|motel|guest|resort|lodging|apartment/i.test(typeStr) ||
        p.class === 'tourism';
      if (!isAccommodation) continue;
      seen.add(key);
      const nd = p.namedetails || {};
      hotels.push({
        placeId: '',
        osmId: key,
        name: nd.name || nd['name:uz'] || nd['name:ru'] || nd['name:en'] || p.display_name.split(',')[0],
        address: p.display_name,
        lat: parseFloat(p.lat),
        lng: parseFloat(p.lon),
        rating: 0,
        reviews: 0,
        source: 'osm',
      });
    }

    if (hotels.length) break;
  }

  return hotels;
}

async function osmNearbyNameSearch(query, cityContext = {}) {
  if (!Number.isFinite(cityContext.lat) || !Number.isFinite(cityContext.lng)) return [];

  const radius = CITY_SEARCH_RADIUS_KM * 1000;
  const overpassQuery = `[out:json][timeout:15];(
    node["tourism"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["tourism"="hostel"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["tourism"="guest_house"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["tourism"="motel"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["tourism"="apartment"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["building"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
    node["amenity"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["tourism"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["tourism"="hostel"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["tourism"="guest_house"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["tourism"="motel"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["tourism"="apartment"](around:${radius},${cityContext.lat},${cityContext.lng});
    way["building"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
    relation["tourism"="hotel"](around:${radius},${cityContext.lat},${cityContext.lng});
  );out center tags 100;`;

  try {
    const r = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(overpassQuery)}`,
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'RateRadar/1.0 (hotel-monitoring)',
        },
      }
    );
    const tokens = normalizeText(query).split(/\s+/).filter(Boolean);

    return (r.data?.elements || [])
      .map((el) => {
        const nameMain = el.tags?.name || '';
        const nameUz = el.tags?.['name:uz'] || '';
        const nameRu = el.tags?.['name:ru'] || '';
        const nameEn = el.tags?.['name:en'] || '';
        const name = nameMain || nameUz || nameRu || nameEn;
        return {
          placeId: '',
          osmId: `${el.type}:${el.id}`,
          name,
          _allNames: `${nameMain} ${nameUz} ${nameRu} ${nameEn}`,
          address: [
            el.tags?.['addr:housenumber'],
            el.tags?.['addr:street'],
            el.tags?.['addr:city'] || cityContext.city,
          ].filter(Boolean).join(', '),
          lat: el.lat || el.center?.lat,
          lng: el.lon || el.center?.lon,
          stars: parseInt(el.tags?.stars) || 0,
          rating: 0,
          reviews: 0,
          source: 'osm_overpass',
        };
      })
      .filter((hotel) => {
        if (!hotel.name || !hotel.lat || !hotel.lng) return false;
        const haystack = normalizeText(`${hotel._allNames} ${hotel.address}`);
        return tokens.some((token) => haystack.includes(token));
      })
      .map(({ _allNames, ...hotel }) => hotel)
      .map((hotel) => ({
        ...hotel,
        distanceKm: distanceKm(cityContext.lat, cityContext.lng, hotel.lat, hotel.lng),
      }))
      .filter((hotel) => hotel.distanceKm <= CITY_SEARCH_RADIUS_KM)
      .slice(0, 15);
  } catch (err) {
    console.error('Overpass name search xato:', describeAxiosError(err));
    return [];
  }
}

async function serpMapsHotelSearch(query, countryCode = '', cityContext = {}) {
  const candidates = allProviders
    .filter((provider) => provider.apiKey && provider.supports?.includes('google_maps'));

  for (const provider of candidates) {
    try {
      const ll = Number.isFinite(cityContext.lat) && Number.isFinite(cityContext.lng)
        ? `@${cityContext.lat},${cityContext.lng},14z`
        : undefined;
      const result = await provider.query('google_maps', {
        q: `${query} hotel${cityContext.city ? ` ${cityContext.city}` : ''}`,
        gl: countryCode?.toLowerCase() || 'uz',
        hl: 'en',
        ...(provider.name !== 'hasdata' && { type: 'search' }),
        ...(ll && { ll }),
      });

      const places = result.places || [];
      if (!places.length) continue;

      return places
        .map((p) => ({
          placeId: '',
          osmId: '',
          name: p.name,
          address: p.address || '',
          lat: p.coords?.latitude,
          lng: p.coords?.longitude,
          rating: p.rating || 0,
          reviews: p.reviews || 0,
          source: result.source || provider.name,
        }))
        .filter((hotel) => hotel.name);
    } catch (err) {
      console.warn(`${provider.name} maps qidiruv xato:`, describeAxiosError(err));
    }
  }

  return [];
}

function filterByCityContext(hotels, cityContext = {}) {
  const hasCityCoords = Number.isFinite(cityContext.lat) && Number.isFinite(cityContext.lng);
  if (!cityContext.city && !hasCityCoords) return hotels;

  const cityName = normalizeText(cityContext.city || '');
  return hotels
    .map((hotel) => ({
      ...hotel,
      distanceKm: hasCityCoords && Number.isFinite(hotel.lat) && Number.isFinite(hotel.lng)
        ? distanceKm(cityContext.lat, cityContext.lng, hotel.lat, hotel.lng)
        : undefined,
    }))
    .filter((hotel) => {
      if (hasCityCoords && Number.isFinite(hotel.distanceKm)) {
        return hotel.distanceKm <= CITY_SEARCH_RADIUS_KM;
      }
      if (!cityName) return true;
      return normalizeText(hotel.address || '').includes(cityName);
    })
    .slice(0, 15);
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function describeAxiosError(err) {
  const status = err.response?.status;
  const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
  return status ? `${status}: ${message}` : message;
}

async function osmNearby(lat, lng, radiusKm) {
  const radius = radiusKm * 1000;
  const query = `[out:json][timeout:10];(
    node["tourism"="hotel"](around:${radius},${lat},${lng});
    node["tourism"="hostel"](around:${radius},${lat},${lng});
    node["tourism"="guest_house"](around:${radius},${lat},${lng});
    node["tourism"="motel"](around:${radius},${lat},${lng});
    node["tourism"="apartment"](around:${radius},${lat},${lng});
    node["building"="hotel"](around:${radius},${lat},${lng});
    way["tourism"="hotel"](around:${radius},${lat},${lng});
    way["tourism"="hostel"](around:${radius},${lat},${lng});
    way["tourism"="guest_house"](around:${radius},${lat},${lng});
    way["tourism"="motel"](around:${radius},${lat},${lng});
    way["tourism"="apartment"](around:${radius},${lat},${lng});
    way["building"="hotel"](around:${radius},${lat},${lng});
  );out center tags 80;`;
  try {
    const r = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'RateRadar/1.0 (hotel-monitoring)',
      },
    });
    return (r.data?.elements || []).map((el) => ({
      osmId: `${el.type}:${el.id}`,
      name: el.tags?.name || 'Unnamed Hotel',
      address: [el.tags?.['addr:street'], el.tags?.['addr:city']].filter(Boolean).join(', '),
      lat: el.lat || el.center?.lat,
      lng: el.lon || el.center?.lon,
      stars: parseInt(el.tags?.stars) || 0,
      rating: 0,
      reviews: 0,
      source: 'osm',
    })).filter((h) => h.lat && h.lng);
  } catch (err) {
    console.error('Overpass xato:', err.message);
    return [];
  }
}

export async function searchViaSerpApi(query, countryCode = '') {
  const result = await rotator.query('google_maps', {
    q: `${query} hotel`,
    gl: countryCode?.toLowerCase() || 'us',
    type: 'search',
  });
  return result.places.map((p) => ({
    name: p.name,
    address: p.address,
    lat: p.coords?.latitude,
    lng: p.coords?.longitude,
    rating: p.rating || 0,
    reviews: p.reviews || 0,
    source: result._provider,
  }));
}
