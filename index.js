const fs = require('fs');
const path = require('path');
require('dotenv').config();

// STABILITY: Ensure taskkill is in PATH for Windows (silences Puppeteer errors)
if (process.platform === 'win32') {
    const sysPaths = [
        'C:\\Windows\\System32',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
    ];
    sysPaths.forEach(p => {
        if (!process.env.PATH.includes(p)) {
            process.env.PATH = `${p}${path.delimiter}${process.env.PATH}`;
        }
    });
}

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

// --- Helper: Coupon Extraction ---
const extractCoupons = (text) => {
    if (!text) return [];
    // 1. Try to find SV patterns (User says mostly starts with SV and 12-18 char long)
    const svMatches = text.match(/SV[A-Z0-9]{8,20}/gi);
    if (svMatches && svMatches.length > 0) {
        // Return unique capitalized matches
        return [...new Set(svMatches.map(c => c.toUpperCase()))];
    }

    // 2. Fallback: Split by any whitespace, newline or comma (Improvement over single space)
    const splitMatches = text.split(/[\s,]+/).map(c => c.trim().toUpperCase()).filter(c => c.length >= 3);
    return [...new Set(splitMatches)];
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
/protect <code>[COUPONS]</code> - Start protecting coupons
/release <code>[COUPON]</code> - Stop checking a specific coupon
/check <code>[COUPONS]</code> - One-time check of coupons
/cart - View current cart status & screenshot
/stop - Stop all protection and scanning tasks
/scan - Start wishlist or stock scan (if enabled)`;

    if (isAdmin(userId)) {
        helpText += `\n\n👮‍♂️ <b>Admin Commands:</b>
/add <code>[ID]</code> - Authorize a user ID
/remove <code>[ID]</code> - Revoke access from a user ID
/vip <code>[ID]</code> - Upgrade user to VIP (No limits)
/unvip <code>[ID]</code> - Remove VIP status
/broadcast <code>[MSG]</code> - Send message to all users
/users - List all authorized users
/admin_status - View global status + results
/set_interval <code>[MIN]</code> - Change check frequency
/login - Manual login (Proxy)
/login_noproxy - Manual login (No Proxy)
/login_cookies - Login via JSON/Netscape
/add_item <code>[URL]</code> - Manually add item
/stopall - Emergency stop ALL`;
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

// --- Command: /refresh_proxies (Admin only) ---
bot.onText(/\/refresh_proxies/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🔄 **Refreshing proxy list from Webshare API...**", { parse_mode: 'HTML' });

    try {
        // Reset cache timer to force a fresh fetch
        browserManager.lastProxyRefresh = 0;
        const list = await browserManager.fetchWebshareProxies();

        if (list && list.length > 0) {
            bot.sendMessage(chatId, `✅ **Success!** Loaded <b>${list.length}</b> proxies from Webshare.`, { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(chatId, "⚠️ **No proxies found.** Ensure your <code>WEBSHARE_API_KEY</code> is correct.", { parse_mode: 'HTML' });
        }
    } catch (err) {
        bot.sendMessage(chatId, `❌ **Error refreshing proxies:** ${err.message}`, { parse_mode: 'HTML' });
    }
});

// --- Command: /check_ip (Admin only) ---
bot.onText(/\/check_ip/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🔍 Checking browser IP via proxy...");

    try {
        const ip = await browserManager.checkMyIp();
        bot.sendMessage(chatId, `🌐 <b>Current Browser IP:</b> <code>${ip}</code>`, { parse_mode: 'HTML' });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Error checking IP: ${err.message}`);
    }
});

