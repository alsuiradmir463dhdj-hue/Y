const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ BOT_TOKEN не найден');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище (замени на БД)
const purchases = new Map(); // userId -> { prefix, date, status }
const pendingInvoices = new Map(); // invoiceId -> { userId, prefix }

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API: получить префиксы пользователя
app.get('/api/my-prefixes', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ prefixes: [] });
    
    const userPurchases = [];
    for (const [uid, data] of purchases.entries()) {
        if (uid === userId) {
            userPurchases.push({ prefix: data.prefix, date: data.date });
        }
    }
    res.json({ prefixes: userPurchases });
});

// API: создать инвойс для оплаты звёздами
app.post('/api/create-invoice', async (req, res) => {
    const { prefix, userId, username, firstName } = req.body;
    
    if (!prefix || !userId) {
        return res.json({ error: 'Не хватает данных' });
    }
    
    const invoiceId = Date.now().toString();
    const price = 50; // 50 звёзд
    
    pendingInvoices.set(invoiceId, {
        userId,
        prefix,
        username,
        firstName,
        status: 'pending'
    });
    
    try {
        // Создаём счёт через Telegram Bot API
        const invoice = await bot.createInvoiceLink(
            `Префикс [${prefix}]`,
            `Купить префикс [${prefix}] для ${firstName || username || userId}`,
            `prefix_${invoiceId}`,
            '',
            'XTR', // Telegram Stars
            [{ label: `Префикс [${prefix}]`, amount: price }],
            {
                start_parameter: `prefix_${invoiceId}`,
                provider_token: '', // для XTR не нужен
                need_name: false,
                need_phone_number: false,
                need_email: false
            }
        );
        
        res.json({ invoiceLink: invoice });
    } catch (err) {
        console.error('Ошибка создания инвойса:', err);
        res.json({ error: 'Не удалось создать счёт' });
    }
});

// Анимация печати
const animations = new Map();

async function animateTyping(chatId, messageId, fullText, speed = 100) {
    if (animations.has(chatId)) {
        clearInterval(animations.get(chatId).interval);
    }
    
    let currentText = '';
    let index = 0;
    
    const interval = setInterval(async () => {
        if (index >= fullText.length) {
            clearInterval(interval);
            animations.delete(chatId);
            return;
        }
        
        currentText += fullText[index];
        index++;
        
        try {
            await bot.editMessageText(currentText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML'
            });
        } catch (err) {}
    }, speed);
    
    animations.set(chatId, { interval });
}

// Клавиатура с кнопкой приложения
function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '🚀 Купить префикс', web_app: { url: 'https://your-domain.com' } }],
                [{ text: '📋 Помощь' }, { text: '💰 Мой префикс' }]
            ],
            resize_keyboard: true
        }
    };
}

// Команда /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '', getMainKeyboard());
    const fullText = `👋 Привет, ${msg.from.first_name}!\n\nЯ бот с анимацией печати.\n\nМожешь купить себе префикс за 50 ⭐ Telegram Stars!\n\nНажми кнопку "Купить префикс" ниже.`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

// Команда /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '');
    const fullText = `📋 Команды:\n\n/start - приветствие\n/help - помощь\n/my_prefix - посмотреть префикс\n/prefix - купить префикс\n\n⭐ Префикс = 50 Telegram Stars\nКупить можно через кнопку "Купить префикс"`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

// /my_prefix
bot.onText(/\/my_prefix/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const purchase = purchases.get(userId);
    
    const sentMsg = await bot.sendMessage(chatId, '');
    const fullText = purchase 
        ? `🏷️ Твой префикс: [${purchase.prefix}]\nКуплен: ${new Date(purchase.date).toLocaleDateString()}`
        : `❌ У тебя нет префикса\n\nКупить можно за 50 ⭐ через кнопку "Купить префикс"`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

// /prefix
bot.onText(/\/prefix/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '', getMainKeyboard());
    const fullText = `🏷️ Купить префикс\n\n💰 Цена: 50 ⭐ Telegram Stars\n\nНапиши свой префикс или выбери готовый в приложении.\n\nНажми кнопку "Купить префикс" ниже.`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

// Обработка текста "хочу купить префикс"
bot.onText(/хочу купить префикс/i, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '', getMainKeyboard());
    const fullText = `🏷️ Префикс [Помощник]\n\n💰 Цена: 50 ⭐ Telegram Stars\n\nНажми кнопку "Купить префикс" ниже и выбери свой!`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

// Обработка успешной оплаты через pre_checkout_query
bot.on('pre_checkout_query', async (query) => {
    const invoiceId = query.invoice_payload.replace('prefix_', '');
    const pending = pendingInvoices.get(invoiceId);
    
    if (pending) {
        await bot.answerPreCheckoutQuery(query.id, true);
    } else {
        await bot.answerPreCheckoutQuery(query.id, false, 'Ошибка');
    }
});

// Обработка успешной оплаты
bot.on('successful_payment', async (msg) => {
    const userId = msg.from.id;
    const invoiceId = msg.successful_payment.invoice_payload.replace('prefix_', '');
    const pending = pendingInvoices.get(invoiceId);
    
    if (pending) {
        // Сохраняем покупку
        purchases.set(userId, {
            prefix: pending.prefix,
            date: new Date().toISOString(),
            username: pending.username,
            firstName: pending.firstName
        });
        
        pendingInvoices.delete(invoiceId);
        
        // Уведомляем пользователя
        await bot.sendMessage(userId, `✅ Поздравляю! Ты купил префикс [${pending.prefix}]\n\nТеперь он будет отображаться в группе!`);
        
        // Отправляем в группу (если нужно)
        const groupId = process.env.GROUP_ID;
        if (groupId) {
            await bot.sendMessage(groupId, `🎉 Участник ${msg.from.first_name} купил префикс [${pending.prefix}]!`);
        }
    }
});

// Запуск сервера для Web App
app.listen(PORT, () => {
    console.log(`🌐 Web App сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот запущен!');