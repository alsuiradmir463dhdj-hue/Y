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
const userBalance = new Map();
const verifiedGroups = new Map();
const pendingGroups = new Map();
const groupVerificationCodes = new Map();

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
function generateSecretCode() {
    const words = ['яблоко', 'груша', 'вишня', 'персик', 'манго', 'киви', 'лимон', 'апельсин'];
    const word = words[Math.floor(Math.random() * words.length)];
    const number = Math.floor(Math.random() * 100);
    return `${word}${number}`;
}

function isGroupVerified(chatId) {
    return verifiedGroups.get(chatId)?.verified === true;
}

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static('public'));

// ========== API ==========

app.get('/api/balance', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    const user = userBalance.get(userId) || { stars: 5 };
    res.json({ stars: user.stars });
});

app.get('/api/my-groups', async (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ groups: [] });
    const groups = [];
    for (const [groupId, data] of verifiedGroups.entries()) {
        if (data.addedBy === userId) {
            try {
                const chat = await bot.getChat(groupId);
                groups.push({ id: groupId, title: chat.title, verified: true });
            } catch (err) {}
        }
    }
    for (const [groupId, data] of pendingGroups.entries()) {
        if (data.addedBy === userId) {
            try {
                const chat = await bot.getChat(groupId);
                groups.push({ id: groupId, title: chat.title, verified: false });
            } catch (err) {}
        }
    }
    res.json({ groups });
});

app.post('/api/generate-code', async (req, res) => {
    const { groupId } = req.body;
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!groupId || !userId) return res.json({ error: 'Не хватает данных' });
    const pending = pendingGroups.get(parseInt(groupId));
    if (!pending) return res.json({ error: 'Группа не найдена. Добавьте бота в группу' });
    const code = generateSecretCode();
    groupVerificationCodes.set(parseInt(groupId), { code, userId, date: Date.now() });
    res.json({ code });
});

app.post('/api/verify-group', async (req, res) => {
    const { groupId, code } = req.body;
    const userId = parseInt(req.headers['x-telegram-user-id']);
    const pending = groupVerificationCodes.get(parseInt(groupId));
    if (!pending) return res.json({ error: 'Код не найден' });
    if (pending.code !== code) return res.json({ error: 'Неверный код' });
    if (pending.userId !== userId) return res.json({ error: 'Не ваш код' });
    const groupData = pendingGroups.get(parseInt(groupId));
    if (!groupData) return res.json({ error: 'Группа не найдена' });
    verifiedGroups.set(parseInt(groupId), {
        verified: true,
        addedBy: groupData.addedBy,
        addedByUsername: groupData.addedByUsername,
        verifiedAt: new Date().toISOString()
    });
    pendingGroups.delete(parseInt(groupId));
    groupVerificationCodes.delete(parseInt(groupId));
    await bot.sendMessage(parseInt(groupId), `✅ Группа верифицирована!`);
    res.json({ success: true });
});

// ========== КОМАНДЫ БОТА ==========

const APP_URL = 'https://alsuiradmir463dhdj-hue.github.io/Y'; // <- ТВОЙ URL

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!userBalance.has(userId)) userBalance.set(userId, { stars: 5 });
    const balance = userBalance.get(userId);
    await bot.sendMessage(chatId, `👋 Привет, ${msg.from.first_name}!\n\n⭐ Баланс: ${balance.stars} звёзд`);
    await bot.sendMessage(chatId, '🚀 Нажмите кнопку ниже:', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Открыть',
                web_app: { url: `${APP_URL}?user_id=${userId}` }
            }]]
        }
    });
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `📋 Команды:
/start - приветствие
/help - помощь
/app - открыть панель
/addgroup - добавить бота в группу`);
});

bot.onText(/\/app/, async (msg) => {
    const userId = msg.from.id;
    await bot.sendMessage(msg.chat.id, '🚀 Открываю...', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть',
                web_app: { url: `${APP_URL}?user_id=${userId}` }
            }]]
        }
    });
});

bot.onText(/\/addgroup/, async (msg) => {
    const inviteLink = `https://t.me/GguhdxfBOT?startgroup&admin=delete_messages+restrict_members+invite_users+ban_users+pin_messages+change_info`;
    await bot.sendMessage(msg.chat.id, `🤖 Добавьте меня в группу:\n\n[Нажмите сюда](${inviteLink})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// ========== ДОБАВЛЕНИЕ В ГРУППУ ==========

bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    for (const member of msg.new_chat_members) {
        if (member.id === bot.options.token.split(':')[0]) {
            if (isGroupVerified(chatId)) {
                await bot.sendMessage(chatId, '✅ Группа уже верифицирована');
                return;
            }
            const secretCode = generateSecretCode();
            pendingGroups.set(chatId, {
                secretCode,
                addedBy: msg.from.id,
                addedByUsername: msg.from.username || msg.from.first_name,
                date: new Date().toISOString()
            });
            await bot.sendMessage(chatId, `🔐 Код активации: <code>${secretCode}</code>`, { parse_mode: 'HTML' });
            await bot.sendMessage(msg.from.id, `🔐 Код: ${secretCode}`);
        }
    }
});

bot.onText(/^(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = match[1];
    if (msg.chat.type === 'private') return;
    const pending = pendingGroups.get(chatId);
    if (pending && text.trim() === pending.secretCode) {
        verifiedGroups.set(chatId, {
            verified: true,
            addedBy: pending.addedBy,
            addedByUsername: pending.addedByUsername,
            verifiedAt: new Date().toISOString()
        });
        pendingGroups.delete(chatId);
        await bot.sendMessage(chatId, `✅ Группа верифицирована!`);
        await bot.sendMessage(pending.addedBy, `✅ Группа активирована!`);
    }
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => {
    console.log(`🌐 Сервер на порту ${PORT}`);
});
console.log('🤖 Бот запущен!');