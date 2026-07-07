import { Router } from 'express';
import {
  getDashboard, listUsers, getUserDetail, toggleUserActive,
  getApiStats, recentActivity, activeUsers, sendBroadcast, listTransactions,
  grantUserPlan, revokeUserPlan,
} from '../controllers/admin.controller.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /admin/dashboard:
 *   get:
 *     tags: [Admin]
 *     summary: Admin dashboard statistikasi
 *     responses:
 *       200: { description: Umumiy statistika }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/dashboard', getDashboard);

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Barcha foydalanuvchilar ro'yxati
 *     responses:
 *       200: { description: Foydalanuvchilar ro'yxati }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/users', listUsers);

/**
 * @openapi
 * /admin/users/recent:
 *   get:
 *     tags: [Admin]
 *     summary: So'nggi faollik (yangi foydalanuvchilar)
 *     responses:
 *       200: { description: So'nggi faollik ro'yxati }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/users/recent', recentActivity);

/**
 * @openapi
 * /admin/users/active:
 *   get:
 *     tags: [Admin]
 *     summary: Aktiv foydalanuvchilar
 *     responses:
 *       200: { description: Aktiv foydalanuvchilar ro'yxati }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/users/active', activeUsers);

/**
 * @openapi
 * /admin/users/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Foydalanuvchi tafsilotlari
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Foydalanuvchi tafsilotlari }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/users/:id', getUserDetail);

/**
 * @openapi
 * /admin/users/{id}/toggle:
 *   patch:
 *     tags: [Admin]
 *     summary: Foydalanuvchini bloklash / blokdan chiqarish
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Holat o'zgartirildi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/users/:id/toggle', toggleUserActive);

/**
 * @openapi
 * /admin/users/{id}/grant:
 *   patch:
 *     tags: [Admin]
 *     summary: Foydalanuvchiga qo'lda Pro dostup berish (30/365 kun yoki 0=doimiy)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               days: { type: number, example: 365, description: "0 = doimiy" }
 *     responses:
 *       200: { description: Dostup berildi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/users/:id/grant', grantUserPlan);

/**
 * @openapi
 * /admin/users/{id}/revoke:
 *   patch:
 *     tags: [Admin]
 *     summary: Qo'lda berilgan dostupni bekor qilish (free'ga qaytarish)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Dostup bekor qilindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/users/:id/revoke', revokeUserPlan);

/**
 * @openapi
 * /admin/api-stats:
 *   get:
 *     tags: [Admin]
 *     summary: Tashqi API'lar ishlatilish statistikasi
 *     responses:
 *       200: { description: API statistikasi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/api-stats', getApiStats);

/**
 * @openapi
 * /admin/transactions:
 *   get:
 *     tags: [Admin]
 *     summary: Barcha to'lov tranzaksiyalari (filtr + sahifalash)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [created, otp_sent, paid, failed, reversed] }
 *       - in: query
 *         name: plan
 *         schema: { type: string, enum: [starter, pro] }
 *       - in: query
 *         name: channel
 *         schema: { type: string, enum: [card, invoice] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200: { description: Tranzaksiyalar ro'yxati }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/transactions', listTransactions);

/**
 * @openapi
 * /admin/broadcast:
 *   post:
 *     tags: [Admin]
 *     summary: Barcha foydalanuvchilarga bildirishnoma yuborish
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string, example: "Yangilanish" }
 *               message: { type: string, example: "Tizim yangilandi" }
 *     responses:
 *       200: { description: Broadcast yuborildi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/broadcast', sendBroadcast);

export default router;
