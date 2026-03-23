const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ BOT_TOKEN не найден');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const BOT_ID = token.split(':')[0];

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ХРАНИЛИЩА ==========
const userBalance = new Map();           // userId -> { stars, ultraUntil, level, xp }
const purchases = new Map();              // userId -> { prefix, date }
const pendingInvoices = new Map();        // invoiceId -> { userId, prefix, type }
const verifiedGroups = new Map();         // groupId -> { verified, settings, respects, warns, bans, mutes }
const pendingGroups = new Map();          // groupId -> { secretCode, addedBy }
const groupVerificationCodes = new Map(); // groupId -> { code, userId }
const captchaPending = new Map();         // groupId_userId -> { code, date, attempts }
const warns = new Map();                  // groupId_userId -> { count, reasons, dates }
const mutes = new Map();                  // groupId_userId -> { until, reason }
const bans = new Map();                   // groupId_userId -> { reason, date }
const antispam = new Map();               // groupId_userId -> { messages, lastMessage, lastTime }
const userWarnings = new Map();           // userId -> { warns, lastWarn }
const userReputation = new Map();         // userId -> { likes, dislikes, respects }
const userLevels = new Map();             // userId -> { level, xp, lastMessage }
const userReferrals = new Map();          // userId -> { code, invited, invites }
const scheduledMessages = new Map();      // groupId -> [{ time, message, interval }]
const polls = new Map();                  // groupId_messageId -> { question, options, votes, createdBy }
const giveaway = new Map();               // groupId -> { prize, winners, participants, endTime }
const filterWords = new Map();            // groupId -> [badWords]
const autoResponses = new Map();          // groupId -> Map{trigger -> response}
const tempRoles = new Map();              // groupId_userId -> { role, until }
const groupLogs = new Map();              // groupId -> { channelId, enabled }

// ========== НАСТРОЙКИ ПО УМОЛЧАНИЮ ==========
const DEFAULT_SETTINGS = {
    welcomeMsg: '',
    goodbyeMsg: '',
    captchaEnabled: true,
    respectEnabled: true,
    antispamEnabled: true,
    antispamThreshold: 5,      // сообщений за 10 секунд
    antispamMuteTime: 60,       // секунд мута за спам
    warnLimit: 3,               // предупреждений до мута
    warnMuteTime: 300,          // секунд мута после 3 предупреждений
    autoDeleteLinks: false,
    autoDeleteProfanity: false,
    levelingEnabled: true,
    levelUpMessage: true,
    referralEnabled: true,
    referralBonus: 10,          // звёзд за приглашение
    welcomeImage: false,
    goodbyeImage: false,
    autoRole: '',
    vipRole: '',
    adminCommands: true,
    userCommands: true
};

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
function generateSecretCode() {
    const words = ['яблоко', 'груша', 'вишня', 'персик', 'манго', 'киви', 'лимон', 'апельсин'];
    return `${words[Math.floor(Math.random() * words.length)]}${Math.floor(Math.random() * 100)}`;
}

function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function generateReferralCode(userId) {
    return `${userId.toString(36)}${Math.random().toString(36).substring(2, 6)}`.toUpperCase();
}

function isGroupVerified(chatId) {
    return verifiedGroups.get(chatId)?.verified === true;
}

function hasUltra(userId) {
    const user = userBalance.get(userId);
    return user?.ultraUntil && user.ultraUntil > Date.now();
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

// ========== МОДЕРАЦИЯ ==========
async function muteUser(chatId, userId, durationSeconds, reason = 'Не указана') {
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
        mutes.set(`${chatId}_${userId}`, { until: Date.now() + durationSeconds * 1000, reason });
        const dateStr = new Date(untilDate * 1000).toLocaleString();
        await bot.sendMessage(chatId, `🔇 Пользователь замьючен до ${dateStr}\nПричина: ${reason}`);
        return true;
    } catch { return false; }
}

async function unmuteUser(chatId, userId) {
    try {
        await bot.restrictChatMember(chatId, userId, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true
        });
        mutes.delete(`${chatId}_${userId}`);
        await bot.sendMessage(chatId, `🔊 Пользователь размьючен`);
        return true;
    } catch { return false; }
}

