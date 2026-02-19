const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

puppeteer.use(StealthPlugin());

const USER_DATA_DIR = path.join(__dirname, 'chrome_profile');

class BrowserManager {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isScanning = false;
    }

    async initBrowser(overrideHeadless = null) {
        if (this.browser) return;

        const isHeadless = overrideHeadless !== null ? overrideHeadless : (process.env.HEADLESS === 'true');

        try {
            console.log(`Launching browser (Headless: ${isHeadless})...`);
            this.browser = await puppeteer.launch({
                headless: isHeadless ? 'new' : false,
                userDataDir: USER_DATA_DIR,
                ignoreHTTPSErrors: true, 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            console.log('✅ Browser launched successfully!');
        } catch (e) {
            console.error('❌ Failed to launch browser:', e.message);
            throw new Error('Could not launch browser. Make sure dependencies are installed.');
        }

        // Workaround for "Requesting main frame too early" with stealth plugin:
        // Don't use the existing pages[0]. Open a brand new context.
        try {
            const pages = await this.browser.pages();
            // Close all existing pages (usually just the default about:blank)
            await Promise.all(pages.map(p => p.close()));
        } catch (e) {
            console.log("Warning: Could not close initial pages:", e.message);
        }

        this.page = await this.browser.newPage();
        
        // Wait a moment for the page to be fully ready
        await new Promise(r => setTimeout(r, 1000));
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }

    async loginManual() {
        // Force headless false for login so user can see it (if running locally)
        await this.initBrowser(false);
        console.log("Browser open for login. Waiting 5 minutes (300s) for you to log in...");

        // Wait for manual intervention or timeout
        await new Promise(r => setTimeout(r, 300000));
        await this.closeBrowser();
        console.log("Login window closed and session saved.");
    }

    async addRandomSheinVerseItem() {
        console.log("🛒 Cart is empty! Finding a Shein Verse item to add...");
        try {
            await this.page.goto('https://www.sheinindia.in/c/sverse-5939-37961', { waitUntil: 'domcontentloaded' });
            await new Promise(r => setTimeout(r, 5000)); // Wait for list

            const links = await this.getProductLinks();
            
            for (const link of links.slice(0, 5)) { // Try first 5
                console.log(`Trying to add: ${link}`);
                const stock = await this.checkStock(link);
                
                if (stock.available) {
                    // We are already on the page (checkStock goes there)
                    // Select size
                    await this.page.evaluate(() => {
                        const sizes = document.querySelectorAll('.product-intro__size-choose .product-intro__size-radio:not(.product-intro__size-radio_disabled)');
                        if (sizes.length > 0) sizes[0].click();
                    });
                    
                    await new Promise(r => setTimeout(r, 500));

                    // Click Add to Bag
                    await this.page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        const addBtn = btns.find(b => b.innerText.toUpperCase().includes('ADD TO BAG'));
                        if (addBtn) addBtn.click();
                    });

                    console.log("✅ Added item to bag!");
                    await new Promise(r => setTimeout(r, 3000)); // Wait for add
                    return true;
                }
            }
        } catch (e) {
            console.error("Failed to add Shein Verse item:", e.message);
        }
        return false;
    }

    async ensureCartHasItem() {
        try {
            // Check if we have items
            const itemCount = await this.page.evaluate(() => {
                 // Try to resolve cart count from header or API
                 // Looking for common bag count elements
                 const badges = document.querySelectorAll('.j-bag-count, .header-cart-count, .iconfont-gouwudai .num');
                 for (const b of badges) {
                     const num = parseInt(b.innerText);
                     if (!isNaN(num)) return num;
                 }
                 return 0; // Default to 0 if not found
            });

            if (itemCount === 0) {
                await this.addRandomSheinVerseItem();
                // Go back to cart
                await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            console.error("Error ensuring cart has item:", e);
        }
    }

    async checkCoupons(coupons, options = { screenshot: true, detailed: true }) {
        await this.initBrowser();
        const results = [];

        try {
            if (!this.page.url().includes('cart')) {
                await this.page.goto('https://www.sheinindia.in/cart', { waitUntil: 'domcontentloaded' });
                // Wait for initial tokens/cookies to settle
                await new Promise(r => setTimeout(r, 4000));
            }

            // Ensure we have a Shein Verse item
            await this.ensureCartHasItem();

            for (const coupon of coupons) {
                if (options.detailed) console.log(`Checking via API: ${coupon}`);

                // Call the internal API directly from the browser context
                // This inherits all cookies and session headers
                const apiResult = await this.page.evaluate(async (code) => {
                    try {
                        const response = await fetch('/api/cart/apply-voucher', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest' 
                                // Browser adds Cookie, Origin, Referer automatically
                            },
                            body: JSON.stringify({
                                voucherId: code,
                                device: { client_type: 'web' }
                            })
                        });

                        const data = await response.json();
                        return { success: response.ok, data, status: response.status };
                    } catch (err) {
                        return { error: err.message };
                    }
                }, coupon);

                if (options.detailed) console.log(`API Response for ${coupon}:`, JSON.stringify(apiResult));

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
                         status = 'APPLICABLE';
                    } 
                    // Error Cases
                    else if (data.errorMessage && data.errorMessage.errors && data.errorMessage.errors.length > 0) {
                        const errorMsg = data.errorMessage.errors[0].message.toLowerCase();
                        
                        if (errorMsg.includes('invalid') || errorMsg.includes('does not exist')) {
                            status = 'INVALID';
                        } else if (errorMsg.includes('redeemed') || errorMsg.includes('limit') || errorMsg.includes('used')) {
                            status = 'REDEEMED';
                        } else if (errorMsg.includes('applicable') || errorMsg.includes('criteria')) {
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
        } catch (e) {
            console.error(e);
        } finally {
            if (options.closeBrowser !== false) {
                await this.closeBrowser();
            }
        }
        return results;
    }
    async checkStock(link) {
        try {
            await this.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));

            return await this.page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();

                // 1. Basic Out of Stock Check
                if (text.includes('sold out') || text.includes('restock') || text.includes('out of stock')) {
                    return { available: false, reason: 'Sold Out' };
                }

                // 2. Size Check - Attempt to find available sizes
                const sizeItems = Array.from(document.querySelectorAll('.product-intro__size-choose .product-intro__size-radio:not(.product-intro__size-radio_disabled)'));
                if (sizeItems.length === 0) {
                    return { available: false, reason: 'No sizes available' };
                }

                // 3. Add to Bag Button Check
                const addToBagBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.toUpperCase().includes('ADD TO BAG'));
                if (!addToBagBtn || addToBagBtn.disabled) {
                    return { available: false, reason: 'Add to Bag disabled' };
                }

                // Get title and price
                const title = document.querySelector('.product-intro__head-name')?.innerText || 'Product';
                const price = document.querySelector('.product-intro__head-mainprice .common-price')?.innerText || 'Unknown';

                return { available: true, title, price, sizes: sizeItems.map(s => s.innerText.trim()) };
            });
        } catch (err) {
            console.error(`Error checking stock for ${link}:`, err.message);
            return { available: false, reason: 'Page Load Error' };
        }
    }

    async getProductLinks() {
        return await this.page.evaluate(() => {
            const links = new Set();

            // Helper to clean and make absolute
            const qualify = (href) => {
                if (!href) return null;
                if (href.startsWith('//')) return 'https:' + href;
                if (href.startsWith('/')) return window.location.origin + href;
                return href;
            };

            // Method 1: All links containing /p- (product pattern)
            const allLinks = Array.from(document.querySelectorAll('a[href*="/p-"]'));
            allLinks.forEach(a => {
                const href = qualify(a.getAttribute('href'));
                if (href && !href.includes('cart') && !href.includes('wishlist') && !href.includes('comment') && href.includes('/p-')) {
                    links.add(href);
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
                    if (href && href.includes('/p-')) links.add(href);
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
