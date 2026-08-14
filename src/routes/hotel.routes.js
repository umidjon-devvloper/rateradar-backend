import { Router } from 'express';
import {
  createHotel, getMyHotel, updateMyHotel, listMyHotels, getOccupancy, setOccupancy,
  getCompetitors, addCompetitor, deleteCompetitor, fetchCompetitorPrice, fetchCompetitorXoteloPrice, fetchCompetitorHasDataPrice, getCompetitorDetail, fetchCompetitorRooms, getCompetitorRoomsByDate,
  updateCompetitorOtaUrls, fetchCompetitorChannel,
  enrichMyHotel, getOtaPrices, getOtaChannels, getOtaChannelDetail, setOtaChannelPrice,
  fetchOtaChannel, fetchAllOtaChannels, findBookingUrlEndpoint,
  getHotelXoteloRates, getMyCategoryRatings,
  discoverNearbyHotels, instantSnapshot, getCollectStatus,
} from '../controllers/hotel.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveHotel } from '../middleware/resolveHotel.js';

const router = Router();
router.use(requireAuth);

/**
 * @openapi
 * /hotels/mine/all:
 *   get:
 *     tags: [Hotels]
 *     summary: Foydalanuvchining barcha hotellari (switcher uchun)
 *     responses:
 *       200: { description: Hotellar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/mine/all', listMyHotels);

// Barcha qolgan endpointlar uchun aktiv hotel'ni aniqlaymiz.
router.use(resolveHotel);

/**
 * @openapi
 * /hotels:
 *   post:
 *     tags: [Hotels]
 *     summary: Yangi hotel yaratish
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "Hotel Bukhara Palace" }
 *               city: { type: string, example: "Buxoro" }
 *               country: { type: string, example: "UZ" }
 *               address: { type: string }
 *               lat: { type: number }
 *               lng: { type: number }
 *               bookingUrl: { type: string }
 *     responses:
 *       201: { description: Yaratilgan hotel }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/', createHotel);

/**
 * @openapi
 * /hotels/me:
 *   get:
 *     tags: [Hotels]
 *     summary: Aktiv hotel ma'lumotlari
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Hotel ma'lumotlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   put:
 *     tags: [Hotels]
 *     summary: Aktiv hotelni yangilash
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               city: { type: string }
 *               address: { type: string }
 *               bookingUrl: { type: string }
 *     responses:
 *       200: { description: Yangilangan hotel }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', getMyHotel);
router.put('/me', updateMyHotel);

/**
 * @openapi
 * /hotels/me/occupancy:
 *   get:
 *     tags: [Hotels]
 *     summary: Haftalik to'lish darajasi (occupancy) — hozirgi holat
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: "{ current: {band, weekStart, ageDays}|null, shouldAsk, weekStart }" }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   put:
 *     tags: [Hotels]
 *     summary: Haftalik to'lish darajasini yozish (narx tavsiyasiga ta'sir qiladi)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               band: { type: string, enum: [low, mid, high] }
 *     responses:
 *       200: { description: "{ ok, current }" }
 *       400: { description: band noto'g'ri }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/occupancy', getOccupancy);
router.put('/me/occupancy', setOccupancy);

/**
 * @openapi
 * /hotels/me/collect-status:
 *   get:
 *     tags: [Hotels]
 *     summary: Onboarding ma'lumot yig'ish holati (pending/collecting/ready/error)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Yig'ish holati va progressi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/collect-status', getCollectStatus);

/**
 * @openapi
 * /hotels/me/enrich:
 *   post:
 *     tags: [Hotels]
 *     summary: Hotel ma'lumotlarini tashqi manbalardan boyitish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Boyitilgan hotel ma'lumotlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/me/enrich', enrichMyHotel);

/**
 * @openapi
 * /hotels/me/find-booking-url:
 *   post:
 *     tags: [Hotels]
 *     summary: Hotel uchun Booking.com URL'ini avtomatik topish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Topilgan Booking URL }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/me/find-booking-url', findBookingUrlEndpoint);

/**
 * @openapi
 * /hotels/me/ota-prices:
 *   get:
 *     tags: [Hotels]
 *     summary: Aktiv hotelning OTA narxlari
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: OTA narxlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/ota-prices', getOtaPrices);

/**
 * @openapi
 * /hotels/me/xotelo-rates:
 *   get:
 *     tags: [Hotels]
 *     summary: Xotelo bepul API orqali OTA narxlari (TripAdvisor key bo'yicha)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200:
 *         description: Xotelo kanallari va narxlari
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured: { type: boolean }
 *                 hotelKey: { type: string, nullable: true }
 *                 channels:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       source: { type: string, example: Booking.com }
 *                       price: { type: number, example: 45 }
 *                       via: { type: string, example: xotelo }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/xotelo-rates', getHotelXoteloRates);

/**
 * @openapi
 * /hotels/me/instant-snapshot:
 *   post:
 *     tags: [Hotels]
 *     summary: "Aha moment — bepul Xotelo orqali o'z + raqiblar narxini avtomatik oladi"
 *     responses:
 *       200: { description: "O'z narx, raqiblar va bozor xulosasi" }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/me/instant-snapshot', instantSnapshot);

/**
 * @openapi
 * /hotels/me/category-ratings:
 *   get:
 *     tags: [Hotels]
 *     summary: Mening hotelimning kategoriya reytinglari — SerpAPI Google Hotels, fallback skreyper (keshlanadi)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: query
 *         name: refresh
 *         schema: { type: boolean }
 *         description: "true — keshni e'tiborsiz qoldirib qaytadan oladi (SerpAPI property details so'rovi)"
 *     responses:
 *       200:
 *         description: Kategoriya reytinglari
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured: { type: boolean }
 *                 overall: { type: number, example: 9.7 }
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       label: { type: string, example: Cleanliness }
 *                       value: { type: number, example: 9.8 }
 *                 source: { type: string, example: Google }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/category-ratings', getMyCategoryRatings);

/**
 * @openapi
 * /hotels/me/ota-channels:
 *   get:
 *     tags: [Hotels]
 *     summary: OTA kanallar ro'yxati va holati
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: OTA kanallar }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/ota-channels', getOtaChannels);

/**
 * @openapi
 * /hotels/me/ota-channels/fetch:
 *   post:
 *     tags: [Hotels]
 *     summary: Bitta OTA kanal narxini tortib olish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source: { type: string, example: booking }
 *     responses:
 *       200: { description: Tortib olingan narx }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/me/ota-channels/fetch', fetchOtaChannel);

/**
 * @openapi
 * /hotels/me/ota-channels/fetch-all:
 *   post:
 *     tags: [Hotels]
 *     summary: Barcha OTA kanallar narxini tortib olish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Barcha kanallar tortildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/me/ota-channels/fetch-all', fetchAllOtaChannels);

/**
 * @openapi
 * /hotels/me/ota-channels/{source}:
 *   get:
 *     tags: [Hotels]
 *     summary: Bitta OTA kanal tafsilotlari
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: source
 *         required: true
 *         schema: { type: string }
 *         description: "Kanal manbai (masalan, booking, expedia)"
 *     responses:
 *       200: { description: Kanal tafsilotlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me/ota-channels/:source', getOtaChannelDetail);

/**
 * @openapi
 * /hotels/me/ota-channels/{source}/price:
 *   put:
 *     tags: [Hotels]
 *     summary: OTA kanal narxini qo'lda o'rnatish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: source
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               price: { type: number, example: 120 }
 *     responses:
 *       200: { description: Narx o'rnatildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.put('/me/ota-channels/:source/price', setOtaChannelPrice);

/**
 * @openapi
 * /hotels/competitors:
 *   get:
 *     tags: [Hotels]
 *     summary: Raqobatchilar ro'yxati
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Raqobatchilar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Hotels]
 *     summary: Yangi raqobatchi qo'shish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, example: "Asia Hotel" }
 *               bookingUrl: { type: string }
 *     responses:
 *       201: { description: Qo'shilgan raqobatchi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/competitors', getCompetitors);

/**
 * @openapi
 * /hotels/discover-nearby:
 *   get:
 *     tags: [Hotels]
 *     summary: Yaqin atrofdagi hotellarni topish (raqobatchi nomzodlar)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *     responses:
 *       200: { description: Yaqin hotellar ro'yxati }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/discover-nearby', discoverNearbyHotels);

router.post('/competitors', addCompetitor);

/**
 * @openapi
 * /hotels/competitors/{id}:
 *   delete:
 *     tags: [Hotels]
 *     summary: Raqobatchini o'chirish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: O'chirildi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.delete('/competitors/:id', deleteCompetitor);

/**
 * @openapi
 * /hotels/competitors/{id}/fetch-price:
 *   post:
 *     tags: [Hotels]
 *     summary: Raqobatchi narxini tortib olish (asosiy provayder)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Tortib olingan narx }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/competitors/:id/fetch-price', fetchCompetitorPrice);

/**
 * @openapi
 * /hotels/competitors/{id}/fetch-xotelo:
 *   post:
 *     tags: [Hotels]
 *     summary: Raqobatchi narxini Xotelo orqali tortib olish
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Xotelo narxi }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/competitors/:id/fetch-xotelo', fetchCompetitorXoteloPrice);

/**
 * @openapi
 * /hotels/competitors/{id}/fetch-hasdata:
 *   post:
 *     tags: [Hotels]
 *     summary: Raqobatchi Booking.com narxini HasData orqali olish (SerpAPI kanali yo'q bo'lsa)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: HasData Booking.com narxi }
 *       422: { description: Booking.com'da narx topilmadi }
 *       503: { description: HasData API kaliti sozlanmagan }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/competitors/:id/fetch-hasdata', fetchCompetitorHasDataPrice);

/**
 * @openapi
 * /hotels/competitors/{id}/ota-urls:
 *   put:
 *     tags: [Hotels]
 *     summary: Raqib kanal havolalarini saqlash (xato havolani qo'lda tuzatish)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               otaUrls:
 *                 type: object
 *                 example: { "Booking.com": "https://www.booking.com/hotel/uz/x.html" }
 *     responses:
 *       200: { description: Yangilangan raqib }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.put('/competitors/:id/ota-urls', updateCompetitorOtaUrls);

/**
 * @openapi
 * /hotels/competitors/{id}/fetch-channel:
 *   post:
 *     tags: [Hotels]
 *     summary: Raqibning tanlangan kanalidan narx olish (saqlangan havoladan, Apify)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source: { type: string, enum: [booking, hotels, expedia, trip] }
 *     responses:
 *       200: { description: Kanal narxi }
 *       404: { description: Havola topilmadi }
 *       503: { description: APIFY_API_KEY sozlanmagan }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/competitors/:id/fetch-channel', fetchCompetitorChannel);

/**
 * @openapi
 * /hotels/competitors/{id}/detail:
 *   get:
 *     tags: [Hotels]
 *     summary: Raqobatchi tafsilotlari (narx tarixi bilan)
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Raqobatchi tafsilotlari }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/competitors/:id/detail', getCompetitorDetail);
router.post('/competitors/:id/rooms', fetchCompetitorRooms);

/**
 * @openapi
 * /hotels/competitors/{id}/rooms:
 *   get:
 *     tags: [Hotels]
 *     summary: Raqibning aynan shu tun uchun xona turlari va narxlari
 *     description: >
 *       Avval keshdan (RoomSnapshot, 20 soat) o'qiydi, yo'q bo'lsagina skreyp
 *       qiladi. Rate Shopper jadvalida narx katakchasi ochilganda chaqiriladi.
 *     parameters:
 *       - $ref: '#/components/parameters/HotelIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: date
 *         required: true
 *         schema: { type: string, example: '2026-08-15' }
 *       - in: query
 *         name: force
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: "{ name, date, rooms:[{name, price, guests, roomsLeft}], fetchedAt, cached }" }
 *       400: { description: date noto'g'ri }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/competitors/:id/rooms', getCompetitorRoomsByDate);

export default router;
