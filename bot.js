const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ BOT_TOKEN не найден');
    process.exit(1);
}

// ========== ИНИЦИАЛИЗАЦИЯ ==========
const bot = new TelegramBot(token, { polling: true });
const BOT_ID = token.split(':')[0];

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ХРАНИЛИЩА ==========
const userBalance = new Map();
const purchases = new Map();
const pendingInvoices = new Map();
const verifiedGroups = new Map();
const pendingGroups = new Map();
const groupVerificationCodes = new Map();
const captchaPending = new Map();

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
function generateSecretCode() {
    const words = ['яблоко', 'груша', 'вишня', 'персик', 'манго', 'киви', 'лимон', 'апельсин'];
    return `${words[Math.floor(Math.random() * words.length)]}${Math.floor(Math.random() * 100)}`;
}

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function isGroupVerified(chatId) {
    return verifiedGroups.get(chatId)?.verified === true;
}

async function isAdminInGroup(chatId, userId) {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return member.status === 'administrator' || member.status === 'creator';
    } catch { return false; }
}

async function adminGuard(req, res, next) {
    const groupId = req.headers['x-telegram-group-id'];
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!groupId || !userId) return res.json({ error: 'Не указана группа' });
    if (!isGroupVerified(parseInt(groupId))) return res.json({ error: 'Группа не верифицирована' });
    const isAdmin = await isAdminInGroup(parseInt(groupId), userId);
    if (!isAdmin) return res.json({ error: 'Требуются права администратора' });
    req.groupId = parseInt(groupId);
    next();
}

// ========== МУТ/БАН ==========
async function muteUserReal(chatId, userId, durationSeconds, reason = 'Не указана') {
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
        const dateStr = new Date(untilDate * 1000).toLocaleString();
        await bot.sendMessage(chatId, `🔇 Пользователь замьючен до ${dateStr}\nПричина: ${reason}`);
        return true;
    } catch { return false; }
}

async function unmuteUserReal(chatId, userId) {
    try {
        await bot.restrictChatMember(chatId, userId, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true
        });
        await bot.sendMessage(chatId, `🔊 Пользователь размьючен`);
        return true;
    } catch { return false; }
}

async function banUserReal(chatId, userId, reason = 'Не указана') {
    try {
        await bot.banChatMember(chatId, userId);
        await bot.sendMessage(chatId, `🔨 Пользователь забанен\nПричина: ${reason}`);
        return true;
    } catch { return false; }
}

async function unbanUserReal(chatId, userId) {
    try {
        await bot.unbanChatMember(chatId, userId);
        await bot.sendMessage(chatId, `✅ Пользователь разбанен`);
        return true;
    } catch { return false; }
}

// ========== API ==========
app.use(express.json());
app.use(express.static('public'));

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
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    let targetGroup = null;
    for (const [groupId, data] of pendingGroups.entries()) {
        if (data.addedBy === userId) { targetGroup = { id: groupId, data }; break; }
    }
    if (!targetGroup) return res.json({ error: 'Нет групп. Добавьте бота в группу' });
    const code = generateSecretCode();
    groupVerificationCodes.set(targetGroup.id, { code, userId, date: Date.now() });
    res.json({ code, groupId: targetGroup.id });
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
        verifiedAt: new Date().toISOString(),
        settings: { welcomeMsg: '', goodbyeMsg: '', captchaEnabled: true, respectEnabled: true },
        respects: new Map()
    });
    pendingGroups.delete(parseInt(groupId));
    groupVerificationCodes.delete(parseInt(groupId));
    await bot.sendMessage(parseInt(groupId), `✅ Группа верифицирована!`);
    res.json({ success: true });
});

app.get('/api/admin/settings', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    res.json({ 
        welcome: group?.settings?.welcomeMsg || '', 
        goodbye: group?.settings?.goodbyeMsg || '',
        captcha_enabled: group?.settings?.captchaEnabled !== false,
        respect_enabled: group?.settings?.respectEnabled !== false
    });
});

