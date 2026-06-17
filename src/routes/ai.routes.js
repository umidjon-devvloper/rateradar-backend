import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import {
  getAIStatus,
  aiPriceRecommendations,
  aiSummarizeReviews,
  aiAnalyzeSingleReview,
  aiChatSupport,
} from '../controllers/ai.controller.js';

const router = Router();

/**
 * @openapi
 * /ai/status:
 *   get:
 *     tags: [AI]
 *     summary: AI xizmati holati (sozlangan provayder bormi)
 *     responses:
 *       200: { description: AI holati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/status', requireAuth, getAIStatus);

/**
 * @openapi
 * /ai/price-recommendations:
 *   get:
 *     tags: [AI]
 *     summary: AI narx tavsiyalari (raqobat va talab asosida)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Narx tavsiyalari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/price-recommendations', requireAuth, resolveHotel, aiPriceRecommendations);

/**
 * @openapi
 * /ai/summarize-reviews:
 *   get:
 *     tags: [AI]
 *     summary: Sharhlarning AI xulosasi (kuchli/zaif tomonlar)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Sharhlar xulosasi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/summarize-reviews', requireAuth, resolveHotel, aiSummarizeReviews);

/**
 * @openapi
 * /ai/analyze-review:
 *   post:
 *     tags: [AI]
 *     summary: Bitta sharhni AI tahlil qilish (sentiment, mavzular)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text: { type: string, description: "Sharh matni" }
 *     responses:
 *       200: { description: Tahlil natijasi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/analyze-review', requireAuth, resolveHotel, aiAnalyzeSingleReview);

/**
 * @openapi
 * /ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: AI chat-support (savol-javob)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message: { type: string, example: "Narxlarni qanday optimallashtiraman?" }
 *     responses:
 *       200: { description: AI javobi }
 */
router.post('/chat', aiChatSupport);

export default router;
