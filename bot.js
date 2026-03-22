// ========== ГЕНЕРАЦИЯ КАПЧИ (4 символа, заглавные буквы + цифры) ==========
function generateCaptcha() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// ========== ПРОВЕРКА КАПЧИ В ГРУППЕ ==========
// При добавлении нового участника
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

// ========== ПРОВЕРКА ВВЕДЁННОГО КОДА ==========
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