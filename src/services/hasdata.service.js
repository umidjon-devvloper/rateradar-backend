import axios from "axios";
import { env } from "../config/env.js";
import { recordApiUsage } from "../utils/apiUsageTracker.js";

/**
 * HasData Booking.com narx servisi.
 *
 * SerpAPI Google Hotels topa olmagan (kanali yo'q) mehmonxonalar uchun
 * to'g'ridan-to'g'ri Booking.com'dan narx olib kelishga ishlatiladi.
 *
 *   • Search API — mehmonxona nomi bo'yicha qidirish (bookingUrl bo'lmasa).
 *   • Place API  — saqlangan Booking URL bo'lsa, aniq narx (eng arzon xona).
 *
 * Har bir muvaffaqiyatli so'rov 10 kredit (oyiga 1000 bepul).
 * Docs: https://docs.hasdata.com/apis/booking/search
 */

const BASE = "https://api.hasdata.com/scrape/booking";

export const hasHasData = () => !!env.HASDATA_API_KEY;

async function hdGet(path, params) {
  const r = await axios.get(`${BASE}/${path}`, {
    params,
    headers: { "x-api-key": env.HASDATA_API_KEY },
    timeout: 90_000,
  });
  return r.data;
}

// Tekshiruv sanalari — bugundan +7 kun (kelajak bo'lishi shart), 1 kechalik.
function defaultDates() {
  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 7);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { checkIn: fmt(checkIn), checkOut: fmt(checkOut) };
}

