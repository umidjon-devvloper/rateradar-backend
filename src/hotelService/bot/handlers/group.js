const Hotel = require("../../models/Hotel");

// ─── TELEGRAM GURUH INTEGRATSIYASI ────────────────────────────────────────────
// Admin botni guruhga qo'shadi → guruhda `/ulash inv_XXXX` yuboradi
// (inv kod — panel Sozlamalar sahifasidagi mehmonxona taklif kodi).
// Shundan keyin barcha mehmon buyurtmalari shu guruhga ham tushadi.
// `/uzish` — guruhni mehmonxonadan uzadi.
//
// MUHIM: bu handlerlar setupRegistration'dan OLDIN ulanadi, chunki u yerdagi
// bot.on("text") next() chaqirmaydi va keyin ro'yxatdan o'tgan komandalarni yutadi.

const isGroup = (ctx) =>
  ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

// Guruhda buyruq yuborgan odam GURUH ADMINI (creator/administrator) mi?
// Telegram'dan real vaqtda so'raymiz — faqat admin ulash/uzish qila oladi.
const isChatAdmin = async (ctx) => {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member?.status === "creator" || member?.status === "administrator";
  } catch (_) {
    return false;
  }
};

const setupGroupHandlers = (bot) => {
  // GURUHDA: guruhni mehmonxonaga ulaydi (buyurtmalar guruhga tushadi).
  // SHAXSIY chatda: yuborgan odamni ADMIN sifatida ulaydi — unga barcha
  // buyurtmalar + nazorat ogohlantirishlari (olinmadi/bajarilmadi) keladi.
  bot.command("ulash", async (ctx) => {
    const code = (ctx.message.text.split(/\s+/)[1] || "").trim();
    if (!code) {
      return ctx.reply(
        "ℹ️ Foydalanish: /ulash inv_XXXXXX\n\nKodni panel → Sozlamalar sahifasidan olasiz."
      );
    }

    const hotel = await Hotel.findOne({ invite_code: code });
    if (!hotel) {
      return ctx.reply("❌ Kod topilmadi. Panel → Sozlamalar'dagi taklif kodini tekshiring.");
    }

    if (isGroup(ctx)) {
      // FAQAT GURUH ADMINI ulashi mumkin.
      if (!(await isChatAdmin(ctx))) {
        return ctx.reply("⛔ Faqat guruh administratori mehmonxonani ulashi mumkin.");
      }
      hotel.group_chat_id = ctx.chat.id;
      hotel.group_title = ctx.chat.title || "";
      await hotel.save();
      return ctx.reply(
        `✅ "${hotel.hotel_name}" shu guruhga ulandi!\n\n` +
        `Endi mehmonlarning barcha buyurtmalari shu guruhga tushadi. ` +
        `Uzish uchun: faqat admin /uzish yozadi.`
      );
    }

    // Shaxsiy chat — ADMIN ulanishi
    const adminName =
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
      ctx.from.username || "Admin";
    hotel.admin_telegram_id = ctx.from.id;
    hotel.admin_name = adminName;
    await hotel.save();
    return ctx.reply(
      `👑 Siz "${hotel.hotel_name}" uchun ADMIN sifatida ulandingiz!\n\n` +
      `Endi sizga keladi:\n` +
      `• barcha yangi buyurtmalar va ularning holati\n` +
      `• ❗ 5 daqiqada hech kim olmagan buyurtmalar\n` +
      `• ⚠️ 2.5 soatda bajarilmagan ishlar (kim olgani bilan)\n\n` +
      `Uzish uchun: /uzish`
    );
  });

  bot.command("uzish", async (ctx) => {
    if (isGroup(ctx)) {
      const hotel = await Hotel.findOne({ group_chat_id: ctx.chat.id });
      if (!hotel) return ctx.reply("ℹ️ Bu guruhga hech qanday mehmonxona ulanmagan.");
      // FAQAT admin uzishi mumkin — oddiy a'zo /uzish yozsa uzilMAYDI.
      // Admin = Telegram guruh admini YOKI shu mehmonxonaning ulangan admini.
      const allowed =
        (await isChatAdmin(ctx)) ||
        (hotel.admin_telegram_id && ctx.from.id === hotel.admin_telegram_id);
      if (!allowed) {
        return ctx.reply("⛔ Faqat guruh administratori guruhni uzishi mumkin.");
      }
      hotel.group_chat_id = null;
      hotel.group_title = "";
      await hotel.save();
      return ctx.reply(`✅ "${hotel.hotel_name}" guruhdan uzildi.`);
    }

    // Shaxsiy chat — admin uzilishi
    const hotel = await Hotel.findOne({ admin_telegram_id: ctx.from.id });
    if (!hotel) return ctx.reply("ℹ️ Siz hech qaysi mehmonxonaga admin sifatida ulanmagansiz.");
    hotel.admin_telegram_id = null;
    hotel.admin_name = "";
    await hotel.save();
    return ctx.reply(`✅ "${hotel.hotel_name}" admin ulanishi uzildi.`);
  });

  // Bot guruhga qo'shilganda — qanday ulashni tushuntiramiz.
  // Guruhdan chiqarilganda — bog'lamani tozalaymiz.
  bot.on("my_chat_member", async (ctx) => {
    const upd = ctx.update.my_chat_member;
    const status = upd.new_chat_member?.status;
    const chat = upd.chat;
    if (!(chat?.type === "group" || chat?.type === "supergroup")) return;

    if (status === "member" || status === "administrator") {
      // Allaqachon ulangan bo'lsa qayta yo'riqnoma bermaymiz
      const linked = await Hotel.findOne({ group_chat_id: chat.id });
      if (linked) return;
      try {
        await ctx.telegram.sendMessage(
          chat.id,
          "👋 Salom! Men mehmonxona xizmat botiman.\n\n" +
          "Buyurtmalar shu guruhga tushishi uchun mehmonxonani ulang:\n" +
          "/ulash inv_XXXXXX\n\n" +
          "Kodni panel → Sozlamalar sahifasidan olasiz."
        );
      } catch (_) {}
    } else if (status === "left" || status === "kicked") {
      await Hotel.updateOne(
        { group_chat_id: chat.id },
        { $set: { group_chat_id: null, group_title: "" } }
      ).catch(() => {});
    }
  });
};

module.exports = { setupGroupHandlers };
