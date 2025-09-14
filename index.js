import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

// add to your existing imports
import { MessageFlags } from 'discord.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');

// near imports (top of file)
import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,   // shorter keep-alive
  headersTimeout: 0       // disable headers timeout
}));

// --- Paywall guard: gate whole commands cleanly ---
async function requireProGuild(interaction, featureName = 'this feature') {
  const isPro = await guildHasPro(client, interaction.guildId);
  if (isPro) return true;

  // If the interaction was already deferred, edit; otherwise reply
  const msg = `🔒 **Pro required** to use **${featureName}** on this server.`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: msg, components: [], flags: MessageFlags.Ephemeral }).catch(()=>{});
    await sendBuyButton(interaction, msg);
  } else {
    await sendBuyButton(interaction, msg);
  }
  return false;
}




// --- Safe interaction replies with retry on UND_ERR_SOCKET ---
async function safeEdit(interaction, payload, attempt = 1) {
  try {
    return await interaction.editReply(payload);
  } catch (e) {
    if (e?.code === 'UND_ERR_SOCKET' && attempt < 3) {
      const delay = attempt * 500; await new Promise(r => setTimeout(r, delay));
      console.warn(`editReply hiccup, retrying (${attempt})`);
      return safeEdit(interaction, payload, attempt + 1);
    }
    console.error('editReply failed:', e);
    throw e;
  }
}
async function safeReply(interaction, payload, attempt = 1) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (e) {
    if (e?.code === 'UND_ERR_SOCKET' && attempt < 3) {
      const delay = attempt * 500; await new Promise(r => setTimeout(r, delay));
      console.warn(`reply hiccup, retrying (${attempt})`);
      return safeReply(interaction, payload, attempt + 1);
    }
    console.error('reply failed:', e);
    throw e;
  }
}
process.on('unhandledRejection', (err) => {
  if (err && err.code === 'UND_ERR_SOCKET') {
    console.warn('⚠️ Network hiccup (UND_ERR_SOCKET). Continuing…');
    return;
  }
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  if (err && err.code === 'UND_ERR_SOCKET') {
    console.warn('⚠️ Network hiccup (UND_ERR_SOCKET). Continuing…');
    return;
  }
  console.error('UNCAUGHT EXCEPTION:', err);
});

const token = process.env.DISCORD_TOKEN;
const devGuildId = process.env.GUILD_ID;
const APP_ID = process.env.APP_ID;                 // NEW
const GUILD_PRO_SKU_ID = process.env.GUILD_PRO_SKU_ID; // NEW

// Free tier: allow creating up to this many weeks without Pro
const FREE_WEEK_LIMIT = 18; // change to 0 if you want everything gated


await fs.ensureDir(DATA_DIR);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Optional: see gateway lifecycle & retry signals
client.on('error', console.error);
client.on('shardError', console.error);
client.on('shardDisconnect', (event, shardId) => {
  console.warn('Shard disconnected', shardId, event?.code);
});
client.on('shardReconnecting', (shardId) => {
  console.warn('Shard reconnecting', shardId);
});

