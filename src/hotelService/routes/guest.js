const router = require("express").Router();
const { getHotelInfo, getTranslatedServices, createRequest, createReview } = require("../controllers/guestController");

// GET /api/guest/hotel/:hotelId — hotel info + subscription check
router.get("/hotel/:hotelId", getHotelInfo);

// GET /api/guest/services/:hotelId?lang=en — tarjima qilingan xizmatlar
router.get("/services/:hotelId", getTranslatedServices);

// POST /api/guest/requests — yangi buyurtma
router.post("/requests", createRequest);

// POST /api/guest/reviews — mehmon sharhi (yulduz + izoh)
router.post("/reviews", createReview);

module.exports = router;
