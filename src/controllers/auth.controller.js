import User from "../models/User.js";
import { signToken } from "../middleware/auth.js";
import { z } from "zod";

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
    const user = await User.findOne({ email }).select("+password");
    if (!user || !user.isActive)
      return res
        .status(401)
        .json({ error: "Email yoki parol noto\x27g\x27ri" });
    const ok = await user.comparePassword(password);
    if (!ok)
      return res
        .status(401)
        .json({ error: "Email yoki parol noto\x27g\x27ri" });
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
  res.json({ user: req.user });
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
