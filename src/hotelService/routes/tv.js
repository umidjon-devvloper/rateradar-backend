const router = require("express").Router();
const { registerDevice, deviceStatus, tvContent } = require("../controllers/tvController");

// TV qurilma endpointlari — OMMAVIY (token/kod bilan himoyalangan).
// Kontent faqat pair qilingan qurilma tokeni + faol obuna bilan ochiladi.
router.post("/register", registerDevice);
router.get("/status/:id", deviceStatus);
router.get("/content", tvContent);

module.exports = router;