// ---------- Team normalization ----------
const TEAM_MAP = (() => {
  const entries = [
    ['ATL', ['atl','atlanta','atlanta falcons','falcons'], 'Falcons'],
    ['DAL', ['dal','dallas','dallas cowboys','cowboys'], 'Cowboys'],
    ['PHI', ['phi','philadelphia','philadelphia eagles','eagles'], 'Eagles'],
    ['SF',  ['sf','sfo','san francisco','49ers','san francisco 49ers'], '49ers'],
    ['SEA', ['sea','seattle','seattle seahawks','seahawks'], 'Seahawks'],
    ['GB',  ['gb','green bay','packers','green bay packers'], 'Packers'],
    ['DET', ['det','detroit','detroit lions','lions'], 'Lions'],
    ['KC',  ['kc','kansas city','chiefs','kansas city chiefs'], 'Chiefs'],
    ['LAC', ['lac','la chargers','los angeles chargers','chargers'], 'Chargers'],
    ['LAR', ['lar','la rams','los angeles rams','rams'], 'Rams'],
    ['LV',  ['lv','las vegas','raiders','las vegas raiders'], 'Raiders'],
    ['NE',  ['ne','new england','patriots','new england patriots'], 'Patriots'],
    ['BUF', ['buf','buffalo','bills','buffalo bills'], 'Bills'],
    ['BAL', ['bal','baltimore','ravens','baltimore ravens'], 'Ravens'],
    ['MIA', ['mia','miami','dolphins','miami dolphins'], 'Dolphins'],
    ['IND', ['ind','indianapolis','colts','indianapolis colts'], 'Colts'],
    ['TB',  ['tb','tampa bay','buccaneers','bucs','tampa bay buccaneers'], 'Buccaneers'],
    ['CLE', ['cle','cleveland','browns','cleveland browns'], 'Browns'],
    ['CIN', ['cin','cincinnati','bengals','cincinnati bengals'], 'Bengals'],
    ['JAX', ['jax','jacksonville','jaguars','jacksonville jaguars'], 'Jaguars'],
    ['CAR', ['car','carolina','panthers','carolina panthers'], 'Panthers'],
    ['NO',  ['no','new orleans','saints','new orleans saints'], 'Saints'],
    ['TEN', ['ten','tennessee','titans','tennessee titans'], 'Titans'],
    ['DEN', ['den','denver','broncos','denver broncos'], 'Broncos'],
    ['NYJ', ['nyj','jets','new york jets'], 'Jets'],
    ['NYG', ['nyg','giants','new york giants'], 'Giants'],
    ['WAS', ['was','wsh','washington','commanders','washington commanders'], 'Commanders'],
    ['PIT', ['pit','pittsburgh','steelers','pittsburgh steelers'], 'Steelers'],
    ['HOU', ['hou','houston','texans','houston texans'], 'Texans'],
    ['ARI', ['ari','arizona','cardinals','arizona cardinals'], 'Cardinals'],
    ['MIN', ['min','minnesota','vikings','minnesota vikings'], 'Vikings'],
    ['CHI', ['chi','chicago','bears','chicago bears'], 'Bears'],
  ];
  const byToken = new Map();
  for (const [, tokens, name] of entries) tokens.forEach(t => byToken.set(t.toLowerCase(), name));
  return { byToken };
})();

function normalizeTeam(input) {
  if (!input) return { canonical: '', ok: false };
  const raw = String(input).trim().toLowerCase();
  const found = TEAM_MAP.byToken.get(raw);
  if (found) return { canonical: found, ok: true };
  const cleaned = raw.replace(/^the\s+/, '').replace(/[^a-z0-9\s]/g, '').trim();
  const maybe = TEAM_MAP.byToken.get(cleaned);
  if (maybe) return { canonical: maybe, ok: true };
  return { canonical: titleCase(input), ok: false };
}
const titleCase = s => String(s).toLowerCase().split(/\s+/).map(w => w[0]?.toUpperCase()+w.slice(1)).join(' ');
const safeChannelName = s => s.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/--+/g,'-');

// ---------- Monetization helpers (NEW) ----------
async function guildHasPro(client, guildId) {
  if (!APP_ID || !GUILD_PRO_SKU_ID) return false; // if not configured, treat as no Pro
  try {
    const entitlements = await client.rest.get(
      Routes.applicationEntitlements(APP_ID),
      {
        query: {
          guild_id: guildId,
          sku_ids: GUILD_PRO_SKU_ID,
          exclude_expired: true
        }
      }
    );
    return Array.isArray(entitlements) && entitlements.length > 0;
  } catch {
    return false;
  }
}

async function sendBuyButton(interaction, message = 'Unlock **GameDay Channels Pro** for this server:') {
  if (!GUILD_PRO_SKU_ID) {
    const warn = '⚠️ Purchase not configured. Ask the owner to set GUILD_PRO_SKU_ID.';
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: warn, flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: warn, flags: MessageFlags.Ephemeral });
  }

  // Try modern builder API first
  let components;
  try {
    const btn = new ButtonBuilder().setLabel('Unlock Pro');

    // ButtonStyle.Premium exists on newer discord.js; fall back to numeric style:6 otherwise
    const premiumStyle = ButtonStyle?.Premium ?? 6;

    // Only call setSkuId if present on this version
    if (typeof btn.setSkuId === 'function') {
      btn.setStyle(premiumStyle).setSkuId(GUILD_PRO_SKU_ID);
      components = [ new ActionRowBuilder().addComponents(btn) ];
    } else {
      throw new Error('setSkuId not available; using raw JSON button');
    }
  } catch {
    // Raw JSON fallback (works without builder support)
    // style 6 = Premium purchase button
    components = [{
      type: 1, // ActionRow
      components: [{
        type: 2,           // Button
        style: 6,          // Premium
        sku_id: GUILD_PRO_SKU_ID,
        label: 'Unlock Pro'
      }]
    }];
  }

  // As a final safety, if style:6 is rejected by this gateway, send a Link button to your store page
  const payload = { content: message, components, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (e) {
    // Fallback to Link button so users can still buy
    const url = `https://discord.com/application-directory/${APP_ID}`; // your listing
    const linkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Pro Listing').setURL(url)
    );
    const linkPayload = { content: message, components: [linkRow], flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) return interaction.editReply(linkPayload);
    return interaction.reply(linkPayload);
  }
}
function buildOverwrites(guild, role) {
  const me = guild.members.me;
  const base = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ]},
  ];
  if (role) base.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] });
  return base;
}

