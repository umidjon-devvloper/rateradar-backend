const { Telegraf } = require("telegraf");
const { setupRegistration } = require("./handlers/registration");
const { setupRequestHandlers } = require("./handlers/requests");

let bot = null;

const initBot = () => {
  if (!process.env.BOT_TOKEN) {
    console.warn("⚠️  BOT_TOKEN yo'q — bot ishga tushmadi");
    return;
  }

  bot = new Telegraf(process.env.BOT_TOKEN);

  setupRegistration(bot);
  setupRequestHandlers(bot);

  bot.catch((err, ctx) => {
    console.error(`Bot xatosi [${ctx.updateType}]:`, err.message);
  });

  bot.launch();

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  console.log("✅ Telegram bot ishga tushdi");
};

const getBot = () => {
  if (!bot) throw new Error("Bot initialize qilinmagan");
  return bot;
};

module.exports = { initBot, getBot };
