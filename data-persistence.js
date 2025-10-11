// Simple file-based data persistence for development
const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'database.json');

class DataPersistence {
  constructor() {
    this.data = {
      users: {},
      dailyStates: {},
      referrals: [],
      orders: [],
      notifications: [],
      ambassadorWaitlist: []
    };
    this.loadData();
  }

  async loadData() {
    try {
      // Ensure data directory exists
      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
      
      const fileContent = await fs.readFile(DATA_FILE, 'utf8');
      this.data = JSON.parse(fileContent);
      console.log('📁 Loaded persistent data from file');
    } catch (error) {
      console.log('📁 No existing data file, starting fresh');
      await this.saveData();
    }
  }

  // Ambassador waitlist operations
  async createAmbassadorWaitlist(entry) {
    this.data.ambassadorWaitlist = this.data.ambassadorWaitlist || [];
    this.data.ambassadorWaitlist.push(entry);
    await this.saveData();
    return entry;
  }

  async listAmbassadorWaitlist() {
    return this.data.ambassadorWaitlist || [];
  }

  async saveData() {
    try {
      await fs.writeFile(DATA_FILE, JSON.stringify(this.data, null, 2));
      console.log('💾 Data saved to persistent storage');
    } catch (error) {
      console.error('❌ Failed to save data:', error.message);
    }
  }

  // User operations
  async createUser(userData) {
    this.data.users[userData.id] = userData;
    await this.saveData();
    return userData;
  }

  async findUser(userId) {
    return this.data.users[userId] || null;
  }

  async updateUser(userId, updateData) {
    if (this.data.users[userId]) {
      this.data.users[userId] = { ...this.data.users[userId], ...updateData };
      await this.saveData();
      return this.data.users[userId];
    }
    return null;
  }

  // Daily state operations
  async createDailyState(stateData) {
    this.data.dailyStates[stateData.userId] = stateData;
    await this.saveData();
    return stateData;
  }

  async findDailyState(userId) {
    return this.data.dailyStates[userId] || null;
  }

  async updateDailyState(userId, updateData) {
    if (this.data.dailyStates[userId]) {
      this.data.dailyStates[userId] = { ...this.data.dailyStates[userId], ...updateData };
      await this.saveData();
      return this.data.dailyStates[userId];
    }
    return null;
  }

  async findAllDailyStates() {
    return Object.values(this.data.dailyStates);
  }

  async countDailyStates(query = {}) {
    const states = Object.values(this.data.dailyStates);
    if (query.totalPoints) {
      return states.filter(s => s.totalPoints > query.totalPoints.$gt).length;
    }
    return states.length;
  }

  // Referral operations
  async createReferral(referralData) {
    this.data.referrals.push(referralData);
    await this.saveData();
    return referralData;
  }

  async findReferrals(query = {}) {
    let referrals = this.data.referrals;
    
    if (query.referrerUserId) {
      referrals = referrals.filter(r => r.referrerUserId === query.referrerUserId);
    }
    if (query.status) {
      referrals = referrals.filter(r => query.status.$in.includes(r.status));
    }
    
    return referrals;
  }

  async countReferrals(query = {}) {
    const referrals = await this.findReferrals(query);
    return referrals.length;
  }

  async aggregateReferrals(pipeline) {
    // Simple aggregation for referrals
    let referrals = this.data.referrals;
    
    // Apply match stage
    const matchStage = pipeline.find(p => p.$match);
    if (matchStage) {
      const match = matchStage.$match;
      if (match.status) {
        referrals = referrals.filter(r => match.status.$in.includes(r.status));
      }
    }
    
    // Apply group stage
    const groupStage = pipeline.find(p => p.$group);
    if (groupStage) {
      const group = groupStage.$group;
      const grouped = {};
      
      referrals.forEach(ref => {
        const key = ref[group._id.replace('$', '')];
        if (!grouped[key]) {
          grouped[key] = { _id: key, referralsCount: 0 };
        }
        grouped[key].referralsCount += 1;
      });
      
      referrals = Object.values(grouped);
    }
    
    // Apply sort stage
    const sortStage = pipeline.find(p => p.$sort);
    if (sortStage) {
      const sort = sortStage.$sort;
      referrals.sort((a, b) => {
        for (const [field, direction] of Object.entries(sort)) {
          if (a[field] > b[field]) return direction === -1 ? -1 : 1;
          if (a[field] < b[field]) return direction === -1 ? 1 : -1;
        }
        return 0;
      });
    }
    
    // Apply limit stage
    const limitStage = pipeline.find(p => p.$limit);
    if (limitStage) {
      referrals = referrals.slice(0, limitStage.$limit);
    }
    
    return referrals;
  }

  // Activity operations
  async createActivity(activityData) {
    this.data.activities = this.data.activities || [];
    this.data.activities.push(activityData);
    await this.saveData();
    return activityData;
  }

  async findActivities(query = {}) {
    const activities = this.data.activities || [];
    
    if (query.userId) {
      return activities.filter(a => a.userId === query.userId);
    }
    if (query.activityType) {
      return activities.filter(a => a.activityType === query.activityType);
    }
    
    return activities;
  }

  async countActivities(query = {}) {
    const activities = await this.findActivities(query);
    return activities.length;
  }
}

module.exports = DataPersistence;