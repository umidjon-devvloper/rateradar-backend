const fetch = require("node-fetch");

// Oddiy in-memory kesh (server qayta ishga tushsa tozalanadi)
// Katta loyihada Redis ishlatiladi
const cache = new Map();
const MAX_CACHE = 2000;

// MyMemory til kodlari map (bizning kodlar → MyMemory kodlari)
const LANG_MAP = {
  en: "en-GB", ru: "ru-RU", zh: "zh-CN", ar: "ar-SA",
  tr: "tr-TR", de: "de-DE", fr: "fr-FR", it: "it-IT",
  es: "es-ES", ko: "ko-KR", ja: "ja-JP", fa: "fa-IR",
  uz: "uz-UZ", hi: "hi-IN", pt: "pt-PT",
};

/**
 * Matnni bir tildan boshqa tilga tarjima qiladi.
 * Xato bo'lsa original matnni qaytaradi.
 */
const translate = async (text, fromLang, toLang) => {
  if (!text?.trim() || fromLang === toLang) return text;

  const cacheKey = `${fromLang}→${toLang}:${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const from = LANG_MAP[fromLang] || fromLang;
    const to   = LANG_MAP[toLang]   || toLang;

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}${
      process.env.MYMEMORY_EMAIL ? `&de=${process.env.MYMEMORY_EMAIL}` : ""
    }`;

    const res  = await fetch(url, { timeout: 6000 });
    const data = await res.json();

    if (data.responseStatus === 200) {
      const translated = data.responseData.translatedText;

      // Keshga saqlash
      if (cache.size >= MAX_CACHE) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      cache.set(cacheKey, translated);
      return translated;
    }

    console.warn(`Translation warning: ${data.responseStatus} — ${data.responseDetails}`);
    return text;
  } catch (err) {
    console.error("Translation error:", err.message);
    return text; // fallback: original matn
  }
};

/**
 * Bir nechta matnni parallel tarjima qilish (tezroq)
 */
const translateMany = async (texts, fromLang, toLang) => {
  if (fromLang === toLang) return texts;
  return Promise.all(texts.map((t) => translate(t, fromLang, toLang)));
};

module.exports = { translate, translateMany };
