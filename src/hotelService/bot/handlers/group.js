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

const setupGroupHandlers = (bot) => {
  bot.command("ulash", async (ctx, next) => {
    if (!isGroup(ctx)) return next();

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

    hotel.group_chat_id = ctx.chat.id;
    hotel.group_title = ctx.chat.title || "";
    await hotel.save();

    return ctx.reply(
      `✅ "${hotel.hotel_name}" shu guruhga ulandi!\n\n` +
      `Endi mehmonlarning barcha buyurtmalari shu guruhga tushadi. ` +
      `Uzish uchun: /uzish`
    );
  });

  bot.command("uzish", async (ctx, next) => {
    if (!isGroup(ctx)) return next();

    const hotel = await Hotel.findOne({ group_chat_id: ctx.chat.id });
    if (!hotel) return ctx.reply("ℹ️ Bu guruhga hech qanday mehmonxona ulanmagan.");

    hotel.group_chat_id = null;
    hotel.group_title = "";
    await hotel.save();

    return ctx.reply(`✅ "${hotel.hotel_name}" guruhdan uzildi.`);
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
