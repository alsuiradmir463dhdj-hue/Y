#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Автоустановка зависимостей
const packages = ['node-telegram-bot-api', 'dotenv'];
const installed = [];

console.log('📦 Проверка зависимостей...');

for (const pkg of packages) {
    try {
        require.resolve(pkg);
        console.log(`✅ ${pkg} уже установлен`);
    } catch (e) {
        console.log(`📥 Устанавливаю ${pkg}...`);
        execSync(`npm install ${pkg} --silent`, { stdio: 'inherit' });
        installed.push(pkg);
    }
}

// Теперь импортируем
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Проверка токена
const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('\n❌ Ошибка: BOT_TOKEN не найден!');
    console.error('📝 Создай файл .env и добавь туда:');
    console.error('   BOT_TOKEN=твой_токен_от_BotFather\n');
    
    // Создаём пример .env если нет
    if (!fs.existsSync('.env')) {
        fs.writeFileSync('.env.example', 'BOT_TOKEN=вставь_свой_токен_сюда\n');
        console.log('📄 Создан файл .env.example, переименуй в .env и добавь токен');
    }
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Хранилище анимаций
const animations = new Map();

// Анимация печати по буквам
async function animateTyping(chatId, messageId, fullText, speed = 800) {
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
                message_id: messageId
            });
        } catch (err) {
            // Игнорируем
        }
    }, speed);
    
    animations.set(chatId, { interval, fullText, index });
}

// Команда /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    const fullText = `Привет! 👋\n\nЯ бот с анимацией печати.\n\nКаждую секунду добавляю по 1 букве.\n\nНапиши /help для команд.`;
    
    await animateTyping(chatId, sentMsg.message_id, fullText, 800);
});

// Команда /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    const fullText = `📋 Команды:\n\n/start - приветствие\n/help - помощь\n/prefix - купить префикс`;
    
    await animateTyping(chatId, sentMsg.message_id, fullText, 700);
});

// Покупка префикса
bot.onText(/\/prefix/, async (msg) => {
    const chatId = msg.chat.id;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    const fullText = `🏷️ Префикс [Помощник]\n\n💰 Цена: 50 ⭐ Telegram Stars\n\nНапиши /buy_prefix для покупки`;
    
    await animateTyping(chatId, sentMsg.message_id, fullText, 800);
});

// Подтверждение покупки
bot.onText(/\/buy_prefix/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    const fullText = `✅ Покупка оформлена!\n\n${name} теперь с префиксом [Помощник]\n\n⚠️ Никаких дополнительных прав не выдано.`;
    
    await animateTyping(chatId, sentMsg.message_id, fullText, 700);
});

// Автоответ на фразу
bot.onText(/хочу купить префикс/i, async (msg) => {
    const chatId = msg.chat.id;
    
    const sentMsg = await bot.sendMessage(chatId, '⬜');
    const fullText = `🏷️ Префикс [Помощник]\n\n💰 Цена: 50 ⭐ Telegram Stars\n\nОтправь /buy_prefix для покупки`;
    
    await animateTyping(chatId, sentMsg.message_id, fullText, 800);
});

console.log('🤖 Бот запущен!');
