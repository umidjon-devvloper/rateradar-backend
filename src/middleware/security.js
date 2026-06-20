import * as sec from '../services/security.service.js';

/**
 * Asosiy xavfsizlik darvozasi (guard). Har bir so'rovda:
 *   1. Haqiqiy IP'ni aniqlaydi (Cloudflare/nginx orqasida)
 *   2. Bloklangan IP bo'lsa → 403
 *   3. Zararli naqsh (path traversal, injection, scanner) → log + strike → ban
 *   4. Flood (bitta IP ko'p so'rov) → log + vaqtinchalik ban → 429
 *
 * express.json'dan KEYIN ulanadi (body'ni ham tekshirish uchun).
 */
export async function securityGuard(req, res, next) {
  const ip = sec.getClientIp(req);
  req.clientIp = ip;

  // 1) Bloklangan IP
  if (sec.isBanned(ip)) {
    sec.recordEvent({
      type: 'blocked', ip, severity: 'medium',
      method: req.method, path: req.originalUrl, userAgent: req.headers['user-agent'],
    });
    return res.status(403).json({ error: 'Kirish bloklangan' });
  }

  // 2) Zararli naqsh
  const susp = sec.detectSuspicious(req);
  if (susp) {
    sec.recordEvent({
      type: susp.type, ip, severity: susp.severity, detail: susp.detail,
      method: req.method, path: req.originalUrl, userAgent: req.headers['user-agent'],
    });
    const strikeCount = sec.addStrike(ip);
    if (strikeCount >= sec.suspiciousCfg.maxStrikes) {
      await sec.banIp(ip, { reason: `Takroriy zararli urinish: ${susp.detail}`, minutes: sec.suspiciousCfg.banMinutes });
      return res.status(403).json({ error: 'Kirish bloklangan' });
    }
    // Yo'l/injection probe'ni darrov rad etamiz (xizmat ko'rsatmaymiz)
    return res.status(400).json({ error: 'Noto\'g\'ri so\'rov' });
  }

  // 3) Flood (rate abuse)
  if (sec.trackRequest(ip)) {
    sec.recordEvent({
      type: 'rate_abuse', ip, severity: 'high',
      method: req.method, path: req.originalUrl, userAgent: req.headers['user-agent'],
    });
    await sec.banIp(ip, { reason: 'So\'rovlar chastotasi oshib ketdi (flood)', minutes: sec.rateCfg.banMinutes });
    res.set('Retry-After', String(sec.rateCfg.banMinutes * 60));
    return res.status(429).json({ error: 'Juda ko\'p so\'rov. Keyinroq urinib ko\'ring.' });
  }

  next();
}
