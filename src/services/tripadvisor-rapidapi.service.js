import axios from 'axios';
import { env } from '../config/env.js';

const BASE = 'https://tripadvisor16.p.rapidapi.com/api/v1/hotels';
const TIMEOUT = 20000;

function headers() {
  return {
    'x-rapidapi-key': env.TRIP_RAPIDAPI_KEY,
    'x-rapidapi-host': 'tripadvisor16.p.rapidapi.com',
  };
}

export function hasTripAdvisorRapidApi() {
  return Boolean(env.TRIP_RAPIDAPI_KEY);
}

function dateStr(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Shahar nomidan locationId topadi
async function searchLocation(query) {
  const r = await axios.get(`${BASE}/searchLocation`, {
    params: { query },
    headers: headers(),
    timeout: TIMEOUT,
  });
  const list = r.data?.data;
  if (!Array.isArray(list) || !list.length) return null;
  const city = list.find((d) => d.geoId || d.locationId) || list[0];
  const id = city?.locationId || city?.geoId;
  return id ? { locationId: String(id), name: city.localizedName || city.name || query } : null;
}

// Shahar bo'yicha hotellarni qidiradi, nomga mos birini qaytaradi
async function searchHotels(locationId, hotelName, checkIn, checkOut) {
  const r = await axios.get(`${BASE}/searchHotels`, {
    params: {
      locationId,
      checkIn,
      checkOut,
      adults: 2,
      rooms: 1,
      currencyCode: 'USD',
    },
    headers: headers(),
    timeout: TIMEOUT,
  });

  const list = r.data?.data?.data || r.data?.data || [];
  if (!Array.isArray(list) || !list.length) return null;

  const target = hotelName.toLowerCase().trim();
  const words = target.split(/\s+/).filter((w) => w.length > 3);

  let best = null;
  let bestScore = -1;
  for (const h of list) {
    const hName = (h.title || h.name || '').toLowerCase();
    let score = 0;
    if (hName === target) score = 1000;
    else if (hName.includes(target)) score = 800;
    else if (target.includes(hName)) score = 700;
    else score = words.filter((w) => hName.includes(w)).length * 100;
    if (score > bestScore) { bestScore = score; best = h; }
  }

  if (!best) return null;

  // Narxni turli formatlardan oladi
  const price =
    best.priceForDisplay?.replace(/[^0-9.]/g, '') ||
    best.price?.replace(/[^0-9.]/g, '') ||
    best.commerceInfo?.priceForDisplay?.replace(/[^0-9.]/g, '') ||
    0;

  return {
    hotelId: String(best.locationId || best.id || ''),
    name: best.title || best.name,
    price: price ? Math.round(Number(price)) : 0,
  };
}

/**
 * Hotel uchun TripAdvisor narxini qaytaradi.
 * @param {object} hotel — Mongoose Hotel hujjati
 * @returns {{ source, price, via } | null}
 */
export async function getTripAdvisorRapidPrice(hotel) {
  if (!hasTripAdvisorRapidApi()) return null;

  const checkIn = dateStr(7);
  const checkOut = dateStr(8);

  try {
    const queries = [hotel.city, hotel.country, hotel.name].filter(Boolean);
    let location = null;

    for (const q of queries) {
      try {
        location = await searchLocation(q);
        if (location) break;
      } catch (err) {
        if (err.response?.status === 429) throw err;
      }
    }

    if (!location) {
      console.warn(`TripAdvisor RapidAPI: shahar topilmadi — "${hotel.name}" / "${hotel.city}"`);
      return null;
    }

    const found = await searchHotels(location.locationId, hotel.name, checkIn, checkOut);
    if (!found) {
      console.warn(`TripAdvisor RapidAPI: hotel topilmadi — "${hotel.name}" / "${location.name}"`);
      return null;
    }

    if (found.hotelId) {
      const { default: Hotel } = await import('../models/Hotel.js');
      Hotel.updateOne({ _id: hotel._id }, { tripAdvisorRapidId: found.hotelId }).catch(() => {});
    }

    if (found.price > 0) {
      return { source: 'TripAdvisor', price: found.price, via: 'trip_rapidapi' };
    }
    return null;
  } catch (err) {
    if (err.response?.status === 429) throw err;
    if (err.response?.status === 403) console.warn('TripAdvisor RapidAPI: 403 — kalitni tekshiring');
    else console.warn('TripAdvisor RapidAPI xato:', err.response?.status || '', err.message);
    return null;
  }
}
