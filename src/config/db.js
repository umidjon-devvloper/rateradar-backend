import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDB() {
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(env.MONGODB_URI);
    console.log("✓ MongoDB ulandi");

    mongoose.connection.on("error", (err) => {
      console.error("MongoDB xatosi:", err);
    });
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB uzildi");
    });
  } catch (err) {
    console.error("MongoDB ulanishda xato:", err.message);
    process.exit(1);
  }
}
