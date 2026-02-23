const fs = require('fs-extra');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');

class DatabaseManager {
    constructor() {
        this.data = {
            authorized_users: []
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(DB_PATH)) {
                this.data = fs.readJsonSync(DB_PATH);

                // BACKWARD COMPATIBILITY: Convert numeric array to objects if needed
                if (Array.isArray(this.data.authorized_users)) {
                    this.data.authorized_users = this.data.authorized_users.map(u => {
                        if (typeof u === 'number' || typeof u === 'string') {
                            return { id: Number(u), isVip: false };
                        }
                        return u;
                    });
                }
            } else {
                this.save();
            }
        } catch (e) {
            console.error('Error loading database:', e.message);
        }
    }

    save() {
        try {
            fs.writeJsonSync(DB_PATH, this.data, { spaces: 2 });
        } catch (e) {
            console.error('Error saving database:', e.message);
        }
    }

    isAuthorized(userId) {
        if (!userId) return false;

        // Check if Admin (always authorized)
        if (process.env.ADMIN_ID && String(userId) === String(process.env.ADMIN_ID)) {
            return true;
        }

        // Check user list
        return this.data.authorized_users.some(u => String(u.id) === String(userId));
    }

    isVip(userId) {
        if (!userId) return false;
        if (process.env.ADMIN_ID && String(userId) === String(process.env.ADMIN_ID)) return true;

        const user = this.data.authorized_users.find(u => String(u.id) === String(userId));
        return user ? !!user.isVip : false;
    }

    addUser(userId) {
        if (!this.data.authorized_users.some(u => String(u.id) === String(userId))) {
            this.data.authorized_users.push({ id: Number(userId), isVip: false });
            this.save();
            return true;
        }
        return false;
    }

    setVip(userId, status = true) {
        const user = this.data.authorized_users.find(u => String(u.id) === String(userId));
        if (user) {
            user.isVip = status;
            this.save();
            return true;
        }
        return false;
    }

    removeUser(userId) {
        const initialLength = this.data.authorized_users.length;
        this.data.authorized_users = this.data.authorized_users.filter(u => String(u.id) !== String(userId));
        this.save();
        return this.data.authorized_users.length < initialLength;
    }

    getAuthorizedUsers() {
        return this.data.authorized_users;
    }
}

module.exports = new DatabaseManager();
