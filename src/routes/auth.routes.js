import { Router } from 'express';
import { register, login, me, updateProfile } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Yangi foydalanuvchi ro'yxatdan o'tkazish
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string, example: Ali Valiyev }
 *               email: { type: string, example: ali@example.com }
 *               password: { type: string, format: password, example: secret123 }
 *     responses:
 *       201:
 *         description: Ro'yxatdan o'tdi, token qaytariladi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400: { description: Validatsiya xatosi yoki email band }
 */
router.post('/register', register);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login qilish va JWT token olish
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: ali@example.com }
 *               password: { type: string, format: password, example: secret123 }
 *     responses:
 *       200:
 *         description: Muvaffaqiyatli login
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/login', login);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Joriy foydalanuvchi ma'lumotlari
 *     responses:
 *       200:
 *         description: Foydalanuvchi profili
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   put:
 *     tags: [Auth]
 *     summary: Profilni yangilash
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: Ali Valiyev }
 *               email: { type: string, example: ali@example.com }
 *               password: { type: string, format: password, description: "Yangi parol (ixtiyoriy)" }
 *     responses:
 *       200:
 *         description: Yangilangan profil
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', requireAuth, me);
router.put('/me', requireAuth, updateProfile);

export default router;
