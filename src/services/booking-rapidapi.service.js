import axios from 'axios';
import { env } from '../config/env.js';

const BASE = 'https://booking-com15.p.rapidapi.com/api/v1';
const TIMEOUT = 20000;

function headers() {
  return {
    'x-rapidapi-key': env.BOOKING_RAPIDAPI_KEY,
    'x-rapidapi-host': 'booking-com15.p.rapidapi.com',
  };
}

export function hasBookingRapidApi() {
  return Boolean(env.BOOKING_RAPIDAPI_KEY);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Har qanday joy ichidan raqamni oladi: "US$85", 85.5, "85", "$85.00"
function extractPrice(value) {
  if (!value && value !== 0) return 0;
  if (typeof value === 'number') return Math.round(value);
  const m = String(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : 0;
}

// API javobidan narxni topishga harakat qiladi — barcha mumkin bo'lgan formatlar
function parseHotelPrice(property) {
  if (!property) return 0;

  // Format 1: property.priceBreakdown.grossPrice.value
  const f1 = property?.priceBreakdown?.grossPrice?.value;
  if (f1 > 0) return Math.round(f1);

  // Format 2: property.priceBreakdown.gross_price
  const f2 = property?.priceBreakdown?.gross_price;
  if (f2 > 0) return extractPrice(f2);

  // Format 3: property.price
  const f3 = property?.price;
  if (f3 > 0) return extractPrice(f3);

  // Format 4: property.minPrice
  const f4 = property?.minPrice?.value || property?.minPrice;
  if (f4 > 0) return extractPrice(f4);

  return 0;
}

// getRooms javobidan narx oladi — har xil response formatlarni qo'llab-quvvatlaydi
function parseRoomPrice(data) {
  if (!data) return 0;
  const list = Array.isArray(data) ? data : (data.data || data.rooms || []);
  if (!list.length) return 0;

  let min = Infinity;
  for (const room of list) {
    // Format A: { min_price: { price: 85 } }
    const a = room?.min_price?.price || room?.min_price?.value;
    // Format B: { price_breakdown: { gross_price: 85 } }
    const b = room?.price_breakdown?.gross_price || room?.price_breakdown?.grossPrice?.value;
    // Format C: { priceBreakdown: { grossPrice: { value: 85 } } }
    const c = room?.priceBreakdown?.grossPrice?.value;
    // Format D: { price: 85 }
    const d = room?.price;
    // Format E: { min_total_price: 85 }
    const e = room?.min_total_price;

    const candidates = [a, b, c, d, e].map(extractPrice).filter((p) => p > 0);
    if (candidates.length) min = Math.min(min, ...candidates);
  }
  return min === Infinity ? 0 : min;
}

// ----- Raw funksiyalar (debug endpoint uchun) -----

export async function searchDestinationRaw(query) {
  const r = await axios.get(`${BASE}/hotels/searchDestination`, {
    params: { query },
    headers: headers(),
    timeout: TIMEOUT,
  });
  return r.data;
}

export async function searchHotelsRaw(dest_id, dest_type, checkIn, checkOut) {
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  const r = await axios.get(`${BASE}/hotels/searchHotels`, {
    params: {
      dest_id,
      search_type: (dest_type || 'CITY').toUpperCase(),
      arrival_date: ci,
      departure_date: co,
      adults: 2,
      room_qty: 1,
      page_number: 1,
      languagecode: 'en-us',
      currency_code: 'USD',
    },
    headers: headers(),
    timeout: TIMEOUT,
  });
  return r.data;
}

export async function getRoomsRaw(hotel_id, checkIn, checkOut) {
  const ci = checkIn || dateOffset(7);
  const co = checkOut || dateOffset(8);
  const r = await axios.get(`${BASE}/hotels/getRooms`, {
    params: {
      hotel_id,
      arrival_date: ci,
      departure_date: co,
      adults: 2,
      room_qty: 1,
      currency_code: 'USD',
      languagecode: 'en-us',
    },
    headers: headers(),
    timeout: TIMEOUT,
  });
  return r.data;
}

// ----- Asosiy funksiyalar -----

// Shahar/mamlakat nomidan dest_id topadi, bir nechta query bilan urinib ko'radi
async function resolveDestination(hotel) {
  const queries = [
    hotel.city,
    hotel.country,
    `${hotel.city} ${hotel.countryCode || ''}`.trim(),
    hotel.name,
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const raw = await searchDestinationRaw(q);
      const list = raw?.data;
      if (!Array.isArray(list) || !list.length) continue;
      const city = list.find((d) =>
        d.dest_type === 'city' || d.dest_type === 'region'
      ) || list[0];
      if (city?.dest_id) {
        return {
          dest_id: String(city.dest_id),
          dest_type: (city.dest_type || 'city').toUpperCase(),
          name: city.name || city.label,
        };
      }
    } catch (err) {
      if (err.response?.status === 429) throw err; // limit — keyingi querylar ham ishlamaydi
    }
  }
  return null;
}

// Hotel nomiga eng mos elementni topadi
function matchHotel(hotels, targetName) {
  if (!Array.isArray(hotels) || !hotels.length) return null;
  const target = targetName.toLowerCase().trim();
  const words = target.split(/\s+/).filter((w) => w.length > 3);

  let bestScore = -1;
  let best = null;

  for (const h of hotels) {
    const hName = (h.property?.name || h.name || '').toLowerCase();
    let score = 0;

    if (hName === target) score = 1000;
    else if (hName.includes(target)) score = 800;
    else if (target.includes(hName)) score = 700;
    else {
      for (const w of words) {
        if (hName.includes(w)) score += 100;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }

  // Kamida bitta so'z mos kelishi shart
  return bestScore >= 100 ? best : (hotels[0] || null);
}

/**
 * Hotel uchun Booking.com narxini qaytaradi.
 * @param {object} hotel — Mongoose Hotel hujjati
 * @returns {{ source, price, via } | null}
 */
export async function getBookingComPrice(hotel) {
  if (!hasBookingRapidApi()) return null;

  const ci = dateOffset(7);
  const co = dateOffset(8);

  try {
    // 1. Saqlangan hotel_id bo'lsa — to'g'ridan-to'g'ri getRooms
    if (hotel.bookingComHotelId) {
      try {
        const raw = await getRoomsRaw(hotel.bookingComHotelId, ci, co);
        const price = parseRoomPrice(raw?.data || raw);
        if (price > 0) {
          return { source: 'Booking.com', price, via: 'booking_rapidapi' };
        }
      } catch (err) {
        if (err.response?.status === 429) throw err; // quota tugagan — tashqariga chiqar
        // ID eskirgan bo'lishi mumkin — qidirishga o'tamiz
      }
    }

    // 2. Destination (shahar) topish
    const dest = await resolveDestination(hotel);
    if (!dest) {
      console.warn(`Booking RapidAPI: shahar topilmadi — hotel="${hotel.name}" city="${hotel.city}"`);
      return null;
    }

    // 3. Shahar bo'yicha hotel qidirish
    const hotelsRaw = await searchHotelsRaw(dest.dest_id, dest.dest_type, ci, co);
    const hotelList = hotelsRaw?.data?.hotels || hotelsRaw?.hotels || [];

    if (!hotelList.length) {
      console.warn(`Booking RapidAPI: "${dest.name}" shahrida hotel topilmadi`);
      return null;
    }

    // 4. Eng mos hotelni tanlaymiz
    const matched = matchHotel(hotelList, hotel.name);
    if (!matched) return null;

    const hotelId = String(matched.hotel_id || matched.hotelId || '');
    if (!hotelId) return null;

    // 5. Hotel ID'ni saqlaymiz (keyingi so'rovlar uchun)
    const { default: Hotel } = await import('../models/Hotel.js');
    Hotel.updateOne({ _id: hotel._id }, { bookingComHotelId: hotelId }).catch(() => {});

    // 6. searchHotels javobidan narxni olamiz
    const priceFromSearch = parseHotelPrice(matched.property);
    if (priceFromSearch > 0) {
      return { source: 'Booking.com', price: priceFromSearch, via: 'booking_rapidapi' };
    }

    // 7. Narx bo'lmasa — getRooms bilan urinib ko'ramiz
    const roomsRaw = await getRoomsRaw(hotelId, ci, co);
    const price = parseRoomPrice(roomsRaw?.data || roomsRaw);
    if (price > 0) {
      return { source: 'Booking.com', price, via: 'booking_rapidapi' };
    }

    console.warn(`Booking RapidAPI: hotel topildi (${matched.property?.name}) lekin narx olishda muammo`);
    return null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      // Caller (controller) quota haqida bilishi kerak — re-throw
      throw err;
    } else if (status === 403) {
      console.warn('Booking RapidAPI: 403 Forbidden — API kalitni tekshiring');
    } else {
      console.warn('Booking RapidAPI xato:', status || '', err.message);
    }
    return null;
  }
}
