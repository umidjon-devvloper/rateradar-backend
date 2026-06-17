import axios from "axios";
import { env } from "../config/env.js";
import { recordApiUsage } from "../utils/apiUsageTracker.js";

/**
 * Yandex Maps Geosearch (Поиск по организациям) servisi.
 *
 * Yandex'da mehmonxona SHARHLARI uchun rasmiy ochiq API yo'q. Shuning uchun
 * gibrid yondashuv:
 *   • Geosearch API (shu fayl) — mehmonxonani nom+shahar bo'yicha topadi,
 *     uning Yandex Maps org URL'ini (sharhlar sahifasi) va metadata'sini beradi.
 *     Bu rasmiy, arzon va tez (kuniga ~1000 bepul so'rov, API key bilan).
 *   • Apify Yandex reviews scraper (apify.service.js) — o'sha URL'dan
 *     alohida sharh matnlarini va umumiy reyting/sonni olib keladi.
 *
 * Geosearch javobi GeoJSON FeatureCollection. Har bir feature'da
 * `properties.CompanyMetaData` (id, name, address, url, Categories, Phones).
 * Reyting/sharhlar soni standart javobda kelmasligi mumkin — kelsa parse
 * qilamiz, aks holda 0 (keyin Apify run'idan to'ldiriladi).
 *
 * Docs: https://yandex.com/maps-api/docs/geosearch-api/
 */

const GEOSEARCH = "https://search-maps.yandex.ru/v1/";

export const hasYandex = () => !!env.YANDEX_GEOSEARCH_API_KEY;

// ─── Nom mosligini baholash (hasdata.service.js bilan bir xil uslub) ──────────
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ\s]/g, " ") // lotin + kiril harflarini saqlaymiz
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

// Geosearch feature → bizning tekis obyektimiz.
function parseFeature(f) {
  const props = f?.properties || {};
  const meta = props.CompanyMetaData || {};
  const id = meta.id || "";
  // Reyting/sharhlar soni — Yandex turli kalitlarda berishi mumkin; topa olsak.
  const ratingObj = meta.Ratings || props.Ratings || props.businessRating || {};
  const rating = Number(
    ratingObj.score ?? ratingObj.rating ?? ratingObj.value ?? meta.score ?? 0
  );
  const reviewCount = Number(
    ratingObj.ratings ?? ratingObj.reviews ?? ratingObj.reviewCount ?? meta.reviewCount ?? 0
  );
  const [lon, lat] = f?.geometry?.coordinates || [0, 0];

  return {
    orgId: id,
    name: meta.name || props.name || "",
    address: meta.address || props.description || "",
    // Sharhlar sahifasiga to'g'ridan-to'g'ri URL — Apify scraper shuni kutadi.
    url: id ? `https://yandex.ru/maps/org/${id}/reviews/` : meta.url || "",
    coords: { latitude: lat, longitude: lon },
    rating: Number.isFinite(rating) ? rating : 0,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : 0,
  };
}

/**
 * Mehmonxonani nom+shahar bo'yicha Yandex Maps'dan topadi.
 *
 * @param {{ name:string, city?:string, coords?:{latitude,longitude} }} args
 * @returns {Promise<{ orgId, name, address, url, coords, rating, reviewCount, matchScore } | { notFound:true, candidates:string[] }>}
 */
export async function findYandexOrg({ name, city, coords } = {}) {
  if (!hasYandex()) throw new Error("YANDEX_GEOSEARCH_API_KEY sozlanmagan");
  if (!name) return { notFound: true, candidates: [] };

  const text = [name, city].filter(Boolean).join(" ");
  const params = {
    apikey: env.YANDEX_GEOSEARCH_API_KEY,
    text,
    lang: "ru_RU",
    type: "biz", // faqat tashkilotlar (mehmonxonalar)
    results: 10,
  };
  // Koordinata bo'lsa — qidiruvni shu nuqta atrofiga yo'naltiramiz (aniqroq).
  if (coords?.latitude && coords?.longitude) {
    params.ll = `${coords.longitude},${coords.latitude}`;
    params.spn = "0.1,0.1";
  }

  let data;
  try {
    const r = await axios.get(GEOSEARCH, { params, timeout: 15_000 });
    data = r.data;
    recordApiUsage("yandex", true, null, "geosearch");
  } catch (err) {
    recordApiUsage("yandex", false, err.message, "geosearch");
    throw err;
  }

  const features = Array.isArray(data?.features) ? data.features : [];
  if (!features.length) return { notFound: true, candidates: [] };

  const scored = features
    .map((f) => {
      const item = parseFeature(f);
      return { item, score: nameScore(name, item.name) };
    })
    .filter((s) => s.item.orgId) // org id'siz natijalar Apify uchun yaroqsiz
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { notFound: true, candidates: [] };

  const best = scored[0];
  const candidates = scored.slice(0, 5).map((s) => s.item.name);
  if (best.score === 0) return { notFound: true, candidates };

  return { ...best.item, matchScore: Number(best.score.toFixed(2)), candidates };
}