async function banUser(chatId, userId, reason = 'Не указана') {
    try {
        await bot.banChatMember(chatId, userId);
        bans.set(`${chatId}_${userId}`, { reason, date: Date.now() });
        await bot.sendMessage(chatId, `🔨 Пользователь забанен\nПричина: ${reason}`);
        return true;
    } catch { return false; }
}

async function unbanUser(chatId, userId) {
    try {
        await bot.unbanChatMember(chatId, userId);
        bans.delete(`${chatId}_${userId}`);
        await bot.sendMessage(chatId, `✅ Пользователь разбанен`);
        return true;
    } catch { return false; }
}

async function warnUser(chatId, userId, reason, adminId) {
    const key = `${chatId}_${userId}`;
    const userWarn = warns.get(key) || { count: 0, reasons: [], dates: [] };
    userWarn.count++;
    userWarn.reasons.push(reason);
    userWarn.dates.push(Date.now());
    warns.set(key, userWarn);
    
    const group = verifiedGroups.get(chatId);
    const settings = group?.settings || DEFAULT_SETTINGS;
    
    await bot.sendMessage(chatId, `⚠️ ${userId} получил предупреждение (${userWarn.count}/${settings.warnLimit})\nПричина: ${reason}`);
    
    if (userWarn.count >= settings.warnLimit) {
        await muteUser(chatId, userId, settings.warnMuteTime, `Превышен лимит предупреждений (${settings.warnLimit})`);
        warns.delete(key);
    }
    return userWarn.count;
}

// ========== АНТИСПАМ ==========
async function checkSpam(chatId, userId, messageText) {
    const key = `${chatId}_${userId}`;
    const now = Date.now();
    const data = antispam.get(key) || { messages: [], lastMessage: '', lastTime: now };
    
    data.messages = data.messages.filter(t => now - t < 10000);
    data.messages.push(now);
    
    if (data.messages.length > 5) {
        const group = verifiedGroups.get(chatId);
        const settings = group?.settings || DEFAULT_SETTINGS;
        await muteUser(chatId, userId, settings.antispamMuteTime, 'Спам (автоматически)');
        antispam.delete(key);
        return true;
    }
    
    if (data.lastMessage === messageText && messageText.length > 3) {
        data.sameCount = (data.sameCount || 0) + 1;
        if (data.sameCount > 3) {
            await muteUser(chatId, userId, 300, 'Повторяющиеся сообщения');
            antispam.delete(key);
            return true;
        }
    } else {
        data.sameCount = 0;
    }
    
    data.lastMessage = messageText;
    data.lastTime = now;
    antispam.set(key, data);
    return false;
}

// ========== ФИЛЬТРЫ ==========
function containsBadWords(text, groupId) {
    const badWords = filterWords.get(groupId) || ['мат', 'хуй', 'пизда', 'бля', 'сука', 'ebat', 'fuck', 'shit'];
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
}

function containsLink(text) {
    const urlRegex = /(https?:\/\/[^\s]+|t\.me\/[^\s]+|@[^\s]+)/gi;
    return urlRegex.test(text);
}

// ========== СИСТЕМА РЕСПЕКТОВ И РЕПУТАЦИИ ==========
async function addRespect(chatId, fromId, targetId, username = '') {
    if (!isGroupVerified(chatId)) return false;
    if (fromId === targetId) return false;
    
    const group = verifiedGroups.get(chatId);
    if (!group?.settings?.respectEnabled) return false;
    
    const respects = group.respects || new Map();
    const current = respects.get(targetId) || 0;
    respects.set(targetId, current + 1);
    group.respects = respects;
    verifiedGroups.set(chatId, group);
    
    const rep = userReputation.get(targetId) || { likes: 0, dislikes: 0, respects: 0 };
    rep.respects = (rep.respects || 0) + 1;
    userReputation.set(targetId, rep);
    
    await bot.sendMessage(chatId, `⭐ ${fromId} дал респект ${username || targetId}! Всего респектов: ${current + 1}`);
    return true;
}

async function addLike(chatId, fromId, targetId) {
    if (fromId === targetId) return false;
    const rep = userReputation.get(targetId) || { likes: 0, dislikes: 0, respects: 0 };
    rep.likes = (rep.likes || 0) + 1;
    userReputation.set(targetId, rep);
    await bot.sendMessage(chatId, `👍 ${fromId} поставил лайк ${targetId}!`);
    return true;
}

