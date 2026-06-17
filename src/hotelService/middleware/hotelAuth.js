const jwt = require("jsonwebtoken");
const Hotel = require("../models/Hotel");

/**
 * Hotel admin paneli uchun JWT tekshirish.
 * Token hotel admini tomonidan /api/hotel/auth orqali olingan bo'ladi.
 */
const hotelAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token yo'q" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Hotel ma'lumotlarini DBdan olish
    const hotel = await Hotel.findOne({ hotel_id: decoded.hotel_id });
    if (!hotel) {
      return res.status(401).json({ message: "Mehmonxona topilmadi" });
    }

    req.hotel = hotel;
    req.hotelId = hotel.hotel_id;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Token yaroqsiz yoki muddati o'tgan" });
  }
};

module.exports = hotelAuth;
