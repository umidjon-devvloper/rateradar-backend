import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

function createTransport() {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT || 587) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
}

export async function sendMail({ to, subject, html, replyTo }) {
  const transport = createTransport();
  if (!transport) {
    console.log('[email] SMTP sozlanmagan — xabar yuborilmadi:', subject);
    return false;
  }
  await transport.sendMail({
    from: env.SMTP_FROM || `TheHotelSaaS <${env.SMTP_USER}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
  return true;
}

// Alert: raqib(lar) narxi sizning mehmonxonangiz narxidan oshib ketganda.
// changes[] elementi: { name, oldPrice, newPrice }
// yourPrice — sizning mehmonxonangiz narxi (currentPrice)
export async function sendCompetitorPriceAlert({ userEmail, hotelName, yourPrice, changes }) {
  if (!changes.length || !userEmail) return;

  const rows = changes
    .map((c) => {
      const above = yourPrice > 0 ? c.newPrice - yourPrice : 0;
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${c.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">$${c.oldPrice}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600">$${c.newPrice}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#16a34a;font-weight:700">+$${Math.abs(above)}</td>
        </tr>`;
    })
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;border-radius:12px;margin-bottom:24px">
    <h1 style="color:#fff;margin:0;font-size:20px">📈 TheHotelSaaS</h1>
    <p style="color:#c7d2fe;margin:4px 0 0">Raqib narxi sizning narxingizdan oshib ketdi</p>
  </div>

  <p style="color:#374151">
    <strong>${hotelName}</strong> (sizning narxingiz: <strong>$${yourPrice}</strong>) uchun
    <strong>${changes.length}</strong> ta raqib narxi sizdan <strong>yuqori</strong> bo'lib ketdi.
    Bu narxingizni ko'tarish uchun yaxshi imkoniyat bo'lishi mumkin.
  </p>

  <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Raqib</th>
        <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Avvalgi</th>
        <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Yangi</th>
        <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase">Sizdan yuqori</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <p style="margin-top:24px;font-size:12px;color:#9ca3af">
    Ushbu xabar TheHotelSaaS tomonidan avtomatik yuborildi.<br>
    Monitoring har 6 soatda tekshiriladi.
  </p>
</body>
</html>`;

  await sendMail({
    to: userEmail,
    subject: `TheHotelSaaS: ${changes.length} ta raqib narxi sizdan oshdi — ${hotelName}`,
    html,
  });
}

// Landing formasidan kelgan lead (bog'lanish so'rovi) — mehmonxona egasiga.
// Yillik reja uchun "Biz bilan bog'laning" formasi shu funksiyani ishlatadi.
export async function sendLeadEmail({ name, hotel, phone, country, email, city, plan, message }) {
  const to = env.LEADS_EMAIL || 'info@thehotelsaas.com';
  const row = (label, val) => val
    ? `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px">${label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">${String(val).replace(/</g, '&lt;')}</td></tr>`
    : '';
  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;border-radius:12px;margin-bottom:20px">
    <h1 style="color:#fff;margin:0;font-size:20px">📩 Yangi so'rov — TheHotelSaaS</h1>
    <p style="color:#c7d2fe;margin:4px 0 0">Saytdagi formadan kelgan bog'lanish so'rovi</p>
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    ${row('Ism', name)}
    ${row('Mehmonxona', hotel)}
    ${row('Telefon', phone)}
    ${row('Davlat', country)}
    ${row('Email', email)}
    ${row('Shahar', city)}
    ${row('Turi', plan)}
    ${row('Xabar', message)}
  </table>
  <p style="margin-top:20px;font-size:12px;color:#9ca3af">
    Bu so'rov TheHotelSaaS landing sahifasidagi formadan avtomatik yuborildi.
  </p>
</body></html>`;

  return sendMail({
    to,
    subject: `🆕 So'rov: ${name || 'Nomsiz'}${hotel ? ` — ${hotel}` : ''}${plan ? ` (${plan})` : ''}`,
    html,
    // Egasi to'g'ridan-to'g'ri "Reply" bossa mijozga borsin.
    replyTo: email || undefined,
  });
}

// Admin e'loni / yangilik xabari — barcha (filtrlangan) foydalanuvchilarga.
export async function sendBroadcastEmail({ to, subject, title, body }) {
  const safeBody = String(body || '').replace(/\n/g, '<br>');
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;border-radius:12px;margin-bottom:24px">
    <h1 style="color:#fff;margin:0;font-size:20px">🔔 TheHotelSaaS</h1>
    <p style="color:#c7d2fe;margin:4px 0 0">Yangilik / e'lon</p>
  </div>

  ${title ? `<h2 style="color:#111827;font-size:18px;margin:0 0 12px">${title}</h2>` : ''}
  <div style="color:#374151;font-size:14px;line-height:1.6">${safeBody}</div>

  <p style="margin-top:24px;font-size:12px;color:#9ca3af">
    Ushbu xabar TheHotelSaaS jamoasi tomonidan yuborildi.
  </p>
</body>
</html>`;

  return sendMail({ to, subject, html });
}