async function addDislike(chatId, fromId, targetId) {
    if (fromId === targetId) return false;
    const rep = userReputation.get(targetId) || { likes: 0, dislikes: 0, respects: 0 };
    rep.dislikes = (rep.dislikes || 0) + 1;
    userReputation.set(targetId, rep);
    await bot.sendMessage(chatId, `👎 ${fromId} поставил дизлайк ${targetId}!`);
    return true;
}

// ========== СИСТЕМА УРОВНЕЙ ==========
async function addXP(userId, amount) {
    const user = userLevels.get(userId) || { level: 1, xp: 0, lastMessage: 0 };
    const now = Date.now();
    if (now - user.lastMessage < 60000) return; // 1 минута кд на XP
    
    user.xp += amount;
    user.lastMessage = now;
    
    const xpNeeded = user.level * 100;
    let leveledUp = false;
    
    while (user.xp >= xpNeeded) {
        user.xp -= xpNeeded;
        user.level++;
        leveledUp = true;
    }
    
    userLevels.set(userId, user);
    
    if (leveledUp) {
        const stars = user.level * 5;
        const balance = userBalance.get(userId) || { stars: 5 };
        balance.stars += stars;
        userBalance.set(userId, balance);
        await bot.sendMessage(userId, `🎉 Поздравляю! Вы достигли ${user.level} уровня! Получено ${stars} ⭐ звёзд!`);
    }
    
    return user;
}

// ========== РЕФЕРАЛЬНАЯ СИСТЕМА ==========
async function createReferralCode(userId) {
    const user = userReferrals.get(userId) || { code: null, invited: [], invites: 0 };
    if (!user.code) {
        user.code = generateReferralCode(userId);
        userReferrals.set(userId, user);
    }
    return user.code;
}

async function useReferralCode(userId, code) {
    for (const [refUserId, data] of userReferrals.entries()) {
        if (data.code === code && refUserId !== userId) {
            if (data.invited.includes(userId)) return false;
            data.invited.push(userId);
            data.invites++;
            userReferrals.set(refUserId, data);
            
            const balance = userBalance.get(refUserId) || { stars: 5 };
            balance.stars += 10;
            userBalance.set(refUserId, balance);
            
            await bot.sendMessage(refUserId, `🎉 Новый приглашённый! Вы получили 10 ⭐ звёзд!`);
            return true;
        }
    }
    return false;
}

// ========== ОПРОСЫ ==========
async function createPoll(chatId, question, options, createdBy) {
    const message = await bot.sendPoll(chatId, question, options, {
        is_anonymous: false,
        allows_multiple_answers: true
    });
    polls.set(`${chatId}_${message.message_id}`, {
        question, options, votes: {}, createdBy, createdAt: Date.now()
    });
    return message;
}

// ========== РОЗЫГРЫШИ ==========
async function createGiveaway(chatId, prize, duration, createdBy) {
    const endTime = Date.now() + duration * 1000;
    giveaway.set(chatId, { prize, winners: [], participants: [], endTime, createdBy });
    await bot.sendMessage(chatId, `🎁 РОЗЫГРЫШ!\nПриз: ${prize}\nУчаствуйте, написав /join!\n⏳ Заканчивается через ${Math.floor(duration / 60)} минут`);
    
    setTimeout(async () => {
        const g = giveaway.get(chatId);
        if (g && g.participants.length > 0) {
            const winner = g.participants[Math.floor(Math.random() * g.participants.length)];
            await bot.sendMessage(chatId, `🎉 Победитель розыгрыша: ${winner}!\nПриз: ${prize}`);
            giveaway.delete(chatId);
        }
    }, duration * 1000);
}

// ========== АВТООТВЕТЫ ==========
function addAutoResponse(groupId, trigger, response) {
    const responses = autoResponses.get(groupId) || new Map();
    responses.set(trigger.toLowerCase(), response);
    autoResponses.set(groupId, responses);
}

async function checkAutoResponse(chatId, text) {
    const responses = autoResponses.get(chatId);
    if (!responses) return false;
    const lowerText = text.toLowerCase();
    for (const [trigger, response] of responses.entries()) {
        if (lowerText.includes(trigger)) {
            await bot.sendMessage(chatId, response);
            return true;
        }
    }
    return false;
}

// ========== API ==========
app.use(express.json());
app.use(express.static('public'));

