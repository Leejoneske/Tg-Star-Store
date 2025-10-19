// Minimal Data Persistence Module
// This is a fallback for development/testing when MongoDB is not available

class DataPersistence {
    constructor() {
        this.data = {
            ambassadorWaitlist: [],
            users: {},
            orders: {},
            referrals: {}
        };
    }

    // Ambassador waitlist methods
    async listAmbassadorWaitlist() {
        return this.data.ambassadorWaitlist || [];
    }

    async createAmbassadorWaitlist(entry) {
        if (!this.data.ambassadorWaitlist) {
            this.data.ambassadorWaitlist = [];
        }
        this.data.ambassadorWaitlist.push(entry);
        return entry;
    }

    // Generic data access methods
    async getData(key) {
        return this.data[key];
    }

    async setData(key, value) {
        this.data[key] = value;
        return value;
    }

    // Save method (no-op for memory storage)
    async save() {
        // In a real implementation, this would save to file
        return true;
    }
}

module.exports = DataPersistence;