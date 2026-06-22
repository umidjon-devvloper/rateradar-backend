import OpenAI from 'openai';
import { env } from '../config/env.js';
import { recordApiUsage } from '../utils/apiUsageTracker.js';

let client = null;

function getClient() {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

async function ask(prompt) {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    recordApiUsage('openai', true);
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    recordApiUsage('openai', false, err);
    throw err;
  }
}

export async function analyzeReview(reviewText, lang = 'uz') {
  const langName = lang === 'uz' ? "O'zbek tilida" : lang === 'ru' ? 'Rus tilida' : 'English';
  const prompt = `Quyidagi mehmonxona sharhini tahlil qil. Faqat JSON qaytar:
{
  "sentiment": "positive" yoki "neutral" yoki "negative",
  "sentimentScore": -1 dan +1 gacha raqam,
  "topics": ["tozalik","xizmat","joylashuv","nonushta","wifi","narx","shovqin"] dan eng ko'pi 4 ta,
  "aiSummary": "${langName} 1 jumla xulosa"
}
Sharh: "${reviewText.slice(0, 1500)}"`;

  try {
    const parsed = await ask(prompt);
    if (!parsed) return { sentiment: 'unknown', sentimentScore: 0, topics: [], aiSummary: '' };
    return {
      sentiment: parsed.sentiment || 'neutral',
      sentimentScore: parseFloat(parsed.sentimentScore) || 0,
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 4) : [],
      aiSummary: parsed.aiSummary || '',
    };
  } catch (err) {
    console.error('OpenAI analyzeReview xato:', err.message);
    return { sentiment: 'unknown', sentimentScore: 0, topics: [], aiSummary: '' };
  }
}

export async function getPriceRecommendations({
  myHotel,
  myPrice,
  competitors,
  marketAvg,
  rating = 0,
  reviewCount = 0,
  stars = 0,
  hotelServiceConnected = false,
  lang = 'uz',
}) {
  const langName = lang === 'uz' ? "o'zbek" : lang === 'ru' ? 'rus' : 'ingliz';
  const compList = competitors.length
    ? competitors.map((c, i) => `${i + 1}. ${c.name} — $${c.price} (${c.stars}★, ${c.distanceKm}km)`).join('\n')
    : 'Ma\'lumot yo\'q';

  const prompt = `Sen hotel revenue manager va mehmonxona biznesi maslahatchisisan. Ma'lumotga qarab 3-5 ta amaliy tavsiya ber.

Mening hotel: ${myHotel}
Mening narx: $${myPrice}
Bozor o'rtacha: $${marketAvg}
Yulduz: ${stars}★ | Reyting: ${rating} (${reviewCount} sharh)
Raqiblar:
${compList}

Mehmonxona-xizmati moduli (RateRadar Hotel Service — mehmonlar QR orqali xizmat buyuradi, so'rovlar xodimlarga Telegram'da boradi) holati: ${hotelServiceConnected ? 'ULANGAN' : 'ULANMAGAN'}

Tavsiyalar quyidagilarni qamrab olsin:
- Narx optimizatsiyasi (raqiblar va bozorga nisbatan) — currentPrice/suggestedPrice bilan.
- Qo'shimcha daromad: qo'shimcha xizmatlar/upsell (transfer, nonushta, kech chiqish, ekskursiya va h.k.) — reyting va bozorga mos.
${hotelServiceConnected
  ? '- Mehmonxona-xizmati ULANGAN: undan qanday yaxshiroq foydalanishni tavsiya qil.'
  : '- Mehmonxona-xizmati ULANMAGAN bo\'lgani uchun ALBATTA bitta tavsiya mehmonxona-xizmati modulini ulashga oid bo\'lsin (mehmon tajribasi va daromadni oshiradi). O\'sha tavsiyaning "action" maydonini "connect_hotel_service" qilib belgila.'}

Faqat JSON qaytar (${langName} tilida):
{
  "recommendations": [
    {
      "priority": 1,
      "title": "Qisqa amal sarlavhasi",
      "description": "Batafsil sabab va tushuntirish",
      "platform": "Booking.com yoki Agoda yoki Hammasi yoki Xizmatlar",
      "action": "price | upsell | connect_hotel_service | other",
      "currentPrice": 0,
      "suggestedPrice": 0,
      "expectedImpact": "Kutilgan effekt"
    }
  ],
  "summary": "Umumiy bozor pozitsiyasi va imkoniyatlar haqida 1-2 jumla"
}`;

  try {
    const parsed = await ask(prompt);
    if (!parsed) return { recommendations: [], summary: '' };
    return parsed;
  } catch (err) {
    console.error('OpenAI getPriceRecommendations xato:', err.message);
    return { recommendations: [], summary: '' };
  }
}

