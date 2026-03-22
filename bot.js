// ========== API ДЛЯ ВЕРИФИКАЦИИ ГРУПП ==========

// Хранилище для кодов верификации
const groupVerificationCodes = new Map(); // groupId -> { code, userId, date }

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

app.post('/api/generate-code', async (req, res) => {
    const userId = parseInt(req.headers['x-telegram-user-id']);
    if (!userId) return res.json({ error: 'Не авторизован' });
    
    // Находим группу, куда недавно добавили бота
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

// ========== API ДЛЯ РЕСПЕКТОВ ==========

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
    } else {
        res.json({ error: 'Группа не найдена' });
    }
});

// Обработка респектов в чате
bot.onText(/^\+респект @(\w+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const targetUsername = match[1];
    
    if (!isGroupVerified(chatId)) return;
    const group = verifiedGroups.get(chatId);
    if (!group?.settings?.respectEnabled) return;
    if (fromId === targetId) return;
    
    try {
        const members = await bot.getChatAdministrators(chatId);
        const target = members.find(m => m.user.username === targetUsername);
        if (!target) return;
        
        const respects = group.settings.respects || new Map();
        const current = respects.get(target.user.id) || 0;
        respects.set(target.user.id, current + 1);
        group.settings.respects = respects;
        verifiedGroups.set(chatId, group);
        
        await bot.sendMessage(chatId, `⭐ ${msg.from.first_name} дал респект @${targetUsername}! Всего респектов: ${current + 1}`);
    } catch (err) {}
});

// Ответ на сообщение с "+"
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