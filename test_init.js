const browserManager = require('./browserManager');
require('dotenv').config();

// Override console.log to be sure it's working
const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, [`[LOG][${new Date().toISOString()}]`, ...args]);
};

async function test() {
    console.log('--- Starting Browser Init Test ---');
    try {
        // Force headless true and no proxy for a simple local test if PROXY_LIST is slow
        // However, the user is having proxy issues, so let's test with PROXY_LIST first
        await browserManager.initBrowser(true, false, false); 
        console.log('--- Browser Init Successful ---');
        await browserManager.closeBrowser();
        process.exit(0);
    } catch (err) {
        console.error('--- Browser Init Failed ---');
        console.error(err.message);
        // Ensure browser is closed
        await browserManager.closeBrowser().catch(() => {});
        process.exit(1);
    }
}

test();
