import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  listPlans,
  createPayment,
  submitCard,
  confirmPayment,
  resendOtp,
  listMyPayments,
  getPayment,
  atmosCallback,
} from '../controllers/payment.controller.js';

const router = Router();

/**
 * @openapi
 * /payments/plans:
 *   get:
 *     tags: [Payments]
 *     summary: Sotib olinadigan obuna rejalari ro'yxati
 *     security: []
 *     responses:
 *       200: { description: Rejalar ro'yxati (narx so'mda) }
 */
router.get('/plans', listPlans);

/**
 * @openapi
 * /payments/callback:
 *   post:
 *     tags: [Payments]
 *     summary: ATMOS Callback API (faqat ATMOS chaqiradi, imzo bilan himoyalangan)
 *     security: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               store_id: { type: integer }
 *               transaction_id: { type: integer }
 *               account: { type: string }
 *               amount: { type: integer }
 *               sign: { type: string }
 *     responses:
 *       200: { description: "{ status: 1 } muvaffaqiyatli tasdiq" }
 */
router.post('/callback', atmosCallback);

// ─── Quyidagilar avtorizatsiya talab qiladi ──────────────────────────
router.use(requireAuth);

/**
 * @openapi
 * /payments/create:
 *   post:
 *     tags: [Payments]
 *     summary: 1-qadam — to'lov yaratish (ATMOS chernovik tranzaksiya)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan]
 *             properties:
 *               plan: { type: string, enum: [starter, pro] }
 *     responses:
 *       201: { description: paymentId va transactionId qaytadi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/create', createPayment);

/**
 * @openapi
 * /payments/card:
 *   post:
 *     tags: [Payments]
 *     summary: 2-qadam — karta yuborish (kartaga SMS-OTP keladi)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentId, cardNumber, expiry]
 *             properties:
 *               paymentId: { type: string }
 *               cardNumber: { type: string, example: "9860090101014364" }
 *               expiry: { type: string, example: "02/28", description: "MM/YY" }
 *     responses:
 *       200: { description: SMS-kod yuborildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/card', submitCard);

/**
 * @openapi
 * /payments/confirm:
 *   post:
 *     tags: [Payments]
 *     summary: 3-qadam — OTP bilan tasdiqlash (test karta uchun 111111)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [paymentId, otp]
 *             properties:
 *               paymentId: { type: string }
 *               otp: { type: string, example: "111111" }
 *     responses:
 *       200: { description: To'lov muvaffaqiyatli, obuna faollashdi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/confirm', confirmPayment);

/**
 * @openapi
 * /payments/{id}/resend-otp:
 *   post:
 *     tags: [Payments]
 *     summary: SMS-kodni qayta yuborish
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: SMS-kod qayta yuborildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/:id/resend-otp', resendOtp);

/**
 * @openapi
 * /payments:
 *   get:
 *     tags: [Payments]
 *     summary: Mening to'lovlarim tarixi
 *     responses:
 *       200: { description: To'lovlar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', listMyPayments);

/**
 * @openapi
 * /payments/{id}:
 *   get:
 *     tags: [Payments]
 *     summary: Bitta to'lov holati (kerak bo'lsa ATMOS'dan sinxronlaydi)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: To'lov holati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/:id', getPayment);

export default router;
