import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ['own', 'competitor'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerHotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
    platform: { type: String, default: 'Google' },
    externalId: { type: String, default: '' },
    author: { type: String, default: 'Anonymous' },
    rating: { type: Number, min: 0, max: 5, required: true },
    text: { type: String, default: '' },
    language: { type: String, default: 'en' },
    publishedAt: { type: Date, default: null },
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative', 'unknown'], default: 'unknown' },
    sentimentScore: { type: Number, default: 0 },
    topics: { type: [String], default: [] },
    aiSummary: { type: String, default: '' },
    aiAnalyzedAt: { type: Date, default: null },
    seenByUser: { type: Boolean, default: false },
  },
  { timestamps: true }
);

reviewSchema.index({ ownerHotelId: 1, publishedAt: -1 });
reviewSchema.index({ targetId: 1, externalId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Review', reviewSchema);
