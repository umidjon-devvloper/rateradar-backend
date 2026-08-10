import mongoose from "mongoose";

const competitorSchema = new mongoose.Schema(
  {
    ownerHotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotel",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    googlePlaceId: { type: String, default: "", index: true },
    osmId: { type: String, default: "" },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] },
    },
    stars: { type: Number, min: 0, max: 5, default: 0 },
    distanceKm: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    photoUrl: { type: String, default: "" },
    // TripAdvisor URL — Xotelo hotel_key shu URL'dan ajratib olinadi.
    // Bir marta SerpAPI tripadvisor orqali topiladi, saqlanadi — keyingi Xotelo so'rovlari uchun qayta qidirilmaydi.
    tripAdvisorUrl: { type: String, default: "" },
    // Booking.com property URL — bir marta topilgach saqlanadi, keyingi
    // Apify so'rovlarda qayta SerpAPI qidiruvi qilinmaydi (tannarx tejaladi).
    bookingUrl: { type: String, default: "" },
    // Kanal URL'lari ({'Booking.com': url, 'Expedia': url, ...}) — foydalanuvchi
    // xato havolani o'zi tuzata oladi; fetch-channel shu URL'dan aniq narx oladi.
    otaUrls: { type: Object, default: {} },
    latestPrices: { type: Map, of: Number, default: {} },
    lastPriceFetchedAt: { type: Date, default: null },
    // Xona turlari — raqibning Booking sahifasidan (nom+shahar) bir marta
    // skreyp qilinadi. Foydalanuvchi qaysi xona qancha ekanini ko'radi.
    roomTypes: {
      type: [{
        name: { type: String, default: "" },
        price: { type: Number, default: 0 },
        guests: { type: Number, default: 2 },
      }],
      default: [],
    },
    roomsFetchedAt: { type: Date, default: null },
    autoAdded: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

competitorSchema.index({ location: "2dsphere" });
competitorSchema.index(
  { ownerHotelId: 1, googlePlaceId: 1 },
  { unique: true, sparse: true },
);

export default mongoose.model("Competitor", competitorSchema);
