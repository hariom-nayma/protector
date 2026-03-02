const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');


// STABILITY: Ensure taskkill is in PATH for Windows (silences Puppeteer errors)
if (process.platform === 'win32') {
    const sysPaths = [
        'C:\\Windows\\System32',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
    ];
    sysPaths.forEach(p => {
        if (!process.env.PATH.includes(p)) {
            process.env.PATH = process.env.PATH + ';' + p;
        }
    });
}

puppeteer.use(StealthPlugin());

const USER_DATA_DIR = path.resolve(__dirname, 'chrome_profile');
const LATEST_COOKIES_FILE = path.resolve(__dirname, 'latest_cookies.txt');

class BrowserManager {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isScanning = false;
        this.currentProxy = null;
        this.initPromise = null;
        this.stickyProxy = null; // STICKY: Keep track of proxy used for login
        this.proxyList = []; // Dynamic list from Webshare
        this.lastProxyRefresh = 0;
        this.lastPid = null; // Track PID for hard kill
    }


    async initBrowser(overrideHeadless = null, skipUserData = false, forceNoProxy = false) {
        if (this.isInitializing && this.initPromise) return this.initPromise;
        this.isInitializing = true;

        this.initPromise = (async () => {
            try {
                const isHeadless = overrideHeadless !== null ? overrideHeadless : (process.env.HEADLESS === 'true');
                const useProxyGlobal = process.env.USE_PROXY !== 'false';

                // 1. Proxy Fetching & Selection
                let proxyUrl = process.env.PROXY_URL;
                let proxyList = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(',') : [];

                if (process.env.WEBSHARE_API_KEY && useProxyGlobal && !forceNoProxy) {
                    const dynamicList = await this.fetchWebshareProxies();
                    if (dynamicList.length > 0) proxyList = dynamicList;
                } else {
                    proxyList = proxyList.map(p => p.trim()).filter(p => p.length > 5);
                }

                let selectedProxy = this.stickyProxy || (proxyList.length > 0 ? proxyList[Math.floor(Math.random() * proxyList.length)] : proxyUrl);

                // 2. Reuse check
                if (this.browser && !skipUserData && !forceNoProxy && this.currentProxy === selectedProxy) {
                    try {
                        const pages = await this.browser.pages();
                        if (pages.length > 0) {
                            this.page = pages[pages.length - 1];
                            this.isInitializing = false;
                            return;
                        }
                    } catch (e) { }
                }

                if (this.browser) await this.closeBrowser().catch(() => { });

                // 3. Validation Loop
                const MAX_INIT_RETRIES = 3;
                let lastError = null;

                for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
                    const currentProxy = selectedProxy;
                    let finalProxyServer = null;
                    let proxyAuth = null;

                    if (currentProxy && currentProxy.includes('@') && !forceNoProxy && useProxyGlobal) {
                        try {
                            const urlString = currentProxy.startsWith('http') ? currentProxy : `http://${currentProxy}`;
                            const urlObj = new URL(urlString);
                            finalProxyServer = urlObj.host;
                            if (urlObj.username && urlObj.password) {
                                proxyAuth = { username: urlObj.username, password: urlObj.password };
                            }
                        } catch (e) { }
                    }

                    try {
                        console.log(`🚀 Launching browser (Attempt ${attempt + 1}/${MAX_INIT_RETRIES}, Proxy: ${finalProxyServer || 'None'})...`);

                        this.browser = await puppeteer.launch({
                            headless: isHeadless ? 'new' : false,
                            userDataDir: skipUserData ? undefined : USER_DATA_DIR,
                            args: [
                                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                                finalProxyServer ? `--proxy-server=${finalProxyServer}` : ''
                            ].filter(Boolean),
                            ignoreHTTPSErrors: true
                        });

                        const browserProcess = this.browser.process();
                        this.lastPid = browserProcess ? browserProcess.pid : null;


                        const username = proxyAuth ? proxyAuth.username : process.env.PROXY_USERNAME;
                        const password = proxyAuth ? proxyAuth.password : process.env.PROXY_PASSWORD;

                        this.page = await this.browser.newPage();

                        // Apply Proxy Auth
                        if (username && password) {
                            await this.page.authenticate({ username, password }).catch(() => { });
                            this.browser.on('targetcreated', async (t) => {
                                if (t.type() === 'page') {
                                    const p = await t.page();
                                    if (p) await p.authenticate({ username, password }).catch(() => { });
                                }
                            });
                        }

                        // Stealth & Navigation
                        await this.page.setUserAgent('Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36');
                        await this.setStealthHeaders();

                        console.log("[DEBUG] Verifying proxy connectivity...");
                        await this.page.goto('https://www.sheinindia.in/', { waitUntil: 'domcontentloaded', timeout: 30000 });

                        console.log('✅ Browser ready with working proxy!');
                        this.currentProxy = currentProxy;
                        this.isInitializing = false;
                        return; // SUCCESS
                    } catch (err) {
                        console.log(`⚠️ Attempt ${attempt + 1} failed: ${err.message}`);
                        lastError = err;
                        await this.closeBrowser().catch(() => { });
                        if (proxyList.length > 1) {
                            selectedProxy = proxyList[Math.floor(Math.random() * proxyList.length)];
                        }
                    }
                }

                this.isInitializing = false;
                throw new Error(`Failed to initialize browser after ${MAX_INIT_RETRIES} attempts. Last error: ${lastError?.message}`);
            } catch (err) {
                this.isInitializing = false;
                throw err;
            } finally {
                this.initPromise = null;
            }
        })();

        return this.initPromise;
    }

    async closeBrowser() {
        if (!this.browser && !this.lastPid) return;
        const pid = this.lastPid;
        console.log(`[DEBUG] Lifecycle: Terminating browser (PID: ${pid})...`);

        try {
            if (this.browser) {
                // DON'T AWAIT pages() if we are stuck, it's a known deadlock point
                // Just try to close gracefully in background
                this.browser.close().catch(() => { });
            }

            // Always attempt hard kill for reliability on Windows/PM2
            if (pid) {
                if (process.platform === 'win32') {
                    cp.exec(`taskkill /pid ${pid} /T /F`, () => { });
                } else {
                    try { process.kill(pid, 'SIGKILL'); } catch (e) { }
                }
            }
        } catch (e) {
            console.log(`[DEBUG] Lifecycle: CloseBrowser Error: ${e.message}`);
        } finally {
            this.browser = null;
            this.page = null;
            this.lastPid = null;
            this.isInitializing = false;
            console.log("[DEBUG] Lifecycle: References cleared.");
        }
    }



    async isBlocked() {
        if (!this.page || this.page.isClosed()) return false;
        try {
            const bodyText = await this.page.evaluate(() => document.body.innerText.substring(0, 1000).toLowerCase());
            const blockSignals = [
                "access denied",
                "site can’t be reached",
                "err_timed_out",
                "security check",
                "bot detection",
                "blocked by cloudflare",
                "request was blocked",
                "err_tunnel_connection_failed",
                "tunnel connection failed"
            ];
            return blockSignals.some(s => bodyText.includes(s));
        } catch (e) {
            return false;
        }
    }

    async handleBlockIfNeeded(error, retryCount, maxRetries = 5) {
        let blockDetected = false;

        // 1. Check if error object indicates a proxy/network block
        if (error) {
            const msg = error.message.toLowerCase();
            if (msg.includes("err_tunnel_connection_failed") ||
                msg.includes("access denied") ||
                msg.includes("timed out") ||
                msg.includes("closed") ||
                msg.includes("target closed")) {
                blockDetected = true;
            }
        }

        // 2. Check page content for visible block messages
        if (!blockDetected) {
            blockDetected = await this.isBlocked();
        }

        if (blockDetected) {
            const useProxyGlobal = process.env.USE_PROXY !== 'false';
            if (!useProxyGlobal) {
                console.log("⚠️ Block detected but proxy rotation is disabled (USE_PROXY=false). retrying with same IP might not work.");
                return false;
            }

            if (retryCount < maxRetries) {
                console.log(`⚠️ Block or Proxy failure detected (Try ${retryCount + 1}). Rotatings session/proxy...`);
                this.stickyProxy = null;
                await this.initBrowser(null, true); // Restart fresh
                return true;
            } else {
                console.error("❌ Max retries reached after recurring blocks/failures.");
                return false;
            }
        }
        return false;
    }

    async loginManual(useProxy = true) {
        // FORCE RESTART: Close any existing browser to ensure a fresh headful window
        await this.closeBrowser();

        // Force headless false for login so user can see it
        // skipUserData must be FALSE to save the session!
        await this.initBrowser(false, false, !useProxy);
        console.log("-----------------------------------------");
        console.log("STEP 1: BROWSER IS OPENING FOR LOGIN.");
        console.log("STEP 2: PLEASE LOG IN TO YOUR SHEIN ACCOUNT.");
        console.log("STEP 3: WAIT UNTIL YOU SEE THE HOME PAGE (Hi, [Name]).");
        console.log("TIP: Use your server's proxy on local for better session stability.");
        console.log("-----------------------------------------");

        try {
            // networkidle2 is safer for Akamai challenges
            await this.page.goto('https://www.sheinindia.in/login?referrer=/my-account/', { waitUntil: 'networkidle2', timeout: 60000 });

            // Wait for user to finish login (check for sign-out or profile indicators)
            console.log("Waiting for successful login detection (up to 5 minutes)...");
            await this.page.waitForFunction(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('sign out') || text.includes('my orders') || text.includes('my profile');
            }, { timeout: 300000 }).catch((err) => {
                if (err.message.includes('detached') || err.message.includes('closed')) {
                    console.log("[DEBUG] Browser closed or navigated away during login wait.");
                } else {
                    console.log("Login timeout. Saving whatever session we have.");
                }
            });

        } catch (e) {
            console.log("Login Error:", e.message);
        }

        await this.closeBrowser();
        console.log("Login session saved to .gemini/chrome_profile");
    }

    parseNetscapeCookies(text) {
        const cookies = [];
        const lines = text.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;

            const fields = line.split('\t');
            if (fields.length < 7) continue;

            cookies.push({
                domain: fields[0],
                path: fields[2],
                secure: fields[3].toUpperCase() === 'TRUE',
                expires: parseInt(fields[4]),
                name: fields[5],
                value: fields[6]
            });
        }
        return cookies;
    }

    async fetchWebshareProxies() {
        const apiKey = process.env.WEBSHARE_API_KEY;
        if (!apiKey) {
            console.log("[DEBUG] WEBSHARE_API_KEY not found. Skipping dynamic proxy fetch.");
            return [];
        }

        // Cache for 30 minutes to avoid rate limits
        if (this.proxyList.length > 0 && (Date.now() - this.lastProxyRefresh < 30 * 60 * 1000)) {
            return this.proxyList;
        }

        console.log("🌐 Fetching fresh proxies from Webshare API...");
        try {
            const response = await fetch("https://proxy.webshare.io/api/v2/proxy/list/?page_size=100&mode=direct", {
                headers: { "Authorization": `Token ${apiKey}` }
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Webshare API error: ${response.status} ${response.statusText} - ${errorBody}`);
            }

            const data = await response.json();
            const results = data.results || [];

            // Format: username:password@ip:port
            const formattedProxies = results.map(p => {
                return `${p.username}:${p.password}@${p.proxy_address}:${p.port}`;
            });

            if (formattedProxies.length > 0) {
                this.proxyList = formattedProxies;
                this.lastProxyRefresh = Date.now();
                console.log(`✅ Successfully fetched ${this.proxyList.length} proxies from Webshare.`);
                return this.proxyList;
            }
        } catch (e) {
            console.error("❌ Failed to fetch Webshare proxies:", e.message);
        }
        return this.proxyList; // Return cached if fetch fails
    }
    async loginWithCookies(cookiesData, useProxy = true, retryCount = 0) {
        const MAX_RETRIES = 5;
        let cookies;

        // Only parse cookies on first try to avoid redundant logs
        if (retryCount === 0) {
            try {
                // Try JSON first
                cookies = JSON.parse(cookiesData);
                if (!Array.isArray(cookies)) cookies = [cookies];
            } catch (e) {
                // Try Netscape parsing
                console.log("[DEBUG] JSON parse failed, trying Netscape format...");
                cookies = this.parseNetscapeCookies(cookiesData);
                if (cookies.length === 0) {
                    throw new Error("Invalid Cookie format. Please provide JSON or standard Netscape cookies.txt content.");
                }
            }
            this._lastCookies = cookies; // Cache for retries
        } else {
            cookies = this._lastCookies;
        }

        // INITIALIZATION: Only init if browser is not already prepared by retry logic
        if (!this.browser || !this.page || this.page.isClosed()) {
            await this.closeBrowser();
            await this.initBrowser(true, false, !useProxy);

            // Initial connectivity check
            if (await this.handleBlockIfNeeded(null, retryCount, MAX_RETRIES)) {
                return await this.loginWithCookies(cookiesData, useProxy, retryCount + 1);
            }
        }

        console.log(`[DEBUG] Attempting to set ${cookies.length} cookies... (Try ${retryCount + 1})`);
        try {
            // Apply cookies
            for (const cookie of cookies) {
                try { await this.page.setCookie(cookie); } catch (err) { }
            }

            // Navigate to home to confirm session
            console.log("Verifying cookie session...");
            try {
                await this.page.goto('https://www.sheinindia.in/', { waitUntil: 'domcontentloaded', timeout: 50000 });
            } catch (e) {
                console.log(`[DEBUG] Navigation error in loginWithCookies: ${e.message}`);
                // ERROR-BASED ROTATION
                if (await this.handleBlockIfNeeded(e, retryCount, MAX_RETRIES)) {
                    // SETTLEMENT WAIT: Give the new proxy/tunnel a moment to stabilize
                    await new Promise(r => setTimeout(r, 4000));
                    return await this.loginWithCookies(cookiesData, useProxy, retryCount + 1);
                }
                throw e;
            }

            // CONTENT-BASED ROTATION
            if (await this.handleBlockIfNeeded(null, retryCount, MAX_RETRIES)) {
                return await this.loginWithCookies(cookiesData, useProxy, retryCount + 1);
            }

            // 1. Popup Crusher
            await new Promise(r => setTimeout(r, 2000));
            await this.page.evaluate(() => {
                const dismissSelectors = [
                    '.common-pop__close-btn', '.sui-dialog__close', '.coupon-pop-close',
                    '.fast-login-close', '.location-confirm-btn', '.j-close-pop',
                    'div[class*="close"]', 'i[class*="close"]'
                ];
                dismissSelectors.forEach(sel => {
                    const el = document.querySelector(sel);
                    if (el && typeof el.click === 'function') el.click();
                });
            });

            await new Promise(r => setTimeout(r, 4000));

            // 2. Dual-Layer Validation
            const activeCookies = await this.page.cookies();
            const lsCookie = activeCookies.find(c => c.name === 'LS' && c.value === 'LOGGED_IN');
            const { isLoggedUI } = await this.page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return { isLoggedUI: text.includes('sign out') || text.includes('my orders') || text.includes('my profile') || text.includes('hi,') };
            });

            if (lsCookie || isLoggedUI) {
                console.log(`✅ Cookie session verified! (LS: ${!!lsCookie}, UI: ${isLoggedUI})`);
                this.stickyProxy = useProxy ? this.currentProxy : null;

                // SAVE SUCCESSFUL COOKIES AS LATEST (Only on first entry to avoid loop-saving)
                if (retryCount === 0) {
                    await this.saveLatestCookies(cookiesData);
                }

                return { success: true };
            } else {
                console.log("⚠️ Cookies applied but session not detected.");
                const screenPath = `cookie_fail_${Date.now()}.png`;
                await this.page.screenshot({ path: screenPath });
                return { success: false, error: "Session not active. Shein might have rejected these cookies." };
            }
        } catch (e) {
            // CATCH-ALL ROTATION
            if (await this.handleBlockIfNeeded(e, retryCount, MAX_RETRIES)) {
                await new Promise(r => setTimeout(r, 4000));
                return await this.loginWithCookies(cookiesData, useProxy, retryCount + 1);
            }
            throw e;
        } finally {
            // Browser stays open
        }
    }

    async saveLatestCookies(cookiesData) {
        try {
            fs.writeFileSync(LATEST_COOKIES_FILE, cookiesData, 'utf8');
            console.log(`[DEBUG] Latest cookies saved to: ${LATEST_COOKIES_FILE}`);
        } catch (e) {
            console.error("Failed to save latest cookies:", e.message);
        }
    }

    async refreshSessionFromLatest(useProxy = true) {
        if (!fs.existsSync(LATEST_COOKIES_FILE)) {
            console.log("[DEBUG] No latest_cookies.txt found. Cannot refresh session.");
            return false;
        }
        console.log("[DEBUG] Refreshing session from latest_cookies.txt...");
        try {
            const cookiesData = fs.readFileSync(LATEST_COOKIES_FILE, 'utf8');
            const result = await this.loginWithCookies(cookiesData, useProxy, 0);
            return result.success;
        } catch (e) {
            console.error("Session refresh failed:", e.message);
            return false;
        }
    }

    async setStealthHeaders() {
        if (!this.page) return;
        // MIRRORING USER LOG EXACTLY: Chrome 145 Android hints
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-IN,en-US;q=0.9,en-GB;q=0.8,en;q=0.7,hi;q=0.6',
            'Upgrade-Insecure-Requests': '1',
            'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"'
        });
    }

    async warmupSession() {
        console.log("[DEBUG] Warming up session (visiting home page)...");
        try {
            // Visit home page to get early cookies (A, device_id, etc.)
            await this.page.goto('https://www.sheinindia.in/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));

            // Simulate human behavior: Random scroll
            await this.page.evaluate(async () => {
                window.scrollBy(0, 500 + Math.random() * 500);
                await new Promise(r => setTimeout(r, 1000));
                window.scrollBy(0, -200 - Math.random() * 200);
            });

            // Occasionally visit cart to "activate" the GUID
            if (Math.random() > 0.5) {
                await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            console.log("[DEBUG] Warmup warning:", e.message);
        }
    }

    async addToCart(url, retryCount = 0) {
        const MAX_RETRIES = 3;
        console.log(`[MANUAL] Attempting to add item: ${url} (Try ${retryCount + 1}/${MAX_RETRIES + 1})`);

        await this.initBrowser();

        try {
            // 0. Preliminary Block Check (Navigation)
            let navError = null;
            try {
                // SESSION WARMUP: If first try or fresh session, warmup first
                if (retryCount === 0) {
                    await this.warmupSession();
                }

                console.log(`[DEBUG] Navigating to product: ${url}`);
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            } catch (e) {
                console.log("[DEBUG] Navigation error:", e.message);
                navError = e;
            }

            if (await this.handleBlockIfNeeded(navError, retryCount, MAX_RETRIES)) {
                return await this.addToCart(url, retryCount + 1);
            }

            await new Promise(r => setTimeout(r, 3000));

            // 1. Pre-Extract GUID and CSRF from Node-side (Puppeteer) to bypass document access errors
            const nodeCookies = await this.page.cookies();

            // CHECK FOR LOGIN SESSION FIRST
            const isLogged = nodeCookies.some(c => c.name === 'user_id' || c.name === 'identity');
            console.log(`[DEBUG] Session state: ${isLogged ? "LOGGED IN" : "GUEST"}`);

            // FILTER OUT identifiers
            // If logged in, 'A' might be useful, but for Cart API cart_id is usually better
            const nodeGuid = nodeCookies
                .filter(c => ['cart_id', 'cart_guid', 'device_id', 'deviceId', 'sessionId', 'session_id', 'A', 'identity'].includes(c.name))
                .find(c => isLogged || !c.value.startsWith('ey'))?.value || "";

            const pageContent = await this.page.content();
            // Broader regex for CSRF in HTML
            let csrfMatch = pageContent.match(/name="csrf-token" content="([^"]+)"/i) ||
                pageContent.match(/"csrfToken"\s*:\s*"([^"]+)"/i) ||
                pageContent.match(/_csrf\s*=\s*"([^"]+)"/i) ||
                pageContent.match(/meta\[name='csrf-token'\] content='([^']+)'/i);
            const nodeCsrf = csrfMatch ? csrfMatch[1] : "";

            console.log(`[DEBUG] Pre-extracted GUID: ${nodeGuid ? (nodeGuid.length > 20 ? nodeGuid.substring(0, 20) + "..." : nodeGuid) : "None"}, CSRF: ${nodeCsrf || "None"}`);

            // 1. Direct API Add to Cart Logic (Fast & Stealthy Fallback)
            console.log("[DEBUG] Attempting direct API cart-add fallback...");
            const apiResult = await Promise.race([
                this.page.evaluate(async (passedGuid, passedCsrf, passedIsLogged) => {
                    try {
                        return await (async (passedGuid, passedCsrf, passedIsLogged) => {
                            // Try to get Cart GUID from minicart API
                            let guid = passedGuid || "";
                            if (!guid) {
                                try {
                                    const controller = new AbortController();
                                    const timeoutId = setTimeout(() => controller.abort(), 8000);
                                    const miniCartResp = await fetch('/api/cart/minicart', { signal: controller.signal });
                                    clearTimeout(timeoutId);
                                    const miniCartData = await miniCartResp.json();
                                    guid = miniCartData.guid || miniCartData.code;
                                } catch (e) {
                                    console.log("Could not fetch minicart guid:", e.message);
                                }
                            }
                            // ... remaining guide/sku logic ...
                            if (!sku || !guid) return { success: false, error: `Missing identifier. SKU: ${sku}, GUID: ${guid}` };
                            // ... csrf extraction ...
                            const addUrl = `/api/cart/${guid}/product/${sku}/add`;
                            const headers = {
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-Tenant-Id': 'SHEIN',
                                'Accept': 'application/json, text/plain, */*',
                                'Referer': window.location.href,
                                'Origin': window.location.origin
                            };
                            if (csrf) headers['X-CSRF-Token'] = csrf;

                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 12000);
                            const response = await fetch(addUrl, {
                                method: 'POST',
                                headers: headers,
                                body: JSON.stringify({ quantity: 1 }),
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);

                            const data = await response.json().catch(() => ({ error: "Non-JSON response" }));
                            return {
                                success: response.ok && (data.statusCode === 'success' || data.code === '0' || data.msg === 'success'),
                                data, sku, guid, isLogged: passedIsLogged, status: response.status
                            };
                        })(passedGuid, passedCsrf, passedIsLogged);
                    } catch (err) {
                        return { error: err.message };
                    }
                }, nodeGuid, nodeCsrf, isLogged),
                new Promise(resolve => setTimeout(() => resolve({ error: 'Evaluation Timeout' }), 25000))
            ]);

            // Extra Step: Try to get GUID from Puppeteer cookies if null and retry API call
            if (!apiResult.success && !apiResult.guid) {
                console.log("[DEBUG] GUID null in page context. Searching Puppeteer cookies for manual API attempt...");
                const cookies = await this.page.cookies();

                // Logging Puppeteer cookie names for debugging
                console.log("[DEBUG] Available cookies (Puppeteer context):", cookies.map(c => c.name).join(', '));

                const cartCookie = cookies.find(c => ['A', 'cart_id', 'device_id', 'identity', 'cart_guid'].includes(c.name));
                if (cartCookie && apiResult.sku) {
                    const guid = cartCookie.value;
                    const sku = apiResult.sku;
                    console.log(`[DEBUG] Found GUID in Puppeteer cookies: ${guid}. Attempting manual Node-side API call...`);

                    try {
                        const addUrl = `https://www.sheinindia.in/api/cart/${guid}/product/${sku}/add`;
                        const res = await this.page.evaluate(async (url) => {
                            // Extract CSRF again
                            const csrf = document.querySelector('meta[name="csrf-token"]')?.content || window._csrf || "";
                            const r = await fetch(url, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'X-Tenant-Id': 'SHEIN',
                                    'X-CSRF-Token': csrf,
                                    'Referer': window.location.href
                                },
                                body: JSON.stringify({ quantity: 1 })
                            });
                            return { ok: r.ok, status: r.status, text: await r.text() };
                        }, addUrl);

                        if (res.ok) {
                            console.log(`✅ Manual API Add Success (via Cookie GUID)!`);
                            await new Promise(r => setTimeout(r, 4000));
                            const count = await this.getCartItemCount();
                            if (count > 0) return { success: true, count };
                        } else {
                            console.log(`[DEBUG] Manual API Add failed. Status: ${res.status}`);
                        }
                    } catch (err) {
                        console.log(`[DEBUG] Manual API Add error: ${err.message}`);
                    }
                }
            }

            if (apiResult.success) {
                console.log(`✅ Direct API Add Success!`);
                await new Promise(r => setTimeout(r, 4000)); // Longer wait for cart update
                const count = await this.getCartItemCount();
                if (count > 0) return { success: true, count };
            }

            // 2. UI Fallback (Traditional Button Click with Size Selection)
            console.log("[DEBUG] API Add failed. Error:", apiResult.error || "Unknown", "Status:", apiResult.status);
            console.log("[DEBUG] Trying UI Fallback with Size Selection...");

            const clicked = await this.page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                // Helper: Enhanced click via MouseEvent
                const forceClick = (el) => {
                    if (!el) return;
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.click();
                    const events = ['mousedown', 'mouseup', 'click'];
                    events.forEach(evtType => {
                        el.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
                    });
                };

                // Helper: Try to click a size if not selected
                const selectFirstSize = (container = document) => {
                    console.log("Attempting size selection...");
                    const sizeSelectors = [
                        '.product-intro__size-radio:not(.product-intro__size-radio_disabled)',
                        '.size-item:not(.size-item_disabled)',
                        '.size-button:not(.disabled)',
                        '.size-list__item:not(.disabled)',
                        '.size-radio:not(.size-radio_disabled)'
                    ];
                    let sizeItems = Array.from(container.querySelectorAll(sizeSelectors.join(',')));

                    // Filter for visible items
                    sizeItems = sizeItems.filter(el => el.offsetWidth > 0);

                    if (sizeItems.length > 0) {
                        forceClick(sizeItems[0]);
                        return true;
                    }

                    // Fallback: look for text (XS, S, M, L, XL, etc.)
                    const patterns = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One-size', 'OS'];
                    const allElements = Array.from(container.querySelectorAll('div, span, p, button, li, a'));
                    const found = allElements.find(el => {
                        const text = el.innerText.trim().toUpperCase();
                        return (patterns.includes(text) || /^\d+[A-Z]?$/.test(text)) && el.offsetWidth > 0 && el.offsetHeight > 0;
                    });

                    if (found) {
                        console.log("Found size by text:", found.innerText);
                        forceClick(found);
                        return true;
                    }
                    return false;
                };

                // Helper: Handle popup/dialog if it appears
                const handlePopup = async () => {
                    await sleep(2000); // Wait for dialog
                    const dialogSelectors = [
                        '.size-select-dialog',
                        '.product-intro__size-choose-dialog',
                        '.s-dialog',
                        '.dialog-container',
                        '[class*="dialog"]',
                        '[class*="popup"]',
                        '.fsp-dialog',
                        '.v-dialog'
                    ];
                    const dialogs = Array.from(document.querySelectorAll(dialogSelectors.join(','))).filter(d => d.innerText.toUpperCase().includes('SIZE') || d.innerText.toUpperCase().includes('BAG') || d.innerText.toUpperCase().includes('SELECT'));
                    const dialog = dialogs[dialogs.length - 1]; // Use topmost dialog

                    if (dialog) {
                        console.log("Dialog detected, selecting size...");
                        selectFirstSize(dialog);
                        await sleep(1000);

                        const confirmSelectors = [
                            '.product-intro__add-btn',
                            '.j-confirm-btn',
                            '.add-to-bag',
                            'button[class*="add"]',
                            'button[class*="confirm"]',
                            'div[role="button"][class*="add"]',
                            '.confirm-btn',
                            '.s-button--primary',
                            '.buy-now-btn'
                        ];
                        const confirmBtn = Array.from(dialog.querySelectorAll(confirmSelectors.join(','))).find(el => {
                            const t = el.innerText.toUpperCase();
                            return el.offsetWidth > 0 && (t.includes('ADD') || t.includes('BAG') || t.includes('CONFIRM') || t.includes('SELECT'));
                        });
                        if (confirmBtn) {
                            forceClick(confirmBtn);
                            console.log("Clicked confirmation button in dialog.");
                            return true;
                        } else {
                            // Last resort: click anything that says ADD TO BAG in the dialog
                            const btns = Array.from(dialog.querySelectorAll('button, div[role="button"], a[role="button"]'));
                            const majorBtn = btns.find(b => b.innerText.toUpperCase().includes('ADD') || b.innerText.toUpperCase().includes('BAG'));
                            if (majorBtn) {
                                forceClick(majorBtn);
                                return true;
                            }
                        }
                    }
                    return false;
                };

                const selectors = ['button', '.product-intro__add-btn', '.j-add-to-bag', 'div[aria-label*="Add to"]', '.add-to-bag', '.goods-add-chart', '.j-product-intro__add-btn', '.goods-add-bag'];
                const btns = Array.from(document.querySelectorAll(selectors.join(',')));
                const addBtn = btns.find(b => {
                    const text = (b.innerText || b.getAttribute('aria-label') || "").toUpperCase();
                    const style = window.getComputedStyle(b);
                    return (style.display !== 'none' && style.visibility !== 'hidden') && (text.includes('ADD TO BAG') || text.includes('ADD TO CART'));
                });

                if (addBtn && !addBtn.disabled) {
                    console.log("Found Add button, clicking...");
                    selectFirstSize();
                    await sleep(500);
                    forceClick(addBtn);

                    // Important: Check if dialog appears
                    await handlePopup();

                    // NEW: Immediate verification via button text change
                    await sleep(2000);
                    const updatedBtns = Array.from(document.querySelectorAll(selectors.join(',')));
                    const viewBagBtn = updatedBtns.find(b => {
                        const t = (b.innerText || b.getAttribute('aria-label') || "").toUpperCase();
                        return t.includes('VIEW BAG') || t.includes('VIEW CART');
                    });

                    return { interacted: true, viewBagFound: !!viewBagBtn };
                }
                return { interacted: false };
            });

            if (clicked && clicked.interacted) {
                console.log("✅ Interaction steps completed. Verifying...");

                if (clicked.viewBagFound) {
                    console.log("✅ 'VIEW BAG' signal detected! Confirmation successful.");
                    return { success: true, count: await this.getCartItemCount() || 1 };
                }

                await new Promise(r => setTimeout(r, 4000)); // Wait a bit more for badge
                const count = await this.getCartItemCount();
                if (count > 0) return { success: true, count };

                // If still 0, try refreshing cart page to see if it's a badge caching issue
                console.log("[DEBUG] Cart badge still 0. Refreshing cart page for final verification...");
                await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 3000));
                const finalCount = await this.getCartItemCount();
                if (finalCount > 0) return { success: true, count: finalCount };
            }

            // 3. Final Check & Retry
            if (retryCount < MAX_RETRIES) {
                console.log("⚠️ Add to Cart failed via all methods. Retrying with fresh session/proxy session...");
                await this.initBrowser(null, true);
                return await this.addToCart(url, retryCount + 1);
            }

            await this.page.screenshot({ path: `add_fail_${Date.now()}.png` });
            return { success: false, error: "Blocked or Button Not Found after multiple attempts." };

        } catch (e) {
            console.error("Error in addToCart:", e.message);
            if (retryCount < MAX_RETRIES) {
                await this.initBrowser(null, true);
                return await this.addToCart(url, retryCount + 1);
            }
            return { success: false, error: e.message };
        }
    }

    async ensureCartHasItem() {
        try {
            let itemCount = await this.getCartItemCount();

            if (itemCount === 0) {
                console.log("🛒 Cart is empty! Attempting session refresh from latest cookies...");

                // SKIPPING AUTO-ADD AS REQUESTED
                const refreshed = await this.refreshSessionFromLatest();
                if (refreshed) {
                    // Go back to cart and check again
                    await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await new Promise(r => setTimeout(r, 3000));
                    itemCount = await this.getCartItemCount();
                }

                if (itemCount === 0) {
                    console.log("⚠️ Cart still empty after cookie re-application.");
                    return false;
                }
            }
            return itemCount > 0;
        } catch (e) {
            console.error("Error ensuring cart has item:", e);
            return false;
        }
    }

    async getCartItemCount(captureDebug = false) {
        if (!this.page || this.page.isClosed()) return 0;
        try {
            const count = await this.page.evaluate(() => {
                // Updated selectors for Shein India
                const selectors = [
                    '.j-bag-count',
                    '.header-cart-count',
                    '.iconfont-gouwudai .num',
                    '.cart-count-icon',
                    '.bag-count',
                    '.cart-num',
                    '.S-header-cart-count',
                    '.cart-badge-num',
                    '[class*="bag-count"]',
                    '[class*="cart-count"]'
                ];
                for (const sel of selectors) {
                    const b = document.querySelector(sel);
                    if (b) {
                        const num = parseInt(b.innerText || b.textContent);
                        if (!isNaN(num)) return num;
                    }
                }

                // Fallback: Check for aria-label or title on cart link
                const cartLink = document.querySelector('a[href*="cart"], .header-right-bag, .cart-anchor');
                if (cartLink) {
                    const label = cartLink.getAttribute('aria-label') || cartLink.getAttribute('title') || "";
                    const match = label.match(/\d+/);
                    if (match) return parseInt(match[0]);
                }

                // Final Fallback: Search for "Bag (N)", "Cart (N)", "My Bag (N)" etc.
                const bodyText = document.body.innerText;
                const genericMatch = bodyText.match(/(?:Bag|Cart|My Bag)\s*\((\d+)[^)]*\)/i);

                if (genericMatch) return parseInt(genericMatch[1]);
                return 0;
            });

            if (count === 0 && captureDebug) {
                const debugPath = path.resolve(__dirname, `empty_cart_debug_${Date.now()}.png`);
                await this.page.screenshot({ path: debugPath }).catch(() => { });
                console.log(`[DEBUG] Cart detected as 0. Debug screenshot saved at: ${debugPath}`);
            }

            return count;
        } catch (e) {
            console.log("[DEBUG] getCartItemCount error (likely navigation):", e.message);
            return 0;
        }
    }

    async checkCoupons(coupons, options = { screenshot: true, detailed: true }, retryCount = 0) {
        const MAX_RETRIES = 5;
        await this.initBrowser();

        const results = [];

        try {
            // Check for initial block / proxy failure
            if (await this.handleBlockIfNeeded(null, retryCount, MAX_RETRIES)) {
                return await this.checkCoupons(coupons, options, retryCount + 1);
            }

            if (!this.page.url().includes('cart')) {
                try {
                    await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded', timeout: 45000 });
                } catch (e) {
                    if (await this.handleBlockIfNeeded(e, retryCount, MAX_RETRIES)) {
                        return await this.checkCoupons(coupons, options, retryCount + 1);
                    }
                    throw e;
                }
                // Wait for initial tokens/cookies to settle
                await new Promise(r => setTimeout(r, 4000));
            }

            // Ensure we have a Shein Verse item
            const cartHasItem = await this.ensureCartHasItem();
            if (!cartHasItem) {
                console.error("❌ Cart is empty and failed to add item. Aborting coupon check.");
                if (options.closeBrowser !== false) await this.closeBrowser();
                return coupons.map(c => ({ code: c, status: 'ERROR_CART_EMPTY' }));
            }

            for (const coupon of coupons) {
                if (options.detailed) console.log(`Checking via API: ${coupon}`);

                // Call the internal API directly from the browser context
                // This inherits all cookies and session headers
                const apiResult = await Promise.race([
                    this.page.evaluate(async (code) => {
                        try {
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s API timeout
                            const response = await fetch('/api/cart/apply-voucher', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Requested-With': 'XMLHttpRequest',
                                    'X-Tenant-Id': 'SHEIN'
                                    // Browser adds Cookie, Origin, Referer automatically
                                },
                                body: JSON.stringify({
                                    voucherId: code,
                                    device: { client_type: 'web' }
                                }),
                                signal: controller.signal
                            });
                            clearTimeout(timeoutId);

                            const data = await response.json();
                            return { success: response.ok, data, status: response.status };
                        } catch (err) {
                            return { error: err.message };
                        }
                    }, coupon),
                    new Promise(resolve => setTimeout(() => resolve({ error: 'Evaluation Timeout (Browser Hung)' }), 20000))
                ]);

                if (options.detailed) {
                    const debugResp = JSON.stringify(apiResult);
                    const truncated = debugResp.length > 500 ? debugResp.substring(0, 500) + "... [TRUNCATED]" : debugResp;
                    console.log(`API Response for ${coupon}:`, truncated);
                }

                let status = 'UNKNOWN';

                if (apiResult.error) {
                    console.error(`API Error for ${coupon}: ${apiResult.error}`);
                    status = 'ERROR';
                } else if (apiResult.data) {
                    // Analyze Response
                    const data = apiResult.data;

                    // Success Case: Usually returns cart info or standard response with no error message
                    // Based on user log: status 400 means failure. So 200 likely means success.
                    if (apiResult.success && !data.errorMessage) {

                        // Check if it actually gave a discount
                        if (data.voucherAmount && data.voucherAmount.value > 0) {
                            status = 'APPLICABLE';
                        } else {
                            // No error, but no discount -> likely means criteria not met without error msg
                            status = 'NOT_APPLICABLE';
                        }
                    }
                    // Error Cases
                    else if (data.errorMessage && data.errorMessage.errors && data.errorMessage.errors.length > 0) {
                        const errorMsg = data.errorMessage.errors[0].message.toLowerCase();

                        if (errorMsg.includes('invalid') || errorMsg.includes('does not exist')) {
                            status = 'INVALID';
                        } else if (errorMsg.includes('redeemed') || errorMsg.includes('limit') || errorMsg.includes('used')) {
                            status = 'REDEEMED';
                        } else if (errorMsg.includes('applicable') || errorMsg.includes('criteria') || errorMsg.includes('eligible')) {
                            status = 'NOT_APPLICABLE';
                        } else {
                            // Fallback for other errors
                            status = 'INVALID'; // Treat unknown errors as failure to apply
                            if (options.detailed) console.log(`Unknown error message: ${errorMsg}`);
                        }
                    } else if (data.code === '0' || data.msg === 'success') {
                        // Some APIs use this format
                        status = 'APPLICABLE';
                    }
                }

                results.push({ code: coupon, status });

                // Small delay to be polite
                await new Promise(r => setTimeout(r, 1000));
            }
            console.log("[DEBUG] Lifecycle: Finished batch processing.");
        } catch (e) {
            console.error(e);
            // On ERROR, close the browser to refresh state for next cycle
            await this.closeBrowser();
        } finally {
            if (options.closeBrowser === true) {
                console.log("[DEBUG] Lifecycle: Explicit Close Requested.");
                await this.closeBrowser();
            }
        }
        return results;
    }


    async checkStock(link) {
        try {
            await this.page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 5000)); // Increased Render Wait for stability

            return await Promise.race([
                this.page.evaluate(async () => {
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                    const bodyText = document.body.innerText.substring(0, 1000);
                    const textLow = bodyText.toLowerCase();

                    if (textLow.includes("site can’t be reached") || textLow.includes("err_timed_out") || textLow.includes("access denied")) {
                        return { available: false, reason: 'Page Error/Block detected' };
                    }
                    if (textLow.includes('sold out') || textLow.includes('restock') || textLow.includes('out of stock')) {
                        return { available: false, reason: 'Sold Out' };
                    }

                    const sizeItems = Array.from(document.querySelectorAll('.product-intro__size-choose .product-intro__size-radio:not(.product-intro__size-radio_disabled)'));
                    if (sizeItems.length > 0) {
                        sizeItems[0].click();
                        await sleep(1000);
                    }

                    const selectors = ['button', '.product-intro__add-btn', '.j-add-to-bag', 'div[aria-label*="Add to"]', '.add-to-bag'];
                    const btns = Array.from(document.querySelectorAll(selectors.join(',')));
                    const addToBagBtn = btns.find(b => {
                        const t = (b.innerText || b.getAttribute('aria-label') || "").toUpperCase();
                        const style = window.getComputedStyle(b);
                        return style.display !== 'none' && (t.includes('ADD TO BAG') || t.includes('ADD TO CART'));
                    });

                    if (!addToBagBtn || addToBagBtn.disabled) return { available: false, reason: 'Add to Bag disabled', needsScreenshot: true };
                    return { available: true };
                }),
                new Promise(resolve => setTimeout(() => resolve({ available: false, reason: 'Evaluation Timeout' }), 15000))
            ]);
        } catch (err) {
            console.error(`Error checking stock for ${link}:`, err.message);
            return { available: false, reason: `Page Error: ${err.message}` };
        } finally {
            // No-op for now
        }
    }

    // New internal method to wrap checkStock with screenshot and PROXY RETRY
    async checkStockWithDebug(link, retryCount = 0) {
        const MAX_RETRIES = 5;
        const result = await this.checkStock(link);

        // If it's a block/error and we have retries left, try again with a NEW proxy
        if (result.reason && (result.reason.includes('Page Error/Block') || result.reason.includes('Timeout')) && retryCount < MAX_RETRIES) {
            console.log(`⚠️ Block detected for ${link}. Retrying with fresh session/proxy (${retryCount + 1}/${MAX_RETRIES})...`);
            await this.initBrowser(null, true); // Use fresh profile
            return await this.checkStockWithDebug(link, retryCount + 1);
        }

        if (result.needsScreenshot) {
            const path = `stock_fail_${Date.now()}.png`;
            await this.page.screenshot({ path });
            result.reason += ` (Screenshot: ${path})`;
        }
        return result;
    }

    async checkMyIp() {
        console.log("🔍 Checking browser IP...");
        await this.initBrowser();
        try {
            await this.page.goto('https://ipv4.webshare.io/', { waitUntil: 'networkidle2', timeout: 30000 });
            const ip = await this.page.evaluate(() => document.body.innerText.trim());
            console.log(`🌐 Browser IP: ${ip}`);
            return ip;
        } catch (e) {
            console.error("❌ Failed to check IP:", e.message);
            return `Error: ${e.message}`;
        }
    }

    async getProductLinks() {
        return await this.page.evaluate(() => {
            const links = new Set();
            console.log(`[DEBUG] getProductLinks on: ${document.title}`);
            console.log(`[DEBUG] Snippet: ${document.body.innerText.substring(0, 300)}`);

            // Helper to clean and make absolute
            const qualify = (href) => {
                if (!href) return null;
                if (href.startsWith('//')) return 'https:' + href;
                if (href.startsWith('/')) return window.location.origin + href;
                return href;
            };

            // Method 1: All links containing /p- or /p/ (product patterns)
            const allLinks = Array.from(document.querySelectorAll('a'));
            allLinks.forEach(a => {
                const href = qualify(a.getAttribute('href'));
                if (href && !href.includes('cart') && !href.includes('wishlist') && !href.includes('comment')) {
                    if (href.includes('/p-') || href.includes('/p/')) {
                        links.add(href);
                    }
                }
            });

            // Method 2: Specific SHEIN/Category selectors
            const specificSelectors = [
                '.S-product-item__img-container a',
                '.product-card__img-container a',
                '.item-img a',
                'a.product-item-img',
                'div[class*="product-item"] a',
                '.S-product-item__info a',
                '.product-item__name a',
                '.wish-list__item a',
                '.wish-item-info a',
                'a[data-type="product"]'
            ];

            specificSelectors.forEach(sel => {
                Array.from(document.querySelectorAll(sel)).forEach(a => {
                    const href = qualify(a.getAttribute('href'));
                    if (href && (href.includes('/p-') || href.includes('/p/'))) links.add(href);
                });
            });

            return Array.from(links);
        });
    }

    async scanSheinVerse(targetUrl, onResult) {
        this.isScanning = true;
        await this.initBrowser();

        const url = targetUrl || 'https://www.sheinindia.in/c/sverse-5939-37961';

        try {
            console.log(`Navigating to ${url}...`);
            // Use domcontentloaded for faster/more stable loading
            const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

            if (response && response.status() === 404) {
                throw new Error(`The page returned a 404 error. Please check the URL: ${url}`);
            }

            // Wait for dynamic content
            console.log('Waiting for content to load...');
            await new Promise(r => setTimeout(r, 8000));

            // Scroll several times to trigger lazy loading
            console.log('Scrolling to load more items...');
            await this.page.evaluate(async () => {
                for (let i = 0; i < 5; i++) {
                    window.scrollBy(0, 1000);
                    await new Promise(r => setTimeout(r, 800));
                }
            });

            // Debug screenshot
            const debugPath = `catalog_debug_${Date.now()}.png`;
            await this.page.screenshot({ path: debugPath });
            console.log(`[DEBUG] Catalog screenshot saved: ${debugPath}`);

            // Get product links
            const productLinks = await this.getProductLinks();
            console.log(`Found ${productLinks.length} products to scan...`);

            const limitedLinks = productLinks.slice(0, 50);
            for (const link of limitedLinks) {
                if (!this.isScanning) break;
                console.log(`Checking link: ${link}`);
                const stockInfo = await this.checkStock(link);
                if (stockInfo.available) {
                    onResult({ link, ...stockInfo });
                }
            }
        } catch (e) {
            console.error('Scan Error:', e.message);
            throw e;
        } finally {
            this.isScanning = false;
        }
    }

    async scanWishlist(onResult) {
        this.isScanning = true;
        await this.initBrowser();

        try {
            console.log('Navigating to Wishlist...');
            const url = 'https://www.sheinindia.in/wishlist';
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

            // Wait for wishlist content
            await new Promise(r => setTimeout(r, 8000));

            // Scroll a bit
            await this.page.evaluate(() => window.scrollBy(0, 500));

            // Debug screenshot
            const debugPath = `wishlist_debug_${Date.now()}.png`;
            await this.page.screenshot({ path: debugPath });
            console.log(`[DEBUG] Wishlist screenshot saved: ${debugPath}`);

            // Check for Access Denied or Challenge
            const bodyText = await this.page.evaluate(() => document.body.innerText.toLowerCase());
            if (bodyText.includes('access denied') || bodyText.includes('please enable cookies')) {
                throw new Error('Access Denied or Security Challenge triggered. Try running /login again to refresh session.');
            }

            // Check if login is needed
            const isLoginNeeded = await this.page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('sign in') || text.includes('log in') || !!document.querySelector('.login-box, #login-box');
            });

            if (isLoginNeeded) {
                throw new Error('Please run /login first to scan your wishlist.');
            }

            // Get product links from wishlist
            let productLinks = await this.getProductLinks();

            // If nothing found, try refreshing as requested by user
            if (productLinks.length === 0) {
                console.log('No wishlist items found, refreshing page...');
                await this.page.reload({ waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 8000));
                await this.page.evaluate(() => window.scrollBy(0, 500));
                productLinks = await this.getProductLinks();
            }

            console.log(`Found ${productLinks.length} wishlist items...`);

            for (const link of productLinks) {
                if (!this.isScanning) break;
                console.log(`Checking wishlist item: ${link}`);
                const stockInfo = await this.checkStock(link);
                if (stockInfo.available) {
                    onResult({ link, ...stockInfo });
                }
            }
        } catch (e) {
            console.error('Wishlist Scan Error:', e.message);
            throw e;
        } finally {
            this.isScanning = false;
        }
    }

    stopScan() {
        this.isScanning = false;
    }
}

module.exports = new BrowserManager();
