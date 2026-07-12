const { Markup } = require("telegraf");
const Hotel   = require("../models/Hotel");
const Service = require("../models/Service");
const Staff   = require("../models/Staff");
const Request = require("../models/Request");
const Review  = require("../models/Review");
const { getBot }        = require("../bot");
const { emit }          = require("../socket");
const { translate }     = require("../services/translationService");
const { getMsg }        = require("../bot/messages");

// GET /api/guest/hotel/:hotelId
// Mehmon QR skanlaydi → hotel info + xizmatlar
const getHotelInfo = async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ hotel_id: req.params.hotelId });

    if (!hotel) {
      return res.status(404).json({ message: "Mehmonxona topilmadi" });
    }

    // Obuna tekshiruvi hozircha o'chirilgan — xizmat har doim faol.

    const services = await Service.find({
      hotel_id: hotel.hotel_id,
      is_active: true,
    }).lean();

    res.json({
      hotel_id:   hotel.hotel_id,
      hotel_name: hotel.hotel_name,
      branding:   hotel.branding || {},
      services,
    });
  } catch (err) {
    console.error("getHotelInfo:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// GET /api/guest/services/:hotelId?lang=en
// Xizmatlarni mehmon tiliga tarjima qilib qaytarish + keshga saqlash
const getTranslatedServices = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const guestLang = req.query.lang || "en";

    const hotel = await Hotel.findOne({ hotel_id: hotelId });
    if (!hotel) return res.status(404).json({ message: "Topilmadi" });

    const services = await Service.find({ hotel_id: hotelId, is_active: true });
    const hotelLang = hotel.language;

    const translated = await Promise.all(
      services.map(async (svc) => {
        const svcObj = svc.toObject();

        // Xizmat nomi tarjimasi
        let translatedName = svc.translations?.get?.(guestLang);
        if (!translatedName) {
          translatedName = await translate(svc.name, hotelLang, guestLang);
          svc.translations.set(guestLang, translatedName);
          await svc.save();
        }

        // Sub-options tarjimasi
        const translatedSubOptions = await Promise.all(
          (svcObj.sub_options || []).map(async (opt) => {
            let tName = opt.translations?.[guestLang];
            if (!tName) {
              tName = await translate(opt.name, hotelLang, guestLang);
            }
            return { ...opt, translated_name: tName };
          })
        );

        // Item'lar (menyu) tarjimasi — faqat faollari mehmonga ko'rinadi
        const translatedItems = await Promise.all(
          (svcObj.items || []).filter((it) => it.is_active !== false).map(async (it) => {
            let tName = it.translations?.[guestLang];
            if (!tName) {
              tName = await translate(it.name, hotelLang, guestLang);
            }
            return { ...it, translated_name: tName };
          })
        );

        return {
          ...svcObj,
          translated_name: translatedName,
          sub_options: translatedSubOptions,
          items: translatedItems,
        };
      })
    );

    res.json(translated);
  } catch (err) {
    console.error("getTranslatedServices:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// POST /api/guest/requests
// Yangi buyurtma: tarjima qilish + xodimlarga yuborish
const createRequest = async (req, res) => {
  try {
    const {
      hotel_id, room_number, service_id,
      sub_option, description, guest_lang,
    } = req.body;

    if (!hotel_id || !room_number || !service_id) {
      return res.status(400).json({ message: "hotel_id, room_number, service_id majburiy" });
    }

    const hotel = await Hotel.findOne({ hotel_id });
    if (!hotel) return res.status(404).json({ message: "Mehmonxona topilmadi" });

    // Obuna tekshiruvi hozircha o'chirilgan — xizmat har doim faol.

    const service = await Service.findOne({ _id: service_id, hotel_id, is_active: true });
    if (!service) return res.status(404).json({ message: "Xizmat topilmadi" });

    const hotelLang = hotel.language;
    const lang = guest_lang || "en";

    // Mehmon tilidan mehmonxona tiliga tarjima
    const [descTranslated, subOptTranslated] = await Promise.all([
      description ? translate(description, lang, hotelLang) : Promise.resolve(null),
      sub_option  ? translate(sub_option,  lang, hotelLang) : Promise.resolve(null),
    ]);

    // Buyurtma yaratish
    const request = await Request.create({
      hotel_id,
      room_number: room_number.toString().trim(),
      service_id,
      sub_option:             sub_option  || null,
      sub_option_translated:  subOptTranslated || null,
      description:            description || null,
      description_translated: descTranslated  || null,
      guest_lang: lang,
    });

    // Xodimlarga bot xabari yuborish
    await sendToStaff(request, service, hotel);

    // Admin panelga socket xabar
    const populated = await Request.findById(request._id)
      .populate("service_id", "name icon color")
      .lean();
    emit.newRequest(hotel_id, { request: populated });

    res.status(201).json({ message: "Buyurtma yuborildi" });
  } catch (err) {
    console.error("createRequest:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// POST /api/guest/reviews
// Mehmon mehmonxona haqida sharh qoldiradi (yulduz + izoh)
const createReview = async (req, res) => {
  try {
    const { hotel_id, room_number, rating, comment, guest_lang } = req.body;

    const stars = parseInt(rating, 10);
    if (!hotel_id || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ message: "hotel_id va rating (1-5) majburiy" });
    }

    const hotel = await Hotel.findOne({ hotel_id });
    if (!hotel) return res.status(404).json({ message: "Mehmonxona topilmadi" });

    const lang = guest_lang || "en";
    const hotelLang = hotel.language;

    // Izohni mehmonxona tiliga tarjima qilamiz (panelda o'qishlari uchun)
    const commentTranslated = comment
      ? await translate(comment, lang, hotelLang)
      : null;

    const review = await Review.create({
      hotel_id,
      room_number: room_number ? room_number.toString().trim() : null,
      rating: stars,
      comment: comment || null,
      comment_translated: commentTranslated,
      guest_lang: lang,
    });

    // Admin panelga jonli xabar
    emit.newReview(hotel_id, { review: review.toObject() });

    res.status(201).json({ message: "Sharh yuborildi" });
  } catch (err) {
    console.error("createReview:", err.message);
    res.status(500).json({ message: "Server xatosi" });
  }
};

// Xodimlarga bot orqali xabar yuborish
const sendToStaff = async (request, service, hotel) => {
  try {
    const bot = getBot();
    const staffList = await Staff.find({
      hotel_id: hotel.hotel_id,
      status: "active",
      service_ids: service._id,
    });

    // Xodim ham, ulangan guruh ham bo'lmasa — yuboradigan joy yo'q.
    if (staffList.length === 0 && !hotel.group_chat_id) return;

    const m = getMsg(hotel.language);
    const time = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit",
    });

    const text = m.newRequest(
      request.room_number,
      service.name,
      request.sub_option_translated || request.sub_option,
      request.description_translated || request.description,
      time
    );

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(m.acceptBtn, `accept_${request._id}`)],
    ]);

    const msgIds = {};
    for (const staff of staffList) {
      try {
        const sent = await bot.telegram.sendMessage(staff.telegram_id, text, keyboard);
        msgIds[staff.telegram_id.toString()] = sent.message_id;
      } catch (err) {
        console.error(`Staff ${staff.telegram_id} ga xabar yuborilmadi:`, err.message);
      }
    }

    // Ulangan Telegram GURUHga ham yuboramiz (bot guruhda /ulash bilan
    // bog'langan bo'lsa). Guruhdagi xabar ham accept tugmasi bilan keladi —
    // kim birinchi bossa, o'sha oladi; qolgan xabarlar avtomatik yangilanadi.
    if (hotel.group_chat_id) {
      try {
        const sent = await bot.telegram.sendMessage(hotel.group_chat_id, text, keyboard);
        msgIds[hotel.group_chat_id.toString()] = sent.message_id;
      } catch (err) {
        console.error(`Guruh ${hotel.group_chat_id} ga xabar yuborilmadi:`, err.message);
        // Bot guruhdan chiqarilgan bo'lsa — bog'lamani tozalaymiz
        if (/chat not found|kicked|blocked/i.test(err.message)) {
          await Hotel.updateOne(
            { hotel_id: hotel.hotel_id },
            { $set: { group_chat_id: null, group_title: "" } }
          ).catch(() => {});
        }
      }
    }

    await Request.findByIdAndUpdate(request._id, { msg_ids: msgIds });
  } catch (err) {
    console.error("sendToStaff:", err.message);
  }
};

module.exports = { getHotelInfo, getTranslatedServices, createRequest, createReview };
