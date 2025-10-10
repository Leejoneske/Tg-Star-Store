/*
  Bot Simulator Service
  - Seeds 10 synthetic users with human-like usernames
  - Periodically simulates daily check-ins and mission completions
  - Works with Mongo (production) or file-based db (development)

  Usage (from server.js):
    const { startBotSimulator } = require('./services/bot-simulator');
    if (process.env.ENABLE_BOT_SIMULATOR === '1') {
      startBotSimulator({ useMongo: !!process.env.MONGODB_URI, models: { User, DailyState }, db });
    }
*/

const DEFAULT_BOTS = [
  { id: '200000001', username: 'maverick' },
  { id: '200000002', username: 'luna' },
  { id: '200000003', username: 'atlas' },
  { id: '200000004', username: 'ember' },
  { id: '200000005', username: 'nova' },
  { id: '200000006', username: 'orion' },
  { id: '200000007', username: 'raven' },
  { id: '200000008', username: 'zephyr' },
  { id: '200000009', username: 'solace' },
  { id: '200000010', username: 'kyra' },
  { id: '200000011', username: 'viper' },
  { id: '200000012', username: 'titan' },
  { id: '200000013', username: 'zara' },
  { id: '200000014', username: 'onyx' },
  { id: '200000015', username: 'kael' },
  { id: '200000016', username: 'arwen' },
  { id: '200000017', username: 'drift' },
  { id: '200000018', username: 'blaze' },
  { id: '200000019', username: 'nyx' },
  { id: '200000020', username: 'astra' },
  { id: '200000021', username: 'sable' },
  { id: '200000022', username: 'rune' },
  { id: '200000023', username: 'echo' },
  { id: '200000024', username: 'lyra' },
  { id: '200000025', username: 'cade' },
  { id: '200000026', username: 'aria' },
  { id: '200000027', username: 'jax' },
  { id: '200000028', username: 'niko' },
  { id: '200000029', username: 'sora' },
  { id: '200000030', username: 'ivy' },
  { id: '200000031', username: 'rio' },
  { id: '200000032', username: 'sage' },
  { id: '200000033', username: 'skye' },
  { id: '200000034', username: 'ren' },
  { id: '200000035', username: 'faye' },
  { id: '200000036', username: 'zaid' },
  { id: '200000037', username: 'kian' },
  { id: '200000038', username: 'mira' },
  { id: '200000039', username: 'asher' },
  { id: '200000040', username: 'juno' },
  { id: '200000041', username: 'remy' },
  { id: '200000042', username: 'soren' },
  { id: '200000043', username: 'nara' },
  { id: '200000044', username: 'leo' },
  { id: '200000045', username: 'kaia' }
];

// Mirror server mission points (m1..m4)
const MISSION_POINTS = { m1: 20, m2: 10, m3: 50, m4: 30 };

const ONE_MINUTE = 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 15 * ONE_MINUTE; // simulate a few actions per hour

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sample(array, count) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function todayKey() {
  const now = new Date();
  return {
    monthKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    day: now.getDate(),
    now
  };
}