async function getOrCreateCategory(guild, name, overwrites) {
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    if (overwrites) await existing.permissionOverwrites.set(overwrites).catch(()=>{});
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites
  });
}

async function getOrCreateTextChannel(guild, name, parentId /*, overwrites */) {
  const safe = safeChannelName(name);
  const existing = guild.channels.cache.find(
    c => c.parentId === parentId && c.type === ChannelType.GuildText && c.name === safe
  );
  if (existing) return existing;

  return guild.channels.create({
    name: safe,
    type: ChannelType.GuildText,
    parent: parentId
    // No permissionOverwrites here → inherits from category
  });
}

// ---------- Schedule storage ----------
const SCHEDULES = new Map(); // guildId -> { source, weeks: { [n]: [{home, away}] } }
const scheduleFile = guildId => path.join(DATA_DIR, `schedule-${guildId}.json`);

async function loadSchedule(guildId) {
  const fp = scheduleFile(guildId);
  if (await fs.pathExists(fp)) {
    const data = await fs.readJSON(fp).catch(() => null);
    if (data && data.weeks) {
      SCHEDULES.set(guildId, data);
      return data;
    }
  }
  const fresh = { source: null, weeks: {} };
  SCHEDULES.set(guildId, fresh);
  return fresh;
}
async function saveSchedule(guildId) {
  const data = SCHEDULES.get(guildId);
  if (!data) return;
  await fs.writeJSON(scheduleFile(guildId), data, { spaces: 2 }).catch(() => {});
}

function addMatch(guildId, week, homeIn, awayIn) {
  const { canonical: home } = normalizeTeam(homeIn);
  const { canonical: away } = normalizeTeam(awayIn);
  const data = SCHEDULES.get(guildId);
  if (!data.weeks[week]) data.weeks[week] = [];
  const exists = data.weeks[week].some(m => m.home === home && m.away === away);
  if (!exists) data.weeks[week].push({ home, away });
}

async function makeWeek(interaction, week, role) {
  const guildId = interaction.guildId;
  const data = SCHEDULES.get(guildId) || { weeks: {} };
  const games = data.weeks[week] || [];
  if (!games.length) {
    await interaction.editReply(`⚠️ No games found for Week ${week}. Add with /manual-add or /add-match.`);
    return;
  }
  const overwrites = buildOverwrites(interaction.guild, role);
  const cat = await getOrCreateCategory(interaction.guild, `Week ${week}`, overwrites);
  const created = [];
  for (const { home, away } of games) {
    const chName = `${home}-vs-${away}`;
    await getOrCreateTextChannel(interaction.guild, chName, cat.id, overwrites);
    created.push(`#${safeChannelName(chName)}`);
  }
  await interaction.editReply(`✅ Week ${week} ready.\n${created.join(', ')}`);
}

// ---------- Preload from bundled local file (no network) ----------
const NFL_2025_BUNDLED = path.join(DATA_DIR, 'nfl_2025.json');

async function readBundled2025Raw() {
  const abs = path.resolve(NFL_2025_BUNDLED);
  const exists = await fs.pathExists(abs);
  if (!exists) throw new Error(`Missing ${abs}`);

  const text = await fs.readFile(abs, 'utf8');
  // quick sanity: count how many games by scanning for `"home":`
  const approxGames = (text.match(/"home"\s*:/g) || []).length;
  console.log(`📄 nfl_2025.json @ ${abs}  bytes=${text.length}  approxGames=${approxGames}`);
  return JSON.parse(text);
}

