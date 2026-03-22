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
const purchases = new Map();           // userId -> { prefix, date }
const pendingInvoices = new Map();     // invoiceId -> { userId, prefix, type }
const verifiedGroups = new Map();      // groupId -> { verified, settings, ultraAdmins }
const pendingGroups = new Map();       // groupId -> { secretCode, addedBy }
const mutedUsers = new Map();          // groupId_userId -> { until, reason }
const bannedUsers = new Map();         // groupId_userId -> { reason }
const captchaPending = new Map();      // groupId_userId -> { code }
const groupVerificationCodes = new Map(); // groupId -> { code, userId }
const userBalance = new Map();         // userId -> { stars, ultraUntil }
const spamWarnings = new Map();        // groupId_userId -> { count, lastMessageTime }
const userActions = new Map();         // userId -> [{ action, date, groupId }]

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function generateSecretCode() {
    const words = ['яблоко', 'груша', 'вишня', 'персик', 'манго', 'киви', 'лимон', 'апельсин'];
    return `${words[Math.floor(Math.random() * words.length)]}${Math.floor(Math.random() * 100)}`;
}

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function isGroupVerified(chatId) {
    return verifiedGroups.get(chatId)?.verified === true;
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

function isUltraAdmin(chatId, userId) {
    const group = verifiedGroups.get(chatId);
    return group?.ultraAdmins?.includes(userId) || false;
}

function hasUltraSubscription(userId) {
    const user = userBalance.get(userId);
    if (!user?.ultraUntil) return false;
    return user.ultraUntil > Date.now();
}

async function isAdminInGroup(chatId, userId) {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return member.status === 'administrator' || member.status === 'creator';
    } catch { return false; }
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

// ========== МУТ И БАН ==========

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

// ========== АНТИСПАМ И АНТИФЛУД ==========

async function checkSpam(chatId, userId, messageText) {
    const key = `${chatId}_${userId}`;
    const now = Date.now();
    const warnings = spamWarnings.get(key) || { count: 0, lastMessageTime: 0, messages: [] };
    
    // Очищаем старые сообщения (старше 10 секунд)
    warnings.messages = (warnings.messages || []).filter(t => now - t < 10000);
    warnings.messages.push(now);
    
    // Проверка на флуд: больше 5 сообщений за 10 секунд
    if (warnings.messages.length > 5) {
        await muteUserReal(chatId, userId, 60, 'Флуд (автоматически)', `@${userId}`);
        spamWarnings.delete(key);
        return true;
    }
    
    // Проверка на спам: одинаковые сообщения подряд
    const lastMessage = warnings.lastMessageText;
    if (lastMessage === messageText && messageText.length > 3) {
        warnings.sameCount = (warnings.sameCount || 0) + 1;
        if (warnings.sameCount > 3) {
            await muteUserReal(chatId, userId, 300, 'Спам (повторяющиеся сообщения)', `@${userId}`);
            spamWarnings.delete(key);
            return true;
        }
    } else {
        warnings.sameCount = 0;
    }
    
    warnings.lastMessageText = messageText;
    warnings.lastMessageTime = now;
    spamWarnings.set(key, warnings);
    return false;
}

// ========== АНИМАЦИЯ ПЕЧАТИ (1 БУКВА В 30 МС) ==========
const animations = new Map();

async function animateTyping(chatId, messageId, fullText, speed = 30) {
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

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static('public'));

// ========== API ==========

// Получить баланс пользователя
app.get('/api/balance', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    const user = userBalance.get(userId) || { stars: 5, ultraUntil: null };
    res.json({ stars: user.stars, ultraUntil: user.ultraUntil, hasUltra: hasUltraSubscription(userId) });
});

// Пополнить баланс (оплата звездами Telegram)
app.post('/api/topup', async (req, res) => {
    const { amount } = req.body;
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    const invoiceId = Date.now().toString();
    pendingInvoices.set(invoiceId, { userId, type: 'topup', amount });
    
    try {
        const invoice = await bot.createInvoiceLink(
            `Пополнение баланса на ${amount} ⭐`,
            `Пополнение баланса на ${amount} звёзд`,
            `topup_${invoiceId}`,
            '',
            'XTR',
            [{ label: `${amount} Telegram Stars`, amount: amount }]
        );
        res.json({ invoiceLink: invoice });
    } catch (err) {
        res.json({ error: 'Не удалось создать счёт' });
    }
});

// Купить ULTRA подписку (5 звёзд)
app.post('/api/buy-ultra', async (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    const user = userBalance.get(userId) || { stars: 5 };
    if (user.stars < 5) return res.json({ error: 'Недостаточно звёзд. Нужно 5 ⭐' });
    
    user.stars -= 5;
    user.ultraUntil = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 дней
    userBalance.set(userId, user);
    
    res.json({ success: true, stars: user.stars, ultraUntil: user.ultraUntil });
});

