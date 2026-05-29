// ============================================================
// Auto-Reply Bot Engine
// ------------------------------------------------------------
// Self-hosted, LLM-free reply engine. Matches user messages
// against a list of intents (see ./intents.js) and produces a
// ready-to-send reply, inline keyboard, and optional follow-up.
//
// Public API:
//   matchIntent(text)                -> intent | null
//   buildReply(text, ctx)            -> { intent, text, options, followUp } | null
//   registerIntent(intent)           -> add at runtime
//   listIntents()                    -> array of intents
//   sendAutoReply(bot, chatId, text, ctx) -> Promise<{ matched, intentId } >
//
// ctx is a free-form object passed to dynamic reply functions
// (e.g. { username, userId, chatId, originalText }).
// ============================================================

const defaultIntents = require('./intents');
const knowledge = require('./knowledge');

let intents = [...defaultIntents].sort((a, b) => (b.priority || 0) - (a.priority || 0));

// Kick off knowledge-base loading in the background (cache → search-ready fast)
knowledge.init().catch((e) => console.warn('[auto-reply] kb init failed:', e.message));

// Light "humanizing" openers — picked at random for KB answers so the bot
// doesn't sound robotic. Intent replies keep their own crafted text.
const KB_OPENERS = [
    '', // sometimes no opener feels most natural
    'Sure — ',
    'Here\'s what I know: ',
    'Quick answer: ',
    'Good question. ',
    'From what I have on hand: ',
];
function pickOpener() {
    return KB_OPENERS[Math.floor(Math.random() * KB_OPENERS.length)];
}


function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(text, word) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
    return re.test(text);
}

function intentMatches(intent, text) {
    if (!text) return false;
    const len = text.length;
    if (intent.minLength && len < intent.minLength) return false;
    if (intent.maxLength && len > intent.maxLength) return false;

    if (Array.isArray(intent.noneOf) && intent.noneOf.some(w => hasWord(text, w))) {
        return false;
    }

    // Patterns: if any provided, match if at least one matches
    if (Array.isArray(intent.patterns) && intent.patterns.length) {
        if (intent.patterns.some(re => re.test(text))) return true;
    }

    // allOf: every keyword must appear
    if (Array.isArray(intent.allOf) && intent.allOf.length) {
        if (intent.allOf.every(w => hasWord(text, w))) return true;
    }

    // anyOf: any keyword appears (only used when no patterns matched above)
    if (Array.isArray(intent.anyOf) && intent.anyOf.length) {
        // Require a question-like signal to avoid false positives on bare nouns
        const hasQuestionSignal = /\b(how|what|when|where|why|can|do|does|is|are|should|need|help)\b/i.test(text)
            || /\?/.test(text);
        if (hasQuestionSignal && intent.anyOf.some(w => hasWord(text, w))) return true;
    }

    return false;
}

function matchIntent(text) {
    for (const intent of intents) {
        try {
            if (intentMatches(intent, text)) return intent;
        } catch (e) {
            console.error(`[auto-reply] intent "${intent.id}" matcher error:`, e.message);
        }
    }
    return null;
}

function resolveReply(intent, ctx) {
    const replyValue = typeof intent.reply === 'function' ? intent.reply(ctx || {}) : intent.reply;
    const options = {};
    if (intent.parseMode) options.parse_mode = intent.parseMode;
    if (intent.buttons && intent.buttons.length) {
        options.reply_markup = { inline_keyboard: intent.buttons };
    }
    return { text: replyValue, options };
}

function buildReply(text, ctx) {
    const intent = matchIntent(text);
    if (intent) {
        const { text: replyText, options } = resolveReply(intent, ctx);
        return {
            source: 'intent',
            intent,
            text: replyText,
            options,
            followUp: intent.followUp || null,
            offerHuman: !!intent.offerHuman,
        };
    }

    // Fallback: knowledge-base search (blog + docs)
    const hit = knowledge.search(text);
    if (hit) {
        const opener = pickOpener();
        return {
            source: 'knowledge',
            intent: { id: 'knowledge_base' },
            text: opener + hit.text,
            options: {},
            followUp: null,
            offerHuman: true, // KB answers always offer escalation
            score: hit.score,
        };
    }

    return null;
}


function registerIntent(intent) {
    if (!intent || !intent.id) throw new Error('Intent requires an id');
    // Replace existing by id, else add
    const idx = intents.findIndex(i => i.id === intent.id);
    if (idx >= 0) intents[idx] = intent; else intents.push(intent);
    intents.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return intent;
}

function listIntents() {
    return intents.map(i => ({ id: i.id, description: i.description, priority: i.priority || 0 }));
}

/**
 * High-level helper: match + send via a node-telegram-bot-api instance.
 * Returns { matched, intentId, offerHuman }. Does NOT forward to admins —
 * callers decide whether to forward when matched is false.
 */
async function sendAutoReply(bot, chatId, text, ctx = {}) {
    const built = buildReply(text, ctx);
    if (!built) return { matched: false, intentId: null, offerHuman: false };

    try {
        await bot.sendMessage(chatId, built.text, built.options || {});
        if (built.followUp && built.followUp.text) {
            const opts = {};
            if (built.followUp.buttons) {
                opts.reply_markup = { inline_keyboard: built.followUp.buttons };
            }
            await bot.sendMessage(chatId, built.followUp.text, opts);
        }
    } catch (e) {
        console.error('[auto-reply] send error:', e.message);
    }

    return {
        matched: true,
        intentId: built.intent.id,
        offerHuman: built.offerHuman,
    };
}

module.exports = {
    matchIntent,
    buildReply,
    registerIntent,
    listIntents,
    sendAutoReply,
    knowledge,
    kbStats: () => knowledge.stats(),
    kbRebuild: () => knowledge.rebuild(),
};

