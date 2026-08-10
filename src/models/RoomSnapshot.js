import mongoose from 'mongoose';

/**
 * Raqib XONA TURLARI tarixi — occupancy (to'lish) signalini aniqlash uchun.
 *
 * Har safar raqib xonalari skreyp qilinganda bitta yozuv qo'shiladi. Vaqt
 * o'tishi bilan (competitor, checkIn) uchun ketma-ket snapshotlar to'planadi.
 * Eng arzon xona nomi (minRoomName) o'zgarib, narx keyingi qimmatroq xonadan
 * hisoblana boshlasa — arzon xonalar SOTILIB BITGAN (occupancy signali).
 *
 * roomsLeft — Booking ba'zan "faqat X xona qoldi" deydi (to'g'ridan-to'g'ri proksi).
 */
const roomSnapshotSchema = new mongoose.Schema(
  {
    competitorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Competitor', required: true, index: true },
    ownerHotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    checkIn: { type: Date, default: null },
    snapshotAt: { type: Date, default: Date.now, index: true },
    rooms: {
      type: [{ name: String, price: Number, roomsLeft: { type: Number, default: null } }],
      default: [],
    },
    minPrice: { type: Number, default: 0 },
    minRoomName: { type: String, default: '' }, // eng arzon xona nomi
    roomsLeft: { type: Number, default: null },  // eng arzon xonada qolgan (agar bor)
  },
  { timestamps: true },
);

roomSnapshotSchema.index({ competitorId: 1, snapshotAt: -1 });
// 120 kun saqlaymiz (tarix uchun yetarli, keyin o'chadi).
roomSnapshotSchema.index({ snapshotAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 120 });

export default mongoose.model('RoomSnapshot', roomSnapshotSchema);
