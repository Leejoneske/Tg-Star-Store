// Debug script to test authentication
const express = require('express');
const app = express();

// Simple middleware to log all headers
app.use((req, res, next) => {
  console.log('=== REQUEST DEBUG ===');
  console.log('URL:', req.url);
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Query:', req.query);
  console.log('====================');
  next();
});

app.use(express.json());

// Test endpoint that mimics the notification endpoint
app.get('/test-auth', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const telegramId = req.headers['x-telegram-id'];
  
  console.log('Auth Debug:');
  console.log('- initData present:', !!initData);
  console.log('- initData length:', initData ? initData.length : 0);
  console.log('- telegramId header:', telegramId);
  console.log('- telegramId type:', typeof telegramId);
  console.log('- telegramId === "undefined":', telegramId === 'undefined');
  
  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      console.log('- user param from initData:', userParam);
      if (userParam) {
        const user = JSON.parse(userParam);
        console.log('- parsed user:', user);
        console.log('- user.id:', user.id);
        console.log('- user.id type:', typeof user.id);
      }
    } catch (e) {
      console.log('- initData parse error:', e.message);
    }
  }
  
  res.json({
    success: true,
    receivedHeaders: {
      initData: !!initData,
      initDataLength: initData ? initData.length : 0,
      telegramId: telegramId,
      telegramIdType: typeof telegramId
    }
  });
});

app.listen(3002, () => {
  console.log('Debug server running on port 3002');
  console.log('Test with: curl -H "x-telegram-id: test" -H "x-telegram-init-data: user=%7B%22id%22%3A123%7D" http://localhost:3002/test-auth');
});