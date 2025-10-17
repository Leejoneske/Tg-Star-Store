/*
  Bot Simulator Service
  - Seeds synthetic users with realistic human usernames
  - Periodically simulates daily check-ins and mission completions
  - Works with Mongo (production) or file-based db (development)

  Usage (from server.js):
    const { startBotSimulator } = require('./services/bot-simulator');
    if (process.env.ENABLE_BOT_SIMULATOR === '1') {
      startBotSimulator({ useMongo: !!process.env.MONGODB_URI, models: { User, DailyState }, db });
    }
*/

const DEFAULT_BOTS = [
  { id: '200000001', username: 'alex_chen' },
  { id: '200000002', username: 'sarah_jones' },
  { id: '200000003', username: 'mike_rodriguez' },
  { id: '200000004', username: 'emma_wilson' },
  { id: '200000005', username: 'david_kim' },
  { id: '200000006', username: 'lisa_brown' },
  { id: '200000007', username: 'james_taylor' },
  { id: '200000008', username: 'anna_garcia' },
  { id: '200000009', username: 'ryan_martinez' },
  { id: '200000010', username: 'jessica_lee' },
  { id: '200000011', username: 'kevin_white' },
  { id: '200000012', username: 'maria_lopez' },
  { id: '200000013', username: 'chris_anderson' },
  { id: '200000014', username: 'amy_thomas' },
  { id: '200000015', username: 'daniel_jackson' },
  { id: '200000016', username: 'nicole_harris' },
  { id: '200000017', username: 'brandon_clark' },
  { id: '200000018', username: 'stephanie_lewis' },
  { id: '200000019', username: 'tyler_walker' },
  { id: '200000020', username: 'rachel_hall' },
  { id: '200000021', username: 'jason_allen' },
  { id: '200000022', username: 'michelle_young' },
  { id: '200000023', username: 'matthew_king' },
  { id: '200000024', username: 'amanda_wright' },
  { id: '200000025', username: 'joshua_scott' },
  { id: '200000026', username: 'jennifer_green' },
  { id: '200000027', username: 'andrew_adams' },
  { id: '200000028', username: 'samantha_baker' },
  { id: '200000029', username: 'nathan_gonzalez' },
  { id: '200000030', username: 'lauren_nelson' },
  { id: '200000031', username: 'eric_carter' },
  { id: '200000032', username: 'megan_mitchell' },
  { id: '200000033', username: 'jacob_perez' },
  { id: '200000034', username: 'ashley_roberts' },
  { id: '200000035', username: 'nicholas_turner' },
  { id: '200000036', username: 'brittany_phillips' },
  { id: '200000037', username: 'jonathan_campbell' },
  { id: '200000038', username: 'crystal_parker' },
  { id: '200000039', username: 'anthony_evans' },
  { id: '200000040', username: 'vanessa_edwards' },
  { id: '200000041', username: 'steven_collins' },
  { id: '200000042', username: 'diana_stewart' },
  { id: '200000043', username: 'benjamin_sanchez' },
  { id: '200000044', username: 'kelly_morris' },
  { id: '200000045', username: 'patrick_rogers' },
  // Added 100 more users for richer simulation
  { id: '200000046', username: 'heather_reed' },
  { id: '200000047', username: 'carlos_cook' },
  { id: '200000048', username: 'tiffany_bailey' },
  { id: '200000049', username: 'gregory_rivera' },
  { id: '200000050', username: 'kimberly_cooper' },
  { id: '200000051', username: 'sean_richardson' },
  { id: '200000052', username: 'monica_cox' },
  { id: '200000053', username: 'jeremy_ward' },
  { id: '200000054', username: 'catherine_torres' },
  { id: '200000055', username: 'marcus_peterson' },
  { id: '200000056', username: 'julie_gray' },
  { id: '200000057', username: 'derek_ramirez' },
  { id: '200000058', username: 'lindsay_james' },
  { id: '200000059', username: 'scott_watson' },
  { id: '200000060', username: 'christine_brooks' },
  { id: '200000061', username: 'keith_kelly' },
  { id: '200000062', username: 'melanie_sanders' },
  { id: '200000063', username: 'travis_price' },
  { id: '200000064', username: 'denise_bennett' },
  { id: '200000065', username: 'austin_wood' },
  { id: '200000066', username: 'shannon_barnes' },
  { id: '200000067', username: 'kyle_ross' },
  { id: '200000068', username: 'natalie_henderson' },
  { id: '200000069', username: 'jordan_coleman' },
  { id: '200000070', username: 'caroline_jenkins' },
  { id: '200000071', username: 'ian_perry' },
  { id: '200000072', username: 'miranda_powell' },
  { id: '200000073', username: 'garrett_long' },
  { id: '200000074', username: 'victoria_patterson' },
  { id: '200000075', username: 'wesley_hughes' },
  { id: '200000076', username: 'danielle_flores' },
  { id: '200000077', username: 'cameron_washington' },
  { id: '200000078', username: 'gabrielle_butler' },
  { id: '200000079', username: 'mason_simmons' },
  { id: '200000080', username: 'jacqueline_foster' },
  { id: '200000081', username: 'connor_gonzales' },
  { id: '200000082', username: 'sierra_bryant' },
  { id: '200000083', username: 'logan_alexander' },
  { id: '200000084', username: 'paige_russell' },
  { id: '200000085', username: 'mitchell_griffin' },
  { id: '200000086', username: 'alexis_diaz' },
  { id: '200000087', username: 'blake_hayes' },
  { id: '200000088', username: 'morgan_myers' },
  { id: '200000089', username: 'hunter_ford' },
  { id: '200000090', username: 'sydney_hamilton' },
  { id: '200000091', username: 'cole_graham' },
  { id: '200000092', username: 'taylor_sullivan' },
  { id: '200000093', username: 'spencer_wallace' },
  { id: '200000094', username: 'veronica_woods' },
  { id: '200000095', username: 'wade_cole' },
  { id: '200000096', username: 'xavier_west' },
  { id: '200000097', username: 'yvonne_jordan' },
  { id: '200000098', username: 'zachary_owens' },
  { id: '200000099', username: 'aaron_reynolds' },
  { id: '200000100', username: 'bailey_fisher' },
  { id: '200000101', username: 'caleb_ellis' },
  { id: '200000102', username: 'dawn_harrison' },
  { id: '200000103', username: 'ethan_gibson' },
  { id: '200000104', username: 'faith_mcdonald' },
  { id: '200000105', username: 'garrett_cruz' },
  { id: '200000106', username: 'hope_marshall' },
  { id: '200000107', username: 'isaac_ortiz' },
  { id: '200000108', username: 'jade_gomez' },
  { id: '200000109', username: 'kai_murray' },
  { id: '200000110', username: 'lucas_freeman' },
  { id: '200000111', username: 'maya_wells' },
  { id: '200000112', username: 'noah_webb' },
  { id: '200000113', username: 'olivia_simpson' },
  { id: '200000114', username: 'preston_stevens' },
  { id: '200000115', username: 'quinn_tucker' },
  { id: '200000116', username: 'ruby_porter' },
  { id: '200000117', username: 'seth_hunter' },
  { id: '200000118', username: 'tara_hicks' },
  { id: '200000119', username: 'ulysses_crawford' },
  { id: '200000120', username: 'violet_henry' },
  { id: '200000121', username: 'wyatt_boyd' },
  { id: '200000122', username: 'xandra_mason' },
  { id: '200000123', username: 'yale_morales' },
  { id: '200000124', username: 'zoe_kennedy' },
  { id: '200000125', username: 'adrian_warren' },
  { id: '200000126', username: 'brooke_dixon' },
  { id: '200000127', username: 'chase_reid' },
  { id: '200000128', username: 'desiree_fuller' },
  { id: '200000129', username: 'elliot_little' },
  { id: '200000130', username: 'felicia_burton' },
  { id: '200000131', username: 'glenn_ellis' },
  { id: '200000132', username: 'hazel_stanley' },
  { id: '200000133', username: 'ivan_boyd' },
  { id: '200000134', username: 'jenna_fox' },
  { id: '200000135', username: 'kent_washington' },
  { id: '200000136', username: 'lara_rose' },
  { id: '200000137', username: 'marco_stone' },
  { id: '200000138', username: 'nadia_hawkins' },
  { id: '200000139', username: 'oscar_dunn' },
  { id: '200000140', username: 'penny_pierce' },
  { id: '200000141', username: 'quincy_black' },
  { id: '200000142', username: 'rita_arnold' },
  { id: '200000143', username: 'simon_lane' },
  { id: '200000144', username: 'tina_harper' },
  { id: '200000145', username: 'victor_austin' }
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
  // Remove version field to prevent conflicts
  const updateData = { ...state };
  delete updateData.__v;
  delete updateData._id;
  
  await DailyState.updateOne(
    { userId: state.userId }, 
    { $set: updateData }, 
    { upsert: true }
  );
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
  console.log(`🌱 Seeding ${bots.length} bots...`);
  const { User, DailyState } = models || {};
  
  if (!User || !DailyState) {
    throw new Error('User or DailyState model not provided');
  }
  
  const { monthKey } = todayKey();
  let seededCount = 0;

  for (const bot of bots) {
    try {
      if (useMongo) {
        await upsertUserMongo(User, bot);
        const state = await getOrCreateDailyStateMongo(DailyState, bot.id, monthKey);
        if (!state.checkedInDays || state.checkedInDays.length === 0) {
          seedStateLikeHuman(state);
          // Use findOneAndUpdate instead of updateOne to avoid version conflicts
          await DailyState.findOneAndUpdate(
            { userId: bot.id },
            { 
              $set: {
                totalPoints: state.totalPoints,
                streak: state.streak,
                checkedInDays: state.checkedInDays,
                lastCheckIn: state.lastCheckIn,
                month: state.month,
                updatedAt: new Date()
              }
            },
            { upsert: true, new: true }
          );
        }
      } else {
        await upsertUserFile(db, bot);
        const state = await getOrCreateDailyStateFile(db, bot.id, monthKey);
        if (!state.checkedInDays || state.checkedInDays.length === 0) {
          seedStateLikeHuman(state);
          await updateDailyStateFile(db, bot.id, state);
        }
      }
      seededCount++;
      
      // Log progress every 25 bots
      if (seededCount % 25 === 0) {
        console.log(`🌱 Seeded ${seededCount}/${bots.length} bots...`);
      }
    } catch (error) {
      console.error(`❌ Failed to seed bot ${bot.username}:`, error.message);
    }
  }
  console.log(`✅ Successfully seeded ${seededCount}/${bots.length} bots`);
  
  if (seededCount === 0) {
    throw new Error('Failed to seed any bots - check database connection and models');
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
      
      // Use findOneAndUpdate for atomic updates
      await DailyState.findOneAndUpdate(
        { userId: bot.id },
        { 
          $set: {
            totalPoints: state.totalPoints,
            streak: state.streak,
            checkedInDays: state.checkedInDays,
            lastCheckIn: state.lastCheckIn,
            month: state.month,
            missionsCompleted: state.missionsCompleted,
            updatedAt: new Date()
          }
        },
        { upsert: true, new: true }
      );
      
      // Log activity for bot actions
      const { Activity } = models || {};
      if (Activity) {
        try {
          await Activity.create({
            userId: bot.id,
            activityType: 'daily_checkin',
            activityName: 'Daily Check-in (Bot)',
            points: 10,
            timestamp: new Date(),
            metadata: { botSimulated: true }
          });
        } catch (activityError) {
          // Don't fail the whole process for activity logging
        }
      }
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
  console.log(`🤖 Bot IDs: ${bots.slice(0, 5).map(b => b.username).join(', ')}...`);

  // Improved async handling for bot seeding and initial tick
  (async () => {
    try {
      await seedBots({ useMongo, models, db, bots });
      console.log('✅ Bot seeding completed successfully');
      await simulateTick({ useMongo, models, db, bots });
      console.log('✅ Initial bot tick completed');
    } catch (err) {
      console.error('❌ Bot simulator seed/tick error:', err.message);
      console.error('Full error:', err);
    }
  })();

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
  const { DailyState, Activity } = models || {};
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
      
      // Log activity for bot check-in
      if (Activity && useMongo) {
        try {
          await Activity.create({
            userId: bot.id,
            activityType: 'daily_checkin',
            activityName: 'Daily Check-in',
            points: 10,
            timestamp: now,
            metadata: { 
              streak: state.streak,
              day: day,
              month: monthKey,
              bot: true
            }
          });
        } catch (activityError) {
          console.warn(`Failed to log bot activity for ${bot.username}:`, activityError.message);
        }
      }
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
        const missionPoints = MISSION_POINTS[m] || 0;
        state.totalPoints = (state.totalPoints || 0) + missionPoints;
        
        // Log activity for bot mission completion
        if (Activity && useMongo) {
          try {
            await Activity.create({
              userId: bot.id,
              activityType: 'mission_complete',
              activityName: 'Mission Complete',
              points: missionPoints,
              timestamp: now,
              metadata: { 
                missionId: m,
                missionTitle: `Mission ${m.toUpperCase()}`,
                missionPoints: missionPoints,
                bot: true
              }
            });
          } catch (activityError) {
            console.warn(`Failed to log bot mission activity for ${bot.username}:`, activityError.message);
          }
        }
        
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
