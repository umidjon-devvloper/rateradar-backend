import mongoose from 'mongoose';

const hotelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    country: { type: String, default: '' },
    countryCode: { type: String, default: '' },
    city: { type: String, default: '' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    googlePlaceId: { type: String, default: '', index: true },
    googleCid: { type: String, default: '' },
    serpPropertyToken: { type: String, default: '' },
    osmId: { type: String, default: '' },
    xoteloHotelKey: { type: String, default: '' },
    makcorpsHotelId: { type: String, default: '' },
    makcorpsCityId: { type: String, default: '' },
    // MakCorps Mapping API'dan kelgan metadata (ism, manzil, koordinatalar)
    makcorpsMeta: {
      name: { type: String, default: '' },
      address: { type: String, default: '' },
      coords: { type: String, default: '' },
      parentName: { type: String, default: '' },
      foundAt: { type: Date, default: null },
    },
    bookingComHotelId: { type: String, default: '' },
    expediaHotelId: { type: String, default: '' },
    tripAdvisorRapidId: { type: String, default: '' },
    // TripAdvisor rasmiy Content API keshi (reyting, ranking, sharhlar soni,
    // havola, rasmlar). locationId topilgach keshlanadi — qayta qidirilmaydi.
    tripAdvisor: {
      locationId: { type: String, default: '' },
      rating: { type: Number, default: 0 },
      reviewCount: { type: Number, default: 0 },
      ranking: { type: String, default: '' },       // "#3 of 45 hotels in Bukhara"
      rankingPosition: { type: Number, default: 0 },
      priceLevel: { type: String, default: '' },     // $$ - $$$ belgi
      url: { type: String, default: '' },            // web_url (attribution majburiy)
      ratingImage: { type: String, default: '' },    // rating_image_url
      photos: { type: [String], default: [] },       // 5 tagacha rasm URL
      address: { type: String, default: '' },
      updatedAt: { type: Date, default: null },
    },
    // OTA property URL'lari — foydalanuvchi o'z mehmonxonasi URL'ini kiritadi
    otaUrls: {
      type: Object,
      default: {},
    },
    stars: { type: Number, min: 0, max: 5, default: 0 },
    rooms: { type: Number, default: 0 },
    photoUrl: { type: String, default: '' },
    otaChannels: {
      type: [String],
      default: ['Booking.com', 'Expedia', 'Agoda', 'Airbnb', 'Hotels.com', 'Google Travel'],
    },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    currentPrice: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    // Booking.com kategoriya subscore'lari (HasData Place API) — keshlanadi.
    // Shakl: { overall: Number, scores: { Location, Cleanliness, Staff, ... } }
    categoryRatings: { type: Object, default: null },
    categoryRatingsAt: { type: Date, default: null },
    // AI narx tavsiyalari (keshlanadi — token tejaladi). Faqat "Yangilash"
    // bosilganda yoki kesh bo'lmaganda qaytadan generatsiya qilinadi.
    aiPriceRecs: { type: Object, default: null },
    aiPriceRecsAt: { type: Date, default: null },
    roomTypes: {
      type: [
        {
          name: { type: String, required: true },
          guests: { type: Number, default: 2 },
          sqm: { type: Number, default: 0 },
          description: { type: String, default: '' },
          basePrice: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

hotelSchema.index({ location: '2dsphere' });
hotelSchema.index({ name: 'text', city: 'text' });

export default mongoose.model('Hotel', hotelSchema);
