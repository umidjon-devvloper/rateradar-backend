import { hasHasData, getBookingPriceHasData } from './hasdata.service.js';
import {
  hasApify,
  getBookingPriceApify,
  getExpediaPriceApify,
  getHotelsComPriceApify,
  getTripComPriceApify,
  findExpediaUrl,
  findHotelsUrl,
  findTripUrl,
} from './apify.service.js';

// SerpAPI bo'sh qaytarganda to'ldirilishi shart bo'lgan 5 ta asosiy kanal.
// Har biriga canonical nom + qaysi nomlarda kelishi mumkinligi (aliases).
export const TARGET_CHANNELS = [
  { label: 'Booking.com', aliases: ['booking.com', 'booking'] },
  { label: 'Agoda',       aliases: ['agoda'] },
  { label: 'Expedia',     aliases: ['expedia'] },
  { label: 'Hotels.com',  aliases: ['hotels.com', 'hotels'] },
  { label: 'Trip.com',    aliases: ['trip.com', 'trip'] },
];

/**
 * Bitta kanal uchun fallback narx — SerpAPI o'sha kanalni (yoki butun
 * mehmonxonani) topa olmaganida. Own hotel uchun ham, raqib uchun ham ishlaydi.
 *   Booking.com → HasData (arzon, tez) → Apify
 *   Expedia / Hotels.com / Trip.com → URL topish (SerpAPI google_search) + Apify
 *   Agoda → fallback yo'q (Apify'da narx scraperi yo'q)
 *
 * @param {{ name, city, otaUrls?, persist? }} target  persist(key,url) — topilgan
 *        URL'ni saqlovchi ixtiyoriy callback (own hotel uchun); raqibda null.
 * @returns {Promise<{ price, link, via, currency } | null>}
 */
export async function fetchChannelFallback(target, label, ciStr, coStr) {
  const { name, city = '', otaUrls = {}, persist = null } = target;
  const save = (key, url) => (persist ? persist(key, url) : Promise.resolve());
  try {
    if (label === 'Booking.com') {
      // 1) HasData — to'g'ridan-to'g'ri Booking.com, arzon (10 kredit).
      if (hasHasData()) {
        const hd = await getBookingPriceHasData({ name, city, bookingUrl: otaUrls['Booking.com'] });
        if (hd && !hd.notFound && hd.price > 0) {
          await save('Booking.com', hd.url);
          return { price: hd.price, link: hd.url || null, via: 'hasdata', currency: hd.currency || 'USD' };
        }
      }
      // 2) Apify Booking scraper.
      if (hasApify()) {
        const ap = await getBookingPriceApify(name, city, {
          checkIn: ciStr, checkOut: coStr, bookingUrl: otaUrls['Booking.com'],
        });
        if (ap?.price > 0) return { price: ap.price, link: ap.link, via: 'apify', currency: 'USD' };
      }
      return null;
    }

    // Qolgan kanallar faqat Apify orqali — URL kerak.
    if (!hasApify()) return null;

    if (label === 'Expedia') {
      const url = otaUrls['Expedia'] || (await findExpediaUrl(name, city));
      if (!url) return null;
      await save('Expedia', url);
      const r = await getExpediaPriceApify(name, city, { checkIn: ciStr, checkOut: coStr, expediaUrl: url });
      return r?.price > 0 ? { price: r.price, link: r.link, via: 'apify', currency: 'USD' } : null;
    }

    if (label === 'Hotels.com') {
      const url = otaUrls['Hotels.com'] || (await findHotelsUrl(name, city));
      if (!url) return null;
      await save('Hotels.com', url);
      const r = await getHotelsComPriceApify(name, city, { checkIn: ciStr, checkOut: coStr, hotelsUrl: url });
      return r?.price > 0 ? { price: r.price, link: r.link, via: 'apify', currency: 'USD' } : null;
    }

    if (label === 'Trip.com') {
      const url = otaUrls['Trip.com'] || (await findTripUrl(name, city));
      if (!url) return null;
      await save('Trip.com', url);
      const r = await getTripComPriceApify(name, city, { checkIn: ciStr, checkOut: coStr, tripUrl: url });
      return r?.price > 0 ? { price: r.price, link: r.link, via: 'apify', currency: 'USD' } : null;
    }

    // Agoda — fallback yo'q.
    return null;
  } catch (err) {
    console.warn(`[Fallback ${label}] "${name}": ${err.message}`);
    return null;
  }
}