// --- Command: /check ---
bot.onText(/\/check(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    const input = match[1];
    if (!input) {
        return bot.sendMessage(chatId, "⚠️ Usage: <code>/check COUPON1 COUPON2</code>", { parse_mode: 'HTML' });
    }

    const coupons = extractCoupons(input);
    const userId = msg.from.id;

    if (coupons.length === 0) {
        return bot.sendMessage(chatId, "⚠️ No valid coupons provided.", { parse_mode: 'HTML' });
    }

    // ENFORCE LIMITS
    if (!isAdmin(userId) && !db.isVip(userId) && coupons.length > 3) {
        return bot.sendMessage(chatId,
            "⚠️ <b>Limit Exceeded</b>\nStandard users can only <code>/check</code> up to 3 coupons at once.\n\nContact @clickme4it to upgrade to 💎 <b>VIP</b> for unlimited checks!",
            { parse_mode: 'HTML' }
        );
    }

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
let protectionIntervalMinutes = 3; // Default 3 mins
const userProtections = new Map(); // UserId -> Set<Coupon>
const lastUserMessageIds = new Map(); // UserId -> MessageId
let lastGlobalResults = new Map(); // Coupon -> Status Result object
let isProtecting = false;
let isRotationEnabled = false; // NEW: SEQUENTIAL ROTATION MODE
let rotationStopRequested = false;
let rotationIndex = 0; // NEW: Persistent index for rotation
let lastCycleStartTime = 0; // WATCHDOG: Last time a cycle started


// --- Command: /cart ---
bot.onText(/\/cart/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    bot.sendMessage(chatId, "🛒 <b>Checking your cart...</b>", { parse_mode: 'HTML' });

    try {
        await browserManager.initBrowser();

        // Helper for manual retry on blocks
        const handleManualBlock = async (err = null) => {
            if (await browserManager.handleBlockIfNeeded(err, 0, 1)) {
                bot.sendMessage(chatId, "⚠️ <b>Block or Proxy failure detected.</b> Rotating session and retrying...", { parse_mode: 'HTML' });
                return true;
            }
            return false;
        };

        // Initial check
        await handleManualBlock();

        if (!browserManager.page.url().includes('cart')) {
            try {
                await browserManager.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (e) {
                if (await handleManualBlock(e)) {
                    await browserManager.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else {
                    throw e;
                }
            }
        }

        // Final sanity check for block AFTER navigation
        if (await browserManager.isBlocked()) {
            throw new Error("Access Denied (WAF Blocked). Please /login again.");
        }

        let count = await browserManager.getCartItemCount();

        // RECOVERY: If cart is empty, try refreshing session from latest cookies
        if (count === 0) {
            bot.sendMessage(chatId, "🛒 <b>Cart is empty!</b> Attempting to restore session from last cookies...", { parse_mode: 'HTML' });
            const refreshed = await browserManager.refreshSessionFromLatest();
            if (refreshed) {
                await browserManager.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000));
                count = await browserManager.getCartItemCount();
            }
        }

        const screenPath = path.resolve(__dirname, `cart_check_${Date.now()}.png`);
        await browserManager.page.screenshot({ path: screenPath });

        let status = `🛒 <b>Cart Status</b>\n\nItems Detected: <b>${count}</b>\nSession: ${await browserManager.page.evaluate(() => document.body.innerText.toLowerCase().includes('sign out') ? 'Logged In' : 'Guest')}`;
        if (count === 0) {
            status += "\n\n⚠️ <b>Warning</b>: Cart is still empty. Please check your cookies or manually add an item.";
        }

        await bot.sendPhoto(chatId, screenPath, { caption: status, parse_mode: 'HTML' });

        if (fs.existsSync(screenPath)) fs.unlinkSync(screenPath);
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Cart Check Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

// --- Command: /cart_url ---
bot.onText(/\/cart_url/, (msg) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    const url = 'https://www.sheinindia.in/c/sverse-5939-37961';
    bot.sendMessage(chatId,
        `🛒 <b>Manual Cart Setup</b>\n\nIf the bot fails to add items, please visit this link and add a cheap item to your cart manually:\n\n<a href="${url}">👉 Shein Verse Collection</a>\n\n<b>Recommended:</b> Use /login first to authenticate!\n\nAfter adding, run /start again.`,
        { parse_mode: 'HTML' }
    );
});

// --- Command: /login ---
bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return;

    bot.sendMessage(chatId, "🔐 <b>Opening login window (WITH PROXY)...</b>\n\nPlease check the browser on the host machine.\n\n💡 <i>Tip: If you get 'Access Denied', try using /login_noproxy</i>", { parse_mode: 'HTML' });

    try {
        await browserManager.loginManual(true);
        bot.sendMessage(chatId, "✅ <b>Login process complete!</b>\nYour session has been saved.", { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Login Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

// --- Command: /login_noproxy ---
bot.onText(/\/login_noproxy/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return;

    bot.sendMessage(chatId, "🔐 <b>Opening login window (NO PROXY)...</b>\n\nThis will use your home IP. This is often more reliable for the initial login.", { parse_mode: 'HTML' });

    try {
        await browserManager.loginManual(false);
        bot.sendMessage(chatId, "✅ <b>Login process complete!</b>\nYour session has been saved.", { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Login Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

// --- Command: /login_cookies ---
bot.onText(/\/login_cookies(.*)/s, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return;

    const json = match[1] ? match[1].trim() : "";
    if (!json) {
        return bot.sendMessage(chatId, "⚠️ Usage: `/login_cookies [COOKIES_DATA]`\n\nYou can paste **JSON** or the content of a **Netscape cookies.txt** file.", { parse_mode: 'Markdown' });
    }

    bot.sendMessage(chatId, "⏳ **Applying cookies...** Please wait.", { parse_mode: 'HTML' });

    try {
        const result = await browserManager.loginWithCookies(json, true);
        if (result.success) {
            bot.sendMessage(chatId, "✅ <b>Cookie login successful!</b>\nYour session has been validated and saved.", { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(chatId, `⚠️ <b>Cookie login failed:</b> ${result.error}`, { parse_mode: 'HTML' });
        }
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

// --- Command: /cookies (Reply to File) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || "";
    if (!text.startsWith('/cookies')) return;
    if (!isAdmin(msg.from.id)) return;

    // Check if it's a reply to a document
    if (!msg.reply_to_message || !msg.reply_to_message.document) {
        return bot.sendMessage(chatId, "⚠️ **Usage**: Please send your `cookies.txt` file first, then **reply** to it with `/cookies`.", { parse_mode: 'HTML' });
    }

    const doc = msg.reply_to_message.document;
    bot.sendMessage(chatId, "⏳ **Downloading and applying cookies...**", { parse_mode: 'HTML' });

    try {
        const filePath = await bot.downloadFile(doc.file_id, __dirname);
        const cookieData = fs.readFileSync(filePath, 'utf8');

        // Clean up temp file
        fs.unlinkSync(filePath);

        const result = await browserManager.loginWithCookies(cookieData, true);
        if (result.success) {
            bot.sendMessage(chatId, "✅ <b>Cookie login successful!</b>\nYour session has been validated and saved.", { parse_mode: 'HTML' });
        } else {
            bot.sendMessage(chatId, `⚠️ <b>Cookie login failed:</b> ${result.error}`, { parse_mode: 'HTML' });
        }
    } catch (e) {
        bot.sendMessage(chatId, `❌ <b>Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});
bot.onText(/\/add_item(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    const url = match[1];
    if (!url || !url.includes('http')) {
        return bot.sendMessage(chatId, "⚠️ Usage: `/add_item <URL>`\nPlease provide a full product URL.", { parse_mode: 'Markdown' });
    }

    bot.sendMessage(chatId, "⏳ Attempting to add item to cart... Please wait.");

    // We need to make sure browser is ready or initialized
    // browserManager.addToCart handles initBrowser
    const result = await browserManager.addToCart(url);

    if (result.success) {
        bot.sendMessage(chatId, `✅ <b>Success!</b> Item added.\nCart Count: ${result.count}\nSession: ${result.isLogged ? "Logged In" : "Guest"}`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(chatId, `❌ <b>Failed:</b> ${result.error}\n\n💡 <i>Tip: Try running /login first to bypass guest restrictions.</i>`, { parse_mode: 'HTML' });
    }
});

// --- Command: /set_interval (Admin Only) ---
bot.onText(/\/set_interval (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const newMinutes = parseInt(match[1]);
    if (newMinutes < 1) {
        return bot.sendMessage(msg.chat.id, "⚠️ Interval must be at least 1 minute.");
    }

    protectionIntervalMinutes = newMinutes;
    bot.sendMessage(msg.chat.id, `✅ Protection interval set to <b>${newMinutes} minutes</b>.\nRestarting cycle if active...`, { parse_mode: 'HTML' });

    // Restart interval if running
    if (protectionInterval) {
        clearInterval(protectionInterval);
        protectionInterval = null;
        startProtection();
    }
});

bot.onText(/\/protect(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!checkAccess(msg)) return;

    const input = match[1];
    if (!input) {
        return bot.sendMessage(chatId, "⚠️ Usage: <code>/protect COUPON1 COUPON2</code>", { parse_mode: 'HTML' });
    }

    const newCoupons = extractCoupons(input);

    if (newCoupons.length === 0) {
        return bot.sendMessage(chatId, "⚠️ No valid coupons provided.");
    }

    if (!userProtections.has(userId)) {
        userProtections.set(userId, new Set());
    }
    const userSet = userProtections.get(userId);

    // ENFORCE LIMITS
    const totalAfterAdd = userSet.size + newCoupons.filter(c => !userSet.has(c)).length;
    if (!isAdmin(userId) && !db.isVip(userId) && totalAfterAdd > 3) {
        return bot.sendMessage(chatId,
            `⚠️ <b>Limit Exceeded</b>\nYou are trying to protect ${totalAfterAdd} coupons total. Standard users are limited to 3.\n\nContact @clickme4it to upgrade to 💎 <b>VIP</b> for unlimited protection!`,
            { parse_mode: 'HTML' }
        );
    }

    newCoupons.forEach(c => userSet.add(c));

    // Reset user's message ID to force a new message
    lastUserMessageIds.delete(userId);

    bot.sendMessage(chatId,
        `🛡️ <b>Protection Started!</b> 🛡️\n\nAdded: <code>${newCoupons.join(', ')}</code>\nYour Total Protected: ${userSet.size}\n\nI will check them every ${protectionIntervalMinutes} minutes via API.`,
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
    if (isRotationEnabled) {
        if (!isProtecting) runRotationLoop();
        return;
    }

    if (protectionInterval) return; // Already running

    // Immediate First Run
    await runProtectionCycle();

    // Interval Run
    protectionInterval = setInterval(async () => {
        if (userProtections.size === 0 || isRotationEnabled) {
            if (protectionInterval) {
                clearInterval(protectionInterval);
                protectionInterval = null;
            }
            return;
        }
        await runProtectionCycle();
    }, protectionIntervalMinutes * 60 * 1000);
}

// --- Command: /rotation ---
bot.onText(/\/rotation/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkAccess(msg)) return;

    isRotationEnabled = !isRotationEnabled;

    if (isRotationEnabled) {
        if (protectionInterval) {
            clearInterval(protectionInterval);
            protectionInterval = null;
        }
        rotationStopRequested = false;
        bot.sendMessage(chatId, "🔄 <b>Rotation Mode ENABLED</b>\nCoupons will be checked one by one with a 5s delay. Interval mode disabled.", { parse_mode: 'HTML' });
        runRotationLoop();
    } else {
        rotationStopRequested = true;
        bot.sendMessage(chatId, "⏹ <b>Rotation Mode DISABLED</b>\nReturning to standard interval mode...", { parse_mode: 'HTML' });
        startProtection();
    }
});

async function runRotationLoop() {
    if (isProtecting || rotationStopRequested) return;

    isProtecting = true;
    console.log(`🔄 [${new Date().toLocaleTimeString()}] Starting rotation cycle...`);

    try {
        // Gather ALL unique coupons from ALL users
        const allCoupons = new Set();
        userProtections.forEach((coupons) => {
            coupons.forEach(c => allCoupons.add(c));
        });

        if (allCoupons.size === 0) {
            isRotationEnabled = false; // No coupons to protect, disable rotation
            bot.sendMessage(process.env.ADMIN_ID, "ℹ️ Rotation mode disabled: No coupons to protect.", { parse_mode: 'HTML' }).catch(() => { });
            return;
        }

        const couponsToRotate = Array.from(allCoupons);
        console.log(`[DEBUG] Rotating through ${couponsToRotate.length} unique coupons. starting from index ${rotationIndex % couponsToRotate.length}`);

        // Ensure rotationIndex is within bounds if size changed
        if (rotationIndex >= couponsToRotate.length) rotationIndex = 0;

        // --- OPTIMIZATION: Perform setup once per cycle ---
        try {
            console.log("[DEBUG] Performing rotation setup...");
            await browserManager.initBrowser();
            console.log("[DEBUG] Browser ready, verifying cart...");
            await browserManager.ensureCartHasItem();
            console.log("[DEBUG] Setup complete.");
        } catch (setupErr) {
            console.error("Rotation setup failed:", setupErr.message);
            // If setup fails, we'll try again in the next cycle in the 'finally' loop
            return;
        }

        for (let i = 0; i < couponsToRotate.length; i++) {
            if (rotationStopRequested || !isRotationEnabled) {
                console.log("Rotation stop requested. Exiting loop.");
                break;
            }

            // Get current coupon based on persistent index
            const couponCode = couponsToRotate[rotationIndex % couponsToRotate.length];

            console.log(`[DEBUG] Checking coupon [${rotationIndex % couponsToRotate.length + 1}/${couponsToRotate.length}]: ${couponCode}`);
            lastCycleStartTime = Date.now(); // Reuse watchdog for rotation too

            try {
                const results = await browserManager.checkCoupons([couponCode], {
                    screenshot: false,
                    detailed: true,
                    closeBrowser: false,
                    skipSetup: true // 🔥 OPTIMIZATION: Speed up single checks
                });
                await broadcastResults(results);
            } catch (checkErr) {
                console.log(`⚠️ Check failed for ${couponCode}, re-initializing and retrying...`);
                // If it fails (e.g. Target closed), try one formal check (with setup) for this coupon
                const results = await browserManager.checkCoupons([couponCode], { screenshot: false, detailed: true, closeBrowser: false });
                await broadcastResults(results);
            }

            rotationIndex++; // Advance to next

            await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
        }

    } catch (error) {
        console.error("Rotation cycle error:", error);
        if (process.env.ADMIN_ID && error.message.includes('initialize')) {
            bot.sendMessage(process.env.ADMIN_ID, `🚨 <b>Critical Bot Failure</b>\nAll proxy attempts failed. The bot is unable to start browser cycles.\n\nError: <code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    } finally {
        isProtecting = false;
        if (isRotationEnabled && !rotationStopRequested) {
            // Keep looping indefinitely
            setTimeout(runRotationLoop, 5000);
        }
    }
}


async function runProtectionCycle() {
    if (userProtections.size === 0) return;

    if (isProtecting) {
        const runningTime = Date.now() - lastCycleStartTime;
        // Watchdog: If cycle has been running for more than 15 minutes, force reset
        if (runningTime > 15 * 60 * 1000) {
            console.log(`🚨 WATCHDOG: Protection cycle has been stuck for ${Math.round(runningTime / 60000)} mins. Force resetting...`);
            isProtecting = false;
            await browserManager.closeBrowser().catch(() => { });
        } else {
            console.log(`⚠️ Previous protection cycle still running (${Math.round(runningTime / 1000)}s). Skipping this interval to prevent overlap.`);
            return;
        }
    }

    isProtecting = true;
    lastCycleStartTime = Date.now();
    console.log(`🔄 [${new Date().toLocaleTimeString()}] Starting protection cycle for ${userProtections.size} users...`);

    try {
        // Gather ALL unique coupons from ALL users
        const allCoupons = new Set();
        userProtections.forEach((coupons) => {
            coupons.forEach(c => allCoupons.add(c));
        });

        if (allCoupons.size === 0) return;

        const couponsToCheck = Array.from(allCoupons);
        console.log(`[DEBUG] Checking ${couponsToCheck.length} unique coupons: ${couponsToCheck.join(', ')}`);

        // USE STAY-ALIVE: Don't close browser every cycle to save RAM/CPU and prevent hangs
        const results = await browserManager.checkCoupons(couponsToCheck, { screenshot: false, detailed: true, closeBrowser: false });
        console.log(`[DEBUG] Cycle check completed. Distributing results...`);
        await broadcastResults(results);

    } catch (error) {
        console.error("Protection cycle error:", error);
        if (process.env.ADMIN_ID && error.message.includes('initialize')) {
            bot.sendMessage(process.env.ADMIN_ID, `🚨 <b>Critical Bot Failure</b>\nAll proxy attempts failed. The bot is unable to start browser cycles.\n\nError: <code>${error.message}</code>`, { parse_mode: 'HTML' }).catch(() => { });
        }
    } finally {
        isProtecting = false;
    }
}

async function broadcastResults(results) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Kolkata'
    });

    // Update global cache with new results
    results.forEach(r => {
        lastGlobalResults.set(r.code, {
            status: r.status,
            time: timeString,
            message: r.message
        });
    });

    // Distribute results to each User
    for (const [userId, userCoupons] of userProtections) {
        if (userCoupons.size === 0) continue;

        let report = `🛡️ <b>Protection Active</b> 🛡️\n<i>Last Updated: ${timeString}</i>\n`;
        if (isRotationEnabled) report += `<i>Mode: 🔄 Sequential Rotation (5s)</i>\n`;
        report += `\n`;

        const userButtons = [];

        userCoupons.forEach(couponCode => {
            const cached = lastGlobalResults.get(couponCode);
            let statusIcon = '⏳';
            let statusText = 'Pending Check...';

            if (cached) {
                statusIcon = '⚠️';
                statusText = cached.status;

                if (cached.status === 'APPLICABLE') {
                    statusIcon = '✅';
                    statusText = 'APPLICABLE (Protected)';
                } else if (cached.status === 'ERROR_CART_EMPTY') {
                    statusIcon = '⚠️';
                    statusText = 'CART EMPTY - Paused';
                } else if (cached.status === 'INVALID' || cached.status.includes('exist')) {
                    statusIcon = '❌';
                } else if (cached.status === 'REDEEMED' || cached.status.includes('limit')) {
                    statusIcon = '🚫';
                    statusText = 'REDEEMED / USED';
                }
            }
            report += `${statusIcon} <code>${couponCode}</code>: <b>${statusText}</b>\n`;

            userButtons.push({
                text: `Release ${couponCode}`,
                callback_data: `release_${couponCode}`
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

        try {
            if (lastMsgId) {
                // Only edit if status has changed significantly or every N sequential cycles
                // For simplicity, let's edit always but catch "message is not modified" errors
                await bot.editMessageText(report, {
                    chat_id: userId,
                    message_id: lastMsgId,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }).catch(e => {
                    if (!e.message.includes('not modified')) throw e;
                });
            } else {
                const sentMsg = await bot.sendMessage(userId, report, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
                lastUserMessageIds.set(userId, sentMsg.message_id);
            }
        } catch (e) {
            console.error(`Failed to update report for ${userId}:`, e.message);
            // If edit failed because message was deleted, send a new one
            if (e.message.includes('not found') || e.message.includes('deleted')) {
                const sentMsg = await bot.sendMessage(userId, report, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }).catch(() => { });
                if (sentMsg) lastUserMessageIds.set(userId, sentMsg.message_id);
            }
        }
    }
}


// --- Command: /release ---
bot.onText(/\/release (.+)/, (msg, match) => {
    if (!checkAccess(msg)) return;
    const userId = msg.from.id;
    const input = match[1].trim();
    const coupons = extractCoupons(input);

    if (coupons.length === 0) return bot.sendMessage(chatId, "⚠️ Please specify coupon(s) to release.");

    if (userProtections.has(userId)) {
        const userSet = userProtections.get(userId);
        const released = [];
        coupons.forEach(c => {
            if (userSet.delete(c)) released.push(c);
        });

        if (released.length > 0) {
            bot.sendMessage(msg.chat.id, `✅ Released: <code>${released.join(', ')}</code>`, { parse_mode: 'HTML' });
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
        status += `👤 <b>User ${uid}</b>:\n`;
        coupons.forEach(c => {
            const last = lastGlobalResults.get(c);
            const statusText = last ? `[${last.status}]` : "[WAITING]";
            status += `  ∟ <code>${c}</code> ${statusText}\n`;
        });
        status += "\n";
    }

    if (lastGlobalResults.size > 0) {
        const sample = Array.from(lastGlobalResults.values())[0];
        if (sample && sample.time) status += `\n<i>⏱ Last Global Cycle: ${sample.time}</i>`;
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

// /vip [ID]
bot.onText(/\/vip (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = match[1];

    if (!db.isAuthorized(targetId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ User <code>${targetId}</code> must be authorized (/add) before making them VIP.`, { parse_mode: 'HTML' });
    }

    if (db.setVip(targetId, true)) {
        bot.sendMessage(msg.chat.id, `💎 User <code>${targetId}</code> upgraded to <b>VIP</b>!`, { parse_mode: 'HTML' });
        bot.sendMessage(targetId, `🎊 <b>Congratulations!</b> 🎊\nYou have been upgraded to 💎 <b>VIP Status</b>!\n\nAll coupon limits have been removed for you. Enjoy!`, { parse_mode: 'HTML' }).catch(() => { });
    } else {
        bot.sendMessage(msg.chat.id, "❌ Error upgrading user.");
    }
});

// /unvip [ID]
bot.onText(/\/unvip (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const targetId = match[1];

    if (db.setVip(targetId, false)) {
        bot.sendMessage(msg.chat.id, `🔸 User <code>${targetId}</code> downgraded to standard user.`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(msg.chat.id, "❌ Error downgrading user.");
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

// /broadcast [Message]
bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const broadcastMsg = match[1];
    const users = db.getAuthorizedUsers();

    if (users.length === 0) {
        return bot.sendMessage(msg.chat.id, "⚠️ No authorized users to broadcast to.");
    }

    bot.sendMessage(msg.chat.id, `🚀 <b>Starting broadcast to ${users.length} users...</b>`, { parse_mode: 'HTML' });

    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
        try {
            await bot.sendMessage(user.id, `📢 <b>MESSAGE FROM ADMIN</b> 📢\n\n${broadcastMsg}`, { parse_mode: 'HTML' });
            successCount++;
            // Small delay to prevent rate limiting
            await new Promise(r => setTimeout(r, 60));
        } catch (e) {
            console.error(`Broadcast failed for ${user.id}:`, e.message);
            failCount++;
        }
    }

    bot.sendMessage(msg.chat.id, `✅ <b>Broadcast Complete!</b>\n\n📦 Total users: ${users.length}\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`, { parse_mode: 'HTML' });
});

// /users
bot.onText(/\/users/, (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const users = db.getAuthorizedUsers();
    let report = `👥 <b>Authorized Users:</b> (${users.length})\n\n`;

    users.forEach(u => {
        const tier = u.isVip ? '💎 VIP' : '👤 STD';
        report += `${tier} - <code>${u.id}</code>\n`;
    });

    if (users.length === 0) report = "No users added.";
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'HTML' });
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
