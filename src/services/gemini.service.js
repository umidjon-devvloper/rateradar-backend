import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';
import { recordApiUsage } from '../utils/apiUsageTracker.js';

let genAI = null;
let model = null;

function getModel() {
  if (!env.GEMINI_API_KEY) return null;
  if (!model) {
    genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
    });
  }
  return model;
}

export async function analyzeReview(reviewText, lang = 'uz') {
  const m = getModel();
  if (!m) return { sentiment: 'unknown', sentimentScore: 0, topics: [], aiSummary: '' };

  const langName = lang === 'uz' ? "O'zbek tilida" : lang === 'ru' ? 'Rus tilida' : 'Ingliz tilida';
  const prompt = `Quyidagi mehmonxona sharhini tahlil qil. Faqat JSON qaytar:
{
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": -1 dan +1 gacha raqam,
  "topics": ["tozalik", "xizmat", "joylashuv", "nonushta", "wifi", "narx", "shovqin"] dan eng ko'pi 4 ta,
  "aiSummary": "${langName} 1 jumla xulosa"
}
Sharh: "${reviewText.slice(0, 1500)}"`;

  try {
    const r = await m.generateContent(prompt);
    recordApiUsage('gemini', true);
    const parsed = JSON.parse(r.response.text());
    return {
      sentiment: parsed.sentiment || 'neutral',
      sentimentScore: parseFloat(parsed.sentimentScore) || 0,
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 4) : [],
      aiSummary: parsed.aiSummary || '',
    };
  } catch (err) {
    recordApiUsage('gemini', false, err);
    console.error('Gemini analyzeReview xato:', err.message);
    return { sentiment: 'unknown', sentimentScore: 0, topics: [], aiSummary: '' };
  }
}

export async function getPriceRecommendations({ myHotel, myPrice, competitors, marketAvg, lang = 'uz' }) {
  const m = getModel();
  if (!m) return { recommendations: [], summary: '' };

  const langName = lang === 'uz' ? "o'zbek" : lang === 'ru' ? 'rus' : 'ingliz';
  const compList = competitors.map((c, i) => `${i + 1}. ${c.name} — $${c.price} (${c.stars}★, ${c.distanceKm}km)`).join('\n');
  const prompt = `Sen hotel revenue manager mutaxassisisan. Ma'lumotga qarab 3 ta amaliy tavsiya ber.

Mening hotel: ${myHotel}
Mening narx: $${myPrice}
Bozor o'rtacha: $${marketAvg}
Raqiblar:
${compList}

Faqat JSON qaytar (${langName} tilida):
{
  "recommendations": [
    { "priority": 1-3, "title": "Qisqa amal", "description": "Sabab", "platform": "Booking.com|Agoda|Hammasi", "currentPrice": son, "suggestedPrice": son, "expectedImpact": "Effekt" }
  ],
  "summary": "Umumiy bozor pozitsiyasi 1-2 jumla"
}`;

  try {
    const r = await m.generateContent(prompt);
    recordApiUsage('gemini', true);
    return JSON.parse(r.response.text());
  } catch (err) {
    recordApiUsage('gemini', false, err);
    console.error('Gemini getPriceRecommendations xato:', err.message);
    return { recommendations: [], summary: '' };
  }
}

export async function summarizeReviews(reviews, lang = 'uz') {
  const m = getModel();
  if (!m) return { strengths: [], weaknesses: [], summary: '', recommendedActions: [] };

  const langName = lang === 'uz' ? "o'zbek" : lang === 'ru' ? 'rus' : 'ingliz';
  const reviewText = reviews.slice(0, 20).map((r) => `[${r.rating}★] ${r.text?.slice(0, 200) || ''}`).join('\n---\n');
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
    const r = await m.generateContent(prompt);
    recordApiUsage('gemini', true);
    return JSON.parse(r.response.text());
  } catch (err) {
    recordApiUsage('gemini', false, err);
    console.error('Gemini summarizeReviews xato:', err.message);
    return { strengths: [], weaknesses: [], summary: '', recommendedActions: [] };
  }
}

export const isGeminiEnabled = () => !!env.GEMINI_API_KEY;

// ─── Support chat — alohida text model (JSON emas) ────────────────────────────

let textModel = null;

function getTextModel() {
  if (!env.GEMINI_API_KEY) return null;
  if (!textModel) {
    if (!genAI) genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    textModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.6, maxOutputTokens: 512 },
    });
  }
  return textModel;
}

const SYSTEM_PROMPT = `Siz TheHotelSaaS platformasining rasmiy yordamchi assistentisiz.

TheHotelSaaS haqida:
TheHotelSaaS — mehmonxona egalari uchun AI-ga asoslangan raqobat tahlili va narx boshqaruvi platformasi.

Asosiy imkoniyatlar:
• Raqobatchilar narxlari — yaqin-atrofdagi mehmonxonalar narxlarini real vaqtda kuzatish
• OTA Kanallar — Booking.com, Agoda, Expedia, Hotels.com, Trip.com narxlarini Apify orqali olish
• AI Tavsiyalar — Gemini AI narx strategiyasini tahlil qilib tavsiyalar beradi
• Mehmon sharhlari — barcha platformalardan sharhlarni to'plash va AI tahlili
• Bildirishnomalar — raqib narxi o'zgarganda avtomatik ogohlantirish
• Narx solishtirish (Rate Shopper) — 7-30 kunlik narx tarixi

Qanday ishlaydi:
1. Ro'yxatdan o'ting va mehmonxonangizni qo'shing
2. Raqiblarni toping (avtomatik yoki qo'lda)
3. OTA saytlaridagi URL'larni Settings'da kiriting
4. Dashboard'da barcha narxlar va tahlillar ko'rinadi

Support bilan bog'lanish:
• Telegram: @rateradar_support
• Email: support@rateradar.uz

Qoidalar:
- Faqat TheHotelSaaS va mehmonxona boshqaruvi haqida javob bering
- Javoblarni qisqa va aniq yozing (3-5 jumla maksimum)
- Foydalanuvchi tilida javob bering (o'zbek, rus yoki ingliz)
- Texnik muammo bo'lsa Telegram yoki email orqali murojaat qilishni tavsiya eting`;

export async function chatSupport(messages) {
  const m = getTextModel();

  const history = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Tushunarli. Men TheHotelSaaS yordamchi assistentiman. Savollaringizga javob berishga tayyorman.' }] },
    ...messages.slice(0, -1).map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    })),
  ];

  const lastMsg = messages[messages.length - 1]?.content || '';

  if (!m) {
    return 'Kechirasiz, AI yordamchi hozir ishlamayapti. Iltimos, bevosita murojaat qiling:\n• Telegram: @rateradar_support\n• Email: support@rateradar.uz';
  }

  try {
    const chat = m.startChat({ history });
    const result = await chat.sendMessage(lastMsg);
    recordApiUsage('gemini', true);
    return result.response.text();
  } catch (err) {
    recordApiUsage('gemini', false, err);
    console.error('Gemini chatSupport xato:', err.message);
    return 'Texnik xatolik yuz berdi. Iltimos, quyidagi manzillar orqali murojaat qiling:\n• Telegram: @rateradar_support\n• Email: support@rateradar.uz';
  }
}
