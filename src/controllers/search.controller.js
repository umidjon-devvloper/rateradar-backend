import { getCountries, searchCities, geocode } from '../services/geo.service.js';
import { searchHotels, listCityHotels } from '../services/places.service.js';

const normalize = (v) =>
  String(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function listCountries(req, res, next) {
  try {
    const countries = await getCountries();
    res.json({ countries });
  } catch (err) { next(err); }
}

export async function findCities(req, res, next) {
  try {
    const { q = '', country = '', limit = 10 } = req.query;
    if (!q || q.length < 2) return res.json({ cities: [] });
    const cities = await searchCities(q, country, parseInt(limit));
    res.json({ cities });
  } catch (err) { next(err); }
}

// Google Hotels/Booking JONLI SKREYPER orqali shahar hotellari — Places/OSM
// hech narsa topmaganda fallback. Natija hotelScraper.service ichida 30 daqiqa
// keshlanadi, shuning uchun bir shahar uchun takror chaqiruv tez. Koordinata
// bermaydi (hotel tanlanganda geocode bilan to'ldiriladi).
async function scraperCityHotels(city) {
  if (!city) return [];
  try {
    const { scraperEnabled, scraperDiscoverCity } = await import('../services/hotelScraper.service.js');
    if (!scraperEnabled()) return [];
    const found = await scraperDiscoverCity(city, '', 10);
    return (found || []).map((h) => ({
      placeId: '',
      name: h.name,
      address: h.address || city,
      lat: undefined,
      lng: undefined,
      rating: h.rating || 0,
      stars: h.stars || 0,
      reviews: h.reviews || 0,
      source: 'scraper',
    }));
  } catch {
    return [];
  }
}

export async function findHotels(req, res, next) {
  try {
    const { q = '', country = '', city = '', lat, lng, direct } = req.query;
    res.set('Cache-Control', 'no-store');
    const cLat = lat ? parseFloat(lat) : undefined;
    const cLng = lng ? parseFloat(lng) : undefined;
    const cityContext = { city, lat: cLat, lng: cLng };
    const isDirect = direct === '1' || direct === 'true';

    // direct=1 → TO'G'RIDAN-TO'G'RI jonli qidiruv (Google Places searchText → SERP → OSM).
    // Keshlangan shahar ro'yxatida yo'q hotelni ham topadi.
    if (isDirect) {
      if (!q || q.trim().length < 2) return res.json({ hotels: [] });
      let hotels = await searchHotels(q, country, cityContext);
      if (!hotels.length) hotels = await scraperCityHotels(city); // scraper fallback
      return res.json({ hotels, count: hotels.length });
    }

    // Shahar koordinatasi bor — o'sha shahardagi BARCHA hotelni qaytaramiz
    // (keshli, to'liq ro'yxat). q berilsa, server tomonda nom bo'yicha filtrlaymiz.
    if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
      let hotels = await listCityHotels(cityContext);
      const qn = normalize(q || '');
      if (qn) hotels = hotels.filter((h) => normalize(h.name).includes(qn));
      // Places/OSM shu shahar uchun hech narsa bermasa — scraper bilan to'ldiramiz.
      if (!hotels.length) {
        const sc = await scraperCityHotels(city);
        hotels = qn ? sc.filter((h) => normalize(h.name).includes(qn)) : sc;
      }
      return res.json({ hotels, count: hotels.length });
    }

    // Koordinatasiz — eski nom bo'yicha qidiruv (fallback)
    if (!q || q.length < 2) return res.json({ hotels: [] });
    let hotels = await searchHotels(q, country, cityContext);
    if (!hotels.length) hotels = await scraperCityHotels(city); // scraper fallback
    res.json({ hotels, count: hotels.length });
  } catch (err) { next(err); }
}

/**
 * GET /search/hotel-details
 * Booking.com'dan BITTA mehmonxonaning TO'LIQ ma'lumotini jonli skreyp qiladi
 * (tavsif, qulayliklar, rasmlar, sharhlar, narx). Foydalanuvchi qidiruvda
 * skreyper topgan natijani bossa, shu yerdan to'liq tafsilot olinadi.
 *
 * Parametrlar:
 *   • bookingUrl — qidiruv natijasidagi Booking.com link (eng to'g'ri yo'l), YOKI
 *   • q + city   — nom va shahar (avval Booking'da topib, keyin tafsilot oladi).
 *   • reviews    — nechta sharh olib kelish (default 10).
 */
export async function getHotelDetails(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const { bookingUrl = '', q = '', city = '', reviews = 10 } = req.query;
    const { scraperEnabled, scraperFindHotel, scraperHotelInfo } =
      await import('../services/hotelScraper.service.js');

    if (!scraperEnabled()) {
      return res.status(503).json({ error: 'Skreyper o\'chirilgan yoki sozlanmagan (HOTEL_SCRAPER_ENABLED / HOTEL_SCRAPER_PATH).' });
    }

    let url = String(bookingUrl || '').trim();
    let summary = null;

    // URL berilmagan bo'lsa — nom + shahar bo'yicha Booking'dan topamiz.
    if (!url) {
      if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: 'bookingUrl yoki (q + city) kerak' });
      }
      summary = await scraperFindHotel(q, city);
      url = summary?.bookingUrl || '';
      if (!url) {
        return res.status(404).json({ error: `"${q}" Booking.com'dan topilmadi` });
      }
    }

    const reviewsLimit = Math.min(50, Math.max(0, parseInt(reviews, 10) || 10));
    const details = await scraperHotelInfo(url, reviewsLimit);
    if (!details) {
      return res.status(502).json({ error: 'Booking.com tafsilotlarini olishda xato (sayt bloklagan yoki tuzilma o\'zgargan bo\'lishi mumkin)' });
    }

    res.json({ source: 'booking_scraper', summary, details });
  } catch (err) { next(err); }
}

export async function geocodeAddress(req, res, next) {
  try {
    const { address = '' } = req.query;
    if (!address) return res.status(400).json({ error: 'address kerak' });
    const result = await geocode(address);
    if (!result) return res.status(404).json({ error: 'Topilmadi' });
    res.json(result);
  } catch (err) { next(err); }
}
