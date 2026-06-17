// RateRadar'ning asosiy Socket.IO serverida alohida namespace ishlatamiz.
// Asosiy "/" namespace JWT auth middleware bilan himoyalangan (faqat
// RateRadar foydalanuvchilari). Mehmonxona-xizmati esa o'zining
// "/hotel-service" namespace'ida — auth talab qilmaydi, alohida xonalar.
let nsp = null;

const init = (socketIO) => {
  nsp = socketIO.of("/hotel-service");

  nsp.on("connection", (socket) => {
    // Admin paneli o'z mehmonxonasining room ga kiradi
    socket.on("join_hotel", (hotelId) => {
      socket.join(`hotel:${hotelId}`);
    });

    socket.on("disconnect", () => {});
  });
};

const getIO = () => {
  if (!nsp) throw new Error("Socket.io initialize qilinmagan");
  return nsp;
};

// Faqat shu mehmonxonaning admin paneliga yuborish
const toHotel = (hotelId, event, data) => {
  try {
    getIO().to(`hotel:${hotelId}`).emit(event, data);
  } catch (_) {}
};

const emit = {
  newRequest:         (hotelId, data) => toHotel(hotelId, "new_request",          data),
  requestAccepted:    (hotelId, data) => toHotel(hotelId, "request_accepted",      data),
  requestCompleted:   (hotelId, data) => toHotel(hotelId, "request_completed",     data),
  requestTimeout:     (hotelId, data) => toHotel(hotelId, "request_timeout",       data),
  newStaffRegistered: (hotelId, data) => toHotel(hotelId, "new_staff_registered",  data),
};

module.exports = { init, getIO, emit };
