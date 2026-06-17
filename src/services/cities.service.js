import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StringDecoder } from 'string_decoder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

// PPL = oddiy shahar/qishloq, PPLA/PPLA2/...= ma'muriy markazlar, PPLC = poytaxt.
// Quyidagilar - tarixiy/yo'q qilingan/diniy/fermalar — qidiruvga kerak emas.
const EXCLUDED_CODES = new Set(['PPLX', 'PPLW', 'PPLH', 'PPLQ', 'PPLF', 'PPLCH', 'PPLR']);

// Ma'muriy markazlar — populationdan qat'i nazar saqlanadi (poytaxt, viloyat/tuman markazi).
// PPLA4 (4-darajali, US'da har bir CDP/qishloq) maxsus istisno qilingan — populationni o'tsa qoladi.
const ADMIN_SEAT_CODES = new Set(['PPLA', 'PPLA2', 'PPLA3', 'PPLC', 'PPLG']);
// Per-country XX.txt fayllarda millionlab qishloq bor — RAM portlamasin uchun shu chegara.
// cities500.zip standartiga mos: pop>=500 yoki ma'muriy markaz.
const MIN_POPULATION = 500;

const byCountry = new Map();
// "UZ.10" -> "Toshkent". Global admin1CodesASCII.txt va per-country ADM1 satrlaridan to'ldiriladi.
const admin1Names = new Map();

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['`ʻʼʹʿ‘’ʹʾ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadAdmin1() {
  const file = path.join(DATA_DIR, 'admin1CodesASCII.txt');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 2) continue;
    admin1Names.set(c[0], c[1]);
  }
  console.log(`✓ Admin1 nomlari yuklandi: ${admin1Names.size}`);
}

// Katta fayllar (US.txt = 293MB) butunlay readFileSync bilan o'qilsa heap portlaydi.
// Shuning uchun chunked sync read — har safar 1MB, StringDecoder UTF-8 chegaralarini ushlaydi.
function forEachLineSync(filePath, lineHandler) {
  const fd = fs.openSync(filePath, 'r');
  const CHUNK = 1 << 20; // 1 MB
  const buf = Buffer.alloc(CHUNK);
  const decoder = new StringDecoder('utf8');
  let leftover = '';
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const text = leftover + decoder.write(buf.subarray(0, n));
      let start = 0;
      let idx;
      while ((idx = text.indexOf('\n', start)) !== -1) {
        let end = idx;
        if (end > start && text.charCodeAt(end - 1) === 13) end--;
        if (end > start) lineHandler(text.slice(start, end));
        start = idx + 1;
      }
      leftover = text.slice(start);
    }
    leftover += decoder.end();
    if (leftover) lineHandler(leftover);
  } finally {
    fs.closeSync(fd);
  }
}

function parseFile(filePath, fixedCountryCode) {
  const countByCC = new Map();

  forEachLineSync(filePath, (line) => {
    const c = line.split('\t');
    if (c.length < 19) return;
    const featureClass = c[6];
    const featureCode = c[7];
    const countryCode = fixedCountryCode || c[8];
    if (!countryCode) return;

    if (featureClass === 'A' && featureCode === 'ADM1') {
      const key = `${countryCode}.${c[10]}`;
      if (!admin1Names.has(key)) admin1Names.set(key, c[1]);
      return;
    }
    if (featureClass !== 'P') return;
    if (EXCLUDED_CODES.has(featureCode)) return;

    const population = parseInt(c[14], 10) || 0;
    if (population < MIN_POPULATION && !ADMIN_SEAT_CODES.has(featureCode)) return;

    const city = {
      name: c[1],
      asciiname: c[2],
      countryCode,
      admin1Code: c[10],
      lat: parseFloat(c[4]),
      lng: parseFloat(c[5]),
      population,
      _search: normalize(`${c[1]}|${c[2]}|${c[3]}`),
    };

    let entry = byCountry.get(countryCode);
    if (!entry) {
      entry = { cities: [] };
      byCountry.set(countryCode, entry);
    }
    entry.cities.push(city);
    countByCC.set(countryCode, (countByCC.get(countryCode) || 0) + 1);
  });

  return countByCC;
}