async function preloadFromBundled2025(guildId) {
  const json = await readBundled2025Raw();

  if (!json || !json.weeks || typeof json.weeks !== 'object') {
    throw new Error(`Invalid format in nfl_2025.json (expected { weeks: { "1": [ ... ] } })`);
  }

  async function preloadFromBundled2025(guildId, { force = false } = {}) {
  const current = SCHEDULES.get(guildId);
  if (current?.source === 'manual' && !force) {
    return {
      ok: false,
      msg: 'Guild is in **manual** mode; not preloading. Use /setup-season source:nfl_2025 to switch.'
    };
  }

  const json = await readBundled2025Raw(); // your validated reader
  const data = { source: 'nfl_2025', weeks: json.weeks || {} };
  SCHEDULES.set(guildId, data);
  await saveSchedule(guildId);

  return { ok: true, msg: `Preloaded 2025 from data/nfl_2025.json (weeks=${Object.keys(data.weeks).length}).` };
}
  // Build a concise summary like 1:16 2:14 ...
  const weekKeys = Object.keys(json.weeks).sort((a, b) => Number(a) - Number(b));
  const summary = weekKeys.map(w => `${w}:${Array.isArray(json.weeks[w]) ? json.weeks[w].length : 0}`).join(' ');
  console.log(`📦 Loaded weeks=${weekKeys.length}  gamesByWeek=${summary}`);

  // Forcefully replace any cached schedule for this guild
  const data = { source: 'nfl_2025', weeks: json.weeks };
  SCHEDULES.set(guildId, data);
  await saveSchedule(guildId);

  return { ok: true, msg: `Preloaded 2025 from data/nfl_2025.json (weeks=${weekKeys.length}).` };
}
// ---------- Commands ----------
const commands = [
  {
  name: 'setup-season',
  description: 'Choose a season source.',
  options: [
    {
      type: 3,
      name: 'source',
      description: 'nfl_2025 (preloaded from local file) or manual',
      required: true,
      choices: [
        { name: 'nfl_2025', value: 'nfl_2025' },
        { name: 'manual', value: 'manual' }
      ]
    },
    {
      type: 5,
      name: 'purge',
      description: 'Also delete existing Week categories/channels',
      required: false
    }
  ],
  default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
},
  {
    name: 'import-schedule',
    description: 'Paste CSV lines: week,home,away',
    options: [
      {
        type: 3,
        name: 'schedule_text',
        description: 'Multi-line CSV: week,home,away',
        required: true
      }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'make-week',
    description: 'Create channels for a week.',
    options: [
      { type: 4, name: 'week', description: 'Week number', required: true },
      { type: 8, name: 'private_to_role', description: 'Optional: restrict visibility to this role', required: false }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'add-match',
    description: 'Add one matchup (no modal).',
    options: [
      { type: 4, name: 'week', description: 'Week number', required: true },
      { type: 3, name: 'home', description: 'Home team name or abbrev', required: true },
      { type: 3, name: 'away', description: 'Away team name or abbrev', required: true },
      { type: 8, name: 'private_to_role', description: 'Optional privacy role', required: false }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'manual-add',
    description: 'Add one matchup via modal (asks Week, Away, Home).',
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'cleanup-week',
    description: 'Delete a whole week category.',
    options: [
      { type: 4, name: 'week', description: 'Week number', required: true },
      { type: 5, name: 'confirm', description: 'Type true to confirm', required: true }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
  name: 'bulk-import',
  description: 'Open a modal to paste many lines: week,home,away',
  default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
},
  // NEW: Upgrade entrypoint
  {
    name: 'upgrade',
    description: 'Open checkout to unlock Pro features for this server.'
  },
  {
  name: 'complete',
  description: 'Mark THIS channel complete (adds ✅ to the channel name).',
  default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
},
{
  name: 'uncomplete',
  description: 'Remove the ✅ from THIS channel name.',
  default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
},
  {
  name: 'debug-week',
  description: 'Show how many games the bot sees for a week',
  options: [{ type: 4, name: 'week', description: 'Week number', required: true }],
  default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
}
];

// Prefix we use for completed channels
const COMPLETE_PREFIX = '✅-';

function isCompletedName(name) {
  return name?.startsWith(COMPLETE_PREFIX) || name?.startsWith('✅');
}

function makeCompletedName(name) {
  // Ensure no spaces (text channels) and avoid double-prefix
  if (isCompletedName(name)) return name;
  return `${COMPLETE_PREFIX}${name}`.slice(0, 100); // Discord limit safety
}

function makeUncompletedName(name) {
  return name.replace(/^✅-?/, '').slice(0, 100);
}

async function registerCommandsAuto(appId, token, commands, devGuildId, attempt = 1) {
  const rest = new REST({ version: '10' }).setToken(token);

  // helper for nicer logs
  const logErr = (prefix, e) =>
    console.error(`${prefix}:`, e?.status ?? '', e?.code ?? '', e?.message ?? e);

  try {
    if (devGuildId) {
      await rest.put(Routes.applicationGuildCommands(appId, devGuildId), { body: commands });
      console.log(`✅ Guild commands registered (instant): guild=${devGuildId} count=${commands.length}`);
    } else {
      console.log('ℹ️ No GUILD_ID set; skipping guild (dev) registration.');
    }
  } catch (e) {
    logErr('❌ Guild registration failed', e);
  }

  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`🌍 Global commands registered: count=${commands.length} (may take up to ~1 hour to appear)`);
  } catch (e) {
    logErr('❌ Global registration failed', e);
    const delay = Math.min(15000 * attempt, 60000);
    console.warn(`Retrying registration in ${Math.round(delay/1000)}s (attempt ${attempt + 1})…`);
    setTimeout(() => registerCommandsAuto(appId, token, commands, devGuildId, attempt + 1), delay);
  }
}

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  for (const [guildId] of client.guilds.cache) {
    // load saved schedule (if any)
    const loaded = await loadSchedule(guildId).catch(() => null);

    if (!loaded || !loaded.source) {
      // default to manual with empty weeks
      SCHEDULES.set(guildId, { source: 'manual', weeks: {} });
      await saveSchedule(guildId);
      console.log(`Initialized ${guildId} → source=manual, weeks=0`);
    } else {
      console.log(`Loaded ${guildId} → source=${loaded.source}, weeks=${Object.keys(loaded.weeks||{}).length}`);
    }
  }

  await registerCommandsAuto(
  process.env.APP_ID,
  process.env.DISCORD_TOKEN,
  commands,
  process.env.GUILD_ID // leave unset in production
);
});

