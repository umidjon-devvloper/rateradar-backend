import { getCountries, searchCities, geocode } from '../services/geo.service.js';
import { searchHotels } from '../services/places.service.js';

export async function listCountries(req, res, next) {
  try {
    const countries = await getCountries();
    res.json({ countries });
  } catch (err) { next(err); }
}

export async function findCities(req, res, next) {
  try {
    const { q = '', country = '', limit = 10 } = req.query;
    if (!q || q.length < 2) return res.json({ cities: [] });
    const cities = await searchCities(q, country, parseInt(limit));
    res.json({ cities });
  } catch (err) { next(err); }
}

export async function findHotels(req, res, next) {
  try {
    const { q = '', country = '', city = '', lat, lng } = req.query;
    res.set('Cache-Control', 'no-store');
    if (!q || q.length < 2) return res.json({ hotels: [] });
    const hotels = await searchHotels(q, country, {
      city,
      lat: lat ? parseFloat(lat) : undefined,
      lng: lng ? parseFloat(lng) : undefined,
    });
    res.json({ hotels, count: hotels.length });
  } catch (err) { next(err); }
}

export async function geocodeAddress(req, res, next) {
  try {
    const { address = '' } = req.query;
    if (!address) return res.status(400).json({ error: 'address kerak' });
    const result = await geocode(address);
    if (!result) return res.status(404).json({ error: 'Topilmadi' });
    res.json(result);
  } catch (err) { next(err); }
}
