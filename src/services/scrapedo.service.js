import axios from 'axios';
import { env } from '../config/env.js';
import { recordApiUsage } from '../utils/apiUsageTracker.js';

/**
 * Scrape.do — universal sahifa-tortish servisi (IP-rotatsiya, anti-blok).
 * https://scrape.do — bepul 1000 kredit/oy, oddiy so'rov = 1 kredit.
 *
 * MUHIM: bu NARX manbasi EMAS (Booking narxlarni JS bilan yuklaydi, kelmaydi).
 * Vazifasi — Booking sahifalaridan IDENTITY ma'lumot olish:
 *   • reyting (8.2) va sharhlar soni
 *   • kategoriya baholari (Cleanliness, Staff, Comfort, Value, Facilities...)
 *   • nom, manzil
 * Ishlatilishi: category-ratings zanjirining oxirgi fallback'i, raqib
 * ma'lumotini boyitish, skreyper o'chiq bo'lganda zaxira.
 */

const API = 'http://api.scrape.do/';
const TIMEOUT = 60_000;

export const hasScrapeDo = () => Boolean(env.SCRAPEDO_API_KEY);

/**
 * Sahifani Scrape.do orqali tortadi. Muvaffaqiyatda HTML string qaytaradi.
 * @param {string} targetUrl
 * @param {object} opts { superMode?: boolean, geoCode?: string }
 */
export async function fetchPage(targetUrl, opts = {}) {
  if (!hasScrapeDo()) throw new Error('SCRAPEDO_API_KEY sozlanmagan');

  const params = {
    url: targetUrl,
    token: env.SCRAPEDO_API_KEY,
    ...(opts.superMode && { super: 'true' }),
    ...(opts.geoCode && { geoCode: opts.geoCode }),
  };

  try {
    const r = await axios.get(API, { params, timeout: TIMEOUT, responseType: 'text' });
    recordApiUsage('scrapedo', true, null, opts.superMode ? 'super' : 'plain');
    return r.data;
  } catch (err) {
    recordApiUsage('scrapedo', false, err.message);
    throw err;
  }
}

/**
 * Booking.com hotel sahifasidan identity ma'lumotlarni ajratadi.
 * Narxlar bu sahifada YO'Q (JS bilan yuklanadi) — ataylab qidirilmaydi.
 *
 * @returns {{ name, rating, reviewCount, address, scores: Record<string,number> }}
 */