// Купить префикс (50 звёзд)
app.post('/api/buy-prefix', async (req, res) => {
    const { prefix } = req.body;
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    if (!prefix) return res.json({ error: 'Не указан префикс' });
    if (prefix.toLowerCase() === 'админ') return res.json({ error: 'Префикс "Админ" недоступен для покупки' });
    
    const user = userBalance.get(userId) || { stars: 5 };
    if (user.stars < 50) return res.json({ error: `Недостаточно звёзд. Нужно 50 ⭐. Ваш баланс: ${user.stars} ⭐` });
    
    user.stars -= 50;
    userBalance.set(userId, user);
    
    purchases.set(userId, { prefix, date: new Date().toISOString() });
    
    res.json({ success: true, stars: user.stars, prefix: prefix });
});

// Получить список моих групп
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

// Сгенерировать код для верификации группы
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

// Подтвердить группу
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
        settings: { captchaEnabled: true, respectEnabled: true, antiSpamEnabled: true, respects: new Map() },
        ultraAdmins: []
    });
    
    pendingGroups.delete(parseInt(groupId));
    groupVerificationCodes.delete(parseInt(groupId));
    
    await bot.sendMessage(parseInt(groupId), `✅ Группа верифицирована! Администратор ${groupData.addedByUsername} получил полный доступ.`);
    
    res.json({ success: true });
});

// Получить настройки группы
app.get('/api/admin/settings', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    const settings = group?.settings || {};
    res.json({ 
        welcome: settings.welcomeMsg || '', 
        goodbye: settings.goodbyeMsg || '', 
        captcha_enabled: settings.captchaEnabled !== false,
        antiSpam_enabled: settings.antiSpamEnabled !== false
    });
});

// Сохранить настройки
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

app.post('/api/admin/antispam', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (!group.settings) group.settings = {};
        group.settings.antiSpamEnabled = enabled;
        verifiedGroups.set(req.groupId, group);
        res.json({ success: true });
    } else { res.json({ error: 'Группа не найдена' }); }
});

// Получить список пользователей
app.get('/api/admin/users', adminGuard, async (req, res) => {
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const users = members.map(m => ({
            id: m.user.id, first_name: m.user.first_name, username: m.user.username,
            is_muted: isMuted(req.groupId, m.user.id),
            is_banned: isBanned(req.groupId, m.user.id),
            is_admin: m.status === 'administrator' || m.status === 'creator',
            is_ultra: isUltraAdmin(req.groupId, m.user.id)
        }));
        res.json({ users });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// Мут
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

// Размут
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

// Бан
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

// Разбан
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

// Префиксы
app.get('/api/admin/prefixes', adminGuard, async (req, res) => {
    const groupPrefixes = [];
    for (const [userId, data] of purchases.entries()) {
        groupPrefixes.push({ user_id: userId, first_name: data.firstName || `User_${userId}`, username: data.username, prefix: data.prefix, date: data.date });
    }
    res.json({ prefixes: groupPrefixes });
});

app.post('/api/admin/giveprefix', adminGuard, async (req, res) => {
    const { username, prefix } = req.body;
    if (prefix.toLowerCase() === 'админ') return res.json({ error: 'Префикс "Админ" нельзя выдать' });
    
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

// Респекты
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

// Информация о группе
app.get('/api/admin/info', adminGuard, async (req, res) => {
    try {
        const chat = await bot.getChat(req.groupId);
        const group = verifiedGroups.get(req.groupId);
        const membersCount = await bot.getChatMembersCount(req.groupId);
        res.json({ 
            id: chat.id, 
            title: chat.title, 
            members_count: membersCount, 
            captcha_enabled: group?.settings?.captchaEnabled !== false,
            antiSpam_enabled: group?.settings?.antiSpamEnabled !== false
        });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// ========== КОМАНДЫ БОТА ==========

// /start — приветствие с балансом и кнопкой открыть приложение
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Бонус 5 звёзд при первом запуске
    let user = userBalance.get(userId);
    if (!user) {
        user = { stars: 5, ultraUntil: null };
        userBalance.set(userId, user);
        await bot.sendMessage(chatId, `🎉 Добро пожаловать! Вам начислено 5 ⭐ бонусных звёзд!`);
    }
    
    const stars = user.stars;
    const hasUltra = hasUltraSubscription(userId);
    
    const text = `👋 Привет, ${msg.from.first_name}!

⭐ Ваш баланс: ${stars} звёзд
${hasUltra ? '🌟 ULTRA подписка активна!' : '💎 ULTRA подписка неактивна'}

Спасибо, что используете меня! 

✨ 5 бонусных звёзд уже на вашем счету.
⭐ Звёзды тратятся на префиксы и ULTRA подписку.

Нажмите кнопку ниже, чтобы открыть мини-приложение.`;
    
    const sentMsg = await bot.sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 Открыть мини-приложение',
                web_app: { url: `https://your-domain.com?user_id=${userId}` }
            }]]
        }
    });
    
    await animateTyping(chatId, sentMsg.message_id, text, 30);
});

