import Integration from '../models/Integration.js';
import OwnBooking from '../models/OwnBooking.js';
import { encryptSecret, maskSecret } from '../services/exely/crypto.js';
import { verifyCredentials, invalidateToken, authLimiterState } from '../services/exely/client.js';
import { fetchProperties, fetchProperty, summarizeProperty } from '../services/exely/content.service.js';
import { runSync, loadIntegration, credsFor } from '../services/exely/sync.service.js';

// ════════════════════════════════════════════════════════════════════
// INTEGRATSIYALAR — mijoz o'z Exely kalitini shu yerdan ulaydi
//
// Multi-tenant: har mehmonxona o'z ulanishiga ega, kalitlar .env'da emas.
// `clientSecret` HECH QACHON qaytarilmaydi — faqat niqoblangan ko'rinish.
// ════════════════════════════════════════════════════════════════════

/** Mijozga ko'rsatiladigan xavfsiz ko'rinish (secret yo'q). */
function publicView(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    provider: doc.provider,
    status: doc.status,
    clientId: doc.credentials?.clientId || '',
    propertyId: doc.propertyId || '',
    property: {
      name: doc.property?.name || '',
      currency: doc.property?.currency || '',
      timeZone: doc.property?.timeZone || '',
      stars: doc.property?.stars || 0,
      cityName: doc.property?.cityName || '',
      countryCode: doc.property?.countryCode || '',
      roomTypeCount: doc.property?.roomTypeCount || 0,
      ratePlanCount: doc.property?.ratePlanCount || 0,
      refreshedAt: doc.property?.refreshedAt || null,
    },
    apiAccesses: doc.apiAccesses || [],
    sync: {
      lastSyncAt: doc.sync?.lastSyncAt || null,
      lastSyncDurationMs: doc.sync?.lastSyncDurationMs || 0,
      backfillDone: Boolean(doc.sync?.backfillDone),
      totalBookings: doc.sync?.totalBookings || 0,
      running: Boolean(doc.sync?.running),
      lastError: doc.sync?.lastError || '',
      lastErrorAt: doc.sync?.lastErrorAt || null,
    },
    createdAt: doc.createdAt,
  };
}

/**
 * GET /integrations/exely
 * Joriy mehmonxona ulanishi holati.
 */
