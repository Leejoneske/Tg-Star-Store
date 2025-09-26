## i18n rollout: Arabic and Hindi

This change ensures consistent translation behavior across the app and adds missing strings for Hindi (hi) and Arabic (ar).

Highlights:

- Added keys used by Sell/History/Referral/About pages (e.g., progress, estCompletion, why21Days, invalid/memo titles, openTelegram, active, date, transactions).
- Wired remaining hardcoded Sell strings to translation keys, and localized the “Why 21 days?” link.
- About page now uses the main language selector (en/ru/hi/ar) and re-applies translations after dynamic content.
- Pages re-apply translations after dynamic DOM inserts (e.g., bottom nav) and on language change.

Verification:

- Switch to ar/hi in the main app, then open Sell/History/Referral/About directly; text localizes correctly and Arabic flips to RTL.
