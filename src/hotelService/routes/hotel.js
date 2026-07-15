const router    = require("express").Router();
const hotelAuth = require("../middleware/hotelAuth");
const {
  verifySSO, getMe, updateSettings, updateBranding, uploadImage,
  getActiveStaff, updateStaff, deleteStaff,
  getServices, createService, updateService, deleteService, regenerateServiceInvite,
  getRequests, getReports, getReviews,
} = require("../controllers/hotelController");

// Auth
router.post("/auth", verifySSO);

router.use(hotelAuth);

router.get("/me", getMe);
router.put("/settings", updateSettings);
router.put("/branding", updateBranding);
// Xizmat item'lari uchun rasm yuklash (base64 → /uploads/hs/...)
router.post("/upload-image", uploadImage);

// Staff — pending holat yo'q endi
router.get("/staff",        getActiveStaff);
router.put("/staff/:id",    updateStaff);
router.delete("/staff/:id", deleteStaff);

// Services
router.get("/services",                         getServices);
router.post("/services",                        createService);
router.put("/services/:id",                     updateService);
router.delete("/services/:id",                  deleteService);
router.post("/services/:id/regenerate-invite",  regenerateServiceInvite);

// Requests + Reports + Reviews
router.get("/requests", getRequests);
router.get("/reports",  getReports);
router.get("/reviews",  getReviews);

// TV qurilmalar (Android TV kiosk) — pair, ro'yxat, tahrirlash, uzish
const {
  pairDevice, listDevices, updateDevice, revokeDevice,
} = require("../controllers/tvController");
router.post("/tv-devices/pair",  pairDevice);
router.get("/tv-devices",        listDevices);
router.put("/tv-devices/:id",    updateDevice);
router.delete("/tv-devices/:id", revokeDevice);

module.exports = router;
