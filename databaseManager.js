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
        return this.data.authorized_users.some(u => String(u) === String(userId));
    }

    addUser(userId) {
        if (!this.data.authorized_users.some(u => String(u) === String(userId))) {
            this.data.authorized_users.push(Number(userId));
            this.save();
            return true;
        }
        return false;
    }

    removeUser(userId) {
        const initialLength = this.data.authorized_users.length;
        this.data.authorized_users = this.data.authorized_users.filter(u => String(u) !== String(userId));
        this.save();
        return this.data.authorized_users.length < initialLength;
    }

    getAuthorizedUsers() {
        return this.data.authorized_users;
    }
}

module.exports = new DatabaseManager();
