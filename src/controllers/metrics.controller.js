import Integration from '../models/Integration.js';
import {
  dailyMetrics,
  periodSummary,
  pickupCurve,
  resolveCapacity,
  warmFxCoverage,
  breakdown,
  distributions,
  BREAKDOWN_DIMENSIONS,
} from '../services/metrics/ownMetrics.service.js';

// ════════════════════════════════════════════════════════════════════
// MENING KO'RSATKICHLARIM — occupancy / ADR / RevPAR / pickup
//
// Barcha endpointlar Exely ulanishini talab qiladi: bu ma'lumot faqat
// mehmonxonaning O'Z bronlaridan chiqadi, skreyping bilan olinmaydi.
// ════════════════════════════════════════════════════════════════════

const DAY_MS = 86400_000;

/** 'YYYY-MM-DD' → UTC Date. Noto'g'ri bo'lsa null. */
function parseDay(v) {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Default oyna: bugundan -30 … +30 kun. */
function windowFrom(q) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = parseDay(q.from) || new Date(today.getTime() - 30 * DAY_MS);
  const to = parseDay(q.to) || new Date(today.getTime() + 30 * DAY_MS);
  return { from, to };
}

/** Ulanish bormi — yo'q bo'lsa 409 va nima qilish kerakligi. */
async function requireIntegration(req, res) {
  if (!req.hotel) {
    res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });
    return null;
  }
  const integ = await Integration
    .findOne({ hotelId: req.hotel._id, provider: 'exely' })
    .select('status sync.backfillDone')
    .lean();

  if (!integ || integ.status !== 'active') {
    res.status(409).json({
      error: 'Bu ko\'rsatkichlar uchun Exely ulanishi kerak',
      hint: 'Sozlamalar → Integratsiyalar → Exely',
      connected: Boolean(integ),
    });
    return null;
  }
  return integ;
}

/**
 * GET /metrics/daily?from&to&asOf
 * Kunlik: sotilgan tun, tushum, ADR, occupancy, RevPAR.
 */
export async function getDailyMetrics(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const { from, to } = windowFrom(req.query);
    const asOf = parseDay(req.query.asOf);
    const data = await dailyMetrics(req.hotel._id, { from, to, asOf });

    return res.json({
      ...data,
      backfillDone: Boolean(integ.sync?.backfillDone),
    });
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/summary?from&to&asOf
 * Davr jami + kanal kesimi + bekor qilish + lead time.
 */
export async function getSummary(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const { from, to } = windowFrom(req.query);
    const asOf = parseDay(req.query.asOf);
    const data = await periodSummary(req.hotel._id, { from, to, asOf });

    return res.json({ ...data, backfillDone: Boolean(integ.sync?.backfillDone) });
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/pickup?from&to&stly=1
 * Booking curve: kitob qanday to'lgan + o'tgan yil bilan taqqoslash.
 */
export async function getPickup(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = parseDay(req.query.from) || today;
    const to = parseDay(req.query.to) || new Date(today.getTime() + 30 * DAY_MS);

    const data = await pickupCurve(req.hotel._id, {
      from, to, stly: String(req.query.stly || '') === '1',
    });
    return res.json(data);
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/capacity
 * Sig'im qayerdan olinganini ochiq ko'rsatadi (kiritilgan / taxmin).
 */
export async function getCapacity(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });
    return res.json(await resolveCapacity(req.hotel._id));
  } catch (err) { return next(err); }
}

/**
 * POST /metrics/warm-fx
 * Valyuta kurslarini fonda to'ldiradi (cbu.uz sekin — javob darhol qaytadi).
 */
export async function warmFx(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    warmFxCoverage(req.hotel._id)
      .then((r) => console.log('[fx] kurs to\'ldirildi:', JSON.stringify(r)))
      .catch((e) => console.warn('[fx] warm xatosi:', e.message));

    return res.status(202).json({ started: true });
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/breakdown?dim=channel|roomType|ratePlan|dow|month&from&to
 * Kesim: qaysi kanal / xona turi / tarif qancha tun va pul keltiradi.
 */
export async function getBreakdown(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const dim = String(req.query.dim || 'channel');
    if (!BREAKDOWN_DIMENSIONS.includes(dim)) {
      return res.status(400).json({ error: `Noma'lum o'lcham: ${dim}`, allowed: BREAKDOWN_DIMENSIONS });
    }
    // Kesimlar uchun default oyna — 1 YIL. Mavsumiylikni ko'rish uchun
    // 30 kunlik oyna juda tor (bitta mavsum ichida qolib ketadi).
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = parseDay(req.query.from) || new Date(today.getTime() - 364 * DAY_MS);
    const to = parseDay(req.query.to) || today;

    return res.json(await breakdown(req.hotel._id, { dim, from, to }));
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/distributions?from&to
 * Bron xulqi: qancha oldin bron qilinadi, necha tun qolinadi, necha kishi.
 */
export async function getDistributions(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = parseDay(req.query.from) || new Date(today.getTime() - 364 * DAY_MS);
    const to = parseDay(req.query.to) || today;

    return res.json(await distributions(req.hotel._id, { from, to }));
  } catch (err) { return next(err); }
}

/**
 * GET /metrics/actions?days=21&lang=uz
 * Diqqat talab qiladigan kunlar — menejerga "bugun qaysi kunlarga
 * qarashim kerak" savoliga javob.
 */
export async function getActions(req, res, next) {
  try {
    const integ = await requireIntegration(req, res);
    if (!integ) return undefined;

    const { buildActionList } = await import('../services/actionList.service.js');
    // 7–45 kun oralig'i: 7 kundan kam bo'lsa ta'sir qilish kech,
    // 45 kundan uzoqda bu bozorda kitob deyarli bo'sh (lead time 10 kun).
    const days = Math.min(Math.max(Number(req.query.days) || 21, 7), 45);
    const lang = ['uz', 'ru', 'en'].includes(req.query.lang) ? req.query.lang : 'uz';

    return res.json(await buildActionList(req.hotel._id, { days, lang }));
  } catch (err) { return next(err); }
}
