import express from "express";
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

// Mehmonxona-xizmati moduli CommonJS — ESM ichidan createRequire bilan yuklaymiz.
const require = createRequire(import.meta.url);
const { mountRoutes: mountHotelService } = require("./hotelService/mount.js");

const app = express();

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
    customSiteTitle: "RateRadar API Docs",
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
if (isDev) app.use(morgan("dev"));

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get("/", (req, res) =>
  res.json({ name: "RateRadar API", version: "0.1.0", docs: "/api/docs" }),
);
app.use("/api", routes);

// Mehmonxona-xizmati marshrutlari (/api/hotel-service/*) — notFound'dan OLDIN.
mountHotelService(app);

app.use(notFound);
app.use(errorHandler);

export default app;
