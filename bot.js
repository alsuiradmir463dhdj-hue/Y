const { Telegraf } = require('telegraf');

// Токен бота (берётся из переменных окружения)
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ Ошибка: BOT_TOKEN не задан!');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Ваш прокси (рабочий)
const PROXY_LINK = "https://t.me/proxy?server=185.239.239.167&port=443&secret=eeaaf0d30441bab41f60acae779df0c";

// Ссылка на мини-приложение (замените на вашу)
const WEBAPP_URL = "https://ваш-username.github.io/Y/";

// Команда /start
bot.start((ctx) => {
    ctx.replyWithHTML(`
🕊️ <b>Seagull VPN</b> 🕊️

🌸 <i>Обход блокировок Telegram</i> 🌸

✨ <b>Нажми кнопку ниже</b> — и Telegram будет работать без ограничений!

📡 <b>Сервер:</b> <code>185.239.239.167:443</code>
🔐 <b>Протокол:</b> MTProto 2.0

⚡ <i>「 繋がりたい、ただそれだけ 」</i>
    `, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🕊️ ОТКРЫТЬ ПРОКСИ", url: PROXY_LINK }],
                [{ text: "✨ ОТКРЫТЬ MINI APP", web_app: { url: WEBAPP_URL } }],
                [{ text: "📢 НАШ КАНАЛ", url: "https://t.me/ваш_канал" }]
            ]
        }
    });
});

// Команда /proxy
bot.command('proxy', (ctx) => {
    ctx.replyWithHTML(`
🔗 <b>Ваша ссылка для подключения:</b>

<code>${PROXY_LINK}</code>

🌸 Нажми на ссылку → подтверди подключение → Telegram разблокирован!
    `);
});

// Команда /help
bot.command('help', (ctx) => {
    ctx.replyWithHTML(`
🕊️ <b>Как пользоваться:</b>

1️⃣ Нажми кнопку <b>"ОТКРЫТЬ ПРОКСИ"</b>
2️⃣ Подтверди подключение в окне Telegram
3️⃣ Всё! Telegram работает без блокировок ✨

❓ <i>Вопросы?</i> Пиши в наш канал!
    `);
});

// Запуск бота
bot.launch().then(() => {
    console.log('✅ Seagull VPN бот запущен!');
    console.log('📡 Прокси: 185.239.239.167:443');
});

// Остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));