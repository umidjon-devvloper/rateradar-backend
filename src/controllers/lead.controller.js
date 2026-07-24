import { z } from 'zod';
import { sendLeadEmail } from '../services/email.service.js';

// Landing formasidan kelgan bog'lanish so'rovi (lead) → egasi pochtasiga email.

const leadSchema = z.object({
  name: z.string().max(120).optional().or(z.literal('')),
  hotel: z.string().max(160).optional().or(z.literal('')),
  phone: z.string().min(5).max(40),
  country: z.string().max(80).optional().or(z.literal('')), // telefon qaysi davlatdan
  email: z.string().email().optional().or(z.literal('')),
  city: z.string().max(120).optional().or(z.literal('')),
  plan: z.string().max(60).optional().or(z.literal('')),
  message: z.string().max(2000).optional().or(z.literal('')),
  // Bot tuzog'i (honeypot) — odam to'ldirmaydi, bot to'ldiradi.
  website: z.string().optional(),
});

// Oddiy IP-throttle: bir IP soatiga 5 tadan ko'p yubormasin (spam himoya).
const HITS = new Map(); // ip → [timestamps]
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) return true;
  arr.push(now);
  HITS.set(ip, arr);
  return false;
}

/**
 * POST /api/leads — public bog'lanish formasi.
 * Ma'lumotni egasi pochtasiga (LEADS_EMAIL, default info@thehotelsaas.com) yuboradi.
 */
export async function submitLead(req, res, next) {
  try {
    const data = leadSchema.parse(req.body);

    // Honeypot to'ldirilgan bo'lsa — bot. Jimgina "muvaffaqiyat" qaytaramiz.
    if (data.website) return res.json({ ok: true });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Juda ko\'p so\'rov. Birozdan keyin urinib ko\'ring.' });
    }

    const sent = await sendLeadEmail({
      name: data.name,
      hotel: data.hotel,
      phone: data.phone,
      country: data.country,
      email: data.email,
      city: data.city,
      plan: data.plan || 'So\'rov',
      message: data.message,
    });

    if (!sent) {
      // SMTP sozlanmagan bo'lsa ham foydalanuvchiga xato ko'rsatmaymiz, lekin loglaymiz.
      console.warn('[lead] Email yuborilmadi (SMTP?) — lead:', JSON.stringify(data));
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.name === 'ZodError') {
      const e = new Error('Ma\'lumotlar to\'liq emas');
      e.status = 400;
      e.details = err.flatten();
      return next(e);
    }
    next(err);
  }
}
