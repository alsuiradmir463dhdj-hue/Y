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
const app = express();  // <--- ЭТО ДОЛЖНО БЫТЬ ПЕРЕД ВСЕМИ app.get()

const PORT = process.env.PORT || 3000;

// ========== Middleware ==========
app.use(express.json());
app.use(express.static('public'));

// ========== ХРАНИЛИЩА ==========
const purchases = new Map();
const pendingInvoices = new Map();
const verifiedGroups = new Map();
const pendingGroups = new Map();
const mutedUsers = new Map();
const bannedUsers = new Map();
const captchaPending = new Map();
const groupVerificationCodes = new Map();

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function generateSecretCode() {
    const words = ['яблоко', 'груша', 'вишня', 'персик', 'манго', 'киви', 'лимон', 'апельсин'];
    const word = words[Math.floor(Math.random() * words.length)];
    const number = Math.floor(Math.random() * 100);
    return `${word}${number}`;
}

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function isGroupVerified(chatId) {
    const verified = verifiedGroups.get(chatId);
    return verified && verified.verified === true;
}

function isMuted(chatId, userId) {
    const key = `${chatId}_${userId}`;
    const muted = mutedUsers.get(key);
    if (!muted) return false;
    if (muted.until < Date.now()) {
        mutedUsers.delete(key);
        return false;
    }
    return true;
}

function isBanned(chatId, userId) {
    return bannedUsers.has(`${chatId}_${userId}`);
}

async function isAdminInGroup(chatId, userId) {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return member.status === 'administrator' || member.status === 'creator';
    } catch {
        return false;
    }
}

// Middleware для проверки админа
async function adminGuard(req, res, next) {
    const groupId = req.headers['x-telegram-group-id'];
    const userId = parseInt(req.headers['x-telegram-user-id']);
    
    if (!groupId || !userId) return res.json({ error: 'Не указана группа или пользователь' });
    if (!isGroupVerified(parseInt(groupId))) return res.json({ error: 'Группа не верифицирована' });
    
    const isAdmin = await isAdminInGroup(parseInt(groupId), userId);
    if (!isAdmin) return res.json({ error: 'Требуются права администратора' });
    
    req.groupId = parseInt(groupId);
    req.adminId = userId;
    next();
}

// ========== НАСТОЯЩИЙ МУТ И БАН ==========

async function muteUserReal(chatId, userId, durationSeconds, reason = 'Не указана', username = '') {
    try {
        const untilDate = Math.floor(Date.now() / 1000) + durationSeconds;
        await bot.restrictChatMember(chatId, userId, {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            until_date: untilDate
        });
        const key = `${chatId}_${userId}`;
        mutedUsers.set(key, { until: Date.now() + (durationSeconds * 1000), until_date: untilDate, reason: reason });
        const dateStr = new Date(untilDate * 1000).toLocaleString();
        await bot.sendMessage(chatId, `🔇 ${username || userId} замьючен до ${dateStr}\nПричина: ${reason}`);
        return true;
    } catch (err) { return false; }
}

async function unmuteUserReal(chatId, userId, username = '') {
    try {
        await bot.restrictChatMember(chatId, userId, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true
        });
        mutedUsers.delete(`${chatId}_${userId}`);
        await bot.sendMessage(chatId, `🔊 ${username || userId} размьючен`);
        return true;
    } catch (err) { return false; }
}

async function banUserReal(chatId, userId, reason = 'Не указана', username = '') {
    try {
        await bot.banChatMember(chatId, userId);
        bannedUsers.set(`${chatId}_${userId}`, { reason: reason, date: Date.now() });
        await bot.sendMessage(chatId, `🔨 ${username || userId} забанен\nПричина: ${reason}`);
        return true;
    } catch (err) { return false; }
}

async function unbanUserReal(chatId, userId, username = '') {
    try {
        await bot.unbanChatMember(chatId, userId);
        bannedUsers.delete(`${chatId}_${userId}`);
        await bot.sendMessage(chatId, `✅ ${username || userId} разбанен`);
        return true;
    } catch (err) { return false; }
}

// ========== АНИМАЦИЯ ==========
const animations = new Map();

async function animateTyping(chatId, messageId, fullText, speed = 100) {
    if (animations.has(chatId)) clearInterval(animations.get(chatId).interval);
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
            await bot.editMessageText(currentText, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        } catch (err) {}
    }, speed);
    animations.set(chatId, { interval });
}

function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [[{ text: '🚀 Купить префикс', web_app: { url: 'https://your-domain.com' } }], [{ text: '📋 Помощь' }, { text: '💰 Мой префикс' }]],
            resize_keyboard: true
        }
    };
}

