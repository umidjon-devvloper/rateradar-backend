import mongoose from 'mongoose';

const priceSnapshotSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ['own', 'competitor'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerHotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    ota: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    available: { type: Boolean, default: true },
    roomsLeft: { type: Number, default: null },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    snapshotAt: { type: Date, default: Date.now, index: true },
    source: { type: String, default: 'unknown' },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: false }
);

priceSnapshotSchema.index({ ownerHotelId: 1, snapshotAt: -1 });
priceSnapshotSchema.index({ targetId: 1, ota: 1, snapshotAt: -1 });
priceSnapshotSchema.index({ ownerHotelId: 1, ota: 1, snapshotAt: -1 });
priceSnapshotSchema.index({ snapshotAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export default mongoose.model('PriceSnapshot', priceSnapshotSchema);