// ===================== Interactions =====================
client.on('interactionCreate', async (interaction) => {
  // Only handle slash commands and our modal submit
  if (!interaction.isChatInputCommand() && !interaction.isModalSubmit()) return;

  // Always load schedule for this guild
  const guildId = interaction.guildId;
  await loadSchedule(guildId);

  // ---------- Slash commands ----------
  if (interaction.isChatInputCommand()) {

    // /setup-season
    if (interaction.commandName === 'setup-season') {
      const source  = interaction.options.getString('source', true);
      const doPurge = interaction.options.getBoolean('purge') || false;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (source === 'nfl_2025') {
          const res = await preloadFromBundled2025(guildId);
          await interaction.editReply({ content: `📅 Source set to **nfl_2025**. ${res.msg}` });
          return;
        }

        // manual → clear all weeks
        const data = SCHEDULES.get(guildId) || { source: null, weeks: {} };
        data.source = 'manual';
        data.weeks  = {};
        SCHEDULES.set(guildId, data);
        await saveSchedule(guildId);

        let msg = '📝 Source set to **manual**. Preloaded games cleared.';
        if (doPurge) {
          const res = await purgeAllWeekCategories(interaction.guild);
          msg += ` 🧹 Deleted **${res.deleted}** week categories (errors: ${res.errors}).`;
        }
        await interaction.editReply({ content: msg });
      } catch (e) {
        await interaction.editReply({ content: `❌ Error: ${e?.message || e}` });
      }
      return;
    }


  // /complete
if (interaction.commandName === 'complete') {
  const guildId = interaction.guildId;

  // 🔒 Monetization gate
  const isPro = await guildHasPro(client, guildId);
  if (!isPro) {
    await sendBuyButton(
      interaction,
      `🔒 **Pro required** to use /complete. Unlock GameDay Channels Pro to enable this feature.`
    );
    return;
  }

  // --- Proceed if Pro ---
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const channel = interaction.channel;
    if (!channel) {
      await interaction.editReply('⚠️ Could not resolve this channel.');
      return;
    }

    const newName = channel.name.includes('✅')
      ? channel.name // already marked
      : `${channel.name} ✅`;

    await channel.setName(newName, 'Marked complete by /complete');
    await interaction.editReply(`✅ Channel marked complete: **${newName}**`);
  } catch (e) {
    console.error('Error in /complete:', e);
    await interaction.editReply('❌ Failed to mark channel complete.');
  }
  return;
}

// /uncomplete — Pro-only
if (interaction.commandName === 'uncomplete') {
  if (!(await requireProGuild(interaction, 'Uncomplete Channel'))) return;

  const ch = interaction.channel;
  if (!ch || !interaction.guild) {
    await interaction.reply({ content: 'Use this inside a server channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  const canManage = interaction.guild.members.me?.permissionsIn(ch)?.has(PermissionFlagsBits.ManageChannels);
  if (!canManage) {
    await interaction.reply({ content: 'I need **Manage Channels** in this channel to rename it.', flags: MessageFlags.Ephemeral });
    return;
  }

  const oldName = ch.name;
  if (!isCompletedName(oldName)) {
    await interaction.reply({ content: `No ✅ to remove on **#${oldName}**.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const newName = makeUncompletedName(oldName);
  await ch.setName(newName, 'Unmarked by /uncomplete').catch(()=>{});
  await interaction.reply({ content: `🧹 Unmarked → **#${newName}**`, flags: MessageFlags.Ephemeral });
  return;
}
    // /import-schedule
    if (interaction.commandName === 'import-schedule') {
      if (!(await requireProGuild(interaction, 'Schedule Import'))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const text  = interaction.options.getString('schedule_text', true);
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

      const data = SCHEDULES.get(guildId) || { source: null, weeks: {} };
      let added = 0, bad = 0;

      for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 3) { bad++; continue; }
        const wk = String(Number(parts[0]));                 // normalize to "1"
        if (!wk || wk === 'NaN') { bad++; continue; }

        const { canonical: home } = normalizeTeam(parts[1]);
        const { canonical: away } = normalizeTeam(parts[2]);

        data.weeks[wk] = data.weeks[wk] || [];
        if (!data.weeks[wk].some(m => m.home === home && m.away === away)) {
          data.weeks[wk].push({ home, away });
          added++;
        }
      }

      SCHEDULES.set(guildId, data);
      await saveSchedule(guildId);
      await interaction.editReply(`✅ Imported. Added ${added} match(es). Skipped ${bad} malformed line(s).`);
      return;
    }

    // /make-week
    if (interaction.commandName === 'make-week') {
      const week = interaction.options.getInteger('week', true);
      const role = interaction.options.getRole('private_to_role') || null;

      const isPro = await guildHasPro(client, guildId);
      if (!isPro && week > FREE_WEEK_LIMIT) {
        await sendBuyButton(
          interaction,
          `🔒 **Pro required** to create Week ${week}. You can create up to **Week ${FREE_WEEK_LIMIT}** for free.`
        );
        return;
      }

      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await makeWeek(interaction, week, role);
      return;
    }

    // /add-match (adds & builds)
    if (interaction.commandName === 'add-match') {
      const week = interaction.options.getInteger('week', true);
      const home = interaction.options.getString('home', true);
      const away = interaction.options.getString('away', true);
      const role = interaction.options.getRole('private_to_role') || null;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      addMatch(guildId, week, home, away);
      await saveSchedule(guildId);
      await makeWeek(interaction, week, role);
      return;
    }

    // /manual-add → open modal (no trailing commas!)
    if (interaction.commandName === 'manual-add') {
      const modal = new ModalBuilder()
        .setCustomId('manualAddModal')
        .setTitle('Add Matchup');

      const weekInput = new TextInputBuilder()
        .setCustomId('week')
        .setLabel('Week number')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const awayInput = new TextInputBuilder()
        .setCustomId('away')
        .setLabel('Away team (name or abbrev)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const homeInput = new TextInputBuilder()
        .setCustomId('home')
        .setLabel('Home team (name or abbrev)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(weekInput),
        new ActionRowBuilder().addComponents(awayInput),
        new ActionRowBuilder().addComponents(homeInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // /cleanup-week
    if (interaction.commandName === 'cleanup-week') {
      if (!(await requireProGuild(interaction, 'Cleanup Week'))) return;
      const week    = interaction.options.getInteger('week', true);
      const confirm = interaction.options.getBoolean('confirm', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!confirm) {
        await interaction.editReply('❌ Deletion not confirmed.');
        return;
      }

      const cat = interaction.guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory &&
             c.name.toLowerCase() === `week ${week}`.toLowerCase()
      );

      if (!cat) {
        await interaction.editReply('⚠️ No category found for that week.');
        return;
      }

      const children = interaction.guild.channels.cache.filter(c => c.parentId === cat.id);
      for (const [, ch] of children) {
        try { await ch.delete('Cleanup by /cleanup-week'); } catch {}
      }
      try { await cat.delete('Cleanup by /cleanup-week'); } catch {}
      await interaction.editReply(`🗑️ Deleted Week ${week}.`);
      return;
    }

    // /bulk-import
    if (interaction.commandName === 'bulk-import') {
    if (!(await requireProGuild(interaction, 'Bulk Import'))) return;

    const modal = new ModalBuilder()
      .setCustomId('bulkImportModal')
      .setTitle('Bulk Import: week,home,away');

    const textarea = new TextInputBuilder()
      .setCustomId('bulkText')
      .setLabel('Paste lines (CSV): week,home,away')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(textarea));
    await interaction.showModal(modal);
    return;
}

    // /upgrade
    if (interaction.commandName === 'upgrade') {
      await sendBuyButton(interaction);
      return;
    }

    // /debug-week
    if (interaction.commandName === 'debug-week') {
      const wk    = String(Number(interaction.options.getInteger('week', true)));
      const data  = SCHEDULES.get(guildId) || { weeks: {} };
      const games = data.weeks?.[wk] || [];
      await interaction.reply({
        content:
          `Guild: \`${guildId}\`\n` +
          `Weeks present: [${Object.keys(data.weeks || {}).join(', ')}]\n` +
          `Week ${wk}: I see **${games.length}** game(s).\n` +
          (games.slice(0, 10).map(g => `• ${g.home} vs ${g.away}`).join('\n') || ''),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  // ---------- Modal submit ----------
if (interaction.isModalSubmit() && interaction.customId === 'bulkImportModal') {
  if (!(await requireProGuild(interaction, 'Bulk Import'))) return;

  const guildId = interaction.guildId;
  await loadSchedule(guildId);

  const raw = interaction.fields.getTextInputValue('bulkText') || '';
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const data = SCHEDULES.get(guildId) || { source: null, weeks: {} };
  let added = 0, bad = 0;

  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 3) { bad++; continue; }

    const wk = String(Number(parts[0]));
    if (!wk || wk === 'NaN') { bad++; continue; }

    const { canonical: home } = normalizeTeam(parts[1]);
    const { canonical: away } = normalizeTeam(parts[2]);

    data.weeks[wk] = data.weeks[wk] || [];
    const dup = data.weeks[wk].some(m => m.home === home && m.away === away);
    if (!dup) { data.weeks[wk].push({ home, away }); added++; }
  }

  SCHEDULES.set(guildId, data);
  await saveSchedule(guildId);

  const touched = Object.entries(data.weeks)
    .filter(([_, arr]) => (arr?.length ?? 0) > 0)
    .map(([w, arr]) => `${w}:${arr.length}`).join(' ');

  await interaction.reply({
    content: `✅ Bulk import complete.\n• Added: **${added}**   • Skipped (bad/dup): **${bad}**\n${touched ? `Weeks now: ${touched}` : ''}`,
    flags: MessageFlags.Ephemeral
  });
  return;
}
  
  if (interaction.isModalSubmit() && interaction.customId === 'manualAddModal') {
    const wk   = String(Number(interaction.fields.getTextInputValue('week')));
    const away = interaction.fields.getTextInputValue('away');
    const home = interaction.fields.getTextInputValue('home');

    if (!wk || wk === 'NaN') {
      await interaction.reply({ content: 'Week must be a positive number.', flags: MessageFlags.Ephemeral });
      return;
    }

    addMatch(guildId, wk, home, away);
    await saveSchedule(guildId);
    await interaction.reply({
      content: `✅ Added to Week ${wk}: ${titleCase(away)} @ ${titleCase(home)}. Use /make-week to build channels.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
});

// keep this as the last line
client.login(token);
