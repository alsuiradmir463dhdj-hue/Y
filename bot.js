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

// ========== АНИМАЦИЯ ПЕЧАТИ (1 БУКВА В 30 МС) ==========
const animations = new Map();

async function animateTyping(chatId, messageId, fullText, speed = 30) {
    // Останавливаем предыдущую анимацию для этого чата
    if (animations.has(chatId)) {
        clearInterval(animations.get(chatId).interval);
        animations.delete(chatId);
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
        } catch (err) {
            // Если сообщение уже удалено или не найдено — останавливаем анимацию
            if (err.response?.statusCode === 400) {
                clearInterval(interval);
                animations.delete(chatId);
            }
        }
    }, speed);
    
    animations.set(chatId, { interval });
}

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static('public'));

// ========== КОМАНДЫ БОТА ==========

// /start — с быстрой анимацией
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Бонус 5 звёзд
    if (!userBalance.has(userId)) {
        userBalance.set(userId, { stars: 5, ultraUntil: null });
    }
    
    const balance = userBalance.get(userId);
    const text = `👋 Привет, ${msg.from.first_name}!

⭐ Баланс: ${balance.stars} звёзд

Спасибо, что используете меня!

🚀 Нажмите кнопку ниже, чтобы открыть мини-приложение.`;
    
    // Отправляем пустое сообщение
    const sentMsg = await bot.sendMessage(chatId, '⬜', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Открыть мини-приложение',
                web_app: { url: `https://your-domain.com?user_id=${userId}` }
            }]]
        }
    });
    
    // Запускаем быструю анимацию (1 буква в 30 мс)
    await animateTyping(chatId, sentMsg.message_id, text, 30);
});

// /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `📋 Команды:
/start - приветствие с балансом
/help - помощь
/app - открыть мини-приложение

⭐ Звёзды можно потратить на префиксы и ULTRA подписку`;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    await animateTyping(chatId, sentMsg.message_id, text, 30);
});

// /app — открыть мини-приложение
bot.onText(/\/app/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, '🚀 Открываю мини-приложение...', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть панель',
                web_app: { url: `https://your-domain.com?user_id=${userId}` }
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

console.log('🤖 Бот запущен! Анимация: 1 буква / 30 мс');