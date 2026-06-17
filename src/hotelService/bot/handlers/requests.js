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
      // Atomic update — birinchi bosgan yutadi
      const request = await Request.findOneAndUpdate(
        { _id: requestId, status: "pending" },
        { status: "accepted", accepted_by: telegramId, accepted_at: new Date() },
        { new: true }
      ).populate("service_id", "name icon");

      if (!request) {
        // Boshqa xodim oldinroq bosdi
        const staff = await Staff.findOne({ telegram_id: telegramId });
        const hotel = await Hotel.findOne({ hotel_id: staff?.hotel_id });
        const m = getMsg(hotel?.language);
        await ctx.answerCbQuery(m.alreadyTaken);
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
        return;
      }

      const staff = await Staff.findOne({ telegram_id: telegramId });
      const hotel = await Hotel.findOne({ hotel_id: request.hotel_id });
      const m = getMsg(hotel?.language);

      // Qabul qilgan xodim xabarini yangilash
      await ctx.editMessageText(
        m.accepted(request.room_number, request.service_id?.name || ""),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: m.doneBtn, callback_data: `complete_${requestId}` },
            ]],
          },
        }
      );

      // Boshqa xodimlarning xabarlarini yangilash
      const staffName = staff?.full_name || "Xodim";
      for (const [idStr, msgId] of request.msg_ids.entries()) {
        if (parseInt(idStr) !== telegramId) {
          try {
            await bot.telegram.editMessageText(
              parseInt(idStr), msgId, null,
              m.takenByOther(staffName),
              { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
            );
          } catch (_) {}
        }
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
      );

      if (!request) {
        const staff = await Staff.findOne({ telegram_id: telegramId });
        const hotel = await Hotel.findOne({ hotel_id: staff?.hotel_id });
        await ctx.answerCbQuery(getMsg(hotel?.language).notYourRequest);
        return;
      }

      const hotel = await Hotel.findOne({ hotel_id: request.hotel_id });
      const m = getMsg(hotel?.language);

      await ctx.editMessageText(m.completed, { reply_markup: { inline_keyboard: [] } });
      emit.requestCompleted(request.hotel_id, { request: request.toObject() });
      await ctx.answerCbQuery();
    } catch (err) {
      console.error("Complete error:", err.message);
      await ctx.answerCbQuery("Xatolik yuz berdi");
    }
  });
};

module.exports = { setupRequestHandlers };
