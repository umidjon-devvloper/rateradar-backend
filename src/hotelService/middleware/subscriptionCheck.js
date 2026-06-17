/**
 * Obuna tekshiruvi.
 * HOZIRCHA O'CHIRILGAN — xizmat har doim faol deb hisoblanadi.
 * Qayta yoqish kerak bo'lsa, quyidagi izohlangan blokni tiklang.
 */
const subscriptionCheck = (req, res, next) => {
  return next();

  /*
  const { subscription } = req.hotel;
  if (!subscription?.active) {
    return res.status(403).json({ message: "Obuna faol emas", code: "SUBSCRIPTION_INACTIVE" });
  }
  if (subscription.expires_at && new Date(subscription.expires_at) < new Date()) {
    return res.status(403).json({ message: "Obuna muddati tugagan", code: "SUBSCRIPTION_EXPIRED" });
  }
  next();
  */
};

module.exports = subscriptionCheck;
