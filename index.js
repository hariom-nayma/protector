require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const browserManager = require('./browserManager');
const { generateCoupons } = require('./couponGenerator');

if (!process.env.BOT_TOKEN) {
    console.error('Error: BOT_TOKEN is missing in .env file');
    process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log('Shein Verse Bot is starting...');

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
Welcome to the <b>Shein Verse Bot</b>! 🛍️✨

<b>Commands:</b>
/login - Manual login to save session
/check [coupon1] [coupon2]... - Check specific coupons
/scan - Scan catalogs for "True Stock"
/wishlist - Scan your wishlist for in-stock items
/stop - Stop any active scan
/add_test_item [url] - Add product to cart (for testing)

<b>Example:</b>
/check SVI1234567890 SVCS0987654321
`;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🚀 Launching browser for login...\n\nI will keep the window open for <b>5 minutes</b>. Please log in to your Shein account and stay active.', { parse_mode: 'HTML' });
    try {
        await browserManager.loginManual();
        bot.sendMessage(chatId, '✅ Session update complete!');
    } catch (error) {
        bot.sendMessage(chatId, `❌ Login error: ${error.message}`);
    }
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    // Prevent matching other commands
    if (msg.text.startsWith('/login') || msg.text.startsWith('/add_test_item')) return;

    const chatId = msg.chat.id;
    const coupons = match[1].split(/\s+/).filter(c => c.length > 0);

    if (coupons.length === 0) return bot.sendMessage(chatId, '❌ Please provide at least one coupon code.');

    try {
        bot.sendMessage(chatId, `🔍 Checking ${coupons.length} coupon(s)...`);
        const results = await browserManager.checkCoupons(coupons);

        if (results.length > 0) {
            let response = "<b>Check Results:</b>\n\n";
            results.forEach(res => {
                let statusIcon = '❌';
                let statusText = res.status;

                if (res.status === 'APPLICABLE') {
                    statusIcon = '✅';
                    statusText = 'APPLICABLE (Valid & Accepted)';
                } else if (res.status === 'NOT_APPLICABLE') {
                    statusIcon = '⚠️';
                    statusText = 'NOT APPLICABLE (Valid but Restricted)';
                } else if (res.status === 'INVALID') {
                    statusIcon = '❌';
                    statusText = 'INVALID (Code incorrect/Expired)';
                } else if (res.status === 'REDEEMED') {
                    statusIcon = '🎫';
                    statusText = 'REDEEMED (Valid but already used)';
                }

                response += `${statusIcon} <code>${res.code}</code>\n┗ <i>${statusText}</i>\n\n`;
            });
            bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(chatId, '😔 No coupons could be verified.');
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

bot.on('polling_error', (error) => console.error(`[Polling Error]: ${error.message}`));

bot.onText(/\/scan\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    let customUrl = match[1].trim();

    // Default URL if none provided
    if (!customUrl) customUrl = 'https://www.sheinindia.in/c/sverse-5939-37961';

    bot.sendMessage(chatId, `🔎 <b>Starting Stock Scan...</b>\nURL: <code>${customUrl}</code>\n\nChecking for items with sizes and "Add to Bag" available.`, { parse_mode: 'HTML' });

    try {
        let foundCount = 0;
        await browserManager.scanSheinVerse(customUrl, async (item) => {
            foundCount++;
            const message = `
🎁 <b>True Stock Found!</b>
<b>Item:</b> ${item.title}
<b>Price:</b> ${item.price}
<b>Sizes:</b> ${item.sizes.join(', ')}
<b>Link:</b> <a href="${item.link}">View Item</a>
`;
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        });

        if (foundCount === 0) {
            bot.sendMessage(chatId, '🏁 Scan finished. No "True Stock" items found in this catalog.');
        } else {
            bot.sendMessage(chatId, `🏁 Scan finished. Found ${foundCount} items!`);
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Scan failed: ${error.message}`);
    }
});

bot.onText(/\/wishlist/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '💖 <b>Scanning your Wishlist for in-stock items...</b>\nURL: <code>https://www.sheinindia.in/wishlist</code>', { parse_mode: 'HTML' });

    try {
        let foundCount = 0;
        await browserManager.scanWishlist(async (item) => {
            foundCount++;
            const message = `
🌟 <b>Wishlist Item In Stock!</b>
<b>Item:</b> ${item.title}
<b>Price:</b> ${item.price}
<b>Sizes:</b> ${item.sizes.join(', ')}
<b>Link:</b> <a href="${item.link}">View Item</a>
`;
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        });

        if (foundCount === 0) {
            bot.sendMessage(chatId, '🏁 Wishlist scan finished. No in-stock items found.');
        } else {
            bot.sendMessage(chatId, `🏁 Wishlist scan finished. Found ${foundCount} items back in stock!`);
        }
    } catch (error) {
        bot.sendMessage(chatId, `❌ Wishlist scan failed: ${error.message}`);
    }
});




// --- Protection Logic ---

const protectedCoupons = new Set();
let protectionInterval = null;

