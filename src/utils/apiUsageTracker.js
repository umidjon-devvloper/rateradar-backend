import ApiUsage from '../models/ApiUsage.js';

function yearMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * API so'rovni hisobga olish (fire-and-forget — asosiy so'rovga ta'sir qilmaydi).
 */
export function recordApiUsage(provider, success = true, error = null, engine = 'default') {
  const ym = yearMonth();
  const update = {
    $inc: {
      requestCount: 1,
      [success ? 'successCount' : 'failureCount']: 1,
    },
    $set: success
      ? { lastSuccessAt: new Date() }
      : {
          lastFailureAt: new Date(),
          lastError: String(error?.message || error || '').slice(0, 500),
        },
  };

  ApiUsage.findOneAndUpdate(
    { provider, yearMonth: ym, engine },
    update,
    { upsert: true }
  ).catch(() => {});
}

/**
 * Provayder haqida static ma'lumot (sayt, oylik limit, kategoriya).
 */
// Faqat saytda HAQIQATDA ishlatiladigan API'lar — aniq limitlari bilan.
export const PROVIDER_REGISTRY = {
  // ── Narx manbalari (OTA narxlari) ──────────────────────────────────────
  xotelo:  { website: 'https://xotelo.com',  monthlyLimit: null, free: true, category: 'prices',
             label: 'Xotelo (TripAdvisor)', note: 'Cheksiz bepul — 8+ OTA narxi, API kalit kerak emas', recommended: true },
  serpapi: { website: 'https://serpapi.com', monthlyLimit: 100, category: 'prices',
             label: 'SerpAPI', note: 'Bepul: 100 so\'rov/oy — google_hotels + sharhlar' },
  apify:   { website: 'https://apify.com',   monthlyLimit: null, category: 'prices',
             label: 'Apify', note: 'Bepul: $5 kredit/oy (~500-1000 scrape) — Booking/Expedia/Agoda' },
  hasdata: { website: 'https://hasdata.com', monthlyLimit: 1000, category: 'prices',
             label: 'HasData', note: 'Bepul: 1000 kredit/oy — 10 kredit/so\'rov (≈ 100 so\'rov)' },

  // ── AI ─────────────────────────────────────────────────────────────────
  gemini: { website: 'https://aistudio.google.com', monthlyLimit: 45000, category: 'ai',
            label: 'Google Gemini', note: 'Bepul: ~1500 so\'rov/kun (gemini-2.5-flash)', recommended: true },
  openai: { website: 'https://platform.openai.com', monthlyLimit: null, payPerUse: true, category: 'ai',
            label: 'OpenAI GPT', note: 'Pullik — ishlatilganicha (gpt-4o-mini)' },

  // ── Joy / rasm ─────────────────────────────────────────────────────────
  google_places: { website: 'https://console.cloud.google.com/google/maps-apis', monthlyLimit: 6000, category: 'geo',
                   label: 'Google Places', note: 'Bepul: $200 kredit/oy (~6000 so\'rov) — rasm + rating' },
  yandex: { website: 'https://yandex.com/maps-api/products/geosearch-api', monthlyLimit: null, category: 'geo',
            label: 'Yandex Geosearch', note: 'Bepul: ~500 so\'rov/kun — mehmonxona/org topish' },

  // ── Qidiruv ────────────────────────────────────────────────────────────
  duckduckgo: { website: 'https://duckduckgo.com', monthlyLimit: null, free: true, category: 'search',
                label: 'DuckDuckGo', note: 'Bepul — TripAdvisor URL qidiruvi (ko\'pincha bloklanadi, ishonchsiz)' },
};

// Admin panelida "Tavsiya etiladi" bo'limida ko'rsatiladigan API'lar —
// hozir ishlatilmagan, lekin sayt uchun foydali (ayniqsa zaif joylarni yopadi).
export const RECOMMENDED_APIS = [
  { label: 'Serper.dev', website: 'https://serper.dev', limit: '2500 so\'rov/oy bepul', priority: 'high',
    why: 'TripAdvisor havolasini ISHONCHLI topish (DuckDuckGo bloklanadi). Auto narx tortishni mustahkamlaydi.' },
  { label: 'Scrape.do', website: 'https://scrape.do', limit: '1000 so\'rov/oy bepul', priority: 'medium',
    why: 'Booking/OTA scraping uchun zaxira (Apify $5 krediti tugaganda ishlaydi).' },
  { label: 'RapidAPI — Booking/Hotels', website: 'https://rapidapi.com/hub', limit: 'Har xil bepul tarif', priority: 'low',
    why: 'Qo\'shimcha OTA narx manbasi — bitta kanal ishlamay qolsa muqobil.' },
];
