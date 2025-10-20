const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : ['123456789'];

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// Generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP (mock implementation - integrate with your Telegram bot)
async function sendOTP(telegramId, otp) {
  // TODO: Integrate with Telegram bot to send OTP
  console.log(`📱 OTP for ${telegramId}: ${otp}`);
  return true;
}

// Middleware to verify JWT
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Send OTP endpoint
router.post('/send-otp', [
  body('telegramId').isNumeric().withMessage('Valid Telegram ID required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { telegramId } = req.body;
    
    // Check if user is admin
    if (!ADMIN_IDS.includes(telegramId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    
    otpStore.set(telegramId, { otp, expiresAt });
    
    await sendOTP(telegramId, otp);
    
    res.json({ 
      success: true, 
      message: 'OTP sent successfully',
      expiresIn: 300 // 5 minutes in seconds
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP and login
router.post('/verify-otp', [
  body('telegramId').isNumeric().withMessage('Valid Telegram ID required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { telegramId, otp } = req.body;
    
    const storedOTP = otpStore.get(telegramId);
    
    if (!storedOTP) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }
    
    if (Date.now() > storedOTP.expiresAt) {
      otpStore.delete(telegramId);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }
    
    if (storedOTP.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    
    // OTP is valid, clean up and generate JWT
    otpStore.delete(telegramId);
    
    const token = jwt.sign(
      { 
        telegramId, 
        isAdmin: true,
        iat: Math.floor(Date.now() / 1000)
      }, 
      JWT_SECRET, 
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      token,
      user: {
        telegramId,
        isAdmin: true
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Refresh token
router.post('/refresh', verifyToken, (req, res) => {
  try {
    const token = jwt.sign(
      { 
        telegramId: req.user.telegramId, 
        isAdmin: true,
        iat: Math.floor(Date.now() / 1000)
      }, 
      JWT_SECRET, 
      { expiresIn: '24h' }
    );
    
    res.json({ success: true, token });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Logout
router.post('/logout', verifyToken, (req, res) => {
  // In a production app, you might want to blacklist the token
  res.json({ success: true, message: 'Logged out successfully' });
});

// Verify current session
router.get('/me', verifyToken, (req, res) => {
  res.json({
    success: true,
    user: {
      telegramId: req.user.telegramId,
      isAdmin: req.user.isAdmin
    }
  });
});

module.exports = router;