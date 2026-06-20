import crypto from "crypto";
import { env } from "../config/env.js";

/**
 * API hujjatlarini (/api/docs) HTTP Basic Auth bilan himoyalaydi.
 *
 * Brauzer login/parol oynasini ko'rsatadi — to'g'ri kiritilmasa, sahifa
 * ochilmaydi. Login: DOCS_USER (default "admin"), parol: DOCS_PASSWORD
 * (berilmasa ADMIN_PASSWORD ishlatiladi).
 */
const USER = env.DOCS_USER;
const PASS = env.DOCS_PASSWORD || env.ADMIN_PASSWORD;

// Vaqt-xavfsiz (timing-safe) solishtirish — parolni belgi-belgi taxmin
// qilishning oldini oladi.
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function docsAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);

    if (safeEqual(user, USER) && safeEqual(pass, PASS)) {
      return next();
    }
  }

  // Brauzer login oynasini chiqarishi uchun WWW-Authenticate header shart.
  res.set("WWW-Authenticate", 'Basic realm="TheHotelSaaS API Docs", charset="UTF-8"');
  return res.status(401).json({ error: "Hujjatlarga kirish uchun login/parol kerak" });
}
