import axios from 'axios';
import { env } from '../config/env.js';

const BASE = 'https://hotels4.p.rapidapi.com';
const TIMEOUT = 20000;

function headers() {
  return {
    'x-rapidapi-key': env.EXPEDIA_RAPIDAPI_KEY,
    'x-rapidapi-host': 'hotels4.p.rapidapi.com',
    'content-type': 'application/json',
  };
}

export function hasExpediaRapidApi() {
  return Boolean(env.EXPEDIA_RAPIDAPI_KEY);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
}

// Shahar nomidan regionId topadi
async function searchRegion(query) {
  const r = await axios.get(`${BASE}/locations/v3/search`, {
    params: { q: query, locale: 'en_US', langid: '1033', siteid: '300000001' },
    headers: headers(),
    timeout: TIMEOUT,
  });
  const list = r.data?.sr;
  if (!Array.isArray(list) || !list.length) return null;
  const city = list.find((x) => x.type === 'CITY' || x.type === 'REGION') || list[0];
  return city?.gaiaId
    ? { regionId: String(city.gaiaId), name: city.regionNames?.shortName || query }
    : null;
}

// Mintaqada hotel qidiradi va nomga eng mosini qaytaradi
async function findHotelInRegion(regionId, hotelName, checkIn, checkOut) {
  const r = await axios.post(
    `${BASE}/properties/v2/list`,
    {
      currency: 'USD', eapid: 1, locale: 'en_US', siteId: 300000001,
      destination: { regionId },
      checkInDate: checkIn, checkOutDate: checkOut,
      rooms: [{ adults: 2 }],
      resultsStartingIndex: 0, resultsSize: 200,
      sort: 'PRICE_LOW_TO_HIGH', filters: {},
    },
    { headers: headers(), timeout: TIMEOUT },
  );

  const props = r.data?.data?.propertySearch?.properties;
  if (!Array.isArray(props) || !props.length) return null;

  const target = hotelName.toLowerCase().trim();
  const words = target.split(/\s+/).filter((w) => w.length > 3);

  let best = null;
  let bestScore = -1;
  for (const p of props) {
    const pName = (p.name || '').toLowerCase();
    let score = 0;
    if (pName === target) score = 1000;
    else if (pName.includes(target)) score = 800;
    else if (target.includes(pName)) score = 700;
    else score = words.filter((w) => pName.includes(w)).length * 100;
    if (score > bestScore) { bestScore = score; best = p; }
  }

  if (!best) return null;

  const price = best.price?.lead?.amount
    || best.price?.strikeOut?.amount
    || best.price?.options?.[0]?.formattedDisplayPrice?.replace(/[^0-9.]/g, '')
    || 0;

  return {
    hotelId: String(best.id || ''),
    name: best.name,
    price: price > 0 ? Math.round(Number(price)) : 0,
  };
}

/**
 * Hotel uchun Expedia narxini qaytaradi.
 * @param {object} hotel — Mongoose Hotel hujjati
 * @returns {{ source, price, via } | null}
 */
export async function getExpediaPrice(hotel) {
  if (!hasExpediaRapidApi()) return null;

  const ci = dateOffset(7);
  const co = dateOffset(8);

  try {
    const queries = [hotel.city, hotel.country, hotel.name].filter(Boolean);
    let region = null;

    for (const q of queries) {
      try {
        region = await searchRegion(q);
        if (region) break;
      } catch (err) {
        if (err.response?.status === 429) throw err;
      }
    }

    if (!region) {
      console.warn(`Expedia RapidAPI: shahar topilmadi — hotel="${hotel.name}" city="${hotel.city}"`);
      return null;
    }

    const found = await findHotelInRegion(region.regionId, hotel.name, ci, co);
    if (!found) {
      console.warn(`Expedia RapidAPI: hotel topilmadi — "${hotel.name}" / "${region.name}"`);
      return null;
    }

    if (found.hotelId) {
      const { default: Hotel } = await import('../models/Hotel.js');
      Hotel.updateOne({ _id: hotel._id }, { expediaHotelId: found.hotelId }).catch(() => {});
    }

    if (found.price > 0) {
      return { source: 'Expedia', price: found.price, via: 'expedia_rapidapi' };
    }
    return null;
  } catch (err) {
    if (err.response?.status === 429) throw err;
    if (err.response?.status === 403) console.warn('Expedia RapidAPI: 403 — kalitni tekshiring');
    else console.warn('Expedia RapidAPI xato:', err.response?.status || '', err.message);
    return null;
  }
}