// /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const sentMsg = await bot.sendMessage(chatId, '');
    const text = `📋 Команды:
/start - приветствие с балансом
/help - помощь
/app - открыть мини-приложение

⭐ Звёзды можно потратить на:
• Префикс — 50 ⭐
• ULTRA подписка для админа — 5 ⭐

👮‍♂️ Все настройки группы в мини-приложении!`;
    await animateTyping(chatId, sentMsg.message_id, text, 30);
});

// /app — открыть мини-приложение
bot.onText(/\/app/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, '🚀 Открываю мини-приложение...', {
        reply_markup: {
            inline_keyboard: [[{
                text: '🔧 Открыть панель управления',
                web_app: { url: `https://your-domain.com?user_id=${userId}` }
            }]]
        }
    });
});

// ========== ОБРАБОТЧИКИ СООБЩЕНИЙ ==========

// Антиспам
bot.on('message', async (msg) => {
    if (msg.chat.type === 'private') return;
    if (!isGroupVerified(msg.chat.id)) return;
    
    const group = verifiedGroups.get(msg.chat.id);
    if (group?.settings?.antiSpamEnabled !== false) {
        const isSpam = await checkSpam(msg.chat.id, msg.from.id, msg.text || '');
        if (isSpam) {
            try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (err) {}
            return;
        }
    }
    
    if (isMuted(msg.chat.id, msg.from.id)) {
        try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (err) {}
        const muted = mutedUsers.get(`${msg.chat.id}_${msg.from.id}`);
        await bot.sendMessage(msg.chat.id, `🔇 ${msg.from.first_name}, вы замьючены до ${new Date(muted.until).toLocaleString()}\nПричина: ${muted.reason}`);
    }
});

// Верификация группы и капча
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
        verifiedGroups.set(chatId, { 
            verified: true, 
            secretCode: pending.secretCode, 
            addedBy: pending.addedBy, 
            addedByUsername: pending.addedByUsername, 
            verifiedAt: new Date().toISOString(), 
            settings: { captchaEnabled: true, respectEnabled: true, antiSpamEnabled: true, respects: new Map() },
            ultraAdmins: []
        });
        pendingGroups.delete(chatId);
        await bot.sendMessage(chatId, `✅ Группа верифицирована! Все настройки в мини-приложении.`);
        await bot.sendMessage(pending.addedBy, `✅ Группа активирована!`);
    }
});

// Респекты
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

// Обработка оплаты
bot.on('pre_checkout_query', async (query) => {
    const payload = query.invoice_payload;
    const pending = pendingInvoices.get(payload.replace('topup_', '').replace('prefix_', ''));
    if (pending) {
        await bot.answerPreCheckoutQuery(query.id, true);
    } else {
        await bot.answerPreCheckoutQuery(query.id, false, 'Ошибка');
    }
});

bot.on('successful_payment', async (msg) => {
    const userId = msg.from.id;
    const payload = msg.successful_payment.invoice_payload;
    
    if (payload.startsWith('topup_')) {
        const invoiceId = payload.replace('topup_', '');
        const pending = pendingInvoices.get(invoiceId);
        if (pending && pending.type === 'topup') {
            const user = userBalance.get(userId) || { stars: 0 };
            user.stars += pending.amount;
            userBalance.set(userId, user);
            pendingInvoices.delete(invoiceId);
            await bot.sendMessage(userId, `✅ Баланс пополнен на ${pending.amount} ⭐! Теперь у вас ${user.stars} ⭐`);
        }
    } else if (payload.startsWith('prefix_')) {
        const invoiceId = payload.replace('prefix_', '');
        const pending = pendingInvoices.get(invoiceId);
        if (pending && pending.type === 'prefix') {
            const user = userBalance.get(userId) || { stars: 0 };
            user.stars -= pending.price;
            userBalance.set(userId, user);
            purchases.set(userId, { prefix: pending.prefix, date: new Date().toISOString() });
            pendingInvoices.delete(invoiceId);
            await bot.sendMessage(userId, `✅ Вы купили префикс [${pending.prefix}]!`);
        }
    }
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => {
    console.log(`🌐 Web App сервер запущен на порту ${PORT}`);
});

console.log('🤖 Бот запущен!');