// Lazy loading: davlat .txt fayli faqat o'sha davlat birinchi marta
// qidirilganda yuklanadi. Server bunga 100x tezroq ishga tushadi (300+
// faylni boshida o'qish o'rniga).
//
// Istisno: agar global cities*.txt mavjud bo'lsa (cities500.zip kabi),
// uni darhol yuklaymiz — chunki u barcha davlatlarni o'z ichiga oladi
// va per-country fayllar ishlatilmaydi.
const loadedCountries = new Set();
let availableCountries = new Set(); // disk'da .txt fayli bor davlatlar

function discoverFiles() {
  if (!fs.existsSync(DATA_DIR)) return { global: [], countries: [] };
  const allFiles = fs.readdirSync(DATA_DIR);
  const global = allFiles.filter((f) => /^cities\d+\.txt$/.test(f));
  const countries = allFiles.filter((f) => /^[A-Z]{2}\.txt$/.test(f));
  return { global, countries };
}

function loadCountryFile(countryCode) {
  const cc = countryCode.toUpperCase();
  if (loadedCountries.has(cc)) return;
  if (!availableCountries.has(cc)) return; // disk'da fayli yo'q
  loadedCountries.add(cc);
  const filePath = path.join(DATA_DIR, `${cc}.txt`);
  try {
    parseFile(filePath, cc);
  } catch (err) {
    console.error(`✗ ${cc}.txt o'qib bo'lmadi:`, err.message);
  }
}

function bootstrap() {
  if (!fs.existsSync(DATA_DIR)) return;
  loadAdmin1();

  const { global, countries } = discoverFiles();

  // Global cities*.txt mavjud bo'lsa — eager loading (boshqa yo'l yo'q).
  if (global.length > 0) {
    for (const file of global) {
      try {
        parseFile(path.join(DATA_DIR, file), null);
      } catch (err) {
        console.error(`✗ ${file} o'qib bo'lmadi:`, err.message);
      }
    }
    console.log(`✓ Cities yuklandi (global): ${global.length} ta fayl`);
    return;
  }

  // Per-country rejim — faqat ro'yxatga olamiz, fayllar lazy.
  availableCountries = new Set(countries.map((f) => f.slice(0, 2)));
  console.log(`✓ Shahar fayllari topildi: ${availableCountries.size} ta davlat (lazy load)`);
}

bootstrap();

export function hasLocalCities(countryCode) {
  if (!countryCode) return byCountry.size > 0 || availableCountries.size > 0;
  const cc = countryCode.toUpperCase();
  return byCountry.has(cc) || availableCountries.has(cc);
}

export function searchLocalCities(query, countryCode = '', limit = 10) {
  const q = normalize(query);
  if (!q) return [];

  if (countryCode) {
    // Lazy: davlat fayli hali yuklanmagan bo'lsa, hozir o'qiymiz.
    loadCountryFile(countryCode);
  } else {
    // Davlat ko'rsatilmagan — hozircha yuklangan davlatlar orasidan
    // qidiramiz (cross-country search uchun barchasini yuklash juda
    // qimmat). Foydalanuvchi country bilan filtrlasa eng yaxshisi.
  }

  const codes = countryCode
    ? (byCountry.has(countryCode.toUpperCase()) ? [countryCode.toUpperCase()] : [])
    : Array.from(byCountry.keys());
  if (codes.length === 0) return [];

  // Variant-bordagi nom shu so'rov bilan boshlansa (alternate names ham), prefix=0.
  // Bu Tashkent (asosiy nomi "Tashkent", lekin "Toshkent" alt nomida) "toshkent" so'rovida
  // yuqori chiqishini ta'minlaydi.
  const prefixRe = new RegExp('(?:^|[|,])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const results = [];
  for (const cc of codes) {
    const entry = byCountry.get(cc);
    if (!entry) continue;
    for (const city of entry.cities) {
      if (!city._search.includes(q)) continue;
      results.push({
        name: city.name,
        country: cc,
        countryCode: cc,
        region: admin1Names.get(`${cc}.${city.admin1Code}`) || '',
        population: city.population,
        lat: city.lat,
        lng: city.lng,
        _prefix: prefixRe.test(city._search) ? 0 : 1,
      });
    }
  }

  results.sort((a, b) => {
    if (a._prefix !== b._prefix) return a._prefix - b._prefix;
    return b.population - a.population;
  });

  return results.slice(0, limit).map(({ _prefix, ...rest }) => rest);
}
