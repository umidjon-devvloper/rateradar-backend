import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Qaysi mehmonxonaga tegishli. null — foydalanuvchi darajasidagi (masalan,
    // admin broadcast) — barcha mehmonxonalarda ko'rinadi. Mehmonxona ID bo'lsa,
    // faqat o'sha mehmonxona tanlanganda ko'rinadi (aralashmaydi).
    hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', default: null, index: true },
    type: {
      type: String,
      enum: [
        'price_drop',
        'price_rise',
        'competitor_below',
        'market_rising',
        'new_review',
        'negative_review',
        'ai_recommendation',
        'system',
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    relatedType: { type: String, default: '' },
    relatedId: { type: mongoose.Schema.Types.ObjectId, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, hotelId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default mongoose.model('Notification', notificationSchema);
