import { z } from 'zod';
import SecurityEvent from '../models/SecurityEvent.js';
import BannedIp from '../models/BannedIp.js';
import * as sec from '../services/security.service.js';

/**
 * GET /api/admin/security/overview
 * Dashboard statistikasi (oxirgi 24 soat).
 */
export async function overview(req, res, next) {
  try {
    const data = await sec.getOverview();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/security/events?type=&severity=&limit=&page=
 * Xavfsizlik hodisalari ro'yxati (filtrli).
 */
export async function listEvents(req, res, next) {
  try {
    const { type, severity, ip } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const filter = {};
    if (type) filter.type = type;
    if (severity) filter.severity = severity;
    if (ip) filter.ip = ip;

    const [items, total] = await Promise.all([
      SecurityEvent.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SecurityEvent.countDocuments(filter),
    ]);

    res.json({ events: items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/security/banned
 * Bloklangan IP'lar ro'yxati (aktiv).
 */
export async function listBanned(req, res, next) {
  try {
    const items = await BannedIp.find({
      $or: [{ permanent: true }, { until: { $gt: new Date() } }],
    })
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json({ banned: items, count: items.length });
  } catch (err) {
    next(err);
  }
}

const banSchema = z.object({
  ip: z.string().min(3),
  reason: z.string().optional().default('Admin tomonidan bloklandi'),
  minutes: z.number().int().positive().optional(),
  permanent: z.boolean().optional().default(false),
});

/**
 * POST /api/admin/security/ban   { ip, reason?, minutes?, permanent? }
 * IP'ni qo'lda bloklash.
 */
export async function banIp(req, res, next) {
  try {
    const { ip, reason, minutes, permanent } = banSchema.parse(req.body);
    await sec.banIp(ip, { reason, minutes, permanent, source: 'admin', by: req.user._id });
    res.json({ ok: true, ip, permanent, minutes: minutes || null });
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ error: 'Validatsiya xatosi', details: err.flatten() });
    }
    next(err);
  }
}

/**
 * POST /api/admin/security/unban   { ip }
 * IP'ni blokdan chiqarish.
 */
export async function unbanIp(req, res, next) {
  try {
    const ip = String(req.body?.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'ip kerak' });
    await sec.unbanIp(ip);
    res.json({ ok: true, ip });
  } catch (err) {
    next(err);
  }
}
