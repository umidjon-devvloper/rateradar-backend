import { Router } from "express";
import authRoutes from "./auth.routes.js";
import hotelRoutes from "./hotel.routes.js";
import searchRoutes from "./search.routes.js";
import adminRoutes from "./admin.routes.js";
import aiRoutes from "./ai.routes.js";
import notificationRoutes from "./notification.routes.js";
import reviewRoutes from "./review.routes.js";
import pricesRoutes from "./prices.routes.js";
import paymentRoutes from "./payment.routes.js";
import securityRoutes from "./security.routes.js";
import hotelServiceSsoRoutes from "./hotelServiceSso.routes.js";
import leadRoutes from "./lead.routes.js";

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Server holatini tekshirish (health-check)
 *     security: []
 *     responses:
 *       200:
 *         description: Server ishlayapti
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 ts: { type: integer, example: 1717200000000 }
 */
router.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
router.use("/auth", authRoutes);
router.use("/hotels", hotelRoutes);
router.use("/search", searchRoutes);
router.use("/admin", adminRoutes);
router.use("/ai", aiRoutes);
router.use("/notifications", notificationRoutes);
router.use("/reviews", reviewRoutes);
router.use("/prices", pricesRoutes);
router.use("/payments", paymentRoutes);
router.use("/leads", leadRoutes);
router.use("/admin/security", securityRoutes);
// Mehmonxona-xizmati SSO ko'prigi (/api/hotel-service/sso). Qolgan
// /api/hotel-service/* marshrutlari CommonJS modulda (app.js'da ulanadi).
router.use("/hotel-service", hotelServiceSsoRoutes);
export default router;
