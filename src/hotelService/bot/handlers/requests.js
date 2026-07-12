const Request = require("../../models/Request");
const Staff = require("../../models/Staff");
const Hotel = require("../../models/Hotel");
const { emit } = require("../../socket");
const { getMsg } = require("../messages");

const setupRequestHandlers = (bot) => {
  // Buyurtmani qabul qilish
  bot.action(/^accept_(.+)$/, async (ctx) => {
    const requestId = ctx.match[1];
    const telegramId = ctx.from.id;

    try {
      // ── BIRIKTIRILGANLIK TEKSHIRUVI (kategoriya bo'yicha) ──────────────
      // Guruhda tugma hammaga ko'rinadi, lekin faqat shu XIZMATGA biriktirilgan
      // faol xodim qabul qila oladi. Boshqalarga ogohlantirish chiqadi.
      const reqDoc = await Request.findById(requestId).select("service_id hotel_id status");
      if (!reqDoc) { await ctx.answerCbQuery("❌"); return; }

      const hotel = await Hotel.findOne({ hotel_id: reqDoc.hotel_id });
      const m = getMsg(hotel?.language);

      const staff = await Staff.findOne({
        telegram_id: telegramId,
        hotel_id: reqDoc.hotel_id,
        status: "active",
      });
      const isAssigned = staff?.service_ids?.some(
        (id) => id.toString() === reqDoc.service_id.toString()
      );
      if (!isAssigned) {
        // show_alert — ekran o'rtasida modal ogohlantirish (guruhda sezilarli)
        await ctx.answerCbQuery(m.notAssigned, { show_alert: true });
        return;
      }

      // Atomic update — birinchi bosgan yutadi
      const request = await Request.findOneAndUpdate(
        { _id: requestId, status: "pending" },
        { status: "accepted", accepted_by: telegramId, accepted_at: new Date() },
        { new: true }
      ).populate("service_id", "name icon");

      if (!request) {
        // Boshqa xodim oldinroq bosdi
        await ctx.answerCbQuery(m.alreadyTaken);
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
        return;
      }

      // Qabul qilgan xodim xabarini yangilash — GURUHDA kim olgani ham
      // darhol ko'rinishi uchun ismini qo'shamiz.
      const acceptorName = staff?.full_name || ctx.from.first_name || "Xodim";
      await ctx.editMessageText(
        m.accepted(request.room_number, request.service_id?.name || "") +
          `\n👤 ${acceptorName}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: m.doneBtn, callback_data: `complete_${requestId}` },
            ]],
          },
        }
      );

      // Qolgan chatlardagi xabarlarni yangilash:
      //   • GURUH — "X qabul qildi" + "Bajarildi" tugmasi QOLADI (tugma faqat
      //     qabul qilgan odamga ishlaydi — boshqa bossa notYourRequest chiqadi)
      //   • qabul qilganning shaxsiy chati — accepted matni + "Bajarildi" tugmasi
      //     (guruhdan qabul qilgan bo'lsa ham shaxsiyda tugmasi bo'lsin)
      //   • boshqa xodimlar — "X qabul qildi", tugmasiz
      const staffName = staff?.full_name || "Xodim";
      const clickedChatId = ctx.chat?.id;
      const doneKeyboard = {
        inline_keyboard: [[{ text: m.doneBtn, callback_data: `complete_${requestId}` }]],
      };
      for (const [idStr, msgId] of request.msg_ids.entries()) {
        const chatId = parseInt(idStr);
        if (chatId === clickedChatId) continue; // bosilgan xabar allaqachon yangilandi
        const isGroupChat = chatId < 0;
        const isAcceptorPrivate = chatId === telegramId;
        try {
          await bot.telegram.editMessageText(
            chatId, msgId, null,
            isAcceptorPrivate
              ? m.accepted(request.room_number, request.service_id?.name || "") + `\n👤 ${staffName}`
              : m.takenByOther(staffName),
            {
              parse_mode: "HTML",
              reply_markup: (isGroupChat || isAcceptorPrivate)
                ? doneKeyboard
                : { inline_keyboard: [] },
            }
          );
        } catch (_) {}
      }

      emit.requestAccepted(request.hotel_id, {
        request: request.toObject(),
        staffName,
      });

      await ctx.answerCbQuery();
    } catch (err) {
      console.error("Accept error:", err.message);
      await ctx.answerCbQuery("Xatolik yuz berdi");
    }
  });

  // Bajarildi
  bot.action(/^complete_(.+)$/, async (ctx) => {
    const requestId = ctx.match[1];
    const telegramId = ctx.from.id;

    try {
      const request = await Request.findOneAndUpdate(
        { _id: requestId, status: "accepted", accepted_by: telegramId },
        { status: "completed", completed_at: new Date() },
        { new: true }
      ).populate("service_id", "name icon");

      if (!request) {
        const staff = await Staff.findOne({ telegram_id: telegramId });
        const hotel = await Hotel.findOne({ hotel_id: staff?.hotel_id });
        await ctx.answerCbQuery(getMsg(hotel?.language).notYourRequest);
        return;
      }

      const hotel = await Hotel.findOne({ hotel_id: request.hotel_id });
      const m = getMsg(hotel?.language);

      await ctx.editMessageText(m.completed, { reply_markup: { inline_keyboard: [] } });

      // Qolgan BARCHA chatlardagi xabarlarni ham yangilaymiz (guruh + boshqa
      // xodimlar) — hamma ish bajarilganini darhol ko'rsin.
      const staff = await Staff.findOne({ telegram_id: telegramId });
      const staffName = staff?.full_name || ctx.from.first_name || "Xodim";
      const doneText = m.completedByOther(
        request.room_number,
        request.service_id?.name || "",
        staffName
      );
      const clickedChatId = ctx.chat?.id;
      for (const [idStr, msgId] of request.msg_ids.entries()) {
        const chatId = parseInt(idStr);
        if (chatId === clickedChatId) continue; // bosilgan xabar allaqachon yangilandi
        try {
          await bot.telegram.editMessageText(
            chatId, msgId, null, doneText,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
          );
        } catch (_) {}
      }

      emit.requestCompleted(request.hotel_id, { request: request.toObject() });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error("Complete error:", err.message);
      await ctx.answerCbQuery("Xatolik yuz berdi");
    }
  });
};

module.exports = { setupRequestHandlers };