export async function getExelyIntegration(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const doc = await Integration.findOne({ hotelId: req.hotel._id, provider: 'exely' });
    if (!doc) return res.json({ integration: null });

    // To'lmagan bronlar — UI'da "yuklanmoqda: 1200/3800" ko'rsatish uchun.
    //
    // Ikkiga ajratilgan: sync 5 martadan ko'p yiqilgan bronni boshqa
    // urinmaydi va uni `remaining` da sanamaydi. Agar bu yerda hammasini
    // birga sanasak, "backfill tugadi" va "500 ta kutilyapti" bir vaqtda
    // ko'rinib, mijozni chalkashtiradi. `failedDetails` — bu qo'lda
    // aralashuv kerak bo'lgan holat (odatda 0).
    const [pending, failed] = await Promise.all([
      OwnBooking.countDocuments({
        hotelId: req.hotel._id, needsDetail: true, detailAttempts: { $lt: 5 },
      }),
      OwnBooking.countDocuments({
        hotelId: req.hotel._id, needsDetail: true, detailAttempts: { $gte: 5 },
      }),
    ]);

    res.json({
      integration: { ...publicView(doc), pendingDetails: pending, failedDetails: failed },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /integrations/exely
 * Kalitlarni tekshirib ulanishni yaratadi/yangilaydi.
 * Body: { clientId, clientSecret, propertyId? }
 *
 * Bitta ulanish bir nechta obyektni qamrasa, propertyId'siz chaqiruv
 * ro'yxatni qaytaradi va status `pending` bo'lib qoladi — mijoz tanlaydi.
 */
export async function connectExely(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    let propertyId = String(req.body?.propertyId || '').trim();

    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'clientId va clientSecret kerak' });
    }

    // 1) Kalitlarni TEKSHIRAMIZ — noto'g'risi bazaga tushmasin.
    let access;
    try {
      invalidateToken(clientId); // eski keshni tozalaymiz (secret almashgan bo'lishi mumkin)
      access = await verifyCredentials({ clientId, clientSecret });
    } catch (err) {
      return res.status(400).json({
        error: 'Exely kalitlari qabul qilinmadi',
        details: err.message,
      });
    }

    const creds = { clientId, clientSecret };

    // 2) Ulanishga tegishli obyektlar.
    const properties = await fetchProperties(creds);
    if (!properties.length) {
      return res.status(400).json({ error: 'Bu kalitga bog\'langan obyekt topilmadi' });
    }
    const ids = properties.map((p) => String(p.id));

    if (!propertyId && ids.length === 1) propertyId = ids[0];
    if (propertyId && !ids.includes(propertyId)) {
      return res.status(400).json({ error: 'Bu propertyId ulanishga tegishli emas', properties: ids });
    }

    // 3) Saqlaymiz. propertyId hali tanlanmagan bo'lsa — pending.
    const update = {
      userId: req.user._id,
      provider: 'exely',
      status: propertyId ? 'active' : 'pending',
      'credentials.clientId': clientId,
      'credentials.clientSecretEnc': encryptSecret(clientSecret),
      apiAccesses: access.apiAccesses,
      propertyId: propertyId || '',
    };

    const existing = await Integration.findOne({ hotelId: req.hotel._id, provider: 'exely' })
      .select('propertyId')
      .lean();

    if (propertyId) {
      const p = await fetchProperty(creds, propertyId);
      update.property = summarizeProperty(p);
      update['sync.lastError'] = '';
      update['sync.consecutiveErrors'] = 0;

      // Kursorni FAQAT obyekt almashganda nolga qaytaramiz: continueToken
      // bitta obyektga bog'langan va boshqasida yaroqsiz.
      //
      // Aks holda (masalan mijoz secret'ini yangilaganda) kursor bekordan
      // bekorga yo'qolib, 3800 ta bron qaytadan sahifalanadi va backfill
      // "tugamagan" holatga tushadi. Bron mazmuni o'zgarmagani uchun
      // zarari yo'q, lekin bu ortiqcha so'rov va mijozga sababsiz
      // "yuklanmoqda" ko'rsatkichi.
      if (existing && existing.propertyId && existing.propertyId !== propertyId) {
        update['sync.continueToken'] = '';
        update['sync.lastModificationCursor'] = null;
        update['sync.backfillDone'] = false;
      }
    }

    const doc = await Integration.findOneAndUpdate(
      { hotelId: req.hotel._id, provider: 'exely' },
      { $set: update, $setOnInsert: { hotelId: req.hotel._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    // 4) Birinchi sinxronizatsiyani FONDA boshlaymiz — 3800 ta bron
    //    yuklanishini HTTP so'rovi kutib turmasin.
    if (propertyId) {
      runSync(doc._id).catch((e) => console.warn('[exely] birinchi sync:', e.message));
    }

    res.json({
      integration: publicView(doc),
      properties: ids,
      needsPropertyChoice: !propertyId,
      secretPreview: maskSecret(clientSecret),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /integrations/exely/sync
 * Qo'lda sinxronizatsiya. Fonda ishlaydi — javob darhol qaytadi.
 */
export async function syncExely(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const doc = await Integration.findOne({ hotelId: req.hotel._id, provider: 'exely' });
    if (!doc) return res.status(404).json({ error: 'Exely ulanishi yo\'q' });
    if (!doc.propertyId) return res.status(400).json({ error: 'Avval obyektni tanlang' });
    if (doc.sync?.running) {
      return res.status(409).json({ error: 'Sinxronizatsiya allaqachon ketyapti', integration: publicView(doc) });
    }

    runSync(doc._id).catch((e) => console.warn('[exely] qo\'lda sync:', e.message));
    res.status(202).json({ started: true, integration: publicView(doc) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /integrations/exely?purge=1
 * Ulanishni uzadi. Default — yuklangan bronlar SAQLANADI (tarix qayta
 * yig'ilmaydi). `purge=1` bilan ular ham o'chiriladi.
 */
export async function disconnectExely(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const doc = await Integration.findOne({ hotelId: req.hotel._id, provider: 'exely' });
    if (!doc) return res.status(404).json({ error: 'Exely ulanishi yo\'q' });

    if (doc.credentials?.clientId) invalidateToken(doc.credentials.clientId);

    let purged = 0;
    if (String(req.query.purge || '') === '1') {
      const r = await OwnBooking.deleteMany({ hotelId: req.hotel._id });
      purged = r.deletedCount || 0;
    }

    await Integration.deleteOne({ _id: doc._id });
    res.json({ disconnected: true, purgedBookings: purged });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /integrations/exely/diagnostics
 * Ulanish sog'lig'i: qaysi API ochiq, auth limitiga qancha yaqinmiz.
 * Nosozlik qidirishda birinchi qaraladigan joy.
 */
export async function exelyDiagnostics(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const doc = await loadIntegration({ hotelId: req.hotel._id, provider: 'exely' });
    if (!doc) return res.status(404).json({ error: 'Exely ulanishi yo\'q' });

    const checks = [];
    try {
      const creds = credsFor(doc);
      const props = await fetchProperties(creds);
      checks.push({ api: 'content', ok: true, detail: `${props.length} obyekt` });
    } catch (err) {
      checks.push({ api: 'content', ok: false, detail: err.message });
    }

    const [total, pending] = await Promise.all([
      OwnBooking.countDocuments({ hotelId: req.hotel._id }),
      OwnBooking.countDocuments({ hotelId: req.hotel._id, needsDetail: true }),
    ]);

    res.json({
      integration: publicView(doc),
      checks,
      bookings: { total, pendingDetails: pending, ready: total - pending },
      authLimiter: authLimiterState(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /integrations/exely/property
 * Exely'dagi obyekt profili TO'LIQ: xona turlari, tarif rejalari, sig'im.
 *
 * `GET /integrations/exely` da bu ro'yxatlar ATAYIN yo'q — u holat
 * so'rovi va har 8 soniyada polling qilinadi, o'nlab kilobayt tarif
 * ro'yxatini har safar tashish keraksiz.
 */
export async function getExelyProperty(req, res, next) {
  try {
    if (!req.hotel) return res.status(400).json({ error: 'Avval mehmonxona qo\'shing' });

    const doc = await Integration.findOne({ hotelId: req.hotel._id, provider: 'exely' })
      .select('propertyId property apiAccesses status')
      .lean();
    if (!doc) return res.status(404).json({ error: 'Exely ulanishi yo\'q' });

    return res.json({
      propertyId: doc.propertyId,
      status: doc.status,
      apiAccesses: doc.apiAccesses || [],
      property: doc.property || null,
    });
  } catch (err) { return next(err); }
}
