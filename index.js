require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const browserManager = require('./browserManager');
const db = require('./databaseManager');
const { generateCoupons } = require('./couponGenerator');

if (!process.env.BOT_TOKEN) {
    console.error('Error: BOT_TOKEN is missing in .env file');
    process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- Helper: Admin Check ---
const isAdmin = (userId) => {
    return process.env.ADMIN_ID && String(userId) === String(process.env.ADMIN_ID);
};

// --- Helper: Access Check ---
const checkAccess = (msg) => {
    const userId = msg.from.id;
    if (db.isAuthorized(userId)) return true;

    bot.sendMessage(msg.chat.id,
        `⛔ <b>Access Denied</b> ⛔\n\nYou are not authorized to use this bot. Contact the admin to request access.\n\nYour ID: <code>${userId}</code>`,
        { parse_mode: 'HTML' }
    );
    return false;
};

// --- Command: /start ---
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Beautiful Welcome Message (HTML)
    const welcome =
        `👋 <b>Welcome to Shein Verse Bot</b> 🛍️

<blockquote>"Your ultimate assistant for Shein coupon protection and automation." 💎</blockquote>

I can help you:
🛡️ <b>Protect</b> your valuable coupons
🤖 <b>Automate</b> boring checks
⚡ <b>Apply</b> vouchers instantly

👇 <b>Get started by choosing functionality below:</b>`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📚 Help & Commands', callback_data: 'help_menu' },
                    { text: '🆔 My ID', callback_data: 'my_id' }
                ],
                [
                    { text: '🌐 Official Shein', url: 'https://www.sheinindia.in/' }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, welcome, { parse_mode: 'HTML', ...keyboard });
});

// --- Helper: Get Help Text ---
const getHelpText = (userId) => {
    let helpText =
        `📚 <b>Shein Bot Command List</b> 📚

🔹 <b>User Commands:</b>
/start - Restart the bot and show menu
/help - Show this help message
/myid - Show your Telegram ID

🔒 <b>Authorized User Commands:</b>
/protect <code>[COUPONS]</code> - Start protecting coupons (e.g., <code>/protect CP1 CP2</code>)
/release <code>[COUPON]</code> - Stop checking a specific coupon
/check <code>[COUPONS]</code> - One-time check of coupons
/stop - Stop all protection and scanning tasks
/scan - Start wishlist or stock scan (if enabled)`;

    if (isAdmin(userId)) {
        helpText += `\n\n👮‍♂️ <b>Admin Commands:</b>
/add <code>[ID]</code> - Authorize a user ID
/remove <code>[ID]</code> - Revoke access from a user ID
/users - List all authorized users`;
    }

    helpText += `\n\n<i>Tip: Tap on a command to copy it (on mobile)</i>`;
    helpText += `\n\n<blockquote>Made with ❤️ by Hari`;
    helpText += `\n\nDev : @clickme4it </blockquote>`;

    return helpText;
};

// --- Command: /help ---
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    bot.sendMessage(chatId, getHelpText(userId), { parse_mode: 'HTML' });
});

// --- Command: /check ---
bot.onText(/\/check(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    const input = match[1];
    if (!input) {
        return bot.sendMessage(chatId, "⚠️ Usage: <code>/check COUPON1 COUPON2</code>", { parse_mode: 'HTML' });
    }

    const coupons = input.split(' ').map(c => c.trim()).filter(c => c);

    if (coupons.length === 0) {
        return bot.sendMessage(chatId, "⚠️ No valid coupons provided.", { parse_mode: 'HTML' });
    }

    bot.sendMessage(chatId, `🔍 <b>Checking ${coupons.length} coupons...</b>`, { parse_mode: 'HTML' });

    // Notify Admin
    if (process.env.ADMIN_ID && String(msg.from.id) !== String(process.env.ADMIN_ID)) {
        bot.sendMessage(process.env.ADMIN_ID, 
            `🔔 <b>Admin Alert</b>\nUser <code>${msg.from.id}</code> checking:\n<code>${coupons.join(', ')}</code>`, 
            { parse_mode: 'HTML' }
        );
    }

    try {
        const results = await browserManager.checkCoupons(coupons, { screenshot: false, detailed: true });

        let report = "🔎 <b>Check Result</b> 🔎\n\n";
        results.forEach(r => {
            const statusEmoji = r.status === 'APPLICABLE' ? '✅' : (r.status === 'INVALID' ? '❌' : '⚠️');
            report += `${statusEmoji} <code>${r.code}</code>: <b>${r.status}</b>\n`;
        });

        bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
    } catch (error) {
        console.error("Check error:", error);
        bot.sendMessage(chatId, "❌ Error checking coupons.", { parse_mode: 'HTML' });
    }
});

