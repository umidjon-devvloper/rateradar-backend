import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import {
  getDailyMetrics,
  getSummary,
  getPickup,
  getCapacity,
  warmFx,
  getBreakdown,
  getDistributions,
  getActions,
} from '../controllers/metrics.controller.js';

const router = Router();

router.use(requireAuth);
router.use(resolveHotel);

/**
 * @openapi
 * /metrics/daily:
 *   get:
 *     tags: [Metrics]
 *     summary: Kunlik ko'rsatkichlar — sotilgan tun, tushum, ADR, occupancy, RevPAR
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: asOf
 *         schema: { type: string, format: date }
 *         description: "Shu sanada kitobda nima bor edi (OTB tiklash)"
 *     responses:
 *       200: { description: Kunlik qator }
 *       409: { description: Exely ulanishi yo'q }
 */
router.get('/daily', getDailyMetrics);

/**
 * @openapi
 * /metrics/summary:
 *   get:
 *     tags: [Metrics]
 *     summary: Davr jami + kanal kesimi + bekor qilish + lead time
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Davr xulosasi }
 *       409: { description: Exely ulanishi yo'q }
 */
router.get('/summary', getSummary);

/**
 * @openapi
 * /metrics/pickup:
 *   get:
 *     tags: [Metrics]
 *     summary: Booking curve — kitob qanday to'lgan (STLY bilan)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: stly
 *         schema: { type: string, enum: ['1'] }
 *         description: "1 bo'lsa o'tgan yil shu davr ham qaytariladi"
 *     responses:
 *       200: { description: Pickup egri chizig'i }
 */
router.get('/pickup', getPickup);

/**
 * @openapi
 * /metrics/capacity:
 *   get:
 *     tags: [Metrics]
 *     summary: Sig'im (jami xona) va u qayerdan olingani
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: "{ rooms, source, estimated }" }
 */
router.get('/capacity', getCapacity);

/**
 * @openapi
 * /metrics/warm-fx:
 *   post:
 *     tags: [Metrics]
 *     summary: Valyuta kurslarini fonda to'ldirish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       202: { description: Boshlandi }
 */
router.post('/warm-fx', warmFx);

/**
 * @openapi
 * /metrics/breakdown:
 *   get:
 *     tags: [Metrics]
 *     summary: Kesim — kanal / xona turi / tarif / hafta kuni / oy bo'yicha
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: dim
 *         schema: { type: string, enum: [channel, roomType, ratePlan, dow, month] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Kesim qatorlari }
 *       409: { description: Exely ulanishi yo'q }
 */
router.get('/breakdown', getBreakdown);

/**
 * @openapi
 * /metrics/distributions:
 *   get:
 *     tags: [Metrics]
 *     summary: Bron xulqi — lead time, qolish davomiyligi, mehmon soni
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Taqsimotlar }
 *       409: { description: Exely ulanishi yo'q }
 */
router.get('/distributions', getDistributions);

/**
 * @openapi
 * /metrics/actions:
 *   get:
 *     tags: [Metrics]
 *     summary: Diqqat talab qiladigan kunlar (o'lchangan talab bo'yicha)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 7, maximum: 45, default: 21 }
 *       - in: query
 *         name: lang
 *         schema: { type: string, enum: [uz, ru, en] }
 *     responses:
 *       200: { description: Kunlar va oraliqlar ro'yxati }
 *       409: { description: Exely ulanishi yo'q }
 */
router.get('/actions', getActions);

export default router;
