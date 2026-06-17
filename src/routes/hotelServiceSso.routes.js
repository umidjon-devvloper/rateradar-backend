import { Router } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveHotel } from "../middleware/resolveHotel.js";

const router = Router();

/**
 * GET /api/hotel-service/sso
 *
 * RateRadar foydalanuvchisi uchun Mehmonxona-xizmati admin paneliga kirish
 * tokeni yaratadi. hotel_id sifatida AKTIV RateRadar mehmonxonasi (_id)
 * ishlatiladi — shuning uchun har bir mehmonxona o'zining alohida xizmat
 * makonini oladi (xizmatlar, xodimlar, QR, buyurtmalar hammasi alohida).
 *
 * Aktiv mehmonxona X-Hotel-Id header orqali aniqlanadi (resolveHotel).
 */
router.get("/sso", requireAuth, resolveHotel, async (req, res) => {
  if (!req.hotel) {
    return res.status(400).json({ error: "Aktiv mehmonxona topilmadi" });
  }

  const payload = {
    hotel_id: req.hotel._id.toString(),
    hotel_name: req.hotel.name || "Hotel",
    hotel_language: req.user.lang || "ru",
    subscription: { active: true, expires_at: null },
  };

  // SSO_SECRET o'rnatilgan bo'lsa, Hotel Service uni jwt.verify bilan tekshiradi;
  // aks holda u faqat payload'ni base64 dekod qiladi.
  const token = jwt.sign(payload, process.env.SSO_SECRET || env.JWT_SECRET, {
    expiresIn: "10m",
  });

  res.json({ token });
});

export default router;