// --- Command: /protect ---
let protectionInterval = null;
const userProtections = new Map(); // UserId -> Set<Coupon>
const lastUserMessageIds = new Map(); // UserId -> MessageId

bot.onText(/\/protect(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!checkAccess(msg)) return;

    const input = match[1];
    if (!input) {
        return bot.sendMessage(chatId, "⚠️ Usage: <code>/protect COUPON1 COUPON2</code>", { parse_mode: 'HTML' });
    }

    const newCoupons = input.split(' ').map(c => c.trim()).filter(c => c);

    if (newCoupons.length === 0) {
        return bot.sendMessage(chatId, "⚠️ No valid coupons provided.");
    }

    if (!userProtections.has(userId)) {
        userProtections.set(userId, new Set());
    }
    const userSet = userProtections.get(userId);
    newCoupons.forEach(c => userSet.add(c));

    // Reset user's message ID to force a new message
    lastUserMessageIds.delete(userId);

    bot.sendMessage(chatId,
        `🛡️ <b>Protection Started!</b> 🛡️\n\nAdded: <code>${newCoupons.join(', ')}</code>\nYour Total Protected: ${userSet.size}\n\nI will check them every 3 minutes via API.`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⛔ Stop My Protection', callback_data: 'stop_my_protection' }]
                ]
            }
        }
    );

    // Notify Admin
    if (process.env.ADMIN_ID && String(userId) !== String(process.env.ADMIN_ID)) {
        bot.sendMessage(process.env.ADMIN_ID,
            `🔔 <b>Admin Alert</b>\nUser <code>${userId}</code> started protecting:\n<code>${newCoupons.join(', ')}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    startProtection();
});

async function startProtection() {
    if (protectionInterval) return; // Already running

    // Immediate First Run
    await runProtectionCycle();

    // Interval Run (3 mins)
    protectionInterval = setInterval(async () => {
        if (userProtections.size === 0) {
            clearInterval(protectionInterval);
            protectionInterval = null;
            return;
        }
        await runProtectionCycle();
    }, 180000);
}

async function runProtectionCycle() {
    if (userProtections.size === 0) return;

    try {
        // Gather ALL unique coupons from ALL users
        const allCoupons = new Set();
        userProtections.forEach((coupons) => {
            coupons.forEach(c => allCoupons.add(c));
        });

        if (allCoupons.size === 0) return;

        const couponsToCheck = Array.from(allCoupons);
        // Use API based check (headless logic) - efficient batch check
        const results = await browserManager.checkCoupons(couponsToCheck, { screenshot: false, detailed: true });

        // Map results for quick lookup
        const resultsMap = new Map();
        results.forEach(r => resultsMap.set(r.code, r));

        const now = new Date();
        const timeString = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Distribute results to each User
        for (const [userId, userCoupons] of userProtections) {
            if (userCoupons.size === 0) continue;

            let report = `🛡️ <b>Protection Active</b> 🛡️\n<i>Last Updated: ${timeString}</i>\n\n`;
            const userButtons = [];

            userCoupons.forEach(couponCode => {
                const r = resultsMap.get(couponCode);
                if (r) {
                    let statusIcon = '⚠️';
                    let statusText = r.status;

                    if (r.status === 'APPLICABLE') {
                        statusIcon = '✅';
                        statusText = 'APPLICABLE (Protected)';
                    } else if (r.status === 'INVALID' || r.status.includes('exist')) {
                        statusIcon = '❌';
                    } else if (r.status === 'REDEEMED' || r.status.includes('limit')) {
                        statusIcon = '🚫';
                        statusText = 'REDEEMED / USED';
                    }
                    report += `${statusIcon} <code>${couponCode}</code>: <b>${statusText}</b>\n`;
                }

                userButtons.push({
                    text: `Release ${couponCode}`,
                    callback_data: `release_${couponCode}` // We'll need user context in callback or handle globally
                });
            });

            // Chunk buttons
            const rows = [];
            for (let i = 0; i < userButtons.length; i += 2) {
                rows.push(userButtons.slice(i, i + 2));
            }
            rows.push([{ text: '⛔ Stop My Protection', callback_data: 'stop_my_protection' }]);

            const keyboard = { inline_keyboard: rows };
            const lastMsgId = lastUserMessageIds.get(userId);

            // Attempt to edit existing message
            if (lastMsgId) {
                try {
                    await bot.editMessageText(report, {
                        chat_id: userId, // Assuming userId is chatId for private chats
                        message_id: lastMsgId,
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                    continue; // Next user
                } catch (err) {
                    // Fail silently, send new
                }
            }

            // Send new message
            try {
                const sentMsg = await bot.sendMessage(userId, report, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
                lastUserMessageIds.set(userId, sentMsg.message_id);
            } catch (e) {
                console.error(`Failed to send report to ${userId}:`, e.message);
            }
        }

    } catch (error) {
        console.error("Protection cycle error:", error);
    }
}


// --- Command: /release ---
bot.onText(/\/release (.+)/, (msg, match) => {
    if (!checkAccess(msg)) return;
    const userId = msg.from.id;
    const coupon = match[1].trim();
    
    if (userProtections.has(userId)) {
        const userSet = userProtections.get(userId);
        if (userSet.delete(coupon)) {
            bot.sendMessage(msg.chat.id, `✅ Released coupon: ${coupon}`);
            // Clean up if empty
            if (userSet.size === 0) {
                userProtections.delete(userId);
                lastUserMessageIds.delete(userId);
            }
        } else {
            bot.sendMessage(msg.chat.id, `⚠️ Coupon not found in your protection list.`);
        }
    } else {
        bot.sendMessage(msg.chat.id, `⚠️ You have no active protections.`);
    }
});


// --- Command: /stop ---
bot.onText(/\/stop/, (msg) => {
    if (!checkAccess(msg)) return;
    const userId = msg.from.id;
    let response = "";
    
    // Stop Scan (Global singleton currently)
    if (browserManager.isScanning) {
        // Maybe check if this user started the scan? For now, allow stopping scan gloablly?
        // Or make stop just stop MY protection.
        // Let's assume /stop is "Stop Everything relating to me" + "Stop Scan if admin"
    }

    // Stop User Protection
    if (userProtections.has(userId)) {
        userProtections.delete(userId);
        lastUserMessageIds.delete(userId);
        response += "🛡️ Your protection tasks cleared.\n";
    }

    if (!response) response = "No active protection tasks found for you.";
    bot.sendMessage(msg.chat.id, response);
});

// --- Command: /stopall (Admin Only) ---
bot.onText(/\/stopall/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    
    userProtections.clear();
    lastUserMessageIds.clear();
    if (protectionInterval) {
        clearInterval(protectionInterval);
        protectionInterval = null;
    }
    if (browserManager.isScanning) browserManager.stopScan();

    bot.sendMessage(msg.chat.id, "🛑 <b>Stopped ALL bot tasks for ALL users!</b>", { parse_mode: 'HTML' });
});

// --- Command: /admin_status ---
bot.onText(/\/admin_status/, (msg) => {
    if (!isAdmin(msg.from.id)) return;

    if (userProtections.size === 0) {
        return bot.sendMessage(msg.chat.id, "ℹ️ No active protections.");
    }

    let status = "📊 <b>Global Protection Status</b>\n\n";
    for (const [uid, coupons] of userProtections) {
        status += `👤 <b>User ${uid}</b>: <code>${Array.from(coupons).join(', ')}</code>\n`;
    }
    bot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML' });
});

// --- Command: /myid ---
bot.onText(/\/myid/, (msg) => {
    bot.sendMessage(msg.chat.id, `🆔 Your ID: <code>${msg.from.id}</code>`, { parse_mode: 'HTML' });
});

// --- Admin Commands ---

// /add [ID]
bot.onText(/\/add (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    if (!isAdmin(userId)) return; // Silent fail for non-admins to avoid spam

    const targetId = match[1];
    if (db.addUser(targetId)) {
        bot.sendMessage(msg.chat.id, `✅ User <code>${targetId}</code> added to authorized list.`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(msg.chat.id, `⚠️ User <code>${targetId}</code> is already authorized.`, { parse_mode: 'HTML' });
    }
});

// /remove [ID]
bot.onText(/\/remove (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const targetId = match[1];
    if (db.removeUser(targetId)) {
        bot.sendMessage(msg.chat.id, `🗑️ User <code>${targetId}</code> removed.`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(msg.chat.id, `⚠️ User <code>${targetId}</code> not found.`, { parse_mode: 'HTML' });
    }
});

// /users
bot.onText(/\/users/, (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const users = db.getAuthorizedUsers();
    bot.sendMessage(msg.chat.id, `👥 <b>Authorized Users:</b>\n<code>${users.length > 0 ? users.join('\n') : 'No users added'}</code>`, { parse_mode: 'HTML' });
});

// --- Callback Query Handler ---
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Error handling wrapper for answerCallbackQuery
    const safeAnswer = (text) => {
        bot.answerCallbackQuery(query.id, { text }).catch(e => {
            // Ignore "query is too old" errors
            if (!e.message.includes('query is too old')) {
                console.error("Callback Answer Error:", e.message);
            }
        });
    };

    if (data === 'help_menu') {
        const userId = query.from.id;
        bot.sendMessage(chatId, getHelpText(userId), { parse_mode: 'HTML' });
        safeAnswer();
    } else if (data === 'my_id') {
        bot.sendMessage(chatId, `🆔 Your ID: <code>${query.from.id}</code>`, { parse_mode: 'HTML' });
        safeAnswer();
    } else if (data === 'stop_my_protection') {
        const userId = query.from.id;
        if (userProtections.has(userId)) {
            userProtections.delete(userId);
            lastUserMessageIds.delete(userId);
            bot.sendMessage(chatId, "🛑 <b>Stopped your protection tasks!</b>", { parse_mode: 'HTML' });
            safeAnswer("Stopped!");
        } else {
            safeAnswer("Nothing running!");
        }
    } else if (data.startsWith('release_')) {
        const coupon = data.replace('release_', '');
        const userId = query.from.id;
        
        if (userProtections.has(userId)) {
            const userSet = userProtections.get(userId);
            if (userSet.delete(coupon)) {
                bot.sendMessage(chatId, `✅ Released: ${coupon}`);
                safeAnswer(`Released ${coupon}`);
                if (userSet.size === 0) { // Clean up
                     userProtections.delete(userId);
                     lastUserMessageIds.delete(userId);
                }
            } else {
                safeAnswer("Coupon not found.");
            }
        } else {
            safeAnswer("No active session.");
        }
    } else {
        safeAnswer();
    }
});

console.log('Shein Verse Bot started successfully!');
