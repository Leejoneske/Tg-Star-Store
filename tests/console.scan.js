const { spawn } = require('child_process');
const path = require('path');

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error('Server did not become ready in time');
}

(async () => {
  const puppeteer = require('puppeteer');
  const port = process.env.PORT || 8080;

  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..')
  });

  try {
    await waitForServer(`http://localhost:${port}/app.html`);

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', msg => {
      if (['error'].includes(msg.type())) {
        consoleErrors.push(`[console.${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push(`[pageerror] ${err.message}`);
    });

    // Directly open key pages as static and via SPA to catch syntax errors
    const staticPages = ['/', '/sell', '/history', '/about', '/blog', '/knowledge-base'];

    // Check static direct load
    for (const p of staticPages) {
      const url = `http://localhost:${port}${p === '/' ? '/index.html' : p + (p.endsWith('.html') ? '' : '')}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    // Go to SPA shell then navigate through routes
    await page.goto(`http://localhost:${port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.professionalSPA !== undefined, { timeout: 5000 });
    for (const r of staticPages) {
      await page.evaluate(route => window.professionalSPA.navigate(route), r);
      await page.waitForSelector('main', { timeout: 5000 });
    }

    await browser.close();

    if (consoleErrors.length) {
      console.log('Console/Syntax errors detected:');
      consoleErrors.forEach(line => console.log(line));
      process.exitCode = 1;
    } else {
      console.log('No console or syntax errors observed across pages.');
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();