export async function summarizeReviews(reviews, lang = 'uz') {
  const langName = lang === 'uz' ? "o'zbek" : lang === 'ru' ? 'rus' : 'ingliz';
  const reviewText = reviews
    .slice(0, 20)
    .map((r) => `[${r.rating}★] ${r.text?.slice(0, 200) || ''}`)
    .join('\n---\n');

  const prompt = `Sharhlarni tahlil qil va JSON qaytar (${langName} tilida):
{
  "strengths": ["3-5 ta kuchli tomon"],
  "weaknesses": ["3-5 ta kamchilik"],
  "summary": "Umumiy xulosa 2-3 jumla",
  "recommendedActions": ["Mehmonxona egasi uchun 2-3 ta amaliy maslahat"]
}
Sharhlar:
${reviewText}`;

  try {
    const parsed = await ask(prompt);
    if (!parsed) return { strengths: [], weaknesses: [], summary: '', recommendedActions: [] };
    return parsed;
  } catch (err) {
    console.error('OpenAI summarizeReviews xato:', err.message);
    return { strengths: [], weaknesses: [], summary: '', recommendedActions: [] };
  }
}

/**
 * Sharh muallifiga professional, empatik javob generatsiyalaydi.
 * Tonality va topiclar asosida.
 */
export async function generateReviewResponse({ review, hotelName, lang = 'uz' }) {
  const fallbackLangName = lang === 'uz' ? "o'zbek" : lang === 'ru' ? 'rus' : 'ingliz';
  const sentiment = review.sentiment || 'neutral';
  const topics = (review.topics || []).join(', ') || '—';
  const tone = sentiment === 'negative'
    ? 'uzr so\'ra, muammoga e\'tibor ber, aniq tuzatish chorasini tilga ol'
    : sentiment === 'positive'
    ? 'samimiy minnatdorchilik, mehmon his-tuyg\'usini qadrla'
    : 'professional, neytral, savollarga aniq javob';

  const prompt = `Sen "${hotelName}" mehmonxonasining mehmonlar bilan ishlash bo'limi vakili sifatida sharh muallifiga rasmiy, hurmatli javob yoz.

Mehmon: ${review.author || 'Anonim'}
Reyting: ${review.rating}/5
Tonallik: ${sentiment}
Mavzular: ${topics}
Sharh matni: "${(review.text || '').slice(0, 1500)}"

ENG MUHIM QOIDA — TIL:
1) Avval sharh matni qaysi TABIIY TILDA yozilganini aniqla (nemis, fransuz, ingliz, rus, o'zbek, ispan, italyan, turk va h.k. — qaysi bo'lsa ham).
2) Javobni AYNAN o'sha tilda yoz. Misol: nemischa sharhga — nemischa, fransuzcha sharhga — fransuzcha, inglizcha sharhga — inglizcha javob. HECH QACHON boshqa tilga o'tib ketma.
3) Faqat sharh matni bo'sh bo'lsa YOKI tilini umuman aniqlab bo'lmasa — ${fallbackLangName} tilida yoz.
"language" maydoniga aniqlangan tilning inglizcha nomini yoz (masalan: "German", "French", "English").

Boshqa talablar:
- Yondashuv: ${tone}
- Uzunligi: 5-8 jumla (mehmon ismi bilan murojaat qil)
- Reklama yoki sotuv-marketing tilini ishlatma
- Aniq topiclarni nomma-nom ko'rib chiq (agar bor bo'lsa)

Faqat JSON qaytar:
{
  "language": "aniqlangan til (inglizcha nomi)",
  "response": "Mehmonga javob matni (aniqlangan tilda)",
  "tone": "${sentiment}",
  "wordCount": 0
}`;

  try {
    const parsed = await ask(prompt);
    if (!parsed?.response) return { response: '', tone: sentiment, wordCount: 0 };
    return {
      response: parsed.response,
      language: parsed.language || null,
      tone: parsed.tone || sentiment,
      wordCount: parsed.response.split(/\s+/).length,
    };
  } catch (err) {
    console.error('OpenAI generateReviewResponse xato:', err.message);
    return { response: '', tone: sentiment, wordCount: 0 };
  }
}

export const isAIEnabled = () => !!env.OPENAI_API_KEY;
