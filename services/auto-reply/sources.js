// ============================================================
// Auto-Reply Knowledge Sources
// ------------------------------------------------------------
// Add a new entry here to teach the bot a new source of facts.
//
// Source shape:
//   { type: 'sitemap', url, refreshHours? }   // crawls every URL in the sitemap
//   { type: 'url',     url, refreshHours? }   // fetches a single URL
//   { type: 'file',    path }                 // reads a local HTML/MD/text file
// ============================================================

const path = require('path');

module.exports = [
    // External blog — discovered via sitemap, auto-refreshed
    { type: 'sitemap', url: 'https://blog.starstore.app/sitemap.xml', refreshHours: 6 },

    // Public site pages bundled with the app
    { type: 'file', path: path.join(__dirname, '..', '..', 'public', 'about.html') },
    { type: 'file', path: path.join(__dirname, '..', '..', 'public', 'policy.html') },
    { type: 'file', path: path.join(__dirname, '..', '..', 'public', 'support.html') },
    { type: 'file', path: path.join(__dirname, '..', '..', 'public', 'feedback.html') },
    { type: 'file', path: path.join(__dirname, '..', '..', 'README.md') },
];