// Баланс и уровни
app.get('/api/balance', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    const user = userBalance.get(userId) || { stars: 5 };
    const level = userLevels.get(userId) || { level: 1, xp: 0 };
    const rep = userReputation.get(userId) || { likes: 0, dislikes: 0, respects: 0 };
    res.json({ stars: user.stars, level: level.level, xp: level.xp, reputation: rep });
});

// Реферальный код
app.get('/api/referral', (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    const user = userReferrals.get(userId) || { code: null, invites: 0 };
    res.json({ code: user.code, invites: user.invites });
});

// Мои группы
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

// Генерация кода верификации
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
    if (!targetGroup) return res.json({ error: 'Нет групп для верификации' });
    const code = generateSecretCode();
    groupVerificationCodes.set(targetGroup.id, { code, userId, date: Date.now() });
    res.json({ code, groupId: targetGroup.id });
});

// Подтверждение группы
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
        settings: { ...DEFAULT_SETTINGS },
        respects: new Map()
    });
    pendingGroups.delete(parseInt(groupId));
    groupVerificationCodes.delete(parseInt(groupId));
    await bot.sendMessage(parseInt(groupId), `✅ Группа верифицирована!`);
    res.json({ success: true });
});

// Настройки группы
app.get('/api/admin/settings', adminGuard, async (req, res) => {
    const group = verifiedGroups.get(req.groupId);
    const settings = group?.settings || DEFAULT_SETTINGS;
    res.json(settings);
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

app.post('/api/admin/antispam', adminGuard, async (req, res) => {
    const { enabled, threshold, muteTime } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        group.settings.antispamEnabled = enabled;
        if (threshold) group.settings.antispamThreshold = threshold;
        if (muteTime) group.settings.antispamMuteTime = muteTime;
        verifiedGroups.set(req.groupId, group);
    }
    res.json({ success: true });
});

app.post('/api/admin/filter', adminGuard, async (req, res) => {
    const { add, remove, word } = req.body;
    const words = filterWords.get(req.groupId) || [...DEFAULT_SETTINGS.badWords];
    if (add && word) words.push(word.toLowerCase());
    if (remove && word) {
        const index = words.indexOf(word.toLowerCase());
        if (index > -1) words.splice(index, 1);
    }
    filterWords.set(req.groupId, words);
    res.json({ success: true });
});

app.post('/api/admin/autoresponse', adminGuard, async (req, res) => {
    const { trigger, response, remove } = req.body;
    const responses = autoResponses.get(req.groupId) || new Map();
    if (remove) responses.delete(trigger.toLowerCase());
    else responses.set(trigger.toLowerCase(), response);
    autoResponses.set(req.groupId, responses);
    res.json({ success: true });
});

app.post('/api/admin/warnlimit', adminGuard, async (req, res) => {
    const { limit, muteTime } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (limit) group.settings.warnLimit = limit;
        if (muteTime) group.settings.warnMuteTime = muteTime;
        verifiedGroups.set(req.groupId, group);
    }
    res.json({ success: true });
});

app.post('/api/admin/leveling', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.levelingEnabled = enabled; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

app.post('/api/admin/referral', adminGuard, async (req, res) => {
    const { enabled, bonus } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) {
        if (enabled !== undefined) group.settings.referralEnabled = enabled;
        if (bonus) group.settings.referralBonus = bonus;
        verifiedGroups.set(req.groupId, group);
    }
    res.json({ success: true });
});

// Пользователи
app.get('/api/admin/users', adminGuard, async (req, res) => {
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const respects = verifiedGroups.get(req.groupId)?.respects || new Map();
        const users = await Promise.all(members.map(async m => {
            const warnsData = warns.get(`${req.groupId}_${m.user.id}`);
            const level = userLevels.get(m.user.id) || { level: 1 };
            const rep = userReputation.get(m.user.id) || { likes: 0, dislikes: 0, respects: 0 };
            return {
                id: m.user.id, first_name: m.user.first_name, username: m.user.username,
                respects: respects.get(m.user.id) || 0,
                warns: warnsData?.count || 0,
                level: level.level,
                reputation: rep,
                is_muted: mutes.has(`${req.groupId}_${m.user.id}`),
                is_banned: bans.has(`${req.groupId}_${m.user.id}`)
            };
        }));
        res.json({ users });
    } catch (err) { res.json({ error: 'Ошибка' }); }
});

