const { nanoid } = require("nanoid");
const TvDevice = require("../models/TvDevice");
const Hotel = require("../models/Hotel");
const Service = require("../models/Service");

const PAIR_CODE_TTL_MS = 15 * 60 * 1000; // kod 15 daqiqa yashaydi
const ONLINE_WINDOW_MS = 6 * 60 * 1000;  // 6 daqiqada ko'ringan = online

// 6 xonali unikal juftlash kodi (faol unpaired qurilmalar orasida)
async function generatePairCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const clash = await TvDevice.findOne({
      pair_code: code,
      status: "unpaired",
      pair_code_expires: { $gt: new Date() },
    }).select("_id");
    if (!clash) return code;
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Obuna faolmi — TV kontenti shunga qarab ochiladi/yopiladi
function subscriptionOk(hotel) {
  const sub = hotel?.subscription || {};
  if (!sub.active) return false;
  if (sub.expires_at && new Date(sub.expires_at).getTime() < Date.now()) return false;
  return true;
}

// ─── TV (ommaviy) ─────────────────────────────────────────────────────────────

// POST /tv/register — TV birinchi ochilganda: qurilma yaratiladi + kod chiqadi
const registerDevice = async (req, res) => {
  try {
    const device = await TvDevice.create({
      device_key: nanoid(32),
      pair_code: await generatePairCode(),
      pair_code_expires: new Date(Date.now() + PAIR_CODE_TTL_MS),
    });
    res.status(201).json({
      device_id: device._id,
      device_key: device.device_key,
      pair_code: device.pair_code,
    });
  } catch (err) {
    console.error("tv registerDevice:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// GET /tv/status/:id?key= — TV har 5 soniyada so'raydi (pair kutish)
const deviceStatus = async (req, res) => {
  try {
    const device = await TvDevice.findOne({
      _id: req.params.id,
      device_key: req.query.key,
    });
    if (!device) return res.status(404).json({ message: "Qurilma topilmadi" });

    if (device.status === "active") {
      return res.json({ status: "active", token: device.token });
    }
    if (device.status === "revoked") {
      return res.json({ status: "revoked" });
    }

    // Kod eskirgan bo'lsa — yangisini beramiz (TV ekranida almashadi)
    if (!device.pair_code_expires || device.pair_code_expires.getTime() < Date.now()) {
      device.pair_code = await generatePairCode();
      device.pair_code_expires = new Date(Date.now() + PAIR_CODE_TTL_MS);
      await device.save();
    }
    res.json({ status: "unpaired", pair_code: device.pair_code });
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

// GET /tv/content — TV vitrina ma'lumoti (token bilan). Heartbeat ham shu.
const tvContent = async (req, res) => {
  try {
    const token = req.headers["x-tv-token"] || req.query.token;
    if (!token) return res.status(401).json({ message: "Token yo'q" });

    const device = await TvDevice.findOne({ token, status: "active" });
    if (!device) return res.status(401).json({ message: "Qurilma uzilgan" });

    device.last_seen = new Date();
    await device.save();

    const hotel = await Hotel.findOne({ hotel_id: device.hotel_id });
    if (!hotel) return res.status(401).json({ message: "Mehmonxona topilmadi" });

    // OBUNA TUGAGAN — kontent yopiladi, TV lock ekran ko'rsatadi.
    if (!subscriptionOk(hotel)) {
      return res.json({
        locked: true,
        reason: "subscription",
        hotel_name: hotel.hotel_name,
      });
    }

    const services = await Service.find({ hotel_id: hotel.hotel_id, is_active: true })
      .select("name icon items")
      .lean();

    res.json({
      locked: false,
      hotel_id: hotel.hotel_id,
      hotel_name: hotel.hotel_name,
      language: hotel.language,
      branding: hotel.branding || {},
      room_number: device.room_number || "",
      device_name: device.name || "TV",
      services: services.map((s) => ({
        name: s.name,
        icon: s.icon || "🛎",
        items_count: (s.items || []).filter((i) => i.is_active !== false).length,
      })),
    });
  } catch (err) {
    console.error("tvContent:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// ─── ADMIN (hotelAuth bilan) ──────────────────────────────────────────────────

// POST /hotel/tv-devices/pair { code, room_number?, name? }
const pairDevice = async (req, res) => {
  try {
    const code = String(req.body.code || "").replace(/\D/g, "");
    if (code.length !== 6) return res.status(400).json({ message: "6 xonali kod kiriting" });

    const device = await TvDevice.findOne({
      pair_code: code,
      status: "unpaired",
      pair_code_expires: { $gt: new Date() },
    });
    if (!device) {
      return res.status(404).json({ message: "Kod topilmadi yoki eskirgan — TV ekranidagi yangi kodni kiriting" });
    }

    device.hotel_id = req.hotelId;
    device.status = "active";
    device.token = nanoid(40);
    device.pair_code = null;
    device.pair_code_expires = null;
    device.paired_at = new Date();
    if (req.body.room_number !== undefined) device.room_number = String(req.body.room_number).trim();
    if (req.body.name) device.name = String(req.body.name).trim();
    await device.save();

    res.json({ message: "Ulandi", device: publicDevice(device) });
  } catch (err) {
    console.error("pairDevice:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// GET /hotel/tv-devices — ro'yxat (online holati bilan)
const listDevices = async (req, res) => {
  try {
    const devices = await TvDevice.find({ hotel_id: req.hotelId, status: "active" })
      .sort({ paired_at: -1 })
      .lean();
    res.json(devices.map((d) => publicDevice(d)));
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

// PUT /hotel/tv-devices/:id { name?, room_number? }
const updateDevice = async (req, res) => {
  try {
    const set = {};
    if (req.body.name !== undefined) set.name = String(req.body.name).trim() || "TV";
    if (req.body.room_number !== undefined) set.room_number = String(req.body.room_number).trim();
    const device = await TvDevice.findOneAndUpdate(
      { _id: req.params.id, hotel_id: req.hotelId, status: "active" },
      { $set: set },
      { new: true },
    );
    if (!device) return res.status(404).json({ message: "Topilmadi" });
    res.json(publicDevice(device));
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

// DELETE /hotel/tv-devices/:id — uzish (token bekor, TV aktivatsiyaga qaytadi)
const revokeDevice = async (req, res) => {
  try {
    const device = await TvDevice.findOneAndUpdate(
      { _id: req.params.id, hotel_id: req.hotelId },
      { $set: { status: "revoked", token: null } },
      { new: true },
    );
    if (!device) return res.status(404).json({ message: "Topilmadi" });
    res.json({ message: "Uzildi" });
  } catch (err) {
    res.status(500).json({ message: "Server xatosi" });
  }
};

function publicDevice(d) {
  const lastSeen = d.last_seen ? new Date(d.last_seen).getTime() : 0;
  return {
    _id: d._id,
    name: d.name,
    room_number: d.room_number,
    paired_at: d.paired_at,
    last_seen: d.last_seen,
    online: lastSeen > Date.now() - ONLINE_WINDOW_MS,
  };
}

module.exports = {
  registerDevice, deviceStatus, tvContent,
  pairDevice, listDevices, updateDevice, revokeDevice,
};
