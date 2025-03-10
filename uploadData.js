require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

mongoose.connect(process.env.MONGODB_URI);

const userSchema = new mongoose.Schema({
    id: String,
    username: String
});

const referralSchema = new mongoose.Schema({
    referredUserId: String,
    referrerUserId: String,
    status: String,
    dateReferred: Date,
    dateCompleted: Date
});

const UserModel = mongoose.model('User', userSchema);
const ReferralModel = mongoose.model('Referral', referralSchema);

const usersFilePath = path.join(__dirname, 'users.json');
const referralsFilePath = path.join(__dirname, 'referrals.json');

const usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8')).users;
const referralsData = JSON.parse(fs.readFileSync(referralsFilePath, 'utf8')).referrals;

async function uploadData() {
    try {
        const usersCount = usersData.length;
        const referralsCount = referralsData.length;

        await UserModel.insertMany(usersData);
        await ReferralModel.insertMany(referralsData);

        console.log(`✅ Uploaded ${usersCount} users and ${referralsCount} referrals to MongoDB.`);
    } catch (err) {
        console.error('❌ Error uploading data:', err);
    } finally {
        mongoose.connection.close();
    }
}

uploadData();
