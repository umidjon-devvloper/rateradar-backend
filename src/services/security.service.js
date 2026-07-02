import SecurityEvent from '../models/SecurityEvent.js';
import BannedIp from '../models/BannedIp.js';

/**
 * Ilova darajasidagi xavfsizlik yadrosi.
 *
 * Tezlik uchun barcha "issiq" tekshiruvlar XOTIRADA bajariladi (Map/Set),
 * DB faqat saqlash (persist) va admin ko'rinishi uchun ishlatiladi.
 *
 * DIQQAT: bu ilova darajasidagi himoya — bitta IP flood, brute-force,
 * scanner/probe'larni to'sadi. Haqiqiy hajmli DDoS uchun oldida Cloudflare
 * bo'lishi shart (trafik serverga umuman yetmasin).
 */

// ─── Sozlamalar (kerak bo'lsa o'zgartiriladi) ────────────────────────
const CFG = {
  // Flood: WINDOW_MS ichida shu sondan ko'p so'rov → abuse
  rate: { windowMs: 10_000, maxReqs: 120, banMinutes: 15 },
  // Brute-force login: WINDOW ichida shuncha noto'g'ri urinish → ban
  login: { windowMs: 15 * 60_000, maxFails: 8, banMinutes: 30 },
  // Shubhali/zararli urinishlar: shu sondan oshsa → ban
  suspicious: { maxStrikes: 5, banMinutes: 60 },
  // Bitta IP+type uchun DB'ga yozish chastotasi (flood paytida bazani himoya)
  logThrottleMs: 30_000,
  // So'rov tanasi (body) eng katta hajmi log uchun (express limiti alohida)
  maxBodyBytes: 1_500_000,
};

// ─── Xotira holati ───────────────────────────────────────────────────
const bannedIps = new Map(); // ip → { until:Date|null, permanent:bool, reason }
const reqWindow = new Map(); // ip → number[] (so'rov timestamplari)
const failedLogins = new Map(); // ip → { count, first }
const strikes = new Map(); // ip → { count, first } (shubhali urinishlar)
const logThrottle = new Map(); // `${ip}:${type}` → lastWriteMs

let loaded = false;

// ─── Boshlang'ich yuklash + davriy tozalash ──────────────────────────
export async function initSecurity() {
  try {
    const rows = await BannedIp.find({
      $or: [{ permanent: true }, { until: { $gt: new Date() } }],
    }).lean();
    for (const b of rows) {
      bannedIps.set(b.ip, { until: b.until, permanent: b.permanent, reason: b.reason });
    }
    loaded = true;
    console.log(`🛡️  Security: ${bannedIps.size} ta bloklangan IP yuklandi`);
  } catch (e) {
    console.error('[security] init xato:', e.message);
  }

  // Har 5 daqiqada xotirani tozalash (eskirgan oynalar/bloklar)
  setInterval(pruneMemory, 5 * 60_000).unref?.();
}

function pruneMemory() {
  const now = Date.now();
  for (const [ip, until] of bannedIps) {
    const b = bannedIps.get(ip);
    if (b && !b.permanent && b.until && new Date(b.until).getTime() < now) {
      bannedIps.delete(ip);
    }
  }
  for (const [ip, arr] of reqWindow) {
    const fresh = arr.filter((t) => now - t < CFG.rate.windowMs);
    if (fresh.length) reqWindow.set(ip, fresh);
    else reqWindow.delete(ip);
  }
  for (const [ip, v] of failedLogins) {
    if (now - v.first > CFG.login.windowMs) failedLogins.delete(ip);
  }
  for (const [ip, v] of strikes) {
    if (now - v.first > 60 * 60_000) strikes.delete(ip);
  }
  for (const [k, t] of logThrottle) {
    if (now - t > CFG.logThrottleMs * 2) logThrottle.delete(k);
  }
}

