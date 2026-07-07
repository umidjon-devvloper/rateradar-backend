import mongoose from "mongoose";
import dns from "node:dns";
import { env } from "./env.js";

export async function connectDB() {
  mongoose.set("strictQuery", true);

  try {
    await mongoose.connect(env.MONGODB_URI);
  } catch (err) {
    // mongodb+srv:// ulanishi DNS SRV so'rovi talab qiladi. Windows'da ba'zi
    // provayder/router DNS'lari SRV'ni rad etadi (querySrv ECONNREFUSED) —
    // ommaviy DNS (Google/Cloudflare) bilan bir marta qayta urinamiz.
    const srvIssue =
      /querySrv|ESERVFAIL|EREFUSED|ENOTFOUND|ETIMEOUT/i.test(String(err.message)) &&
      env.MONGODB_URI.startsWith("mongodb+srv://");
    if (!srvIssue) {
      console.error("MongoDB ulanishda xato:", err.message);
      process.exit(1);
    }
    console.warn("DNS SRV xatosi — 8.8.8.8/1.1.1.1 DNS bilan qayta urinilmoqda...");
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
    try {
      await mongoose.connect(env.MONGODB_URI);
    } catch (err2) {
      console.error("MongoDB ulanishda xato (DNS fallback bilan ham):", err2.message);
      process.exit(1);
    }
  }

  console.log("✓ MongoDB ulandi");

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB xatosi:", err);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB uzildi");
  });
}
