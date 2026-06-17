import axios from "axios";
import { env } from "../config/env.js";
import { recordApiUsage } from "../utils/apiUsageTracker.js";

const TIMEOUT = 15000;

function wrapWithTracking(name, fn) {
  return async function (engine, params) {
    try {
      const result = await fn.call(this, engine, params);
      recordApiUsage(name, true, null, engine);
      return result;
    } catch (err) {
      recordApiUsage(name, false, err, engine);
      throw err;
    }
  };
}

// ─── Yagona provider: SerpAPI ────────────────────────────────────────────────
// https://serpapi.com/
// Bepul: 100 ta so'rov/oy. Kerakli enginelar:
//   google_hotels  — hotel narxlari + barcha OTA partnerlari (Booking, Agoda, Hotels.com, Trip.com …)
//   google         — umumiy qidiruv (narx fallback + hotel ma'lumot)
//   google_maps    — yaqin-atrofdagi joylar
//   tripadvisor    — TripAdvisor rating + link
const serpapi = {
  name: "serpapi",
  monthlyLimit: 100,
  supports: ["google_hotels", "google_search", "google_maps", "tripadvisor"],
  get apiKey() {
    return env.SERPAPI_API_KEY;
  },
  async query(engine, params) {
    if (!this.apiKey) throw new Error("SERPAPI_API_KEY yo\x27q — https://serpapi.com/manage-api-key");
    const engineMap = {
      google_hotels: "google_hotels",
      google_search: "google",
      google_maps: "google_maps",
      tripadvisor: "tripadvisor",
    };
    const r = await axios.get("https://serpapi.com/search", {
      params: { ...params, engine: engineMap[engine] || engine, api_key: this.apiKey },
      timeout: TIMEOUT,
    });
    return normalize(engine, r.data, "serpapi");
  },
};

serpapi.query = wrapWithTracking("serpapi", serpapi.query.bind(serpapi));

// ─── Normalize ────────────────────────────────────────────────────────────────

function normalize(engine, raw, source) {
  // google_hotels → hotel ro'yxati + har birining OTA narxlari
  if (engine === "google_hotels") {
    const properties = raw.properties || raw.hotels_results || raw.results || [];
    return {
      type: "hotels",
      hotels: properties.map((p) => ({
        name: p.name || p.title,
        price: extractPrice(p),
        rating: p.overall_rating || p.rating || 0,
        reviews: p.reviews || p.review_count || 0,
        image: p.images?.[0]?.thumbnail || p.thumbnail || null,
        link: p.link || p.serpapi_property_details_link || null,
        coords: p.gps_coordinates || null,
        amenities: p.amenities || [],
        hotelClass: p.hotel_class || p.extracted_hotel_class || p.class || 0,
        otaPrices: extractOtaPrices(p),
        description: p.description || "",
      })),
      raw,
      source,
    };
  }

  // google → umumiy qidiruv natijasi (narx fallback, knowledge graph)
  if (engine === "google_search") {
    return {
      type: "search",
      results: (raw.organic_results || raw.organic || []).map((r) => ({
        title: r.title,
        snippet: r.snippet,
        link: r.link,
      })),
      knowledgeGraph: raw.knowledge_graph || raw.knowledgeGraph || null,
      localResults: (raw.local_results || []).map((r) => ({
        name: r.title || r.name,
        rating: r.rating || 0,
        reviews: r.reviews || 0,
        address: r.address || "",
      })),
      raw,
      source,
    };
  }

  // google_maps → atrofdagi joylar
  if (engine === "google_maps") {
    const places = raw.local_results || raw.places_results || raw.results || raw.places || [];
    return {
      type: "maps",
      places: places.map((p) => ({
        name: p.title || p.name,
        address: p.address || p.fullAddress,
        rating: p.rating || p.reviewsRating,
        reviews: p.reviews || p.reviewsCount,
        coords: p.gps_coordinates || p.coords || {
          latitude: p.latitude,
          longitude: p.longitude,
        },
      })),
      raw,
      source,
    };
  }

  // tripadvisor → hotel ro'yxati (rating, link, narx)
  if (engine === "tripadvisor") {
    const items =
      raw.location_results ||
      raw.search_results ||
      raw.hotels_results ||
      raw.results ||
      [];
    return {
      type: "tripadvisor",
      items: items.map((it) => ({
        name: it.title || it.name,
        rating:
          it.rating?.value ||
          it.rating ||
          it.bubble_rating?.rating ||
          0,
        reviews: it.reviews_count || it.reviews || it.review_count || 0,
        link: it.link || it.url || it.serpapi_link || "",
        price: extractPrice(it),
        image: it.image || it.thumbnail || "",
        address: it.address || it.location || "",
        hotelClass: it.hotel_class || it.extracted_hotel_class || it.class || 0,
        priceLevel: it.price_level || "",
      })),
      raw,
      source,
    };
  }

  return { type: "unknown", raw, source };
}

// ─── Price helpers ────────────────────────────────────────────────────────────

function extractPrice(p) {
  if (typeof p.rate_per_night?.extracted_lowest === "number")
    return p.rate_per_night.extracted_lowest;
  if (typeof p.price === "number") return p.price;
  if (typeof p.rate?.extracted_lowest === "number")
    return p.rate.extracted_lowest;
  const str = p.rate_per_night?.lowest || p.price_str || p.price || "";
  const m = String(str).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : 0;
}

// Google Hotels → OTA partners (Booking.com, Agoda, Hotels.com, Trip.com …)
function extractOtaPrices(p) {
  const arr = p.prices || p.featured_prices || p.partners || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((pr) => ({
      source: pr.source || pr.partner || pr.name || "",
      logo: pr.logo || null,
      price:
        pr.rate_per_night?.extracted_lowest ||
        pr.extracted_price ||
        extractPrice(pr) ||
        0,
      link: pr.link || pr.official_link || null,
    }))
    .filter((x) => x.source && x.price > 0);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { serpapi };
export const providers = [serpapi].filter((p) => !!p.apiKey);
export const allProviders = [serpapi];