export function parseBookingHotelPage(html) {
  const out = { name: '', rating: 0, reviewCount: 0, address: '', scores: {} };
  if (!html || typeof html !== 'string') return out;

  // Nom — <h1> yoki title'dan
  out.name =
    (html.match(/<h1[^>]*>\s*([^<]{3,120})\s*</) || [])[1]?.trim() ||
    (html.match(/<title>\s*([^<,(]{3,120})/) || [])[1]?.trim() || '';

  // Umumiy reyting va sharhlar soni (JSON-LD ishonchli)
  out.rating = parseFloat((html.match(/"ratingValue"\s*:\s*"?([\d.]+)/) || [])[1]) || 0;
  out.reviewCount = parseInt((html.match(/"reviewCount"\s*:\s*"?(\d+)/) || [])[1], 10) || 0;

  // Manzil
  out.address = (html.match(/"streetAddress"\s*:\s*"([^"]{5,160})"/) || [])[1] || '';

  // Kategoriya baholari — 3 bosqichli, ishonchlilik tartibida:

  // 1) Sahifaga joylangan GraphQL JSON (eng aniq):
  //    "name":"hotel_location","translation":"Location","value":9.06...
  //    Har label uchun BIRINCHI qiymat olinadi (u umumiy; keyingilari
  //    customerType bo'yicha kesimlar bo'ladi).
  const jsonRe = /"name":"hotel_[a-z_]+","translation":"([^"]{2,40})","value":([\d.]+)/g;
  let jm;
  while ((jm = jsonRe.exec(html)) !== null) {
    const label = jm[1];
    const val = Math.round(parseFloat(jm[2]) * 10) / 10;
    if (val >= 1 && val <= 10 && !out.scores[label]) out.scores[label] = val;
  }

  // 2) Klassik markup: review_score_name">Label</p> ... review_score_value">9.1
  if (!Object.keys(out.scores).length) {
    const barRe = /review_score_name">([^<]{2,40})<[\s\S]{0,300}?review_score_value">([\d.]+)/g;
    let bm;
    while ((bm = barRe.exec(html)) !== null) {
      const val = parseFloat(bm[2]);
      if (val >= 1 && val <= 10 && !out.scores[bm[1].trim()]) out.scores[bm[1].trim()] = val;
    }
  }

  return out;
}

/**
 * Booking.com sahifasidagi tanlangan sharhlarni (featuredReviews) oladi.
 * Sahifa HTML'ida GraphQL JSON ko'rinishida ~10 ta sharh bo'ladi:
 *   { guestDetails:{username,countryCode}, reviewedDate, reviewScore,
 *     textDetails:{title, positiveText, negativeText} }
 * Apify/SerpAPI kalitisiz, 1 kredit. Sharh MATNI bilan (AI tahlil uchun).
 *
 * @returns {Promise<Array<{author, rating, text, date, source, externalId}>>}
 */
export async function getBookingReviews(bookingUrl) {
  if (!bookingUrl || !/booking\.com/.test(bookingUrl)) return [];
  const url = `${bookingUrl.split('?')[0]}?lang=en-us`;
  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.warn('Scrape.do getBookingReviews xato:', err.message);
    return [];
  }
  if (!html) return [];

  const out = [];
  // featuredReviews massividagi har bir yozuvni ajratamiz.
  const re = /"__typename":"PropertyFeaturedReview","reviewId":(\d+)[\s\S]{0,1400}?"textDetails":\{[^}]*\}/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const reviewId = m[1];
    if (seen.has(reviewId)) continue;
    seen.add(reviewId);

    const g = (re2) => (block.match(re2) || [])[1] || '';
    const author = g(/"username":"([^"]{1,60})"/) || 'Anonymous';
    const country = g(/"countryCode":"([a-z]{2})"/);
    const score10 = Number(g(/"reviewScore":(\d+(?:\.\d+)?)/)) || 0;
    const dateUnix = Number(g(/"reviewedDate":(\d{9,13})/)) || 0;
    const title = g(/"title":"((?:[^"\\]|\\.)*)"/);
    const pos = g(/"positiveText":"((?:[^"\\]|\\.)*)"/);
    const neg = g(/"negativeText":"((?:[^"\\]|\\.)*)"/);

    // JSON escape'larni (\n) va HTML entity'larni (&#39; &amp;) ochamiz
    const unesc = (s) => {
      let t = s;
      try { t = JSON.parse(`"${s}"`); } catch { /* xom qoldiramiz */ }
      return t
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .trim();
    };
    const parts = [unesc(pos), unesc(neg)].filter(Boolean);
    const text = parts.join(' — ').trim();
    if (!text && !unesc(title)) continue;

    out.push({
      author: unesc(author),
      country,
      rating: score10 ? Math.round((score10 / 2) * 10) / 10 : 0, // 10 → 5 ball
      title: unesc(title),
      text: text || unesc(title),
      date: dateUnix ? new Date(dateUnix * 1000) : null,
      source: 'Booking.com',
      externalId: `scrapedo:booking:${reviewId}`,
    });
  }
  return out;
}

/**
 * Booking URL bo'yicha hotel identity (reyting + kategoriya baholari).
 * category-ratings fallback va raqib-enrich shu funksiyani ishlatadi.
 */
export async function getBookingIdentity(bookingUrl) {
  if (!bookingUrl || !/booking\.com/.test(bookingUrl)) return null;
  // Til/valyutani barqarorlashtiramiz — parser inglizcha labellarga mo'ljallangan
  const url = `${bookingUrl.split('?')[0]}?lang=en-us&selected_currency=USD`;
  const html = await fetchPage(url);
  const parsed = parseBookingHotelPage(html);
  if (!parsed.rating && !Object.keys(parsed.scores).length) return null;
  return parsed;
}
