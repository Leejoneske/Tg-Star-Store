
require('dotenv').config();
const mongoose = require('mongoose');

let cachedDb = null;
const connectMongoDB = async () => {
  if (cachedDb) return cachedDb;
  
  try {
    const connection = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      retryReads: true
    });
    cachedDb = connection;
    return connection;
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectMongoDB();
    const isMongoConnected = mongoose.connection.readyState === 1;
    
    res.json({
      status: 'ok',
      mongodb: isMongoConnected,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      mongodb: false,
      timestamp: new Date().toISOString()
    });
  }
}
