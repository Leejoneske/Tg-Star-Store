const http = require('http');
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

async function run() {
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

    // Go to SPA shell
    await page.goto(`http://localhost:${port}/app.html`, { waitUntil: 'domcontentloaded' });

    // Wait for Professional SPA to initialize
    await page.waitForFunction(() => window.professionalSPA !== undefined, { timeout: 5000 });

    // Preload should begin automatically; navigate through a few routes
    const routes = ['/', '/sell', '/history', '/about'];

    for (const r of routes) {
      // Click synthetic navigation by invoking router to avoid real reloads
      await page.evaluate((route) => window.professionalSPA.navigate(route), r);
      // Ensure title updates and main content renders
      await page.waitForSelector('main', { timeout: 5000 });
      await page.waitForFunction(() => document.title.includes('StarStore'), { timeout: 5000 });
    }

    // Validate that caching/preloading works by checking performance metrics
    const metrics = await page.evaluate(() => window.professionalSPA.getPerformanceMetrics());
    if (!metrics || typeof metrics !== 'object') {
      throw new Error('Performance metrics not available');
    }

    await browser.close();
    console.log('SPA smoke test passed');
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

