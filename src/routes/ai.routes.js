import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import { requireFeature } from '../utils/planGate.js';

// AI funksiyalari faqat Pro va Business tariflarida (Starter'da yo'q).
const aiGate = requireFeature('ai', 'AI funksiyalari Pro va Business tariflarida mavjud');
import {
  getAIStatus,
  aiPriceRecommendations,
  aiSummarizeReviews,
  aiAnalyzeSingleReview,
  aiChatSupport,
  aiAssistantChat,
  aiOtaAdvice,
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
router.get('/price-recommendations', requireAuth, aiGate, resolveHotel, aiPriceRecommendations);

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
router.get('/summarize-reviews', requireAuth, aiGate, resolveHotel, aiSummarizeReviews);

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
router.post('/analyze-review', requireAuth, aiGate, resolveHotel, aiAnalyzeSingleReview);

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

/**
 * @openapi
 * /ai/assistant-chat:
 *   post:
 *     tags: [AI]
 *     summary: AI-tahlil sahifasidagi shaxsiy yordamchi chat (hotel konteksti bilan)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role: { type: string, enum: [user, assistant] }
 *                     content: { type: string }
 *     responses:
 *       200: { description: "AI javobi { reply }" }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/assistant-chat', requireAuth, aiGate, resolveHotel, aiAssistantChat);

/**
 * @openapi
 * /ai/ota-advice:
 *   get:
 *     tags: [AI]
 *     summary: Har bir OTA kanali uchun AI narx tavsiyasi (raqiblar tahlili bilan, 6h kesh)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: refresh
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: "{ summary, channels:[{channel, currentPrice, suggestedPrice, delta, action, reason, stats}] }" }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/ota-advice', requireAuth, aiGate, resolveHotel, aiOtaAdvice);

export default router;