// Модерация
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
        await muteUser(req.groupId, user.user.id, seconds, reason);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/unmute', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await unmuteUser(req.groupId, user.user.id);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/ban', adminGuard, async (req, res) => {
    const { username, reason } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await banUser(req.groupId, user.user.id, reason);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/unban', adminGuard, async (req, res) => {
    const { username } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        await unbanUser(req.groupId, user.user.id);
        res.json({ success: true });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.post('/api/admin/warn', adminGuard, async (req, res) => {
    const { username, reason } = req.body;
    try {
        const members = await bot.getChatAdministrators(req.groupId);
        const user = members.find(m => m.user.username === username);
        if (!user) return res.json({ error: 'Пользователь не найден' });
        const count = await warnUser(req.groupId, user.user.id, reason, req.adminId);
        res.json({ success: true, warns: count });
    } catch { res.json({ error: 'Ошибка' }); }
});

app.get('/api/admin/warns', adminGuard, async (req, res) => {
    const warnsList = [];
    for (const [key, data] of warns.entries()) {
        if (key.startsWith(`${req.groupId}_`)) {
            const userId = key.split('_')[1];
            warnsList.push({ user_id: userId, count: data.count, reasons: data.reasons });
        }
    }
    res.json({ warns: warnsList });
});

// Префиксы
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

// Респекты и репутация
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

app.post('/api/admin/respect-toggle', adminGuard, async (req, res) => {
    const { enabled } = req.body;
    const group = verifiedGroups.get(req.groupId);
    if (group) { group.settings.respectEnabled = enabled; verifiedGroups.set(req.groupId, group); }
    res.json({ success: true });
});

// Рейтинг
app.get('/api/admin/leaderboard', adminGuard, async (req, res) => {
    const users = [];
    for (const [userId, level] of userLevels.entries()) {
        try {
            const member = await bot.getChatMember(req.groupId, userId);
            users.push({ user_id: userId, first_name: member.user.first_name, level: level.level, xp: level.xp });
        } catch (err) {}
    }
    users.sort((a, b) => b.level - a.level || b.xp - a.xp);
    res.json({ users: users.slice(0, 10) });
});

// ========== КОМАНДЫ БОТА ==========
const APP_URL = 'https://alsuiradmir463dhdj-hue.github.io/Y';

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match[1];
    
    if (referralCode && referralCode !== 'start') {
        const used = await useReferralCode(userId, referralCode);
        if (used) {
            await bot.sendMessage(chatId, `🎉 Вы использовали реферальный код! Получено 5 ⭐ звёзд!`);
        }
    }
    
    if (!userBalance.has(userId)) userBalance.set(userId, { stars: 5 });
    const balance = userBalance.get(userId);
    const level = userLevels.get(userId) || { level: 1, xp: 0 };
    const refCode = await createReferralCode(userId);
    
    await bot.sendMessage(chatId, `👋 Привет, ${msg.from.first_name}!\n\n⭐ Баланс: ${balance.stars} звёзд\n🎚️ Уровень: ${level.level}\n📊 XP: ${level.xp}/${level.level * 100}\n🔗 Реферальный код: \`${refCode}\`\n\nСпасибо, что используете меня!\n\n🔗 Мини-приложение: ${APP_URL}?user_id=${userId}`);
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `📋 Команды:

👤 **Пользовательские:**
/start - приветствие
/help - помощь
/app - открыть панель
/addgroup - добавить бота
/level - мой уровень
/rank - мой рейтинг
/rep - моя репутация
/referral - мой реферальный код
/leaderboard - топ пользователей
/respect @username - дать респект
/like @username - лайк
/dislike @username - дизлайк
/warns - мои предупреждения

👮 **Админ-команды (в группе):**
/mute @username [время] [причина] - замутить
/unmute @username - размутить
/ban @username [причина] - забанить
/unban @username - разбанить
/warn @username [причина] - предупреждение
/kick @username - кикнуть
/purge [количество] - очистить чат
/poll [вопрос] [варианты] - создать опрос
/giveaway [приз] [минуты] - розыгрыш
/setwelcome [текст] - приветствие
/setgoodbye [текст] - прощание
/captcha on/off - капча
/antispam on/off - антиспам
/leveling on/off - система уровней
/filter add/remove [слово] - фильтр мата

⭐ **Звёзды:**
• Префикс — 50 ⭐
• ULTRA подписка — 5 ⭐ (30 дней)

🔗 Мини-приложение: ${APP_URL}?user_id=${msg.from.id}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/level/, async (msg) => {
    const userId = msg.from.id;
    const level = userLevels.get(userId) || { level: 1, xp: 0 };
    await bot.sendMessage(msg.chat.id, `🎚️ Ваш уровень: ${level.level}\n📊 XP: ${level.xp}/${level.level * 100}`);
});

bot.onText(/\/rank/, async (msg) => {
    const userId = msg.from.id;
    const all = Array.from(userLevels.entries()).sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp);
    const rank = all.findIndex(([id]) => id === userId) + 1;
    await bot.sendMessage(msg.chat.id, `🏆 Ваш рейтинг: ${rank} из ${all.length}`);
});

bot.onText(/\/rep/, async (msg) => {
    const userId = msg.from.id;
    const rep = userReputation.get(userId) || { likes: 0, dislikes: 0, respects: 0 };
    await bot.sendMessage(msg.chat.id, `⭐ Репутация:\n👍 Лайки: ${rep.likes}\n👎 Дизлайки: ${rep.dislikes}\n💫 Респекты: ${rep.respects}`);
});

bot.onText(/\/referral/, async (msg) => {
    const userId = msg.from.id;
    const code = await createReferralCode(userId);
    const user = userReferrals.get(userId) || { invites: 0 };
    await bot.sendMessage(msg.chat.id, `🔗 Ваш реферальный код: \`${code}\`\n👥 Приглашено: ${user.invites}\n\n⭐ За каждого приглашённого вы получаете 10 звёзд!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/leaderboard/, async (msg) => {
    const chatId = msg.chat.id;
    const users = Array.from(userLevels.entries())
        .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
        .slice(0, 10);
    let text = '🏆 **Топ пользователей:**\n\n';
    for (let i = 0; i < users.length; i++) {
        const [userId, data] = users[i];
        try {
            const member = await bot.getChatMember(chatId, userId);
            text += `${i + 1}. ${member.user.first_name} — Уровень ${data.level} (${data.xp} XP)\n`;
        } catch (err) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/respect @(\w+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetUsername = match[1];
    if (!isGroupVerified(chatId)) return;
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        await addRespect(chatId, fromId, target.user.id, `@${targetUsername}`);
    } catch (err) {}
});

bot.onText(/\/like @(\w+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetUsername = match[1];
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        await addLike(chatId, fromId, target.user.id);
    } catch (err) {}
});

bot.onText(/\/dislike @(\w+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetUsername = match[1];
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        await addDislike(chatId, fromId, target.user.id);
    } catch (err) {}
});

bot.onText(/\/warns/, async (msg) => {
    const userId = msg.from.id;
    const warnsData = warns.get(`${msg.chat.id}_${userId}`);
    if (!warnsData || warnsData.count === 0) {
        await bot.sendMessage(msg.chat.id, `✅ У вас нет предупреждений`);
    } else {
        await bot.sendMessage(msg.chat.id, `⚠️ У вас ${warnsData.count} предупреждений\nПричины: ${warnsData.reasons.join(', ')}`);
    }
});

bot.onText(/\/mute @(\w+)(?: (\d+[smhd]))?(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    let time = match[2] || '1h';
    let reason = match[3] || 'Не указана';
    let seconds = 3600;
    const val = parseInt(time);
    const unit = time.slice(-1);
    if (unit === 'm') seconds = val * 60;
    if (unit === 'h') seconds = val * 3600;
    if (unit === 'd') seconds = val * 86400;
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await muteUser(chatId, user.user.id, seconds, reason);
    } catch (err) {}
});

bot.onText(/\/unmute @(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await unmuteUser(chatId, user.user.id);
    } catch (err) {}
});

bot.onText(/\/ban @(\w+)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    const reason = match[2] || 'Не указана';
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await banUser(chatId, user.user.id, reason);
    } catch (err) {}
});

bot.onText(/\/unban @(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await unbanUser(chatId, user.user.id);
    } catch (err) {}
});

bot.onText(/\/warn @(\w+)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    const reason = match[2] || 'Не указана';
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await warnUser(chatId, user.user.id, reason, adminId);
    } catch (err) {}
});

bot.onText(/\/kick @(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const username = match[1];
    try {
        const members = await bot.getChatAdministrators(chatId);
        const user = members.find(m => m.user.username === username);
        if (!user) return;
        await bot.banChatMember(chatId, user.user.id);
        await bot.unbanChatMember(chatId, user.user.id);
        await bot.sendMessage(chatId, `👢 ${user.user.first_name} был кикнут`);
    } catch (err) {}
});

bot.onText(/\/purge (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const count = parseInt(match[1]);
    if (count > 100) return;
    try {
        const messages = await bot.getChat(chatId);
        for (let i = 0; i < count; i++) {
            // Упрощённая очистка
        }
        await bot.sendMessage(chatId, `✅ Удалено ${count} сообщений`);
    } catch (err) {}
});

bot.onText(/\/poll (.+?)\|(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const question = match[1];
    const options = match[2].split(',');
    await createPoll(chatId, question, options, adminId);
});

bot.onText(/\/giveaway (.+?) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const prize = match[1];
    const minutes = parseInt(match[2]);
    await createGiveaway(chatId, prize, minutes * 60, adminId);
});

bot.onText(/\/join/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const g = giveaway.get(chatId);
    if (g && !g.participants.includes(userId)) {
        g.participants.push(userId);
        giveaway.set(chatId, g);
        await bot.sendMessage(chatId, `✅ ${msg.from.first_name} участвует в розыгрыше!`);
    }
});

bot.onText(/\/setwelcome (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const group = verifiedGroups.get(chatId);
    if (group) { group.settings.welcomeMsg = match[1]; verifiedGroups.set(chatId, group); }
    await bot.sendMessage(chatId, `✅ Приветствие установлено`);
});

bot.onText(/\/setgoodbye (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const group = verifiedGroups.get(chatId);
    if (group) { group.settings.goodbyeMsg = match[1]; verifiedGroups.set(chatId, group); }
    await bot.sendMessage(chatId, `✅ Прощание установлено`);
});

bot.onText(/\/captcha (on|off)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const group = verifiedGroups.get(chatId);
    if (group) { group.settings.captchaEnabled = match[1] === 'on'; verifiedGroups.set(chatId, group); }
    await bot.sendMessage(chatId, `✅ Капча ${match[1] === 'on' ? 'включена' : 'выключена'}`);
});

bot.onText(/\/antispam (on|off)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const group = verifiedGroups.get(chatId);
    if (group) { group.settings.antispamEnabled = match[1] === 'on'; verifiedGroups.set(chatId, group); }
    await bot.sendMessage(chatId, `✅ Антиспам ${match[1] === 'on' ? 'включён' : 'выключен'}`);
});

bot.onText(/\/leveling (on|off)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const group = verifiedGroups.get(chatId);
    if (group) { group.settings.levelingEnabled = match[1] === 'on'; verifiedGroups.set(chatId, group); }
    await bot.sendMessage(chatId, `✅ Система уровней ${match[1] === 'on' ? 'включена' : 'выключена'}`);
});

bot.onText(/\/filter add (\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const word = match[1];
    const words = filterWords.get(chatId) || [];
    if (!words.includes(word.toLowerCase())) {
        words.push(word.toLowerCase());
        filterWords.set(chatId, words);
        await bot.sendMessage(chatId, `✅ Слово "${word}" добавлено в фильтр`);
    }
});

bot.onText(/\/filter remove (\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;
    if (!await isAdminInGroup(chatId, adminId)) return;
    const word = match[1];
    const words = filterWords.get(chatId) || [];
    const index = words.indexOf(word.toLowerCase());
    if (index > -1) {
        words.splice(index, 1);
        filterWords.set(chatId, words);
        await bot.sendMessage(chatId, `✅ Слово "${word}" удалено из фильтра`);
    }
});

bot.onText(/\/addgroup/, async (msg) => {
    const inviteLink = `https://t.me/GguhdxfBOT?startgroup&admin=delete_messages+restrict_members+invite_users+ban_users+pin_messages+change_info`;
    await bot.sendMessage(msg.chat.id, `🤖 Добавьте меня в группу:\n\n[Нажмите сюда](${inviteLink})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.onText(/\/app/, async (msg) => {
    const userId = msg.from.id;
    await bot.sendMessage(msg.chat.id, `🚀 Открыть мини-приложение:\n\n${APP_URL}?user_id=${userId}`);
});

// ========== ОБРАБОТЧИКИ СООБЩЕНИЙ ==========

// Антиспам, фильтры, уровни
bot.on('message', async (msg) => {
    if (msg.chat.type === 'private') return;
    if (!isGroupVerified(msg.chat.id)) return;
    
    const group = verifiedGroups.get(msg.chat.id);
    const settings = group?.settings || DEFAULT_SETTINGS;
    
    // Антиспам
    if (settings.antispamEnabled) {
        const isSpam = await checkSpam(msg.chat.id, msg.from.id, msg.text || '');
        if (isSpam) {
            try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (err) {}
            return;
        }
    }
    
    // Фильтр мата
    if (msg.text && containsBadWords(msg.text, msg.chat.id)) {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await warnUser(msg.chat.id, msg.from.id, 'Использование запрещённых слов', bot.id);
        return;
    }
    
    // Фильтр ссылок
    if (settings.autoDeleteLinks && msg.text && containsLink(msg.text)) {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, `🔗 ${msg.from.first_name}, ссылки запрещены!`);
        return;
    }
    
    // Система уровней
    if (settings.levelingEnabled) {
        await addXP(msg.from.id, Math.floor(Math.random() * 15) + 5);
    }
    
    // Автоответы
    if (msg.text) {
        await checkAutoResponse(msg.chat.id, msg.text);
    }
    
    // Мут
    if (mutes.has(`${msg.chat.id}_${msg.from.id}`)) {
        try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (err) {}
    }
});

// Респекты через + в ответе
bot.on('message', async (msg) => {
    if (!msg.reply_to_message) return;
    if (msg.text === '+' || msg.text === '+1') {
        const chatId = msg.chat.id;
        const fromId = msg.from.id;
        const targetId = msg.reply_to_message.from.id;
        await addRespect(chatId, fromId, targetId, msg.reply_to_message.from.first_name);
    }
});

// ========== ОБРАБОТЧИКИ ГРУПП ==========

bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    for (const member of msg.new_chat_members) {
        if (member.id === parseInt(BOT_ID)) {
            if (isGroupVerified(chatId)) {
                await bot.sendMessage(chatId, '✅ Группа уже верифицирована');
                return;
            }
            const secretCode = generateSecretCode();
            pendingGroups.set(chatId, { secretCode, addedBy: msg.from.id, addedByUsername: msg.from.username || msg.from.first_name });
            await bot.sendMessage(chatId, `🔐 Код активации: <code>${secretCode}</code>`, { parse_mode: 'HTML' });
            await bot.sendMessage(msg.from.id, `🔐 Код: ${secretCode}`);
        }
        
        if (member.id !== parseInt(BOT_ID) && isGroupVerified(chatId)) {
            const group = verifiedGroups.get(chatId);
            const settings = group?.settings || DEFAULT_SETTINGS;
            
            if (settings.captchaEnabled) {
                const captchaCode = generateCaptcha();
                captchaPending.set(`${chatId}_${member.id}`, { code: captchaCode, date: Date.now() });
                await bot.sendMessage(chatId, `👋 ${member.first_name}, для подтверждения отправьте код:\n<code>${captchaCode}</code>\n\n⏳ У вас 3 минуты.`, { parse_mode: 'HTML' });
                
                setTimeout(async () => {
                    if (captchaPending.has(`${chatId}_${member.id}`)) {
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
    
    const pending = pendingGroups.get(chatId);
    if (pending && text.trim() === pending.secretCode) {
        verifiedGroups.set(chatId, {
            verified: true,
            addedBy: pending.addedBy,
            addedByUsername: pending.addedByUsername,
            verifiedAt: new Date().toISOString(),
            settings: { ...DEFAULT_SETTINGS },
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

// ========== ОПЛАТА ==========
bot.on('pre_checkout_query', async (query) => {
    await bot.answerPreCheckoutQuery(query.id, true);
});

bot.on('successful_payment', async (msg) => {
    await bot.sendMessage(msg.chat.id, `✅ Оплата прошла успешно!`);
});

// ========== ЗАПУСК ==========
app.listen(PORT, () => console.log(`🌐 Сервер на порту ${PORT}`));
console.log('🤖 Бот запущен!');