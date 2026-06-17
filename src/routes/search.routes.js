import { Router } from 'express';
import { listCountries, findCities, findHotels, geocodeAddress } from '../controllers/search.controller.js';

const router = Router();

/**
 * @openapi
 * /search/countries:
 *   get:
 *     tags: [Search]
 *     summary: Davlatlar ro'yxati
 *     security: []
 *     responses:
 *       200: { description: Davlatlar ro'yxati }
 */
router.get('/countries', listCountries);

/**
 * @openapi
 * /search/cities:
 *   get:
 *     tags: [Search]
 *     summary: Shahar qidirish (GeoNames lokal dump)
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Shahar nomi (qidiruv matni)
 *       - in: query
 *         name: country
 *         schema: { type: string }
 *         description: ISO davlat kodi (masalan, UZ)
 *     responses:
 *       200: { description: Mos shaharlar ro'yxati }
 */
router.get('/cities', findCities);

/**
 * @openapi
 * /search/hotels:
 *   get:
 *     tags: [Search]
 *     summary: Hotel qidirish
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Hotel nomi yoki manzili
 *     responses:
 *       200: { description: Topilgan hotellar }
 */
router.get('/hotels', findHotels);

/**
 * @openapi
 * /search/geocode:
 *   get:
 *     tags: [Search]
 *     summary: Manzilni koordinatalarga aylantirish (geocoding)
 *     security: []
 *     parameters:
 *       - in: query
 *         name: address
 *         schema: { type: string }
 *         description: To'liq manzil matni
 *     responses:
 *       200: { description: lat/lng va manzil tafsilotlari }
 */
router.get('/geocode', geocodeAddress);

export default router;
