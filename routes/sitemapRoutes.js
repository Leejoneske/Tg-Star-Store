const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// Generate dynamic sitemap
router.get('/sitemap.xml', (req, res) => {
    const baseUrl = process.env.BASE_URL || 'https://yourdomain.com';
    const currentDate = new Date().toISOString().split('T')[0];
    
    // Define your site structure
    const pages = [
        { url: '/', priority: '1.0', changefreq: 'daily' },
        { url: '/index.html', priority: '1.0', changefreq: 'daily' },
        { url: '/about.html', priority: '0.8', changefreq: 'weekly' },
        { url: '/sell.html', priority: '0.9', changefreq: 'daily' },
        { url: '/history.html', priority: '0.7', changefreq: 'daily' },
        { url: '/referral.html', priority: '0.6', changefreq: 'weekly' },
        { url: '/notification.html', priority: '0.5', changefreq: 'daily' },
        { url: '/blog/', priority: '0.8', changefreq: 'weekly' },
        { url: '/blog/index.html', priority: '0.8', changefreq: 'weekly' },
        { url: '/blog/telegram-stars-guide.html', priority: '0.7', changefreq: 'monthly' }
    ];
    
    // Generate sitemap XML
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    
    pages.forEach(page => {
        sitemap += `
    <url>
        <loc>${baseUrl}${page.url}</loc>
        <lastmod>${currentDate}</lastmod>
        <changefreq>${page.changefreq}</changefreq>
        <priority>${page.priority}</priority>
    </url>`;
    });
    
    sitemap += `
</urlset>`;
    
    res.header('Content-Type', 'application/xml');
    res.send(sitemap);
});

// Generate robots.txt
router.get('/robots.txt', (req, res) => {
    const baseUrl = process.env.BASE_URL || 'https://yourdomain.com';
    
    const robotsTxt = `User-agent: *
Allow: /

# Sitemap location
Sitemap: ${baseUrl}/api/sitemap.xml

# Allow crawling of all pages
Allow: /index.html
Allow: /about.html
Allow: /sell.html
Allow: /history.html
Allow: /referral.html
Allow: /notification.html
Allow: /blog/

# Allow crawling of static assets
Allow: /css/
Allow: /js/
Allow: /images/

# Allow crawling of API endpoints (for SEO purposes)
Allow: /api/

# Disallow admin or sensitive areas
Disallow: /admin/
Disallow: /private/
Disallow: /temp/

# Crawl delay (optional - be respectful to server)
Crawl-delay: 1`;
    
    res.header('Content-Type', 'text/plain');
    res.send(robotsTxt);
});

module.exports = router;