const startProtection = (chatId) => {
    if (protectionInterval) clearInterval(protectionInterval);

    // Run every 3 minutes (180,000 ms)
    protectionInterval = setInterval(async () => {
        if (protectedCoupons.size === 0) {
            clearInterval(protectionInterval);
            protectionInterval = null;
            return;
        }

        const coupons = Array.from(protectedCoupons);
        console.log(`🛡️ Running protection cycle for: ${coupons.join(', ')}`);

        try {
            // Run check silently (no screenshots)
            const results = await browserManager.checkCoupons(coupons, { screenshot: false, detailed: false });

            // Build report
            let message = "🛡️ <b>Protection Cycle Report</b>\n\n";
            const rowButtons = [];

            results.forEach(res => {
                let statusIcon = '❓';
                if (res.status === 'APPLICABLE') statusIcon = '✅';
                else if (res.status === 'REDEEMED') statusIcon = '🎫';
                else if (res.status === 'INVALID') statusIcon = '❌';
                else statusIcon = '⚠️';

                message += `${statusIcon} <code>${res.code}</code>: ${res.status}\n`;

                // Add button to release this specific coupon
                rowButtons.push({ text: `Release ${res.code}`, callback_data: `release_${res.code}` });
            });

            // Split buttons into rows of 2
            const keyboard = [];
            for (let i = 0; i < rowButtons.length; i += 2) {
                keyboard.push(rowButtons.slice(i, i + 2));
            }
            // Add a "Stop All" button
            keyboard.push([{ text: '🛑 Stop All Protection', callback_data: 'stop_all_protection' }]);

            bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });

        } catch (error) {
            console.error("Protection cycle error:", error);
            bot.sendMessage(chatId, `⚠️ Protection cycle error: ${error.message}`);
        }

    }, 3 * 60 * 1000); // 3 minutes
};

bot.onText(/\/protect (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const newCoupons = match[1].split(/\s+/).filter(c => c.length > 0);

    if (newCoupons.length === 0) return bot.sendMessage(chatId, '❌ Please provide at least one coupon code.');

    // Add to set
    newCoupons.forEach(c => protectedCoupons.add(c));

    const totalCoupons = Array.from(protectedCoupons);

    // Build buttons
    const keyboard = totalCoupons.map(c => [{ text: `Release ${c}`, callback_data: `release_${c}` }]);
    keyboard.push([{ text: '🛑 Stop All', callback_data: 'stop_all_protection' }]);

    bot.sendMessage(chatId, `
🛡️ <b>Protection Started!</b>
Added: ${newCoupons.map(c => `<code>${c}</code>`).join(', ')}
Total Protected: ${protectedCoupons.size}

<i>I will re-apply these every 3 minutes.</i>
`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
    });

    // Start interval if not running
    if (!protectionInterval) {
        startProtection(chatId);
        // Maybe run one immediately? 
        // For now, let's wait for the interval or user can /check manually.
        // Actually, user expects "protect" to mean "keep applied", so better run one now if browser is free?
        // Let's stick to interval to avoid conflict if user just ran /check.
        bot.sendMessage(chatId, "⏳ First automated check will run in 3 minutes.");
    }
});

bot.onText(/\/release (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const couponsToRelease = match[1].split(/\s+/).filter(c => c.length > 0);

    couponsToRelease.forEach(c => protectedCoupons.delete(c));

    if (protectedCoupons.size === 0) {
        if (protectionInterval) {
            clearInterval(protectionInterval);
            protectionInterval = null;
        }
        bot.sendMessage(chatId, "🛑 All coupons released. Protection stopped.");
    } else {
        bot.sendMessage(chatId, `✅ Released: ${couponsToRelease.join(', ')}\nRemaining Protected: ${protectedCoupons.size}`);
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;

    if (data.startsWith('release_')) {
        const coupon = data.replace('release_', '');
        if (protectedCoupons.has(coupon)) {
            protectedCoupons.delete(coupon);

            // Check if we need to stop everything
            if (protectedCoupons.size === 0 && protectionInterval) {
                clearInterval(protectionInterval);
                protectionInterval = null;
                await bot.answerCallbackQuery(callbackQuery.id, { text: `Released ${coupon}. Protection stopped.` });
                bot.sendMessage(chatId, `🛑 ${coupon} released. No coupons left. Protection stopped.`);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: `Released ${coupon}` });
                bot.sendMessage(chatId, `✅ Released ${coupon}. Remaining: ${protectedCoupons.size}`);
            }
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, { text: `${coupon} is not currently protected.` });
        }
    } else if (data === 'stop_all_protection') {
        protectedCoupons.clear();
        if (protectionInterval) {
            clearInterval(protectionInterval);
            protectionInterval = null;
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'All protection stopped.' });
        bot.sendMessage(chatId, "🛑 All protection stopped.");
    }
});

// Update /stop to also clear protection
const originalStopMatch = /\/stop/; // We already have a handler, let's override or append.
// Since we can't easily override without removing listeners, let's just add a listener that checks for /stop 
// and *also* clears protection, assuming the original one runs too.
// Note: multiple listeners for same regex work in node-telegram-bot-api.
bot.onText(/\/stop/, (msg) => {
    let response = "";

    // Stop Scan
    if (browserManager.isScanning) {
        browserManager.stopScan();
        response += "⏹️ Scan stopped.\n";
    }

    // Stop Protection
    if (protectionInterval || protectedCoupons.size > 0) {
        protectedCoupons.clear();
        if (protectionInterval) clearInterval(protectionInterval);
        protectionInterval = null;
        response += "🛡️ Protection interval cleared.";
    }

    if (!response) response = "Nothing is currently running.";
    bot.sendMessage(msg.chat.id, response);
});
