// ============================================================
// Auto-Reply Intents
// ------------------------------------------------------------
// Each intent is a self-contained rule. Add a new object to the
// array to teach the bot a new auto-reply. No code changes
// needed elsewhere.
//
// Intent shape:
//   id            unique identifier (string)
//   description   human-readable purpose
//   priority      higher runs first (default 0). Use to disambiguate
//                 overlapping intents (e.g. "how to sell" > "sell").
//   patterns      array of RegExp that, if any match, trigger this intent
//   anyOf         array of keyword strings; match if ANY appear (word-ish)
//   allOf         array of keyword strings; match only if ALL appear
//   noneOf        array of keyword strings; reject if ANY appear
//   minLength     ignore very short messages (default 0)
//   maxLength     ignore very long messages (default Infinity)
//   reply         string OR function(ctx) -> string  (the message text)
//   parseMode     'Markdown' | 'HTML' | undefined
//   buttons       inline keyboard rows (array of arrays of {text, url|web_app|callback_data})
//   followUp      optional { text, buttons } sent right after the main reply
//   offerHuman    when true, append a "Talk to a person" follow-up automatically
// ============================================================

const SELL_URL = 'https://starstore.app/sell';
const BUY_URL = 'https://starstore.app/';
const REFERRAL_URL = 'https://starstore.app/referral';
const DAILY_URL = 'https://starstore.app/daily';
const SUPPORT_URL = 'https://starstore.app/support';
const AMBASSADOR_URL = 'https://starstore.app/apply_ambassador';

