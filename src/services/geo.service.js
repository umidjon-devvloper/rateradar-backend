import axios from 'axios';
import { env } from '../config/env.js';
import { hasLocalCities, searchLocalCities } from './cities.service.js';

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24;

function cached(key) {
  const item = cache.get(key);
  if (!item || Date.now() - item.at > CACHE_TTL) return null;
  return item.value;
}
function setCache(key, value) {
  cache.set(key, { value, at: Date.now() });
}

export async function getCountries() {
  const c = cached('countries');
  if (c) return c;
  try {
    const r = await axios.get('https://restcountries.com/v3.1/all', {
      params: { fields: 'name,cca2,cca3,flag,currencies,languages,latlng' },
      timeout: 10000,
    });
    const result = r.data
      .map((c) => ({
        code: c.cca2,
        code3: c.cca3,
        name: c.name?.common || '',
        flag: c.flag || '',
        currency: Object.keys(c.currencies || {})[0] || '',
        currencySymbol: Object.values(c.currencies || {})[0]?.symbol || '',
        languages: Object.values(c.languages || {}),
        coords: c.latlng || [],
      }))
      .filter((c) => c.code && c.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    setCache('countries', result);
    return result;
  } catch (err) {
    console.error('REST Countries xato:', err.message);
    return FALLBACK_COUNTRIES;
  }
}

export async function searchCities(query, countryCode = '', limit = 10) {
  if (!query || query.length < 2) return [];

  if (hasLocalCities(countryCode)) {
    return searchLocalCities(query, countryCode, limit);
  }

  const key = `cities:${countryCode}:${query.toLowerCase()}`;
  const c = cached(key);
  if (c) return c;
  try {
    const r = await axios.get('http://api.geonames.org/searchJSON', {
      params: {
        q: query, country: countryCode || undefined, featureClass: 'P',
        maxRows: limit, username: env.GEONAMES_USERNAME, orderby: 'population',
      },
      timeout: 10000,
    });
    const cities = (r.data?.geonames || []).map((g) => ({
      name: g.name, country: g.countryName, countryCode: g.countryCode,
      region: g.adminName1 || '', population: g.population,
      lat: parseFloat(g.lat), lng: parseFloat(g.lng),
    }));
    setCache(key, cities);
    return cities;
  } catch (err) {
    console.error('GeoNames xato:', err.message);
    return [];
  }
}

export async function geocode(address) {
  const key = `geo:${address.toLowerCase()}`;
  const c = cached(key);
  if (c) return c;
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: address, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'RateRadar/1.0' },
      timeout: 10000,
    });
    if (!r.data?.length) return null;
    const x = r.data[0];
    const result = { lat: parseFloat(x.lat), lng: parseFloat(x.lon), displayName: x.display_name };
    setCache(key, result);
    return result;
  } catch (err) {
    console.error('Nominatim xato:', err.message);
    return null;
  }
}

const FALLBACK_COUNTRIES = [
  { code: 'UZ', name: 'Uzbekistan', flag: '🇺🇿', currency: 'UZS', languages: ['Uzbek'] },
  { code: 'RU', name: 'Russia', flag: '🇷🇺', currency: 'RUB', languages: ['Russian'] },
  { code: 'KZ', name: 'Kazakhstan', flag: '🇰🇿', currency: 'KZT', languages: ['Kazakh'] },
  { code: 'TR', name: 'Turkey', flag: '🇹🇷', currency: 'TRY', languages: ['Turkish'] },
  { code: 'US', name: 'United States', flag: '🇺🇸', currency: 'USD', languages: ['English'] },
];
