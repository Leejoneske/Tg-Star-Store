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
  { id: '200000025', username: 'cade' }
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

module.exports = { startBotSimulator };
