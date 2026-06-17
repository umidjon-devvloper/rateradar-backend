import cron from 'node-cron';
import Hotel from '../models/Hotel.js';
import Competitor from '../models/Competitor.js';
import User from '../models/User.js';
import PriceSnapshot from '../models/PriceSnapshot.js';
import Notification from '../models/Notification.js';
import { hasApify, getBookingCitySearchApify, matchHotelByName } from './apify.service.js';
import { sendCompetitorPriceAlert } from './email.service.js';
import { emitToUser } from './socket.service.js';

// 5% dan oshiq o'zgarsa — alert
const CHANGE_THRESHOLD = 0.05;

function nextCheckIn() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

async function createAndEmitPriceChange({ userId, hotel, comp, oldPrice, newPrice }) {
  const dropped = newPrice < oldPrice;
  const diffPct = Math.round(Math.abs(newPrice - oldPrice) / oldPrice * 100);
  const diffAbs = Math.round(newPrice - oldPrice);

  const title = dropped
    ? `📉 ${comp.name} narxni tushirdi`
    : `📈 ${comp.name} narxni ko'tardi`;

  const message = dropped
    ? `${comp.name} narxni ${diffPct}% tushirdi: $${oldPrice} → $${newPrice}`
    : `${comp.name} narxni ${diffPct}% oshirdi: $${oldPrice} → $${newPrice}`;

  const notif = await Notification.create({
    userId,
    hotelId: hotel._id,
    type: dropped ? 'price_drop' : 'price_rise',
    severity: dropped ? 'warning' : 'info',
    title,
    message,
    relatedType: 'competitor',
    relatedId: comp._id,
    payload: {
      competitorId: comp._id,
      competitorName: comp.name,
      hotelId: hotel._id,
      oldPrice,
      newPrice,
      diff: diffAbs,
      diffPercent: diffPct,
      direction: dropped ? 'down' : 'up',
    },
  });

  emitToUser(userId, 'notification:new', notif.toObject());
}

async function monitorHotel(hotel) {
  if (!hasApify() || !hotel.city) return;

  const competitors = await Competitor.find({ ownerHotelId: hotel._id, isActive: true }).lean();
  if (!competitors.length) return;

  const user = await User.findById(hotel.userId).select('email').lean();
  if (!user?.email) return;

  // Sizning mehmonxonangiz narxi — raqib shu narxdan oshganini aniqlash uchun
  const yourPrice = hotel.currentPrice || 0;

  const checkIn = nextCheckIn();
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);
  const ciStr = checkIn.toISOString().slice(0, 10);
  const coStr = checkOut.toISOString().slice(0, 10);

  // Bitta Apify shahar qidiruvi — 50 ta hotel, har bir raqibni nom bo'yicha mos qilamiz
  let items = [];
  try {
    items = await getBookingCitySearchApify(hotel.city, {
      checkIn: ciStr,
      checkOut: coStr,
      maxItems: 50,
    });
  } catch (err) {
    console.error(`[cron] Apify city search xatosi (${hotel.city}):`, err.message);
    return;
  }
  if (!items.length) return;

  const changes = [];

  for (const comp of competitors) {
    try {
      const match = matchHotelByName(items, comp.name, 0.4);
      if (!match?.price) continue;

      const newPrice = match.price;
      const oldPrice = comp.latestPrices?.bookingcom || comp.latestPrices?.booking || 0;

      await PriceSnapshot.create({
        targetType: 'competitor',
        targetId: comp._id,
        ownerHotelId: hotel._id,
        ota: 'Booking.com',
        price: newPrice,
        currency: 'USD',
        checkIn,
        checkOut,
        source: 'cron',
      });

      await Competitor.findByIdAndUpdate(comp._id, {
        'latestPrices.bookingcom': newPrice,
        lastPriceFetchedAt: new Date(),
      });

      // Ilova ichidagi bildirishnoma — har qanday sezilarli (≥5%) o'zgarishda
      if (oldPrice > 0 && Math.abs(newPrice - oldPrice) / oldPrice >= CHANGE_THRESHOLD) {
        try {
          await createAndEmitPriceChange({
            userId: hotel.userId,
            hotel,
            comp,
            oldPrice,
            newPrice,
          });
        } catch (e) {
          console.error('[cron] notif yaratish xatosi:', e.message);
        }
      }

      // Email alert — FAQAT raqib narxi sizning narxingizdan endi oshib ketganda
      // (crossing): avval sizdan past/teng edi, hozir yuqori. Takroriy spam bo'lmaydi.
      if (
        yourPrice > 0 &&
        oldPrice > 0 &&
        oldPrice <= yourPrice &&
        newPrice > yourPrice
      ) {
        changes.push({
          name: comp.name,
          oldPrice,
          newPrice,
        });
      }
    } catch (err) {
      console.error(`[cron] Raqib "${comp.name}" xatosi:`, err.message);
    }
  }

  if (changes.length) {
    await sendCompetitorPriceAlert({
      userEmail: user.email,
      hotelName: hotel.name,
      yourPrice,
      changes,
    });
    console.log(`[cron] ${hotel.name}: ${changes.length} ta raqib sizdan oshdi — alert yuborildi → ${user.email}`);
  }
}

async function runMonitor() {
  console.log('[cron] Raqiblar narx monitoring boshlandi...');
  try {
    const hotels = await Hotel.find({}).lean();
    for (const hotel of hotels) {
      await monitorHotel(hotel);
    }
    console.log('[cron] Monitoring tugadi');
  } catch (err) {
    console.error('[cron] Monitoring xatosi:', err.message);
  }
}

// Har 6 soatda: 0 soat, 6 soat, 12 soat, 18 soat
export function startCompetitorMonitor() {
  cron.schedule('0 */6 * * *', runMonitor);
  console.log('[cron] Raqib narx monitoring yoqildi (har 6 soatda)');
}

// On-demand: bitta raqibga narx tekshirish va o'zgarganda real-time push qilish
export async function checkCompetitorOnce({ userId, competitorId }) {
  if (!hasApify()) return null;

  const comp = await Competitor.findOne({ _id: competitorId, isActive: true });
  if (!comp) return null;
  const hotel = await Hotel.findById(comp.ownerHotelId);
  if (!hotel || hotel.userId.toString() !== userId.toString()) return null;
  if (!hotel.city) return null;

  const checkIn = nextCheckIn();
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);

  const items = await getBookingCitySearchApify(hotel.city, {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
    maxItems: 50,
  });
  const match = matchHotelByName(items, comp.name, 0.4);
  if (!match?.price) return null;

  const newPrice = match.price;
  const oldPrice = comp.latestPrices?.get?.('bookingcom') || 0;

  await Competitor.findByIdAndUpdate(comp._id, {
    'latestPrices.bookingcom': newPrice,
    lastPriceFetchedAt: new Date(),
  });

  if (oldPrice > 0 && Math.abs(newPrice - oldPrice) / oldPrice >= CHANGE_THRESHOLD) {
    await createAndEmitPriceChange({ userId, hotel, comp, oldPrice, newPrice });
    return { changed: true, oldPrice, newPrice };
  }

  return { changed: false, oldPrice, newPrice };
}