// ─── Nom mosligini baholash ──────────────────────────────
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function nameTokens(s) {
  return new Set(normName(s).split(" ").filter((w) => w.length > 2));
}
/** 0..1 — qancha yuqori bo'lsa, nom shunchalik mos. */
function nameScore(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.9;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function normalizeSearchItem(r, score) {
  return {
    price: Math.round(r.price.pricePerStayParsed),
    currency: r.price.currency || "USD",
    url: r.url || "",
    matchedName: r.title || "",
    matchScore: Number(score.toFixed(2)),
    stars: r.rating || 0,
    reviewScore: r.reviews?.score || 0,
    reviewCount: r.reviews?.count || 0,
    address: r.location?.address || "",
  };
}

/**
 * Search API — keyword bo'yicha NOM bo'yicha eng mos mehmonxonani topadi
 * (narx bor-yo'qligidan qat'i nazar). Tanlangan sanalarda o'sha hotel narxi
 * inline kelmasa, chaqiruvchi Place API'ga o'tadi.
 *
 * @returns {{ item, score } | { notFound:true, candidates }}
 */
async function searchBestMatch({ name, city, checkIn, checkOut }) {
  const keyword = [name, city].filter(Boolean).join(" ");
  let data;
  try {
    data = await hdGet("search", {
      keyword,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      rooms: 1,
      adults: 2,
      children: 0,
      currency: "usd",
    });
    recordApiUsage("hasdata", true, null, "booking_search");
  } catch (err) {
    recordApiUsage("hasdata", false, err.message, "booking_search");
    throw err;
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return { notFound: true, candidates: [] };

  // Barcha natijalarni NOM bo'yicha baholaymiz (narxi yo'qlari ham — chunki
  // eng mos hotel tanlangan sanalarda band bo'lishi mumkin).
  const scored = results
    .map((r) => ({ r, score: nameScore(name, r.title) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  // Hech qanday nom mosligi bo'lmasa — umuman boshqa hotel, noaniq.
  if (best.score === 0) {
    return { notFound: true, candidates: scored.slice(0, 5).map((s) => s.r.title) };
  }
  return { item: best.r, score: best.score, candidates: scored.slice(0, 5).map((s) => s.r.title) };
}

/**
 * Place API — aniq Booking URL bo'yicha eng arzon xona narxi.
 */
async function placeBookingPrice({ url, checkIn, checkOut }) {
  let data;
  try {
    data = await hdGet("place", {
      url,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      rooms: 1,
      adults: 2,
      children: 0,
      currency: "usd",
    });
    recordApiUsage("hasdata", true, null, "booking_place");
  } catch (err) {
    recordApiUsage("hasdata", false, err.message, "booking_place");
    throw err;
  }

  // Barcha xona variantlari ichidan eng arzon narxni topamiz.
  let min = Infinity;
  for (const room of data?.rooms || []) {
    for (const v of room?.variants || []) {
      const p = v?.prices?.currentPriceParsed;
      if (p > 0 && p < min) min = p;
    }
  }
  if (!Number.isFinite(min)) return { notFound: true };

  const avgRating = (data?.ratings || []).find((x) => /average/i.test(x.label));
  return {
    price: Math.round(min),
    currency: data?.bookingDetails?.currency || "USD",
    url,
    matchedName: data?.overview?.title || "",
    matchScore: 1,
    stars: 0,
    reviewScore: avgRating?.value || 0,
    reviewCount: avgRating?.votes || 0,
    address: data?.overview?.address?.streetAddress || "",
  };
}

/**
 * XONA TURLARI — Booking Place API'dan TO'LIQ ro'yxat.
 *
 * `placeBookingPrice` xuddi shu javobni oladi, lekin `rooms[].variants[]` ni
 * aylanib chiqib faqat ENG ARZON narxni qaytaradi — qolgan hamma narsa
 * tashlanardi. Aslida o'sha javobda har bir xona turi, sig'imi va "faqat X
 * qoldi" ma'lumoti bor.
 *
 * Nima uchun bu skreyperdan yaxshiroq: HasData strukturaviy JSON qaytaradi,
 * HTML parsing yo'q, 522/timeout yo'q. Bitta so'rov 10 kredit.
 *
 * @returns {Promise<{rooms:Array<{name,price,guests,roomsLeft}>, currency, url}|null>}
 */
export async function getBookingRoomsHasData({ url, checkIn, checkOut }) {
  if (!hasHasData() || !url) return null;

  const dates = checkIn && checkOut ? { checkIn, checkOut } : defaultDates();
  let data;
  try {
    data = await hdGet("place", {
      url,
      checkInDate: dates.checkIn,
      checkOutDate: dates.checkOut,
      rooms: 1,
      adults: 2,
      children: 0,
      currency: "usd",
    });
    recordApiUsage("hasdata", true, null, "booking_rooms");
  } catch (err) {
    recordApiUsage("hasdata", false, err.message, "booking_rooms");
    throw err;
  }

  // Bitta xona turi bir necha "variant" bilan keladi (nonushta bilan/siz,
  // qaytariladigan/qaytarilmaydigan...). Foydalanuvchiga xona turi kerak,
  // shuning uchun har turdan ENG ARZON variantni olamiz.
  const rooms = [];
  for (const room of data?.rooms || []) {
    let best = null;
    for (const v of room?.variants || []) {
      const price = v?.prices?.currentPriceParsed;
      if (!(price > 0)) continue;
      if (!best || price < best.price) {
        best = {
          price: Math.round(price),
          // Sig'im va "qoldi" turli javoblarda turli nomda keladi.
          guests: Number(v?.maxOccupancy ?? v?.guests ?? room?.maxOccupancy ?? 2) || 2,
          roomsLeft: firstFinite(v?.roomsLeft, v?.availableRooms, room?.roomsLeft),
        };
      }
    }
    if (!best) continue;
    rooms.push({
      name: String(room?.name || room?.title || "Room").trim() || "Room",
      price: best.price,
      guests: best.guests,
      roomsLeft: best.roomsLeft,
    });
  }

  if (!rooms.length) return null;
  rooms.sort((a, b) => a.price - b.price);
  return {
    rooms: rooms.slice(0, 12),
    currency: data?.bookingDetails?.currency || "USD",
    url,
  };
}

function firstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Booking.com narxini HasData orqali oladi.
 *   - bookingUrl mavjud bo'lsa → Place API (aniqroq)
 *   - aks holda → Search API (nom bo'yicha)
 *
 * @returns {Promise<{price?, currency?, url?, matchedName?, ...} | {notFound:true, candidates?}>}
 */
export async function getBookingPriceHasData({ name, city, bookingUrl }) {
  if (!hasHasData()) throw new Error("HASDATA_API_KEY sozlanmagan");
  const { checkIn, checkOut } = defaultDates();

  // 1) Saqlangan Booking URL bo'lsa — Place API (aniqroq).
  if (bookingUrl && /booking\.com/.test(bookingUrl)) {
    const res = await placeBookingPrice({ url: bookingUrl, checkIn, checkOut });
    if (!res.notFound) return res;
    // Place topa olmasa — nom bo'yicha qidirishga tushamiz.
  }

  // 2) Nom bo'yicha eng mos hotelni topamiz.
  const match = await searchBestMatch({ name, city, checkIn, checkOut });
  if (match.notFound) return match;

  const { item, score } = match;
  // Inline narx bo'lsa — to'g'ridan-to'g'ri qaytaramiz.
  if (item?.price?.pricePerStayParsed > 0) {
    return normalizeSearchItem(item, score);
  }

  // Eng mos hotel topildi, lekin search'da narx kelmadi (band yoki sponsor
  // natija). Ishonchli moslik (>=0.5) bo'lsa, aniq narx uchun Place API'ga
  // o'tamiz — bu noto'g'ri hotel narxini qaytarmaslikni kafolatlaydi.
  if (score >= 0.5 && item?.url) {
    const placed = await placeBookingPrice({ url: item.url, checkIn, checkOut });
    if (!placed.notFound) return { ...placed, matchedName: item.title || placed.matchedName };
  }

  return {
    notFound: true,
    reason: "no_availability",
    matchedName: item?.title || "",
    candidates: match.candidates,
  };
}
