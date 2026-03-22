const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ BOT_TOKEN не найден');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

// ========== ХРАНИЛИЩА ==========
const verifiedGroups = new Map();
const pendingGroups = new Map();
const userBalance = new Map();
const purchases = new Map();
const pendingInvoices = new Map();
const mutedUsers = new Map();
const bannedUsers = new Map();
const captchaPending = new Map();
const groupVerificationCodes = new Map();
const animations = new Map();

// ========== АНИМАЦИЯ ==========
async function animateTyping(chatId, fullText, speed = 70) {
    if (animations.has(chatId)) {
        clearInterval(animations.get(chatId).interval);
        animations.delete(chatId);
    }
    
    const sentMsg = await bot.sendMessage(chatId, '⬜', {
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    
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
                message_id: sentMsg.message_id,
                parse_mode: 'HTML'
            });
        } catch (err) {
            clearInterval(interval);
            animations.delete(chatId);
        }
    }, speed);
    
    animations.set(chatId, { interval, messageId: sentMsg.message_id });
    return sentMsg;
}

async function waitForAnimation(chatId) {
    return new Promise((resolve) => {
        const check = setInterval(() => {
            if (!animations.has(chatId)) {
                clearInterval(check);
                resolve();
            }
        }, 50);
        setTimeout(() => {
            clearInterval(check);
            resolve();
        }, 10000);
    });
}

// ========== УДАЛЕНИЕ СООБЩЕНИЙ ==========
async function deleteMessage(chatId, messageId) {
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (err) {
        // Игнорируем ошибки (сообщение уже удалено или нет прав)
    }
}

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static('public'));

// ========== КОМАНДЫ БОТА С УДАЛЕНИЕМ ==========

// /start — удаляет команду пользователя
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Удаляем команду пользователя
    await deleteMessage(chatId, msg.message_id);
    
    if (!userBalance.has(userId)) {
        userBalance.set(userId, { stars: 5, ultraUntil: null });
    }
    
    const balance = userBalance.get(userId);
    
    const text = `👋 Привет, ${msg.from.first_name}!

⭐ Ваш баланс: ${balance.stars} звёзд

Спасибо, что используете меня!`;
    
    await animateTyping(chatId, text, 70);
    await waitForAnimation(chatId);
    
    await bot.sendMessage(chatId, '🚀 Нажмите кнопку ниже, чтобы открыть мини-приложение:', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Открыть мини-приложение',
                web_app: { url: `https://alsuiradmir463dhdj-hue.github.io/Y?user_id=${userId}` }
            }]]
        }
    });
});

// /help — удаляет команду пользователя
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Удаляем команду пользователя
    await deleteMessage(chatId, msg.message_id);
    
    const text = `📋 Команды:
/start - приветствие с балансом
/help - помощь
/app - открыть мини-приложение

⭐ Звёзды можно потратить на:
• Префикс — 50 ⭐
• ULTRA подписка — 5 ⭐

👮‍♂️ Все настройки группы в мини-приложении!`;
    
    await animateTyping(chatId, text, 70);
});

// /app — удаляет команду пользователя
bot.onText(/\/app/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Удаляем команду пользователя
    await deleteMessage(chatId, msg.message_id);
    
    await bot.sendMessage(chatId, '🚀 Открываю мини-приложение...', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть панель',
                web_app: { url: `https://alsuiradmir463dhdj-hue.github.io/Y?user_id=${userId}` }
            }]]
        }
    });
});

// /my_prefix — удаляет команду пользователя
bot.onText(/\/my_prefix/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await deleteMessage(chatId, msg.message_id);
    
    const purchase = purchases.get(userId);
    const text = purchase 
        ? `🏷️ Твой префикс: [${purchase.prefix}]
Куплен: ${new Date(purchase.date).toLocaleDateString()}`
        : `❌ У тебя нет префикса

Купить можно за 50 ⭐ через мини-приложение`;
    
    await animateTyping(chatId, text, 70);
});

// /prefix — удаляет команду пользователя
bot.onText(/\/prefix/, async (msg) => {
    const chatId = msg.chat.id;
    
    await deleteMessage(chatId, msg.message_id);
    
    const text = `🏷️ Купить префикс
💰 Цена: 50 ⭐ Telegram Stars

Открой мини-приложение через /app и выбери свой префикс!`;
    
    await animateTyping(chatId, text, 70);
});

// ========== API ==========
app.get('/api/balance', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    const user = userBalance.get(userId) || { stars: 5, ultraUntil: null };
    res.json({ stars: user.stars, ultraUntil: user.ultraUntil });
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => {
    console.log(`🌐 Web App сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот запущен!');