// ─── IP aniqlash (Cloudflare / nginx orqasida) ───────────────────────
export function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ─── Ishonchli IP'lar (hech qachon banlanmaydi) ──────────────────────
// Loopback/private/link-local — bu proxy (nginx/CF) yoki serverning o'zi.
// Agar proxy header'lari noto'g'ri sozlansa, BUTUN trafik bitta shunday IP'ga
// "yig'ilib" qoladi; uni banlash esa hamma foydalanuvchini bloklab qo'yadi.
// Qo'shimcha ishonchli IP'larni SECURITY_IP_WHITELIST (vergul bilan) orqali beriladi.
const IP_WHITELIST = new Set(
  (process.env.SECURITY_IP_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function isPrivateIp(ip) {
  const s = String(ip).replace(/^::ffff:/i, ''); // IPv4-mapped IPv6 normalizatsiya
  if (s === '127.0.0.1' || s === '::1' || s === 'localhost') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true; // 172.16–172.31
  if (/^169\.254\./.test(s)) return true; // link-local
  if (/^(fc|fd)/i.test(s)) return true; // IPv6 ULA (fc00::/7)
  if (/^fe80:/i.test(s)) return true; // IPv6 link-local
  return false;
}

/** Ushbu IP xavfsizlik tekshiruvidan ozod (ban qilinmaydi, bloklanmaydi). */
export function isExempt(ip) {
  if (!ip || ip === 'unknown') return true;
  if (IP_WHITELIST.has(ip)) return true;
  return isPrivateIp(ip);
}

// ─── Ban boshqaruvi ──────────────────────────────────────────────────
export function isBanned(ip) {
  if (isExempt(ip)) return false; // ishonchli IP hech qachon bloklanmaydi
  const b = bannedIps.get(ip);
  if (!b) return false;
  if (b.permanent) return true;
  if (b.until && new Date(b.until).getTime() > Date.now()) return true;
  bannedIps.delete(ip); // muddati o'tgan
  return false;
}

export async function banIp(ip, { reason = '', minutes = null, permanent = false, source = 'auto', by = null } = {}) {
  // Ishonchli/loopback/private IP'ni HECH QACHON banlamaymiz — aks holda
  // proxy noto'g'ri sozlanganida butun trafik bloklanib qolishi mumkin.
  if (isExempt(ip)) {
    console.warn(`[security] ban rad etildi — ishonchli IP: ${ip} (sabab: ${reason})`);
    return;
  }
  const until = permanent ? null : new Date(Date.now() + (minutes || CFG.rate.banMinutes) * 60_000);
  bannedIps.set(ip, { until, permanent, reason });
  try {
    await BannedIp.findOneAndUpdate(
      { ip },
      { ip, reason, permanent, until, source, createdBy: by, $inc: { hits: 0 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await recordEvent({ type: 'ip_banned', ip, severity: 'high', detail: reason, meta: { permanent, minutes } });
  } catch (e) {
    console.error('[security] banIp xato:', e.message);
  }
}

export async function unbanIp(ip) {
  bannedIps.delete(ip);
  failedLogins.delete(ip);
  strikes.delete(ip);
  try {
    await BannedIp.deleteOne({ ip });
    await recordEvent({ type: 'ip_unbanned', ip, severity: 'low' });
  } catch (e) {
    console.error('[security] unbanIp xato:', e.message);
  }
}

// ─── Hodisani yozish (throttled) ─────────────────────────────────────
export async function recordEvent({ type, ip, severity = 'medium', method, path, userAgent, detail, meta }) {
  if (!loaded) return;
  // ip_banned/ip_unbanned doimo yoziladi; qolganlari throttle bilan
  const throttled = !['ip_banned', 'ip_unbanned'].includes(type);
  if (throttled) {
    const key = `${ip}:${type}`;
    const last = logThrottle.get(key) || 0;
    if (Date.now() - last < CFG.logThrottleMs) return; // flood paytida bazani himoya
    logThrottle.set(key, Date.now());
  }
  try {
    await SecurityEvent.create({
      type, ip, severity,
      method: method || null,
      path: path ? String(path).slice(0, 300) : null,
      userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
      detail: detail ? String(detail).slice(0, 300) : null,
      meta: meta || null,
    });
  } catch (e) {
    // log yozish xatosi ilovani to'xtatmasligi kerak
  }
}

// ─── Flood (rate abuse) tekshiruvi ───────────────────────────────────
// true qaytarsa — IP ban qilindi (so'rovni to'sish kerak)
export function trackRequest(ip) {
  const now = Date.now();
  const arr = reqWindow.get(ip) || [];
  // eski timestamplarni tozalash
  const fresh = arr.filter((t) => now - t < CFG.rate.windowMs);
  fresh.push(now);
  reqWindow.set(ip, fresh);
  return fresh.length > CFG.rate.maxReqs;
}

// ─── Brute-force login ───────────────────────────────────────────────
export function recordFailedLogin(ip) {
  const now = Date.now();
  const v = failedLogins.get(ip) || { count: 0, first: now };
  if (now - v.first > CFG.login.windowMs) {
    v.count = 0;
    v.first = now;
  }
  v.count += 1;
  failedLogins.set(ip, v);
  return v.count; // chaqiruvchi maxFails bilan solishtiradi
}
export function clearFailedLogin(ip) {
  failedLogins.delete(ip);
}
export const loginCfg = CFG.login;

// ─── Shubhali urinish strike'i (ban tomon) ───────────────────────────
export function addStrike(ip) {
  const now = Date.now();
  const v = strikes.get(ip) || { count: 0, first: now };
  v.count += 1;
  strikes.set(ip, v);
  return v.count;
}
export const suspiciousCfg = CFG.suspicious;
export const rateCfg = CFG.rate;
export const maxBodyBytes = CFG.maxBodyBytes;

// ─── Zararli naqshlarni aniqlash ─────────────────────────────────────
const PATH_PATTERNS = [
  { re: /\.\.[\/\\]/, detail: 'path traversal', sev: 'high' },
  { re: /\/\.(env|git|aws|ssh|htpasswd)\b/i, detail: 'sensitive file probe', sev: 'high' },
  { re: /\/(wp-admin|wp-login|xmlrpc\.php|phpmyadmin|pma|adminer|\.well-known\/.*\.php)/i, detail: 'scanner probe', sev: 'medium' },
  { re: /\/(vendor\/phpunit|cgi-bin|boaform|hudson|solr|actuator\/env)/i, detail: 'exploit probe', sev: 'high' },
];
const INJECTION_PATTERNS = [
  { re: /(union\s+select|select.+from|insert\s+into|drop\s+table|;--|'\s+or\s+'1'='1)/i, detail: 'SQL injection', sev: 'high' },
  { re: /(\$where|\$ne|\$gt|\$regex|\$function)\b/i, detail: 'NoSQL injection', sev: 'high' },
  { re: /(<script|onerror\s*=|javascript:|onload\s*=|document\.cookie)/i, detail: 'XSS attempt', sev: 'high' },
];

/**
 * So'rovni tekshiradi. Zararli naqsh topilsa { type, detail, severity }, aks holda null.
 */
export function detectSuspicious(req) {
  const url = (req.originalUrl || req.url || '').slice(0, 500);

  for (const p of PATH_PATTERNS) {
    if (p.re.test(url)) return { type: 'suspicious_path', detail: p.detail, severity: p.sev };
  }

  // Query + body'ni injection uchun tekshirish (faqat string qiymatlar)
  const haystack =
    decodeSafe(url) +
    ' ' +
    flattenValues(req.body).slice(0, 50).join(' ').slice(0, 2000);

  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(haystack)) return { type: 'injection', detail: p.detail, severity: p.sev };
  }

  // Mongo operator kalitlari body ichida (NoSQL injection)
  if (hasMongoOperatorKey(req.body)) {
    return { type: 'injection', detail: 'NoSQL operator key', severity: 'high' };
  }

  return null;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function flattenValues(obj, out = [], depth = 0) {
  if (depth > 4 || obj == null) return out;
  if (typeof obj === 'string') {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) flattenValues(v, out, depth + 1);
  } else if (typeof obj === 'object') {
    for (const v of Object.values(obj)) flattenValues(v, out, depth + 1);
  }
  return out;
}
function hasMongoOperatorKey(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('$') || k.includes('.')) return true;
    if (hasMongoOperatorKey(obj[k], depth + 1)) return true;
  }
  return false;
}

// ─── Admin uchun statistika ──────────────────────────────────────────
export async function getOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [byType, total, bannedActive, recentByHour, topIps] = await Promise.all([
    SecurityEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    SecurityEvent.countDocuments({ createdAt: { $gte: since } }),
    BannedIp.countDocuments({ $or: [{ permanent: true }, { until: { $gt: new Date() } }] }),
    SecurityEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%H:00', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    SecurityEvent.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$ip', count: { $sum: 1 }, lastType: { $last: '$type' } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  return {
    last24h: total,
    bannedActive,
    byType: byType.map((t) => ({ type: t._id, count: t.count })),
    byHour: recentByHour.map((h) => ({ hour: h._id, count: h.count })),
    topIps: topIps.map((i) => ({ ip: i._id, count: i.count, lastType: i.lastType })),
    inMemoryBanned: bannedIps.size,
  };
}
