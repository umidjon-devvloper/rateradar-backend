const router    = require("express").Router();
const hotelAuth = require("../middleware/hotelAuth");
const {
  verifySSO, getMe, updateSettings, updateBranding,
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

module.exports = router;
