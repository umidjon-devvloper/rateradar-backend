import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import swaggerUi from "swagger-ui-express";

import { env, isDev } from "./config/env.js";
import routes from "./routes/index.js";
import { swaggerSpec } from "./config/swagger.js";
import { docsAuth } from "./middleware/docsAuth.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { securityGuard } from "./middleware/security.js";

// Mehmonxona-xizmati moduli CommonJS — ESM ichidan createRequire bilan yuklaymiz.
const require = createRequire(import.meta.url);
const { mountRoutes: mountHotelService } = require("./hotelService/mount.js");

const app = express();

// nginx/Cloudflare orqasida — haqiqiy mijoz IP'sini olish uchun.
app.set("trust proxy", 1);

// Rate-limit/ban kaliti: Cloudflare → nginx → app zanjirida haqiqiy IP.
const ipKey = (req) =>
  req.headers["cf-connecting-ip"] ||
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.ip;

// API hujjatlari (Swagger UI). helmet CSP va rate-limit'dan OLDIN ulanadi —
// aks holda UI assetlari bloklanishi yoki limitga tushishi mumkin.
// docsAuth — Basic Auth: faqat login/parolni biluvchilar kira oladi.
//   • Interaktiv UI:  GET /api/docs
//   • Xom OpenAPI JSON: GET /api/docs.json
app.get("/api/docs.json", docsAuth, (req, res) => res.json(swaggerSpec));
app.use(
  "/api/docs",
  docsAuth,
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customSiteTitle: "TheHotelSaaS API Docs",
    swaggerOptions: { persistAuthorization: true },
  }),
);

app.use(helmet());
app.use(
  cors({
    origin: function (origin, callback) {
      const allowed = [
        env.CLIENT_URL,
        env.ADMIN_URL,
        ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
      ].filter(Boolean);
      if (!origin || allowed.includes(origin) || isDev) {
        callback(null, true);
      } else {
        callback(null, true); // production da ham ruxsat
      }
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Yuklangan rasmlar (hotel-service item'lari va h.k.) — backend/uploads/.
// Frontend boshqa domenda bo'lgani uchun helmet'ning same-origin CORP
// sarlavhasini shu yo'lda ochamiz, aks holda brauzer rasmlarni bloklaydi.
app.use(
  "/uploads",
  express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../uploads"), {
    maxAge: "7d",
    setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
  }),
);
if (isDev) app.use(morgan("dev"));

// Xavfsizlik darvozasi — body parse'dan KEYIN (injection tekshiruvi uchun),
// barcha marshrutlar uchun (root'dagi scanner probe'larni ham tutadi).
app.use(securityGuard);

// Umumiy rate-limit (barcha /api). Haqiqiy IP bo'yicha hisoblaydi.
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    keyGenerator: ipKey,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Maxsus, qattiqroq limitlar — sezgir endpointlar (brute-force/abuse himoyasi).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // 15 daqiqada 30 urinish
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Juda ko'p urinish. 15 daqiqadan keyin urinib ko'ring." },
});
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 25, // 10 daqiqada 25 to'lov urinishi
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "To'lov urinishlari ko'payib ketdi. Keyinroq urinib ko'ring." },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/payments/create", paymentLimiter);
app.use("/api/payments/invoice", paymentLimiter);
app.use("/api/payments/card", paymentLimiter);

app.get("/", (req, res) =>
  res.json({ name: "TheHotelSaaS API", version: "0.1.0", docs: "/api/docs" }),
);
app.use("/api", routes);

// Mehmonxona-xizmati marshrutlari (/api/hotel-service/*) — notFound'dan OLDIN.
mountHotelService(app);

app.use(notFound);
app.use(errorHandler);

export default app;
