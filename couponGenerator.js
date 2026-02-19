const crypto = require('crypto');

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
    return result;
}

function generateCoupons(type, count) {
    const coupons = [];
    let prefix = '';
    switch (type) {
        case '500': prefix = 'SVI'; break;
        case '1000': prefix = 'SVDJ'; break;
        case '2000': prefix = 'SVCS'; break;
        default: throw new Error('Invalid type (500, 1000, 2000)');
    }
    for (let i = 0; i < count; i++) {
        coupons.push(prefix + generateRandomString(15 - prefix.length));
    }
    return coupons;
}

module.exports = { generateCoupons };
