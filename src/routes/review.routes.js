import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import { listReviews, markReviewSeen, markAllReviewsSeen, scrapeReviews, generateResponse, scrapeApifyReviews, scrapeTripadvisor } from '../controllers/review.controller.js';

const router = Router();

router.use(requireAuth);
router.use(resolveHotel);

/**
 * @openapi
 * /reviews:
 *   get:
 *     tags: [Reviews]
 *     summary: Hotel sharhlari ro'yxati
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Sharhlar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', listReviews);

/**
 * @openapi
 * /reviews/scrape:
 *   post:
 *     tags: [Reviews]
 *     summary: Sharhlarni yig'ish (default scraper)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Yig'ilgan sharhlar }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/scrape', scrapeReviews);

/**
 * @openapi
 * /reviews/scrape-apify:
 *   post:
 *     tags: [Reviews]
 *     summary: Sharhlarni Apify scraper orqali yig'ish (Booking.com)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Apify orqali yig'ilgan sharhlar }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/scrape-apify', scrapeApifyReviews);

/**
 * @openapi
 * /reviews/scrape-tripadvisor:
 *   post:
 *     tags: [Reviews]
 *     summary: TripAdvisor Content API orqali reyting/ranking/sharhlar
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: TripAdvisor ma'lumotlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/scrape-tripadvisor', scrapeTripadvisor);

/**
 * @openapi
 * /reviews/seen-all:
 *   patch:
 *     tags: [Reviews]
 *     summary: Barcha sharhlarni o'qildi deb belgilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Barcha sharhlar o'qildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/seen-all', markAllReviewsSeen);

/**
 * @openapi
 * /reviews/{id}/seen:
 *   patch:
 *     tags: [Reviews]
 *     summary: Bitta sharhni o'qildi deb belgilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Sharh ID
 *     responses:
 *       200: { description: Sharh o'qildi deb belgilandi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/:id/seen', markReviewSeen);

/**
 * @openapi
 * /reviews/{id}/generate-response:
 *   post:
 *     tags: [Reviews]
 *     summary: Sharhga AI javob matnini generatsiya qilish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Sharh ID
 *     responses:
 *       200: { description: Generatsiya qilingan javob matni }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/:id/generate-response', generateResponse);

export default router;