async function upsertUserMongo(User, bot) {
  await User.updateOne(
    { id: bot.id },
    { $set: { username: bot.username, lastActive: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

async function getOrCreateDailyStateMongo(DailyState, userId, monthKey) {
  let state = await DailyState.findOne({ userId });
  if (!state) {
    state = await DailyState.create({ userId, totalPoints: 0, streak: 0, missionsCompleted: [], checkedInDays: [], month: monthKey });
  }
  if (state.month !== monthKey) {
    state.month = monthKey;
    state.checkedInDays = [];
  }
  return state;
}

async function updateDailyStateMongo(DailyState, state) {
  await DailyState.updateOne({ userId: state.userId }, { $set: state }, { upsert: true });
}

async function upsertUserFile(db, bot) {
  const existing = await db.findUser(bot.id);
  if (!existing) await db.createUser({ id: bot.id, username: bot.username, createdAt: new Date(), lastActive: new Date() });
  else await db.updateUser(bot.id, { username: bot.username, lastActive: new Date() });
}

async function getOrCreateDailyStateFile(db, userId, monthKey) {
  let state = await db.findDailyState(userId);
  if (!state) {
    state = await db.createDailyState({ userId, totalPoints: 0, streak: 0, missionsCompleted: [], checkedInDays: [], month: monthKey });
  }
  if (state.month !== monthKey) {
    state.month = monthKey;
    state.checkedInDays = [];
  }
  return state;
}

async function updateDailyStateFile(db, userId, state) {
  await db.updateDailyState(userId, state);
}

function seedStateLikeHuman(state) {
  const { monthKey } = todayKey();
  state.month = monthKey;
  const daysInMonth = new Date(parseInt(monthKey.slice(0, 4), 10), parseInt(monthKey.slice(5, 7), 10), 0).getDate();
  const checkins = randomInt(5, Math.min(22, daysInMonth));
  state.checkedInDays = sample(Array.from({ length: daysInMonth }, (_, i) => i + 1), checkins).sort((a, b) => a - b);
  const lastDay = state.checkedInDays[state.checkedInDays.length - 1] || null;
  const { day, now } = todayKey();
  state.lastCheckIn = lastDay ? new Date(now.getFullYear(), now.getMonth(), lastDay) : null;

  // Estimate streak
  let streak = 0;
  for (let i = state.checkedInDays.length - 1; i >= 0; i--) {
    if (i === state.checkedInDays.length - 1) {
      streak = 1;
    } else if (state.checkedInDays[i] + streak === state.checkedInDays[state.checkedInDays.length - 1]) {
      streak++;
    } else {
      break;
    }
  }
  if (lastDay && (lastDay === day || lastDay === day - 1)) {
    state.streak = Math.max(streak, 1);
  } else {
    state.streak = Math.max(1, randomInt(1, Math.min(7, state.checkedInDays.length)));
  }

  // Randomly complete missions
  const missionIds = Object.keys(MISSION_POINTS);
  const completedCount = randomInt(0, missionIds.length);
  state.missionsCompleted = sample(missionIds, completedCount);

  // Derive total points
  const checkInPoints = (state.checkedInDays?.length || 0) * 10;
  const missionPoints = state.missionsCompleted.reduce((sum, id) => sum + (MISSION_POINTS[id] || 0), 0);
  state.totalPoints = checkInPoints + missionPoints;
}

function applyTodayCheckInAndMissions(state) {
  const { monthKey, day, now } = todayKey();
  if (state.month !== monthKey) {
    state.month = monthKey;
    state.checkedInDays = [];
    state.streak = 0;
  }
  const alreadyToday = state.lastCheckIn && new Date(state.lastCheckIn).toDateString() === now.toDateString();
  if (!alreadyToday && Math.random() < 0.8) {
    const checked = new Set(state.checkedInDays || []);
    checked.add(day);
    state.checkedInDays = Array.from(checked).sort((a, b) => a - b);

    if (state.lastCheckIn) {
      const diffDays = Math.round((now - new Date(state.lastCheckIn)) / (1000 * 60 * 60 * 24));
      state.streak = diffDays === 1 ? (state.streak || 0) + 1 : 1;
    } else {
      state.streak = 1;
    }
    state.lastCheckIn = now;
    state.totalPoints = (state.totalPoints || 0) + 10;
  }

  if (Math.random() < 0.3) {
    const missionIds = Object.keys(MISSION_POINTS);
    const completed = new Set(state.missionsCompleted || []);
    const remaining = missionIds.filter(m => !completed.has(m));
    if (remaining.length > 0) {
      const m = remaining[Math.floor(Math.random() * remaining.length)];
      completed.add(m);
      state.missionsCompleted = Array.from(completed);
      state.totalPoints = (state.totalPoints || 0) + (MISSION_POINTS[m] || 0);
    }
  }
}

async function seedBots({ useMongo, models, db, bots = DEFAULT_BOTS }) {
  const { User, DailyState } = models || {};
  const { monthKey } = todayKey();

  for (const bot of bots) {
    if (useMongo) {
      await upsertUserMongo(User, bot);
      const state = await getOrCreateDailyStateMongo(DailyState, bot.id, monthKey);
      if (!state.checkedInDays || state.checkedInDays.length === 0) {
        seedStateLikeHuman(state);
        await updateDailyStateMongo(DailyState, state);
      }
    } else {
      await upsertUserFile(db, bot);
      const state = await getOrCreateDailyStateFile(db, bot.id, monthKey);
      if (!state.checkedInDays || state.checkedInDays.length === 0) {
        seedStateLikeHuman(state);
        await updateDailyStateFile(db, bot.id, state);
      }
    }
  }
}

async function simulateTick({ useMongo, models, db, bots = DEFAULT_BOTS }) {
  const { DailyState } = models || {};
  const { monthKey } = todayKey();
  const activeBots = sample(bots, randomInt(3, Math.min(6, bots.length)));

  for (const bot of activeBots) {
    if (useMongo) {
      let state = await getOrCreateDailyStateMongo(DailyState, bot.id, monthKey);
      applyTodayCheckInAndMissions(state);
      state.updatedAt = new Date();
      await updateDailyStateMongo(DailyState, state);
    } else {
      let state = await getOrCreateDailyStateFile(db, bot.id, monthKey);
      applyTodayCheckInAndMissions(state);
      state.updatedAt = new Date();
      await updateDailyStateFile(db, bot.id, state);
    }
  }
}

function startBotSimulator({ useMongo, models, db, bots = DEFAULT_BOTS, tickIntervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
  if (!models || (!useMongo && !db)) {
    console.warn('Bot simulator not started: models/db missing');
    return { stop: () => {} };
  }
  // Initialize Mongo profile model if present
  try {
    BotProfileModel = models.BotProfile || null;
    useMongoProfiles = !!BotProfileModel;
  } catch {}
  let stopped = false;
  console.log(`🤖 Bot simulator starting with ${bots.length} bots (interval ${Math.round(tickIntervalMs / 60000)}m)`);

  seedBots({ useMongo, models, db, bots }).then(() => simulateTick({ useMongo, models, db, bots })).catch(err => {
    console.warn('Bot simulator seed/tick error:', err.message);
  });

  const handle = setInterval(() => {
    if (stopped) return;
    simulateTick({ useMongo, models, db, bots }).catch(err => console.warn('Bot simulator tick error:', err.message));
  }, tickIntervalMs);

  const stop = () => {
    stopped = true;
    clearInterval(handle);
    console.log('🤖 Bot simulator stopped');
  };

  return { stop };
}

// --- Enhanced human-like behavior, concurrency, and lightweight learning ---

const fs = require('fs').promises;
const path = require('path');

const PROFILES_FILE = path.join(__dirname, '..', 'data', 'bot-profiles.json');
let botProfiles = null;
let saveProfilesTimer = null;
const botLocks = new Map(); // Map<botId, Promise/boolean> simple mutex
let BotProfileModel = null; // Mongo-backed profile model if provided
let useMongoProfiles = false;

const DEFAULT_PROFILE = () => ({
  version: 1,
  experience: 0,
  checkInProbability: 0.85, // Base chance to check in when active
  missionProbability: 0.35,  // Chance to complete one mission when active
  preferredHours: [9, 23],   // Active window (local time)
  lastActionAt: 0,
  lastPoints: 0,
  minCooldownMs: 60000, // adaptive per-bot cooldown between actions
  dayWeights: [1,1,1,1,1,1,1], // Sun..Sat engagement multipliers (0.5..1.5)
  missionWeights: Object.fromEntries(Object.keys(MISSION_POINTS).map(k => [k, 1])),
  adjustments: {
    missionBoost: 0,
    consistency: 0
  }
});

async function ensureProfilesLoaded() {
  if (useMongoProfiles) return;
  if (botProfiles) return;
  try {
    await fs.mkdir(path.dirname(PROFILES_FILE), { recursive: true });
    const content = await fs.readFile(PROFILES_FILE, 'utf8').catch(() => '{}');
    botProfiles = JSON.parse(content || '{}');
  } catch (_) {
    botProfiles = {};
  }
}

function scheduleSaveProfiles() {
  if (saveProfilesTimer) return;
  saveProfilesTimer = setTimeout(async () => {
    try {
      await fs.mkdir(path.dirname(PROFILES_FILE), { recursive: true });
      await fs.writeFile(PROFILES_FILE, JSON.stringify(botProfiles || {}, null, 2));
    } catch {}
    saveProfilesTimer = null;
  }, 5000);
}

async function getProfile(botId) {
  if (useMongoProfiles && BotProfileModel) {
    let doc = await BotProfileModel.findOne({ botId }).lean();
    if (!doc || !doc.profile) {
      const profile = DEFAULT_PROFILE();
      await BotProfileModel.updateOne({ botId }, { $set: { profile, updatedAt: new Date() } }, { upsert: true });
      return profile;
    }
    return doc.profile;
  }
  await ensureProfilesLoaded();
  if (!botProfiles[botId]) {
    botProfiles[botId] = DEFAULT_PROFILE();
    scheduleSaveProfiles();
  }
  return botProfiles[botId];
}

function randBool(p) { return Math.random() < p; }
function nowMs() { return Date.now(); }

function inPreferredHours(profile) {
  try {
    const hour = new Date().getHours();
    const [start, end] = profile.preferredHours || [8, 22];
    if (start <= end) return hour >= start && hour <= end;
    // Overnight window
    return hour >= start || hour <= end;
  } catch { return true; }
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function learnFromDelta(profile, deltaPoints) {
  // Lightweight heuristic: if missions likely caused gain, slightly raise missionProbability
  // If no gain for a while, nudge checkInProbability to maintain consistency
  profile.experience = (profile.experience || 0) + 1;
  const lr = 0.01; // small step
  if (deltaPoints >= 20) {
    profile.adjustments.missionBoost = Math.min(0.2, (profile.adjustments.missionBoost || 0) + lr);
  } else if (deltaPoints === 0) {
    profile.adjustments.consistency = Math.min(0.1, (profile.adjustments.consistency || 0) + lr);
  } else {
    // slight decay
    profile.adjustments.missionBoost = Math.max(0, (profile.adjustments.missionBoost || 0) - lr * 0.5);
    profile.adjustments.consistency = Math.max(0, (profile.adjustments.consistency || 0) - lr * 0.5);
  }
  // Apply adjustments to effective probabilities (bounded)
  const effCheckIn = Math.max(0.4, Math.min(0.98, (profile.checkInProbability || 0.85) + (profile.adjustments.consistency || 0)));
  const effMission = Math.max(0.1, Math.min(0.8, (profile.missionProbability || 0.35) + (profile.adjustments.missionBoost || 0)));
  return { effCheckIn, effMission };
}

async function withBotLock(botId, fn) {
  // Very lightweight mutex to avoid per-bot races
  while (botLocks.get(botId)) {
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
  }
  botLocks.set(botId, true);
  try { return await fn(); } finally { botLocks.delete(botId); }
}

async function actBot({ bot, useMongo, models, db, missionIds }) {
  const { DailyState } = models || {};
  const profile = await getProfile(bot.id);
  // Skip if still in cooldown (randomized for human-like pacing)
  const now = new Date();
  const effectiveCooldown = (profile.minCooldownMs || 60000) * (0.75 + Math.random() * 0.5);
  if (nowMs() - (profile.lastActionAt || 0) < effectiveCooldown) return;
  if (!inPreferredHours(profile) && Math.random() < 0.35) {
    // Sometimes act off-hours to look human-like
    return;
  }
  await withBotLock(bot.id, async () => {
    const { monthKey, day } = todayKey();
    let state;
    if (useMongo) state = await getOrCreateDailyStateMongo(DailyState, bot.id, monthKey);
    else state = await getOrCreateDailyStateFile(db, bot.id, monthKey);

    const pointsBefore = state.totalPoints || 0;
    const alreadyToday = state.lastCheckIn && new Date(state.lastCheckIn).toDateString() === now.toDateString();

    const { effCheckIn, effMission } = learnFromDelta(profile, Math.max(0, pointsBefore - (profile.lastPoints || 0)));
    // Day-of-week multiplier
    const dow = now.getDay();
    const dayWeight = Array.isArray(profile.dayWeights) ? clamp(profile.dayWeights[dow] || 1, 0.5, 1.5) : 1;
    const actCheckIn = clamp(effCheckIn * dayWeight, 0.2, 0.98);
    const actMission = clamp(effMission * dayWeight, 0.05, 0.85);

    // Decide actions with randomness
    if (!alreadyToday && randBool(actCheckIn)) {
      const checked = new Set(state.checkedInDays || []);
      checked.add(day);
      state.checkedInDays = Array.from(checked).sort((a, b) => a - b);
      if (state.lastCheckIn) {
        const diffDays = Math.round((now - new Date(state.lastCheckIn)) / (1000 * 60 * 60 * 24));
        state.streak = diffDays === 1 ? (state.streak || 0) + 1 : 1;
      } else {
        state.streak = 1;
      }
      state.lastCheckIn = now;
      state.totalPoints = (state.totalPoints || 0) + 10;
    }

    // Ensure mission weights present
    if (!profile.missionWeights) profile.missionWeights = Object.fromEntries(missionIds.map(m => [m, 1]));

    if (randBool(actMission)) {
      const completed = new Set(state.missionsCompleted || []);
      const remaining = missionIds.filter(m => !completed.has(m));
      if (remaining.length > 0) {
        // Weighted choice among remaining missions
        const weights = remaining.map(m => Math.max(0.2, profile.missionWeights[m] || 1));
        const totalW = weights.reduce((s,v)=>s+v,0) || 1;
        let r = Math.random() * totalW;
        let chosen = remaining[0];
        for (let i = 0; i < remaining.length; i++) { r -= weights[i]; if (r <= 0) { chosen = remaining[i]; break; } }
        const m = chosen;
        completed.add(m);
        state.missionsCompleted = Array.from(completed);
        state.totalPoints = (state.totalPoints || 0) + (MISSION_POINTS[m] || 0);
        // Reinforce successful mission preference
        const w = Math.max(0.2, profile.missionWeights[m] || 1);
        profile.missionWeights[m] = clamp(w + 0.05, 0.2, 2.0);
        for (const k of Object.keys(profile.missionWeights)) {
          if (k !== m) profile.missionWeights[k] = clamp(profile.missionWeights[k] * 0.995, 0.2, 2.0);
        }
      }
    }

    state.updatedAt = new Date();
    if (useMongo) await updateDailyStateMongo(DailyState, state);
    else await updateDailyStateFile(db, bot.id, state);

    const delta = (state.totalPoints || 0) - pointsBefore;
    profile.lastPoints = state.totalPoints || 0;
    profile.lastActionAt = nowMs();
    // Adapt day-of-week and cooldown slightly
    if (Array.isArray(profile.dayWeights)) {
      const cur = clamp(profile.dayWeights[now.getDay()] || 1, 0.5, 1.5);
      profile.dayWeights[now.getDay()] = clamp(cur + (delta > 0 ? 0.01 : -0.005), 0.5, 1.5);
    }
    const baseCd = clamp((profile.minCooldownMs || 60000) + (delta > 0 ? -2000 : 1000), 30000, 300000);
    profile.minCooldownMs = baseCd;
    // Persist profile occasionally
    scheduleSaveProfiles();
  });
}

function pLimit(concurrency) {
  // Minimal concurrency limiter
  let activeCount = 0;
  const queue = [];
  const next = () => {
    if (queue.length === 0 || activeCount >= concurrency) return;
    activeCount++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((val) => { activeCount--; resolve(val); next(); })
      .catch((err) => { activeCount--; reject(err); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Override simulateTick to schedule randomized, concurrent, human-like actions
async function simulateTick({ useMongo, models, db, bots = DEFAULT_BOTS }) {
  const missionIds = Object.keys(MISSION_POINTS);
  // Randomly pick many bots to act this tick (40% to 80% of bots)
  const count = Math.max(3, Math.round(bots.length * (0.4 + Math.random() * 0.4)));
  const activeBots = sample(bots, Math.min(count, bots.length));

  // Concurrency control and jitter to avoid rate limits and races
  const conf = process.env.BOT_SIM_MAX_CONCURRENCY;
  const parsed = conf != null ? parseInt(conf, 10) : NaN;
  const unlimited = conf === '0' || (typeof conf === 'string' && conf.toLowerCase() === 'unlimited') || parsed === 0;
  const defaultLimit = Math.max(8, Math.ceil(bots.length / 2));
  const limitVal = unlimited ? activeBots.length : (isFinite(parsed) && parsed > 0 ? parsed : defaultLimit);

  // Random jitter per bot action within 0-45s to spread load
  const runOne = async (bot) => {
    const jitter = Math.floor(Math.random() * 45000);
    await new Promise(r => setTimeout(r, jitter));
    await actBot({ bot, useMongo, models, db, missionIds });
  };

  if (unlimited) {
    await Promise.allSettled(activeBots.map(bot => runOne(bot)));
  } else {
    const runLimited = pLimit(limitVal);
    const tasks = activeBots.map((bot) => runLimited(() => runOne(bot)));
    await Promise.allSettled(tasks);
  }
}

module.exports = { startBotSimulator };
