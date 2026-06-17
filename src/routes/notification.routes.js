import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  checkCompetitorPrices,
} from '../controllers/notification.controller.js';

const router = Router();

router.use(requireAuth);
router.use(resolveHotel);

/**
 * @openapi
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Bildirishnomalar ro'yxati
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Bildirishnomalar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', listNotifications);

/**
 * @openapi
 * /notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: O'qilmagan bildirishnomalar soni
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200:
 *         description: O'qilmaganlar soni
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer, example: 3 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/unread-count', getUnreadCount);

/**
 * @openapi
 * /notifications/read-all:
 *   patch:
 *     tags: [Notifications]
 *     summary: Barcha bildirishnomalarni o'qildi deb belgilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Barchasi o'qildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/read-all', markAllRead);

/**
 * @openapi
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Bitta bildirishnomani o'qildi deb belgilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Bildirishnoma ID
 *     responses:
 *       200: { description: O'qildi deb belgilandi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.patch('/:id/read', markRead);

/**
 * @openapi
 * /notifications/check-competitors:
 *   post:
 *     tags: [Notifications]
 *     summary: Raqobatchi narxlarini tekshirib, kerak bo'lsa bildirishnoma yaratish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Tekshiruv natijasi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/check-competitors', checkCompetitorPrices);

export default router;
