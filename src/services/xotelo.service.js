import axios from 'axios';

// Xotelo /rates direct'da bepul ishlaydi. hotel_key olish uchun TripAdvisor URL'ni
// DuckDuckGo HTML qidiruvi orqali topamiz — hech qanday API kalit kerak emas.
const DIRECT_BASE = 'https://data.xotelo.com/api';
const TIMEOUT = 8000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// HTML'dan birinchi tripadvisor Hotel_Review (yoki Hotel-Review) URL'ni ajratadi.
function matchTaUrl(html) {
  const s = String(html || '');
  let m = s.match(/tripadvisor\.[a-z.]+\/Hotel[_-]Review-g\d+-d\d+[^\s"'<>\\)]*/i);
  if (m) return m[0].startsWith('http') ? m[0] : `https://www.${m[0]}`;
  m = s.match(/Hotel[_-]Review-g\d+-d\d+/i);
  if (m) return `https://www.tripadvisor.com/${m[0]}`;
  return null;
}

// Qidiruv tizimlari — biri bloklasa (DDG ko'pincha bloklaydi), keyingisi sinaladi.
const SEARCH_ENGINES = [
  async (q) => {
    const body = new URLSearchParams({ q }).toString();
    const r = await axios.post('https://html.duckduckgo.com/html/', body, {
      timeout: 10_000,
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return r.data;
  },
  async (q) => {
    const r = await axios.get('https://www.bing.com/search', {
      params: { q }, timeout: 10_000,
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return r.data;
  },
  async (q) => {
    const body = new URLSearchParams({ q }).toString();
    const r = await axios.post('https://lite.duckduckgo.com/lite/', body, {
      timeout: 10_000,
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return r.data;
  },
];

/**
 * Mehmonxona uchun tripadvisor.com/Hotel_Review URL'ni topadi. Bepul, API
 * kalit kerak emas. Bir nechta qidiruv tizimini ketma-ket sinaydi — biri
 * bloklasa, Bing yoki DDG-Lite urinib ko'riladi.
 */
export async function findTripAdvisorUrl(name, city = '') {
  const q = `${name} ${city} tripadvisor hotel`.trim();
  for (const engine of SEARCH_ENGINES) {
    try {
      const url = matchTaUrl(await engine(q));
      if (url) return url;
    } catch {
      // bu tizim bloklandi yoki xato — keyingisini sinaymiz
    }
  }
  console.warn('TripAdvisor URL topilmadi (barcha qidiruv tizimlari):', name, city);
  return null;
}

const CHANNEL_MAP = {
  // Booking.com
  'Booking.com': 'Booking.com',
  Booking: 'Booking.com',
  BookingCom: 'Booking.com',
  booking: 'Booking.com',
  // Agoda
  Agoda: 'Agoda',
  'Agoda.com': 'Agoda',
  // Hotels.com
  'Hotels.com': 'Hotels.com',
  Hotels: 'Hotels.com',
  HotelsCom: 'Hotels.com',
  HotelsCom2: 'Hotels.com',
  // Expedia
  Expedia: 'Expedia',
  // Vio.com (eski nomi HotelsCombined)
  'Vio.com': 'Vio.com',
  Vio: 'Vio.com',
  HotelsCombined: 'Vio.com',
  // Trip.com (eski nomi Ctrip)
  'Trip.com': 'Trip.com',
  TripCom: 'Trip.com',
  Ctrip: 'Trip.com',
  // Priceline
  Priceline: 'Priceline',
  // TripAdvisor
  TripAdvisor: 'TripAdvisor',
  Tripadvisor: 'TripAdvisor',
  // Boshqalar
  Amari: 'Amari.com',
  'Amari.com': 'Amari.com',
  Destinia: 'Destinia',
  eDreams: 'eDreams',
  Orbitz: 'Orbitz',
  Travelocity: 'Travelocity',
};

export async function getXoteloRates(hotelKey, {
  checkIn,
  checkOut,
  currency = 'USD',
  adults = 2,
  rooms = 1,
} = {}) {
  const normalizedKey = extractXoteloHotelKey(hotelKey);
  if (!normalizedKey) return null;
  const chkIn = checkIn || dateOffset(7);
  const chkOut = checkOut || dateOffset(8);

  try {
    const r = await axios.get(`${DIRECT_BASE}/rates`, {
      params: {
        hotel_key: normalizedKey,
        chk_in: chkIn,
        chk_out: chkOut,
        currency,
        adults,
        rooms,
      },
      timeout: TIMEOUT,
    });

    if (r.data?.error) {
      console.warn('Xotelo /rates xato:', r.data.error);
      return null;
    }

    const rates = normalizeRates(r.data?.result?.rates || []);
    if (!rates.length) return null;

    return {
      provider: 'xotelo',
      hotelKey: normalizedKey,
      checkIn: r.data?.result?.chk_in || chkIn,
      checkOut: r.data?.result?.chk_out || chkOut,
      timestamp: r.data?.timestamp || null,
      rates,
      raw: r.data,
    };
  } catch (err) {
    console.warn('Xotelo /rates xato:', err.response?.status || '', err.message);
    return null;
  }
}

/**
 * Hotel nomidan Xotelo hotel_key topish — TripAdvisor URL'ni DuckDuckGo'dan topib,
 * undagi `g{loc}-d{hotel}` formatdagi hotel_key ajratiladi.
 * `hasXoteloSearch()` har doim true qaytaradi — qidiruv DDG orqali ishlaydi.
 */
export function hasXoteloSearch() { return true; }

export async function searchXoteloHotel(name, city) {
  const url = await findTripAdvisorUrl(name, city);
  return url ? extractXoteloHotelKey(url) : null;
}

export async function getXoteloRatesForHotel({ hotelKey, tripAdvisorUrl, currency = 'USD' }) {
  const key = extractXoteloHotelKey(hotelKey) || extractXoteloHotelKey(tripAdvisorUrl);
  if (!key) return null;

  const rates = await getXoteloRates(key, { currency });
  if (!rates) return null;

  return {
    ...rates,
    rates: rates.rates.map((p) => ({ ...p, via: 'xotelo' })),
  };
}

/**
 * Yaqin sanalardagi kanallarni yig'adi. Standart — ERTAGA (+1) va INDIN (+2):
 * bugundan emas, kelgusi 2 kun narxini olamiz. Xotelo /rates har bir sanada
 * faqat o'sha kunga band bo'lmagan kanallarni qaytaradi, shuning uchun 2 kunni
 * birlashtiramiz (union). Har bir kanal uchun eng yaqin sanadagi narx olinadi.
 * Xotelo bepul va cheklovsiz.
 */
export async function getXoteloMergedRates({
  hotelKey,
  tripAdvisorUrl,
  currency = 'USD',
  offsets = [1, 2],
} = {}) {
  const key = extractXoteloHotelKey(hotelKey) || extractXoteloHotelKey(tripAdvisorUrl);
  if (!key) return null;

  // Sanalarni parallel so'raymiz (offsets tartibi saqlanadi → eng yaqin g'olib).
  const results = await Promise.all(
    offsets.map((off) =>
      getXoteloRates(key, {
        checkIn: dateOffset(off),
        checkOut: dateOffset(off + 1),
        currency,
      }).catch(() => null),
    ),
  );

  const bySource = new Map();
  for (const res of results) {
    if (!res?.rates?.length) continue;
    for (const r of res.rates) {
      if (r.price > 0 && !bySource.has(r.source)) {
        bySource.set(r.source, { ...r, via: 'xotelo', checkIn: res.checkIn });
      }
    }
  }
  if (!bySource.size) return null;

  return { provider: 'xotelo', hotelKey: key, rates: Array.from(bySource.values()) };
}

export function extractXoteloHotelKey(value) {
  if (!value) return '';
  const str = String(value).trim();

  const direct = str.match(/\b(g\d+-d\d+)\b/i);
  if (direct) return direct[1].toLowerCase();

  const tripAdvisorUrl = str.match(/Hotel-Review-(g\d+)-d(\d+)/i);
  if (tripAdvisorUrl) return `${tripAdvisorUrl[1].toLowerCase()}-d${tripAdvisorUrl[2]}`;

  return '';
}

function normalizeRates(rates) {
  const byChannel = new Map();

  for (const row of rates) {
    const rawName = row?.name || row?.code || '';
    const source = CHANNEL_MAP[rawName] || CHANNEL_MAP[row?.code] || rawName;
    const price = Number(row?.rate);
    if (!source || !Number.isFinite(price) || price <= 0) continue;

    const existing = byChannel.get(source);
    if (!existing || price < existing.price) {
      byChannel.set(source, {
        source,
        price: Math.round(price * 100) / 100,
        code: row?.code || '',
      });
    }
  }

  return Array.from(byChannel.values());
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
