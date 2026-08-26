import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import {
  getExelyIntegration,
  connectExely,
  syncExely,
  disconnectExely,
  exelyDiagnostics,
  getExelyProperty,
} from '../controllers/integration.controller.js';

const router = Router();

router.use(requireAuth);
router.use(resolveHotel);

/**
 * @openapi
 * /integrations/exely:
 *   get:
 *     tags: [Integrations]
 *     summary: Exely ulanishi holati (kalitlar qaytarilmaydi)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Ulanish holati va sinxronizatsiya progressi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/exely', getExelyIntegration);

/**
 * @openapi
 * /integrations/exely:
 *   post:
 *     tags: [Integrations]
 *     summary: Exely kalitlarini ulash (tekshiriladi, so'ng shifrlab saqlanadi)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId, clientSecret]
 *             properties:
 *               clientId: { type: string, example: api_connection_xxxxx_xxxxxxxx }
 *               clientSecret: { type: string }
 *               propertyId: { type: string, description: "Ulanishda bir nechta obyekt bo'lsa tanlanadi" }
 *     responses:
 *       200: { description: Ulandi (yoki obyekt tanlash kerak) }
 *       400: { description: Kalit qabul qilinmadi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/exely', connectExely);

/**
 * @openapi
 * /integrations/exely/sync:
 *   post:
 *     tags: [Integrations]
 *     summary: Qo'lda sinxronizatsiya boshlash (fonda ishlaydi)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       202: { description: Boshlandi }
 *       409: { description: Allaqachon ketyapti }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/exely/sync', syncExely);

/**
 * @openapi
 * /integrations/exely/diagnostics:
 *   get:
 *     tags: [Integrations]
 *     summary: Nosozlik tashxisi — qaysi API ochiq, auth limiti holati
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Tashxis natijasi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/exely/diagnostics', exelyDiagnostics);

/**
 * @openapi
 * /integrations/exely/property:
 *   get:
 *     tags: [Integrations]
 *     summary: Exely obyekt profili — xona turlari va tarif rejalari
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Obyekt profili }
 *       404: { description: Ulanish yo'q }
 */
router.get('/exely/property', getExelyProperty);

/**
 * @openapi
 * /integrations/exely:
 *   delete:
 *     tags: [Integrations]
 *     summary: Ulanishni uzish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: purge
 *         schema: { type: string, enum: ['1'] }
 *         description: "1 bo'lsa yuklangan bronlar ham o'chiriladi (qaytarib bo'lmaydi)"
 *     responses:
 *       200: { description: Uzildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.delete('/exely', disconnectExely);

export default router;
