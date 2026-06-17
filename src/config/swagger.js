import swaggerJsDoc from "swagger-jsdoc";
import { fileURLToPath } from "url";
import path from "path";
import { env } from "./env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * OpenAPI 3.0 spetsifikatsiyasi.
 *
 * Endpointlar har bir route faylidagi `@openapi` JSDoc bloklaridan
 * avtomatik yig'iladi (`apis` glob orqali). Umumiy qismlar — auth sxemasi,
 * takrorlanuvchi parametrlar, javob modellari va teglar — shu yerda.
 */
const options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "RateRadar API",
      version: "0.1.0",
      description:
        "Hotel narx monitoring platformasi — multi-provider narx rotatori, " +
        "raqobatchi kuzatuvi, sharhlar tahlili va Gemini AI tavsiyalari.\n\n" +
        "**Autentifikatsiya:** ko'p endpoint `Authorization: Bearer <token>` " +
        "talab qiladi. Tokenni `/api/auth/login` orqali oling, so'ng yuqoridagi " +
        "**Authorize** tugmasiga joylashtiring.\n\n" +
        "**Aktiv hotel:** hotel'ga bog'liq endpointlar `X-Hotel-Id` header " +
        "orqali qaysi hotel ustida ishlashni aniqlaydi (yuborilmasa — " +
        "foydalanuvchining birinchi hoteli olinadi).",
    },
    servers: [
      {
        url: `http://localhost:${env.PORT}/api`,
        description: "Lokal development server",
      },
      {
        url: "/api",
        description: "Joriy host (relative)",
      },
    ],
    tags: [
      { name: "Auth", description: "Ro'yxatdan o'tish, login va profil" },
      { name: "Hotels", description: "Hotel va raqobatchilarni boshqarish, OTA kanallar" },
      { name: "Prices", description: "Rate shopper va kanal narxlarini yangilash" },
      { name: "Reviews", description: "Sharhlarni yig'ish, ko'rish va AI javoblar" },
      { name: "Notifications", description: "Bildirishnomalar va o'qildi belgilash" },
      { name: "AI", description: "Gemini AI tavsiyalar, sharh tahlili, chat" },
      { name: "Search", description: "Davlat / shahar / hotel qidiruvi va geocoding" },
      { name: "Admin", description: "Admin panel — foydalanuvchilar, statistika, broadcast" },
      { name: "System", description: "Health-check va xizmat holati" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token. `/api/auth/login` javobidagi `token` qiymati.",
        },
      },
      parameters: {
        HotelIdHeader: {
          name: "X-Hotel-Id",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "Aktiv hotel ID. Yuborilmasa, foydalanuvchining birinchi hoteli olinadi.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Yaroqsiz token" },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            token: { type: "string", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6..." },
            user: { $ref: "#/components/schemas/User" },
          },
        },
        User: {
          type: "object",
          properties: {
            _id: { type: "string", example: "665f1c2a9b3e4a0012abcd34" },
            name: { type: "string", example: "Ali Valiyev" },
            email: { type: "string", example: "ali@example.com" },
            role: { type: "string", enum: ["user", "admin"], example: "user" },
            isActive: { type: "boolean", example: true },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: "Token yo'q yoki yaroqsiz",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        Forbidden: {
          description: "Ruxsat yo'q (masalan, faqat admin uchun)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        NotFound: {
          description: "Resurs topilmadi",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  // glob backslash'ni escape sifatida ko'radi — Windows yo'llarini
  // forward-slash'ga aylantiramiz, aks holda route fayllari topilmaydi.
  apis: [path.join(__dirname, "../routes/*.js").replace(/\\/g, "/")],
};

export const swaggerSpec = swaggerJsDoc(options);
