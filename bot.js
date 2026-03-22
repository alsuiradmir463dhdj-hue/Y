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

// ========== ТВОЙ URL ==========
const APP_URL = 'https://alsuiradmir463dhdj-hue.github.io/Y';

// ========== АНИМАЦИЯ ПЕЧАТИ ==========
async function animateTyping(chatId, fullText, speed = 30) {
    if (animations.has(chatId)) {
        clearInterval(animations.get(chatId).interval);
        animations.delete(chatId);
    }
    
    const firstChar = fullText[0];
    let currentText = firstChar;
    let index = 1;
    
    const sentMsg = await bot.sendMessage(chatId, currentText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    
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

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static('public'));

// ========== КОМАНДЫ БОТА ==========

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!userBalance.has(userId)) {
        userBalance.set(userId, { stars: 5, ultraUntil: null });
    }
    
    const balance = userBalance.get(userId);
    
    const text = `👋 Привет, ${msg.from.first_name}!

⭐ Ваш баланс: ${balance.stars} звёзд

Спасибо, что используете меня!`;
    
    await animateTyping(chatId, text, 30);
    await waitForAnimation(chatId);
    
    await bot.sendMessage(chatId, '🚀 Нажмите кнопку ниже, чтобы открыть мини-приложение:', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Открыть мини-приложение',
                web_app: { url: `${APP_URL}?user_id=${userId}` }
            }]]
        }
    });
});

// /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `📋 Команды:
/start - приветствие с балансом
/help - помощь
/app - открыть мини-приложение

⭐ Звёзды можно потратить на:
• Префикс — 50 ⭐
• ULTRA подписка — 5 ⭐

👮‍♂️ Все настройки группы в мини-приложении!`;
    
    await animateTyping(chatId, text, 30);
});

// /app
bot.onText(/\/app/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, '🚀 Открываю мини-приложение...', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть панель',
                web_app: { url: `${APP_URL}?user_id=${userId}` }
            }]]
        }
    });
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