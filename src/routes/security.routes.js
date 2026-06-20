import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  overview,
  listEvents,
  listBanned,
  banIp,
  unbanIp,
} from '../controllers/security.controller.js';

const router = Router();
router.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /admin/security/overview:
 *   get:
 *     tags: [Security]
 *     summary: Xavfsizlik dashboard statistikasi (24 soat)
 *     responses:
 *       200: { description: Statistika }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/overview', overview);

/**
 * @openapi
 * /admin/security/events:
 *   get:
 *     tags: [Security]
 *     summary: Xavfsizlik hodisalari ro'yxati (filtrli)
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *       - in: query
 *         name: severity
 *         schema: { type: string }
 *       - in: query
 *         name: ip
 *         schema: { type: string }
 *     responses:
 *       200: { description: Hodisalar ro'yxati }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/events', listEvents);

/**
 * @openapi
 * /admin/security/banned:
 *   get:
 *     tags: [Security]
 *     summary: Bloklangan IP'lar ro'yxati
 *     responses:
 *       200: { description: Bloklangan IP'lar }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/banned', listBanned);

/**
 * @openapi
 * /admin/security/ban:
 *   post:
 *     tags: [Security]
 *     summary: IP'ni qo'lda bloklash
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ip]
 *             properties:
 *               ip: { type: string }
 *               reason: { type: string }
 *               minutes: { type: integer }
 *               permanent: { type: boolean }
 *     responses:
 *       200: { description: Bloklandi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/ban', banIp);

/**
 * @openapi
 * /admin/security/unban:
 *   post:
 *     tags: [Security]
 *     summary: IP'ni blokdan chiqarish
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ip]
 *             properties:
 *               ip: { type: string }
 *     responses:
 *       200: { description: Blokdan chiqarildi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/unban', unbanIp);

export default router;
