const { Telegraf } = require('telegraf');

// Токен бота (замените на свой)
const BOT_TOKEN = 'ВАШ_ТОКЕН_ОТ_BOTFATHER';

const bot = new Telegraf(BOT_TOKEN);

// Ваш прокси
const PROXY_LINK = "https://t.me/proxy?server=4.180.183.240&port=443&secret=759773b1a20c258fbc4dde470bc0460e";

// Команда /start
bot.start((ctx) => {
    ctx.replyWithHTML(
        `🔐 <b>VPN Proxy Bot</b>\n\n` +
        `Обход блокировок Telegram одним нажатием.\n\n` +
        `🛡️ Ваш прокси готов к подключению:\n` +
        `<code>4.180.183.240:443</code>\n\n` +
        `👇 Нажмите кнопку ниже, чтобы включить обход`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔓 ВКЛЮЧИТЬ ОБХОД", url: PROXY_LINK }],
                    [{ text: "📱 Открыть Mini App", web_app: { url: "https://ВАШ_username.github.io/ВАШ_репозиторий" } }]
                ]
            }
        }
    );
});

// Команда /proxy
bot.command('proxy', (ctx) => {
    ctx.replyWithHTML(
        `🔗 <b>Ваша ссылка для подключения:</b>\n\n` +
        `<code>${PROXY_LINK}</code>\n\n` +
        `Нажмите на ссылку → подтвердите подключение → Telegram разблокирован!`
    );
});

// Запуск бота
bot.launch().then(() => {
    console.log('✅ Бот запущен!');
});

// Остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));