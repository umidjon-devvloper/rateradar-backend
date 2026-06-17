const { Markup } = require("telegraf");
const Staff   = require("../../models/Staff");
const Hotel   = require("../../models/Hotel");
const Service = require("../../models/Service");
const { emit }   = require("../../socket");
const { getMsg } = require("../messages");

// In-memory holat
// { telegram_id: { step, hotel_id, service_id, hotel_lang } }
const regState = new Map();

const setupRegistration = (bot) => {
  bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const param = ctx.startPayload || "";

    // ── Service-specific link (svc_XXXX) ──────────────────────────────
    if (param.startsWith("svc_")) {
      const existing = await Staff.findOne({ telegram_id: telegramId });

      // Allaqachon faol xodim
      if (existing?.status === "active") {
        const hotel = await Hotel.findOne({ hotel_id: existing.hotel_id });
        const m = getMsg(hotel?.language);
        return ctx.reply(m.alreadyActive);
      }

      const service = await Service.findOne({ invite_code: param });
      if (!service) {
        return ctx.reply("❌ Havola topilmadi yoki muddati o'tgan.");
      }

      const hotel = await Hotel.findOne({ hotel_id: service.hotel_id });
      const m = getMsg(hotel?.language);

      regState.set(telegramId, {
        step:       "awaiting_phone_svc",
        hotel_id:   service.hotel_id,
        service_id: service._id,
        hotel_lang: hotel?.language || "en",
      });

      return ctx.reply(
        m.enterPhone,
        Markup.keyboard([[Markup.button.contactRequest("📱")]])
          .resize().oneTime()
      );
    }

    // ── Noto'g'ri yoki bo'sh param ────────────────────────────────────
    return ctx.reply(
      "❌ Noto'g'ri havola.\n\nXizmat bo'yicha ro'yxatdan o'tish uchun admindan to'g'ri havolani oling."
    );
  });

  // Matn xabari — faqat holatga bog'liq
  bot.on("text", async (ctx) => {
    const telegramId = ctx.from.id;
    const state = regState.get(telegramId);
    if (!state) return;

    const m = getMsg(state.hotel_lang);

    // Telefon kutilayotgan bo'lsa — matn o'rniga contact so'raymiz
    return ctx.reply(
      m.sendPhoneAgain,
      Markup.keyboard([[Markup.button.contactRequest("📱")]]).resize().oneTime()
    );
  });

  // Telefon raqam (contact)
  bot.on("contact", async (ctx) => {
    const telegramId = ctx.from.id;
    const state = regState.get(telegramId);

    if (!state || state.step !== "awaiting_phone_svc") return;

    if (ctx.message.contact.user_id !== telegramId) {
      return ctx.reply(getMsg(state.hotel_lang).ownContactRequired);
    }

    const m = getMsg(state.hotel_lang);

    // Ism: Telegram profilidan olish (so'ralmasdan)
    const firstName = ctx.from.first_name || "";
    const lastName  = ctx.from.last_name  || "";
    const fullName  =
      [firstName, lastName].filter(Boolean).join(" ") ||
      ctx.from.username ||
      `Staff_${telegramId}`;

    try {
      const existing = await Staff.findOne({ telegram_id: telegramId });

      if (existing) {
        // Allaqachon bor — xizmatni qo'shib qo'yamiz
        if (!existing.service_ids.includes(state.service_id)) {
          await Staff.findByIdAndUpdate(existing._id, {
            $addToSet: { service_ids: state.service_id },
            status: "active",
            activated_at: existing.activated_at || new Date(),
          });
        }
        regState.delete(telegramId);
        return ctx.reply(m.activated, Markup.removeKeyboard());
      }

      // Yangi xodim — to'g'ridan active
      const newStaff = await Staff.create({
        hotel_id:          state.hotel_id,
        telegram_id:       telegramId,
        telegram_username: ctx.from.username || null,
        full_name:         fullName,
        phone:             ctx.message.contact.phone_number,
        status:            "active",
        service_ids:       [state.service_id],
        activated_at:      new Date(),
      });

      regState.delete(telegramId);

      // Admin panelga socket xabar
      emit.newStaffRegistered(state.hotel_id, { staff: newStaff.toObject() });

      return ctx.reply(m.activated, Markup.removeKeyboard());
    } catch (err) {
      console.error("Registration error:", err.message);
      return ctx.reply(m.error);
    }
  });
};

module.exports = { setupRegistration };
