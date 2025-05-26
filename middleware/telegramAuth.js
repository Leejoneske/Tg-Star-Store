// middleware/telegramAuth.js
const crypto = require('crypto');

function verifyTelegramAuth(botToken) {
  return (req, res, next) => {
    // Skip auth for API routes, health checks, and static files
    if (req.path.startsWith('/api') || 
        req.path === '/health' ||
        req.path.startsWith('/public') ||
        req.path === '/telegram-webhook') {
      return next();
    }

    // Check for Telegram WebApp initData
    const initData = req.query.initData || req.headers['telegram-init-data'];
    
    if (initData) {
      try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        
        // Create data-check-string
        const dataCheckString = Array.from(params.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');
        
        // Verify hash
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey)
          .update(dataCheckString)
          .digest('hex');
        
        if (calculatedHash === hash) {
          return next();
        }
      } catch (err) {
        console.error('Telegram auth error:', err);
      }
    }

    // Not authenticated - show error page
    return res.status(403).send(`
      <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 Page Not Found</title>
    <style>
        /*******************************************************
            404 page
        ---*/
        body {
            margin: 0;
            padding: 0;
            font-family: 'Arvo', serif;
            background: #fff;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            text-align: center;
        }
        
        .page_404 {
            width: 100%;
            max-width: 800px;
            padding: 40px 20px;
        }
        
        .four_zero_four_bg {
            background-image: url(https://cdn.dribbble.com/users/285475/screenshots/2083086/dribbble_1.gif);
            height: 400px;
            background-position: center;
            background-repeat: no-repeat;
            position: relative;
            margin-bottom: 30px;
        }
        
        .four_zero_four_bg h1 {
            font-size: 80px;
            margin: 0;
            position: absolute;
            top: 0;
            left: 50%;
            transform: translateX(-50%);
        }
        
        .contant_box_404 {
            text-align: center;
        }
        
        .contant_box_404 h3 {
            font-size: 24px;
            margin-bottom: 10px;
        }
        
        .contant_box_404 p {
            font-size: 18px;
            margin-bottom: 20px;
        }
        
        .link_404 {
            color: #fff !important;
            padding: 10px 20px;
            background: #39ac31;
            margin: 20px 0;
            display: inline-block;
            text-decoration: none;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.3s;
        }
        
        .link_404:hover {
            background: #2d8a26;
        }
    </style>
</head>
<body>
    <section class="page_404">
        <div class="four_zero_four_bg">
            <h1>404</h1>
        </div>
        <div class="contant_box_404">
            <h3>Look like you're lost</h3>
            <p>the page you are looking for not avaible!</p>
            <a onclick="window.location.href='index.html'" class="link_404">Go to Home</a>
        </div>
    </section>

    <script>
        // Alternative JavaScript approach if needed
        document.querySelector('.link_404').addEventListener('click', function() {
            window.location.href = 'index.html';
        });
    </script>
</body>
</html>
    `);
  };
}

module.exports = verifyTelegramAuth;
