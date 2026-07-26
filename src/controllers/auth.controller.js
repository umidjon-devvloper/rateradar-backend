import User from "../models/User.js";
import { signToken } from "../middleware/auth.js";
import { z } from "zod";
import * as sec from "../services/security.service.js";

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  country: z.string().optional().default(""),
  countryCode: z.string().optional().default(""),
  city: z.string().optional().default(""),
  lang: z.enum(["uz", "en", "ru"]).optional().default("uz"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function register(req, res, next) {
  try {
    const data = registerSchema.parse(req.body);
    console.log("Register data:", data);
    const exists = await User.findOne({ email: data.email });
    if (exists)
      return res
        .status(409)
        .json({ error: "Bu email allaqachon ro\x27yxatdan o\x27tgan" });
    const user = await User.create(data);
    const token = signToken(user._id);
    res.status(201).json({ user, token });
  } catch (err) {
    if (err.name === "ZodError") {
      return res
        .status(400)
        .json({ error: "Validatsiya xatosi", details: err.flatten() });
    }
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const ip = req.clientIp || req.ip;
    const user = await User.findOne({ email }).select("+password");
    const ok = user && user.isActive && (await user.comparePassword(password));
    if (!ok) {
      // Brute-force kuzatuvi: ketma-ket noto'g'ri urinishlarni hisoblaymiz.
      const fails = sec.recordFailedLogin(ip);
      sec.recordEvent({
        type: "failed_login", ip, severity: "low",
        method: req.method, path: req.originalUrl,
        userAgent: req.headers["user-agent"], detail: email,
      });
      if (fails >= sec.loginCfg.maxFails) {
        await sec.banIp(ip, {
          reason: `Login brute-force (${fails} urinish)`,
          minutes: sec.loginCfg.banMinutes,
        });
      }
      return res
        .status(401)
        .json({ error: "Email yoki parol noto\x27g\x27ri" });
    }
    sec.clearFailedLogin(ip); // muvaffaqiyatli login — hisoblagichni tozalaymiz
    user.lastLoginAt = new Date();
    await user.save();
    const token = signToken(user._id);
    res.json({ user, token });
  } catch (err) {
    if (err.name === "ZodError") {
      return res
        .status(400)
        .json({ error: "Validatsiya xatosi", details: err.flatten() });
    }
    next(err);
  }
}

export async function me(req, res) {
  // Tarif cheklovlarini ham qaytaramiz — frontend AI/kanal/raqib gating'ni
  // shundan o'qiydi (yagona manba). Admin barcha cheklovdan ozod.
  const { planLimits } = await import("../config/plans.js");
  const isAdmin = req.user?.role === "admin";
  const base = planLimits(req.user?.plan);
  const limits = isAdmin
    ? { maxCompetitors: 0, maxHotels: 0, channels: null, ai: true, reviewsReply: true, reviewsAnalytics: true, maxTv: 0, hotelService: true }
    : base;
  res.json({ user: req.user, limits });
}

export async function updateProfile(req, res, next) {
  try {
    const allowed = ["name", "country", "countryCode", "city", "lang"];
    const update = {};
    for (const k of allowed)
      if (req.body[k] !== undefined) update[k] = req.body[k];
    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true,
    });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}