// ========== API ==========

// API: получить мои группы
app.get('/api/my-groups', async (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ groups: [] });
    
    const groups = [];
    for (const [groupId, data] of verifiedGroups.entries()) {
        if (data.addedBy === userId || data.verified) {
            try {
                const chat = await bot.getChat(groupId);
                groups.push({ id: groupId, title: chat.title, verified: data.verified });
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

// API: сгенерировать код для верификации
app.post('/api/generate-code', async (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    let targetGroup = null;
    for (const [groupId, data] of pendingGroups.entries()) {
        if (data.addedBy === userId) {
            targetGroup = { id: groupId, data };
            break;
        }
    }
    
    if (!targetGroup) return res.json({ error: 'Нет групп для верификации. Добавьте бота в группу' });
    
    const code = generateSecretCode();
    groupVerificationCodes.set(targetGroup.id, { code, userId, date: Date.now() });
    
    res.json({ code, groupId: targetGroup.id });
});

// API: подтвердить группу
app.post('/api/verify-group', async (req, res) => {
    const { groupId, code } = req.body;
    const userId = parseInt(req.headers['x-telegram-user-id']);
    
    const pending = groupVerificationCodes.get(parseInt(groupId));
    if (!pending) return res.json({ error: 'Код не найден или истёк' });
    if (pending.code !== code) return res.json({ error: 'Неверный код' });
    if (pending.userId !== userId) return res.json({ error: 'Не ваш код' });
    
    const groupData = pendingGroups.get(parseInt(groupId));
    if (!groupData) return res.json({ error: 'Группа не найдена' });
    
    verifiedGroups.set(parseInt(groupId), {
        verified: true,
        secretCode: code,
        addedBy: groupData.addedBy,
        addedByUsername: groupData.addedByUsername,
        verifiedAt: new Date().toISOString(),
        settings: { captchaEnabled: true, respectEnabled: true, respects: new Map() }
    });
    
    pendingGroups.delete(parseInt(groupId));
    groupVerificationCodes.delete(parseInt(groupId));
    
    await bot.sendMessage(parseInt(groupId), `✅ Группа верифицирована! Администратор ${groupData.addedByUsername} получил полный доступ.`);
    
    res.json({ success: true });
});

// API: получить список пользователей
app.get('/api/admin/users', adminGuard, async (req, res) => {
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const users = members.map(m => ({
            id: m.user.id, first_name: m.user.first_name, username: m.user.username,
            is_muted: isMuted(req.groupId, m.user.id),
            is_banned: isBanned(req.groupId, m.user.id),
            is_admin: m.status === 'administrator' || m.status === 'creator'
        }));
        res.json({ users });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: замутить
app.post('/api/admin/mute', adminGuard, async (req, res) => {
    const { username, time, reason } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        let seconds = 3600;
        if (time) {
            const val = parseInt(time);
            const unit = time.slice(-1);
            if (unit === 'm') seconds = val * 60;
            if (unit === 'h') seconds = val * 3600;
            if (unit === 'd') seconds = val * 86400;
        }
        
        await muteUserReal(req.groupId, user.user.id, seconds, reason || 'Не указана', `@${username}`);
        res.json({ success: true, message: `${user.user.first_name} замьючен` });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: размутить
app.post('/api/admin/unmute', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        await unmuteUserReal(req.groupId, user.user.id, `@${username}`);
        res.json({ success: true, message: `${user.user.first_name} размьючен` });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: забанить
app.post('/api/admin/ban', adminGuard, async (req, res) => {
    const { username, reason } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        await banUserReal(req.groupId, user.user.id, reason || 'Не указана', `@${username}`);
        res.json({ success: true, message: `${user.user.first_name} забанен` });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: разбанить
app.post('/api/admin/unban', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        await unbanUserReal(req.groupId, user.user.id, `@${username}`);
        res.json({ success: true, message: `${user.user.first_name} разбанен` });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: настройки группы
app.get('/api/admin/settings', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    const settings = group?.settings || {};
    res.json({ welcome: settings.welcomeMsg || '', goodbye: settings.goodbyeMsg || '', captcha_enabled: settings.captchaEnabled !== false });
});

app.post('/api/admin/setwelcome', adminGuard, async (req, res) => {
    const { welcome } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (!group.settings) group.settings = {};
        group.settings.welcomeMsg = welcome;
        verifiedGroups.set(req.groupId, group);
        res.json({ success: true });
    } else { res.json({ error: 'Группа не найдена' }); }
});

app.post('/api/admin/setgoodbye', adminGuard, async (req, res) => {
    const { goodbye } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (!group.settings) group.settings = {};
        group.settings.goodbyeMsg = goodbye;
        verifiedGroups.set(req.groupId, group);
        res.json({ success: true });
    } else { res.json({ error: 'Группа не найдена' }); }
});

app.post('/api/admin/captcha', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (!group.settings) group.settings = {};
        group.settings.captchaEnabled = enabled;
        verifiedGroups.set(req.groupId, group);
        res.json({ success: true });
    } else { res.json({ error: 'Группа не найдена' }); }
});

app.get('/api/admin/info', adminGuard, async (req, res) => {
    try {
        const chat = await bot.getChat(req.groupId);
        const group = verifiedGroups.get(req.groupId);
        const membersCount = await bot.getChatMembersCount(req.groupId);
        res.json({ id: chat.id, title: chat.title, members_count: membersCount, captcha_enabled: group?.settings?.captchaEnabled !== false });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// API: префиксы
app.get('/api/admin/prefixes', adminGuard, async (req, res) => {
    const groupPrefixes = [];
    for (const [userId, data] of purchases.entries()) {
        groupPrefixes.push({ user_id: userId, first_name: data.firstName || `User_${userId}`, username: data.username, prefix: data.prefix, date: data.date });
    }
    res.json({ prefixes: groupPrefixes });
});

app.post('/api/admin/giveprefix', adminGuard, async (req, res) => {
    const { username, prefix } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        
        purchases.set(user.user.id, { prefix, date: new Date().toISOString(), firstName: user.user.first_name, username: user.user.username });
        
        try {
            await bot.setChatAdministratorCustomTitle(req.groupId, user.user.id, prefix);
        } catch (err) {}
        
        await bot.sendMessage(req.groupId, `🏷️ ${user.user.first_name} получил префикс [${prefix}]!`);
        res.json({ success: true, message: `Префикс [${prefix}] выдан ${user.user.first_name}` });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/removeprefix', adminGuard, async (req, res) => {
    const { user_id } = req.body;
    if (purchases.has(parseInt(user_id))) {
        purchases.delete(parseInt(user_id));
        res.json({ success: true });
    } else { res.json({ error: 'Префикс не найден' }); }
});

// API: респекты
app.get('/api/admin/respect-stats', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    const respects = group?.settings?.respects || new Map();
    const stats = [];
    for (const [userId, count] of respects.entries()) {
        try {
            const member = await bot.getChatMember(req.groupId, userId);
            stats.push({ user_id: userId, first_name: member.user.first_name, username: member.user.username, respects: count });
        } catch (err) {}
    }
    stats.sort((a, b) => b.respects - a.respects);
    res.json({ stats });
});

app.post('/api/admin/respect-toggle', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (!group.settings) group.settings = {};
        group.settings.respectEnabled = enabled;
        verifiedGroups.set(req.groupId, group);
        res.json({ success: true });
    } else { res.json({ error: 'Группа не найдена' }); }
});

// ========== КОМАНДЫ БОТА ==========

bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    for (const member of msg.new_chat_members) {
        if (member.id === bot.options.token.split(':')[0]) {
            if (isGroupVerified(chatId)) {
                await bot.sendMessage(chatId, '✅ Группа уже верифицирована!');
                return;
            }
            const secretCode = generateSecretCode();
            pendingGroups.set(chatId, { secretCode, addedBy: msg.from.id, addedByUsername: msg.from.username || msg.from.first_name, date: new Date().toISOString() });
            await bot.sendMessage(chatId, `🔐 Для активации отправьте код:\n<code>${secretCode}</code>`, { parse_mode: 'HTML' });
            await bot.sendMessage(msg.from.id, `🔐 Код активации: ${secretCode}`);
        }
        
        if (member.id !== bot.options.token.split(':')[0] && isGroupVerified(chatId)) {
            const settings = verifiedGroups.get(chatId)?.settings;
            if (settings?.captchaEnabled !== false) {
                const captchaCode = generateCaptcha();
                captchaPending.set(`${chatId}_${member.id}`, { code: captchaCode, date: Date.now() });
                await bot.sendMessage(chatId, `👋 ${member.first_name}, для подтверждения отправьте код:\n<code>${captchaCode}</code>`, { parse_mode: 'HTML' });
                setTimeout(async () => {
                    if (captchaPending.has(`${chatId}_${member.id}`)) {
                        await bot.banChatMember(chatId, member.id);
                        await bot.unbanChatMember(chatId, member.id);
                        await bot.sendMessage(chatId, `❌ ${member.first_name} не прошёл капчу`);
                        captchaPending.delete(`${chatId}_${member.id}`);
                    }
                }, 5 * 60 * 1000);
            } else if (settings?.welcomeMsg) {
                await bot.sendMessage(chatId, settings.welcomeMsg.replace('{name}', member.first_name));
            }
        }
    }
});

bot.on('left_chat_member', async (msg) => {
    if (msg.left_chat_member.id === bot.options.token.split(':')[0]) {
        verifiedGroups.delete(msg.chat.id);
        pendingGroups.delete(msg.chat.id);
    }
});

bot.onText(/^(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = match[1];
    if (msg.chat.type === 'private') return;
    
    const captchaKey = `${chatId}_${userId}`;
    const captcha = captchaPending.get(captchaKey);
    if (captcha && text.trim().toUpperCase() === captcha.code) {
        captchaPending.delete(captchaKey);
        await bot.sendMessage(chatId, `✅ ${msg.from.first_name}, добро пожаловать!`);
        return;
    }
    
    const pending = pendingGroups.get(chatId);
    if (pending && text.trim() === pending.secretCode) {
        verifiedGroups.set(chatId, { verified: true, secretCode: pending.secretCode, addedBy: pending.addedBy, addedByUsername: pending.addedByUsername, verifiedAt: new Date().toISOString(), settings: { captchaEnabled: true, respectEnabled: true, respects: new Map() } });
        pendingGroups.delete(chatId);
        await bot.sendMessage(chatId, `✅ Группа верифицирована! Команды: /help`);
        await bot.sendMessage(pending.addedBy, `✅ Группа активирована!`);
    }
});

// Респекты в чате
bot.onText(/^\+респект @(\w+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetUsername = match[1];
    
    if (!isGroupVerified(chatId)) return;
    const group = verifiedGroups.get(chatId);
    if (!group?.settings?.respectEnabled) return;
    
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        if (fromId === target.user.id) return;
        
        const respects = group.settings.respects || new Map();
        const current = respects.get(target.user.id) || 0;
        respects.set(target.user.id, current + 1);
        group.settings.respects = respects;
        verifiedGroups.set(chatId, group);
        
        await bot.sendMessage(chatId, `⭐ ${msg.from.first_name} дал респект @${targetUsername}! Всего респектов: ${current + 1}`);
    } catch (err) {}
});

bot.on('message', async (msg) => {
    if (!msg.reply_to_message) return;
    if (msg.text !== '+' && msg.text !== '+1') return;
    
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetId = msg.reply_to_message.from.id;
    
    if (!isGroupVerified(chatId)) return;
    const group = verifiedGroups.get(chatId);
    if (!group?.settings?.respectEnabled) return;
    if (fromId === targetId) return;
    
    const respects = group.settings.respects || new Map();
    const current = respects.get(targetId) || 0;
    respects.set(targetId, current + 1);
    group.settings.respects = respects;
    verifiedGroups.set(chatId, group);
    
    await bot.sendMessage(chatId, `⭐ ${msg.from.first_name} дал респект ${msg.reply_to_message.from.first_name}! Всего респектов: ${current + 1}`);
});

// Команды бота
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '');
    const fullText = `👋 Привет, ${msg.from.first_name}!\nЯ бот для групп. Добавь меня в группу и активируй кодом.\n\n⭐ Можешь купить префикс за 50 Telegram Stars!`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '');
    const fullText = `📋 Команды:\n/start - приветствие\n/help - помощь\n/my_prefix - мой префикс\n/prefix - купить префикс\n\n👮‍♂️ Админ-команды через панель: /admin\n\n⭐ Префикс = 50 Telegram Stars`;
    await animateTyping(chatId, sentMsg.message_id, fullText, 100);
});

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isGroupVerified(chatId)) {
        await bot.sendMessage(chatId, '⚠️ Группа не активирована. Добавьте бота и подтвердите код.');
        return;
    }
    
    if (!await isAdminInGroup(chatId, userId)) {
        await bot.sendMessage(chatId, '❌ Только администраторы группы могут открыть панель');
        return;
    }
    
    const webAppUrl = `https://your-domain.com?group_id=${chatId}`;
    await bot.sendMessage(chatId, '🛡️ Панель управления ботом', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть панель',
                web_app: { url: webAppUrl }
            }]]
        }
    });
});

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, () => {
    console.log(`🌐 Web App сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот запущен!');