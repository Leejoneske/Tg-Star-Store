# SPA Conversion Guide

## Overview
Your application is now set up as a Single Page Application (SPA). The router handles client-side navigation without full page refreshes while maintaining all API connections.

## Architecture

### Server-Side (server.js)
- Added catch-all route that serves `spa-index.html` for all non-API paths
- All `/api/*` endpoints continue to work unchanged
- Static files are still served normally

### Client-Side
- **spa-router.js**: Simple client-side router that manages navigation
- **spa-index.html**: Main entry point that initializes the app
- API connections remain unchanged (axios still works normally)

## How to Convert Existing Pages

### Step 1: Use Current Approach (Gradual Migration)
For now, you can use the existing pages without refactoring:

```javascript
// In spa-index.html router registration
router.register('/sell', async () => {
    const response = await fetch('/sell.html');
    return await response.text();
}, { name: 'sell' });
```

This loads your existing `sell.html` directly.

### Step 2: Create Templates (For New Pages or Refactors)
If you want to create optimized templates, create files in `/public/spa/`:

```html
<!-- /public/spa/home.html -->
<div id="page-content">
    <!-- Just the main content, no <html>, <head>, or <body> tags -->
    <main class="page-wrapper">
        <h1>Home</h1>
        <p>Page content here</p>
    </main>
</div>
```

Then register it:
```javascript
router.register('/', async () => {
    const response = await fetch('/spa/home.html');
    return await response.text();
}, { name: 'home' });
```

## Page Scripts & Functionality

When a page loads, these happen automatically:

1. **Translations**: `TranslationUtils.applyTranslations()` is called
2. **Theme**: Dark/light theme is applied
3. **Custom Events**: `spa:pageLoaded` event fires for page init code

### Add Page-Specific Scripts

For pages with complex interactions, add this listener:

```javascript
document.addEventListener('spa:pageLoaded', (e) => {
    if (e.detail.path === '/sell') {
        initializeSellPage();
    }
});
```

## Navigation

### SPA Navigation (No Full Reload)
```html
<!-- These work automatically with SPA router -->
<a href="/sell">Go to Sell</a>
<a href="/referral">Go to Referral</a>
```

### External Links (Open Outside App)
```html
<!-- For Telegram WebApp links -->
<a href="https://t.me/StarStore_app" class="external-link">Telegram</a>
```

### Programmatic Navigation
```javascript
window.router.navigate('/sell');
```

## Global Utilities

All scripts from spa-index.html are globally available:

```javascript
window.router     // The SPA router instance
window.Telegram   // Telegram WebApp API
axios            // HTTP client for API calls
TranslationUtils // Translation system
```

## API Calls

All existing API calls work unchanged:

```javascript
// All of these continue to work exactly as before
const response = await axios.get('/api/sell-orders');
const result = await axios.post('/api/sell-orders', data);
const statss = await axios.get('/api/referral-stats/:userId');
```

## Query Parameters & Hash

The router supports query parameters and hash fragments:

```javascript
// These all work
window.router.navigate('/sell?stars=100');
window.router.navigate('/referral#top');
window.location.href = '/sell?type=buy'; // Also works with router
```

## Browser History

Back/forward buttons work automatically. The router uses the History API:

```javascript
// Browser back button works automatically
// Click interceptor prevents full page reload
```

## Dark Theme

Dark theme works automatically on all pages:
- Uses CSS variables: `var(--surface)`, `var(--text)`, `var(--brand)`
- System preference is detected (prefers-color-scheme)
- All pages inherit theme automatically

## Performance Tips

1. **Lazy Load Heavy Content**
   - Load charts, lists after page renders
   - Show skeleton loaders while fetching

2. **Cache Page Data**
   - Store API results when navigating back
   - Refresh when needed

3. **Optimize Templates**
   - Keep templates small (just HTML structure)
   - Use CSS, not inline styles

## Conversion Checklist

- [ ] Test navigation between pages
- [ ] Verify API calls work (`/api/*` endpoints)
- [ ] Check translations apply to loaded pages
- [ ] Test dark theme works
- [ ] Test Telegram WebApp features
- [ ] Test browser back/forward
- [ ] Test external links

## Troubleshooting

### 404 on API calls
- Make sure routes are registered
- Check that `/api/*` endpoints still exist
- Verify axios is loading properly

### Layout breaks on page load
- Check that CSS variables are being applied: `var(--surface)`, etc.
- Verify theme.css is loaded
- Check for hardcoded colors in page HTML

### Translations not working
- Make sure `TranslationUtils` is loaded before router init
- Call `TranslationUtils.applyTranslations()` after page loads

### Telegram WebApp not working
- Verify `telegram-web-app.js` is loaded first
- Check that Telegram API is initialized before router

## Next Steps

1. Build templates for frequently changed pages
2. Add caching for navigation history
3. Implement progressive loading for large content
4. Add service worker for offline support
