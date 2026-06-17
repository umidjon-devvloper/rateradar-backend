import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import {
  getRateShopper,
  getRoomShopper,
  refreshRoomShopper,
  refreshChannelPrices,
  refreshAllChannels,
} from '../controllers/prices.controller.js';

const router = Router();

router.use(requireAuth);
router.use(resolveHotel);

/**
 * @openapi
 * /prices/rate-shopper:
 *   get:
 *     tags: [Prices]
 *     summary: Rate shopper — o'z hotel va raqobatchilar narxlari taqqoslamasi
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: checkIn
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: checkOut
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Narxlar taqqoslama jadvali }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/rate-shopper', getRateShopper);

/**
 * @openapi
 * /prices/room-shopper:
 *   get:
 *     tags: [Prices]
 *     summary: Room shopper — xona turlari bo'yicha narxlar
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Xona turlari bo'yicha narxlar }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/room-shopper', getRoomShopper);

/**
 * @openapi
 * /prices/refresh-rooms:
 *   post:
 *     tags: [Prices]
 *     summary: O'z mehmonxona xona turlari narxini Apify Booking orqali yangilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Real xona turlari yangilandi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/refresh-rooms', refreshRoomShopper);

/**
 * @openapi
 * /prices/refresh-channel:
 *   post:
 *     tags: [Prices]
 *     summary: Bitta OTA kanal narxini yangilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source: { type: string, example: booking, description: "OTA kanal manbai" }
 *     responses:
 *       200: { description: Yangilangan kanal narxi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/refresh-channel', refreshChannelPrices);

/**
 * @openapi
 * /prices/refresh-all:
 *   post:
 *     tags: [Prices]
 *     summary: Barcha OTA kanallar narxini yangilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Barcha kanallar yangilandi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/refresh-all', refreshAllChannels);

export default router;