app.post('/api/admin/setwelcome', adminGuard, async (req, res) => {
    const { welcome } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.welcomeMsg = welcome; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

app.post('/api/admin/setgoodbye', adminGuard, async (req, res) => {
    const { goodbye } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.goodbyeMsg = goodbye; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

app.post('/api/admin/captcha', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.captchaEnabled = enabled; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

app.post('/api/admin/respect-toggle', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.respectEnabled = enabled; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

app.get('/api/admin/users', adminGuard, async (req, res) => {
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const respects = verifiedGroups.get(req.groupId)?.respects || new Map();
        const users = members.map(m => ({
            id: m.user.id, first_name: m.user.first_name, username: m.user.username,
            respects: respects.get(m.user.id) || 0
        }));
        res.json({ users });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

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
        await muteUserReal(req.groupId, user.user.id, seconds, reason);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/unmute', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await unmuteUserReal(req.groupId, user.user.id);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/ban', adminGuard, async (req, res) => {
    const { username, reason } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await banUserReal(req.groupId, user.user.id, reason);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/unban', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await unbanUserReal(req.groupId, user.user.id);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.get('/api/admin/prefixes', adminGuard, async (req, res) => {
    const prefixes = [];
    for (const [userId, data] of purchases.entries()) {
        prefixes.push({ user_id: userId, first_name: data.firstName || `User_${userId}`, prefix: data.prefix });
    }
    res.json({ prefixes });
});

app.post('/api/admin/giveprefix', adminGuard, async (req, res) => {
    const { username, prefix } = req.body;
    if (prefix.toLowerCase() === 'админ') return res.json({ error: 'Префикс "Админ" нельзя выдать' });
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        purchases.set(user.user.id, { prefix, firstName: user.user.first_name });
        try { await bot.setChatAdministratorCustomTitle(req.groupId, user.user.id, prefix); } catch (err) {}
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/removeprefix', adminGuard, async (req, res) => {
    const { user_id } = req.body;
    purchases.delete(parseInt(user_id));
    res.json({ success: true });
});

app.get('/api/admin/respect-stats', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    const respects = group?.respects || new Map();
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

// ========== КОМАНДЫ БОТА ==========
const APP_URL = 'https://alsuiradmir463dhdj-hue.github.io/Y';

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!userBalance.has(userId)) userBalance.set(userId, { stars: 5 });
    const balance = userBalance.get(userId);
    await bot.sendMessage(chatId, `👋 Привет, ${msg.from.first_name}!\n\n⭐ Баланс: ${balance.stars} звёзд\n\nСпасибо, что используете меня!\n\n🔗 Мини-приложение: ${APP_URL}?user_id=${userId}`);
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `📋 Команды:
/start - приветствие
/help - помощь
/app - открыть панель
/addgroup - добавить бота в группу

⭐ Звёзды:
• Префикс — 50 ⭐
• ULTRA подписка — 5 ⭐ (30 дней)

🔗 Мини-приложение: ${APP_URL}?user_id=${msg.from.id}`);
});

bot.onText(/\/app/, async (msg) => {
    const userId = msg.from.id;
    await bot.sendMessage(msg.chat.id, `🚀 Открыть мини-приложение:\n\n${APP_URL}?user_id=${userId}`);
});

bot.onText(/\/addgroup/, async (msg) => {
    const inviteLink = `https://t.me/GguhdxfBOT?startgroup&admin=delete_messages+restrict_members+invite_users+ban_users+pin_messages+change_info`;
    await bot.sendMessage(msg.chat.id, `🤖 Добавьте меня в группу:\n\n[Нажмите сюда](${inviteLink})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// ========== ОБРАБОТЧИКИ ГРУПП ==========

bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    for (const member of msg.new_chat_members) {
        // Если добавляют бота
        if (member.id === parseInt(BOT_ID)) {
            if (isGroupVerified(chatId)) {
                await bot.sendMessage(chatId, '✅ Группа уже верифицирована');
                return;
            }
            const secretCode = generateSecretCode();
            pendingGroups.set(chatId, { 
                secretCode, 
                addedBy: msg.from.id, 
                addedByUsername: msg.from.username || msg.from.first_name 
            });
            await bot.sendMessage(chatId, `🔐 Код активации: <code>${secretCode}</code>`, { parse_mode: 'HTML' });
            await bot.sendMessage(msg.from.id, `🔐 Код: ${secretCode}`);
        }
        
        // Если добавляют обычного пользователя (капча)
        if (member.id !== parseInt(BOT_ID) && isGroupVerified(chatId)) {
            const group = verifiedGroups.get(chatId);
            const settings = group?.settings || {};
            
            if (settings.captchaEnabled !== false) {
                const captchaCode = generateCaptcha();
                captchaPending.set(`${chatId}_${member.id}`, { 
                    code: captchaCode, 
                    date: Date.now(),
                    attempts: 0
                });
                await bot.sendMessage(chatId, `👋 ${member.first_name}, для подтверждения отправьте код:\n<code>${captchaCode}</code>\n\n⏳ У вас 3 минуты.`, { 
                    parse_mode: 'HTML' 
                });
                
                // Авто-кик через 3 минуты
                setTimeout(async () => {
                    const pending = captchaPending.get(`${chatId}_${member.id}`);
                    if (pending) {
                        await bot.banChatMember(chatId, member.id);
                        await bot.unbanChatMember(chatId, member.id);
                        await bot.sendMessage(chatId, `❌ ${member.first_name} не прошёл капчу и был удалён.`);
                        captchaPending.delete(`${chatId}_${member.id}`);
                    }
                }, 3 * 60 * 1000);
                
            } else if (settings.welcomeMsg) {
                await bot.sendMessage(chatId, settings.welcomeMsg.replace('{name}', member.first_name));
            }
        }
    }
});

bot.onText(/^(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = match[1];
    if (msg.chat.type === 'private') return;
    
    // Проверка капчи для новых участников
    const captchaKey = `${chatId}_${userId}`;
    const captcha = captchaPending.get(captchaKey);
    if (captcha && text.trim().toUpperCase() === captcha.code) {
        captchaPending.delete(captchaKey);
        const group = verifiedGroups.get(chatId);
        if (group?.settings?.welcomeMsg) {
            await bot.sendMessage(chatId, group.settings.welcomeMsg.replace('{name}', msg.from.first_name));
        } else {
            await bot.sendMessage(chatId, `✅ ${msg.from.first_name}, добро пожаловать!`);
        }
        return;
    }
    
    // Проверка кода верификации группы
    const pending = pendingGroups.get(chatId);
    if (pending && text.trim() === pending.secretCode) {
        verifiedGroups.set(chatId, {
            verified: true,
            addedBy: pending.addedBy,
            addedByUsername: pending.addedByUsername,
            verifiedAt: new Date().toISOString(),
            settings: { welcomeMsg: '', goodbyeMsg: '', captchaEnabled: true, respectEnabled: true },
            respects: new Map()
        });
        pendingGroups.delete(chatId);
        await bot.sendMessage(chatId, `✅ Группа верифицирована!`);
        await bot.sendMessage(pending.addedBy, `✅ Группа активирована!`);
    }
});

bot.on('left_chat_member', async (msg) => {
    const chatId = msg.chat.id;
    const leftMember = msg.left_chat_member;
    if (leftMember.id === parseInt(BOT_ID)) {
        verifiedGroups.delete(chatId);
        pendingGroups.delete(chatId);
        return;
    }
    const group = verifiedGroups.get(chatId);
    if (group?.settings?.goodbyeMsg) {
        await bot.sendMessage(chatId, group.settings.goodbyeMsg.replace('{name}', leftMember.first_name));
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
    if (fromId.toString() === targetUsername) return;
    
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        
        const respects = group.respects || new Map();
        const current = respects.get(target.user.id) || 0;
        respects.set(target.user.id, current + 1);
        group.respects = respects;
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
    
    const respects = group.respects || new Map();
    const current = respects.get(targetId) || 0;
    respects.set(targetId, current + 1);
    group.respects = respects;
    verifiedGroups.set(chatId, group);
    
    await bot.sendMessage(chatId, `⭐ ${msg.from.first_name} дал респект ${msg.reply_to_message.from.first_name}! Всего респектов: ${current + 1}`);
});

// Обработка оплаты
bot.on('pre_checkout_query', async (query) => {
    await bot.answerPreCheckoutQuery(query.id, true);
});

bot.on('successful_payment', async (msg) => {
    await bot.sendMessage(msg.chat.id, `✅ Оплата прошла успешно!`);
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => console.log(`🌐 Сервер на порту ${PORT}`));
console.log('🤖 Бот запущен!');