const intents = [
    // ---------------- HOW TO SELL ----------------
    {
        id: 'how_to_sell',
        description: 'User is asking how to sell stars',
        priority: 100,
        patterns: [
            /how.*sell/i,
            /how.*to.*sell/i,
            /sell.*how/i,
            /how.*selling/i,
            /selling.*how/i,
            /how.*sell.*stars?/i,
            /sell.*stars?.*how/i,
            /how.*sell.*telegram/i,
            /way.*to.*sell/i,
            /steps?.*to.*sell/i,
        ],
        anyOf: ['sell', 'selling', 'sale'],
        reply: 'Hi, click on launch App below ↙️ tap Sell at the bottom, enter your USDT TON wallet address, the number of stars you want to sell, then tap Sell Now.',
        buttons: [[{ text: '💰 Open Sell Page', web_app: { url: SELL_URL } }]],
        offerHuman: true,
    },

    // ---------------- HOW TO BUY ----------------
    {
        id: 'how_to_buy',
        description: 'User is asking how to buy stars',
        priority: 100,
        patterns: [
            /how.*buy.*stars?/i,
            /how.*to.*buy/i,
            /buy.*how/i,
            /purchas.*stars?/i,
            /how.*purchase/i,
            /way.*to.*buy/i,
        ],
        anyOf: ['buy', 'purchase', 'order'],
        reply: 'To buy Telegram Stars: open the app, choose the star pack you want, enter the recipient\'s @username, then pay with TON or USDT. Delivery is instant.',
        buttons: [[{ text: '⭐ Open Buy Page', web_app: { url: BUY_URL } }]],
        offerHuman: true,
    },

    // ---------------- WANT / NEED STARS (intent to buy) ----------------
    {
        id: 'want_stars',
        description: 'User says they need / want / are looking for stars',
        priority: 95,
        patterns: [
            /\b(i\s*)?(need|want|looking\s*for|get\s*me|gimme|buy\s*me)\s+(some\s+|more\s+)?(telegram\s+)?stars?\b/i,
            /\bwhere.*(buy|get).*stars?\b/i,
            /\bcan\s*i\s*(buy|get).*stars?\b/i,
        ],
        reply: 'Got it — you can grab Telegram Stars right here. Open the app, pick a star pack, enter the recipient @username, and pay with TON or USDT. Delivery is instant.',
        buttons: [[{ text: '⭐ Buy Stars', web_app: { url: BUY_URL } }]],
        offerHuman: true,
    },

    // ---------------- PAYMENT / WITHDRAW TIME ----------------
    {
        id: 'payment_time',
        description: 'When will I receive payment / how long does withdrawal take',
        priority: 90,
        patterns: [
            /how.*long.*(pay|paid|payment|withdraw|receive)/i,
            /when.*(pay|paid|payment|receive|get.*money|get.*usdt)/i,
            /payment.*time/i,
            /withdraw.*time/i,
            /(hold|holding).*period/i,
            /21.*day/i,
        ],
        reply: 'Sell-Stars payouts are released after a 21-day hold (a Telegram requirement to prevent star refunds). Once the hold ends, USDT is sent to your TON wallet automatically — usually within minutes.',
        offerHuman: true,
    },

    // ---------------- FEES ----------------
    {
        id: 'fees',
        description: 'What are the fees / commission',
        priority: 90,
        patterns: [
            /\bfees?\b/i,
            /commission/i,
            /charge/i,
            /how.*much.*cost/i,
            /cost.*to.*(buy|sell)/i,
        ],
        reply: 'Fees are shown live on the Sell/Buy screen before you confirm. Network gas (TON) is paid by you for withdrawals; StarStore does not add hidden fees on top of the quoted rate.',
        offerHuman: true,
    },

    // ---------------- WALLET HELP ----------------
    {
        id: 'wallet_help',
        description: 'Wallet address problems',
        priority: 85,
        patterns: [
            /wallet.*(invalid|wrong|not.*work|error)/i,
            /(invalid|wrong).*wallet/i,
            /what.*wallet.*use/i,
            /which.*wallet/i,
            /usdt.*ton.*wallet/i,
            /ton.*wallet.*address/i,
        ],
        reply: 'You need a USDT-TON wallet address (starts with UQ or EQ). Tonkeeper, MyTonWallet, Telegram Wallet, Binance, OKX, Bybit and Cryptomus all support USDT on TON. Paste the receive address from one of those.',
        offerHuman: true,
    },

    // ---------------- REFERRAL ----------------
    {
        id: 'referral',
        description: 'Referral program info',
        priority: 85,
        patterns: [
            /referr?al/i,
            /invite.*friend/i,
            /refer.*friend/i,
            /my.*invite.*link/i,
        ],
        reply: 'Invite friends with your referral link and earn rewards every time they buy or sell. Open the Referral page to grab your link and see your stats.',
        buttons: [[{ text: '🤝 Open Referral', web_app: { url: REFERRAL_URL } }]],
    },

    // ---------------- DAILY / REWARDS ----------------
    {
        id: 'daily_rewards',
        description: 'Daily check-in / missions / rewards',
        priority: 85,
        patterns: [
            /daily.*reward/i,
            /daily.*check.?in/i,
            /missions?/i,
            /streak/i,
            /how.*earn.*reward/i,
        ],
        reply: 'Visit the Daily page every day to check in, complete missions, and redeem rewards. Keeping your streak unlocks bigger bonuses.',
        buttons: [[{ text: '🎁 Open Daily', web_app: { url: DAILY_URL } }]],
    },

    // ---------------- AMBASSADOR ----------------
    {
        id: 'ambassador',
        description: 'Ambassador program',
        priority: 85,
        patterns: [
            /ambassador/i,
            /become.*partner/i,
            /partner.*program/i,
        ],
        reply: 'The Ambassador program rewards top referrers with higher commissions, a verified badge, and dedicated support. Apply from the Ambassador page.',
        buttons: [[{ text: '🎖 Apply as Ambassador', web_app: { url: AMBASSADOR_URL } }]],
    },

    // ---------------- ORDER STATUS ----------------
    {
        id: 'order_status',
        description: 'Where is my order / status',
        priority: 80,
        patterns: [
            /where.*(order|stars?|payment)/i,
            /order.*status/i,
            /didn'?t.*receive/i,
            /not.*received/i,
            /pending.*order/i,
            /stars?.*not.*delivered/i,
        ],
        reply: 'Open History inside the app to see every order and its current status. Buy-Stars deliveries are usually instant; Sell-Stars payouts are released after the 21-day hold. If something looks stuck for more than a few hours, talk to a person below.',
        offerHuman: true,
    },

    // ---------------- ACCOUNT BAN / SUSPENSION ----------------
    {
        id: 'ban_appeal',
        description: 'Banned / suspended account',
        priority: 95,
        patterns: [
            /banned/i,
            /suspend/i,
            /restrict/i,
            /can'?t.*(login|access|use)/i,
            /account.*lock/i,
        ],
        reply: 'If your account is restricted you\'ll see the reason on the access-denied screen. You can appeal directly from there, or talk to a person below and an admin will review it.',
        offerHuman: true,
    },

    // ---------------- GREETING ----------------
    {
        id: 'greeting',
        description: 'Greetings / hello',
        priority: 10,
        maxLength: 40,
        patterns: [
            /^\s*(hi|hello|hey|yo|hola|salam|hii+)[\s!.?]*$/i,
            /^\s*good\s*(morning|afternoon|evening|day)[\s!.?]*$/i,
        ],
        reply: 'Hi there 👋 I\'m the StarStore assistant. Ask me how to buy or sell stars, about fees, payouts, your wallet, or referrals — or tap "Talk to a person" to reach support.',
        offerHuman: true,
    },

    // ---------------- THANKS ----------------
    {
        id: 'thanks',
        description: 'User says thanks',
        priority: 10,
        maxLength: 40,
        patterns: [
            /^\s*(thanks?|thank\s*you|thx|ty|appreciate)[\s!.?]*$/i,
        ],
        reply: 'You\'re welcome! 💫 If you have more questions just send them here.',
    },
];

module.exports = intents;
