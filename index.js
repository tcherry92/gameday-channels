```javascript
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
  EmbedBuilder,
  ButtonStyle,
  MessageFlags,
  ComponentType,
} from 'discord.js';
import { fileURLToPath } from 'url';
import { setGlobalDispatcher, Agent } from 'undici';

// ---- Paths (only once) ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const token = process.env.DISCORD_TOKEN;
const devGuildId = process.env.GUILD_ID;
const APP_ID = process.env.APP_ID;
const GUILD_PRO_SKU_ID = process.env.GUILD_PRO_SKU_ID;

const APP_DIR_URL = `https://discord.com/application-directory/${APP_ID}`;
const INVITE_URL  = `https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot%20applications.commands&permissions=0`;

const NFL_LOGO_URL = 'https://1000logos.net/wp-content/uploads/2017/05/NFL-logo.png';

// Persistent disk for dynamic guild data
const DATA_DIR = process.env.DATA_DIR || '/disk';
await fs.ensureDir(DATA_DIR);

// Bundled, read-only NFL file in the repo
const NFL_2025_BUNDLED = path.join(__dirname, 'data', 'nfl_2025.json');

// Guild schedule files live on disk
const scheduleFile = (guildId) => path.join(DATA_DIR, `schedule-${guildId}.json`);

// Guild config files
const configFile = (guildId) => path.join(DATA_DIR, `config-${guildId}.json`);

// Undici tuning
setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, headersTimeout: 0 }));

// --- Paywall guard: gate whole commands cleanly ---
async function requireProGuild(interaction, featureName = 'this feature') {
  const isPro = await guildHasPro(client, interaction.guildId);
  if (isPro) return true;

  const msg = `🔒 **Pro required** to use **${featureName}** on this server.`;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [buildErrorEmbed(msg)], components: [] }).catch(()=>{});
    await sendBuyButton(interaction, msg);
  } else {
    await sendBuyButton(interaction, msg);
  }
  return false;
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Free tier: allow creating up to this many weeks without Pro
const FREE_WEEK_LIMIT = 18;

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

// ---------- Embed Helpers ----------
function buildSuccessEmbed(title, description, thumbnail = NFL_LOGO_URL) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x00FF00) // Green
    .setThumbnail(thumbnail)
    .setFooter({ text: 'GameDay Channels • v1.0' });
}

function buildErrorEmbed(description, thumbnail = NFL_LOGO_URL) {
  return new EmbedBuilder()
    .setTitle('❌ Error')
    .setDescription(description)
    .setColor(0xFF0000) // Red
    .setThumbnail(thumbnail)
    .setFooter({ text: 'GameDay Channels • v1.0' });
}

function buildInfoEmbed(title, description, thumbnail = NFL_LOGO_URL) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x0099FF) // Blue
    .setThumbnail(thumbnail)
    .setFooter({ text: 'GameDay Channels • v1.0' });
}

function buildWelcomeCard(guild) {
  const embed = buildInfoEmbed(
    '🏈 Welcome to GameDay Channels',
    [
      'Thanks for installing **GameDay Channels**!',
      '',
      '**Quick start**',
      '1. Run `/setup-season` → choose **nfl_2025** (preloaded) or **manual**.',
      '2. Use `/make-week` to auto-create game channels for a week.',
      '3. Add games with `/add-match` or `/manual-add`.',
      '4. (Optional) Use `/team-assign` so fans get tagged when weeks are created.',
      '',
      '💎 Unlock **Pro** for bulk import, unlimited weeks beyond the free limit, and quality-of-life tools.'
    ].join('\n')
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Upgrade to Pro')
      .setStyle(ButtonStyle.Link)
      .setURL(APP_DIR_URL),
    new ButtonBuilder()
      .setLabel('Invite to another server')
      .setStyle(ButtonStyle.Link)
      .setURL(INVITE_URL)
  );

  return { embeds: [embed], components: [row] };
}

// ---------- Monetization helpers ----------
async function guildHasPro(_client, guildId) {
  try {
    if (!APP_ID || !GUILD_PRO_SKU_ID) {
      console.warn('guildHasPro: missing APP_ID or GUILD_PRO_SKU_ID');
      return false;
    }

    const appId = String(APP_ID);
    const skuId = String(GUILD_PRO_SKU_ID);
    const gId   = String(guildId);

    const entitlements = await rest.get(
      `/applications/${appId}/entitlements`,
      {
        query: {
          guild_id: gId,
          sku_ids: [skuId],
          exclude_expired: true
        }
      }
    );

    const count = Array.isArray(entitlements) ? entitlements.length : 0;
    console.log(`guildHasPro: guild=${gId} sku=${skuId} entitlements=${count}`);
    if (count) {
      const e = entitlements[0];
      console.log('guildHasPro: first entitlement =>',
        { id: e?.id, sku_id: e?.sku_id, guild_id: e?.guild_id, starts_at: e?.starts_at, ends_at: e?.ends_at });
    }
    return count > 0;
  } catch (e) {
    console.warn('guildHasPro error:', e?.status, e?.code, e?.message || e);
    return false;
  }
}

async function sendBuyButton(interaction, message = 'Unlock **GameDay Channels Pro** for this server:') {
  if (!GUILD_PRO_SKU_ID) {
    const warn = '⚠️ Purchase not configured. Ask the owner to set GUILD_PRO_SKU_ID.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [buildErrorEmbed(warn)] });
    } else {
      await interaction.reply({ embeds: [buildErrorEmbed(warn)], flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const payload = {
    content: message,
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 6, // Premium purchase button
        sku_id: String(GUILD_PRO_SKU_ID),
        label: 'Unlock Pro'
      }]
    }],
    flags: MessageFlags.Ephemeral
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    const url = `https://discord.com/application-directory/${APP_ID}`;
    const linkPayload = {
      content: message,
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5, // Link
          url,
          label: 'Open Pro Listing'
        }]
      }],
      flags: MessageFlags.Ephemeral
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(linkPayload);
    } else {
      await interaction.reply(linkPayload);
    }
  }
}

async function buildOverwrites(guild, role) {
  let me = guild.members.me;
  if (!me) {
    me = await guild.members.fetchMe();
  }
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
  const config = await loadConfig(guild.id);
  const prefix = config.categoryPrefix || 'Week';
  const catName = `${prefix} ${name}`;

  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === catName.toLowerCase()
  );
  if (existing) {
    if (overwrites) await existing.permissionOverwrites.set(overwrites).catch(()=>{});
    return existing;
  }
  return guild.channels.create({
    name: catName,
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
  });
}

// ---------- Config storage ----------
const CONFIGS = new Map(); // guildId -> { categoryPrefix: string }
async function loadConfig(guildId) {
  if (CONFIGS.has(guildId)) return CONFIGS.get(guildId);

  const fp = configFile(guildId);
  if (await fs.pathExists(fp)) {
    const raw = await fs.readJSON(fp).catch(()=>null);
    if (raw && typeof raw === 'object') {
      CONFIGS.set(guildId, raw);
      return raw;
    }
  }
  const fresh = { categoryPrefix: 'Week' };
  CONFIGS.set(guildId, fresh);
  await saveConfig(guildId);
  return fresh;
}

async function saveConfig(guildId) {
  const config = CONFIGS.get(guildId) || { categoryPrefix: 'Week' };
  await fs.writeJSON(configFile(guildId), config, { spaces: 2 }).catch(()=>{});
}

// ---------- Team assignments ----------
const TEAM_ASSIGN_FILE = guildId => path.join(DATA_DIR, `team-assign-${guildId}.json`);
const TEAM_ASSIGN = new Map();

async function loadTeamAssign(guildId) {
  const fp = TEAM_ASSIGN_FILE(guildId);
  if (await fs.pathExists(fp)) {
    const raw = await fs.readJSON(fp).catch(()=>null);
    if (raw && typeof raw === 'object') {
      const map = {};
      for (const [team, arr] of Object.entries(raw)) map[team] = new Set(arr || []);
      TEAM_ASSIGN.set(guildId, map);
      return map;
    }
  }
  const fresh = {};
  TEAM_ASSIGN.set(guildId, fresh);
  return fresh;
}
async function saveTeamAssign(guildId) {
  const map = TEAM_ASSIGN.get(guildId) || {};
  const json = {};
  for (const [team, set] of Object.entries(map)) json[team] = Array.from(set);
  await fs.writeJSON(TEAM_ASSIGN_FILE(guildId), json, { spaces: 2 }).catch(()=>{});
}

function getAssignedSet(guildId, team) {
  const map = TEAM_ASSIGN.get(guildId) || {};
  const t = normalizeTeam(team).canonical;
  map[t] = map[t] || new Set();
  TEAM_ASSIGN.set(guildId, map);
  return map[t];
}

// ---------- Schedule storage ----------
const SCHEDULES = new Map();
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
    await interaction.editReply({ embeds: [buildErrorEmbed(`⚠️ No games found for Week ${week}. Add with /manual-add or /add-match.`)] });
    return;
  }
  const overwrites = await buildOverwrites(interaction.guild, role);
  const cat = await getOrCreateCategory(interaction.guild, week, overwrites);
  const created = [];
  for (const { home, away } of games) {
    const chName = `${home}-vs-${away}`;
    const ch = await getOrCreateTextChannel(interaction.guild, chName, cat.id);

    // Assigned users
    const assignMap = TEAM_ASSIGN.get(guildId) || {};
    const homeSet = assignMap[home] || new Set();
    const awaySet = assignMap[away] || new Set();
    const homeIds = Array.from(homeSet);
    const awayIds = Array.from(awaySet);

    // If the category is private (role provided), let assigned users in
    if (role && (homeIds.length || awayIds.length)) {
      for (const uid of new Set([...homeIds, ...awayIds])) {
        try {
          await ch.permissionOverwrites.edit(uid, { ViewChannel: true });
        } catch {}
      }
    }

    // Post kickoff message with controlled mentions
    const mentions = [...new Set([...homeIds, ...awayIds])];
    const allowMentions = { parse: [], users: mentions };
    const lines = [
      `**${home} vs ${away}**`,
      homeIds.length ? `Home fans: ${homeIds.map(id=>`<@${id}>`).join(' ')}` : '',
      awayIds.length ? `Away fans: ${awayIds.map(id=>`<@${id}>`).join(' ')}` : ''
    ].filter(Boolean).join('\n');

    try {
      if (lines) await ch.send({ content: lines, allowedMentions: allowMentions });
    } catch {}

    created.push(`#${safeChannelName(chName)}`);
  }
  const desc = `✅ Week ${week} ready.\n${created.join(', ')}`;
  await interaction.editReply({ embeds: [buildSuccessEmbed('Week Created', desc)] });
}

// ---------- Preload from bundled local file ----------
function sanitizeBundledSeason(json) {
  const out = { weeks: {} };

  for (const rawKey of Object.keys(json?.weeks || {})) {
    const weekKey = String(rawKey).trim();
    const arr = Array.isArray(json.weeks[rawKey]) ? json.weeks[rawKey] : [];
    const cleaned = [];

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;

      const home = String(item.home ?? '').replace(/\s+/g, ' ').trim();
      const away = String(item.away ?? '').replace(/\s+/g, ' ').trim();
      if (!home || !away) continue;

      const key = `${home}::${away}`;
      if (!cleaned.some(x => `${x.home}::${x.away}` === key)) {
        cleaned.push({ home, away });
      }
    }

    if (cleaned.length) out.weeks[weekKey] = cleaned;
  }
  return out;
}

async function readBundled2025Raw() {
  const exists = await fs.pathExists(NFL_2025_BUNDLED);
  if (!exists) throw new Error(`Missing bundled file: ${NFL_2025_BUNDLED}`);

  const text = await fs.readFile(NFL_2025_BUNDLED, 'utf8');
  const parsed = JSON.parse(text);
  const json = sanitizeBundledSeason(parsed);

  const approxGames = Object.values(json.weeks).reduce((n, a) => n + a.length, 0);
  console.log(`📄 nfl_2025.json sanitized → weeks=${Object.keys(json.weeks).length} games=${approxGames}`);
  return json;
}

async function preloadFromBundled2025(guildId) {
  const json = await readBundled2025Raw();

  const weekKeys = Object.keys(json.weeks).sort((a, b) => Number(a) - Number(b));
  const summary  = weekKeys.map(w => `${w}:${json.weeks[w].length}`).join(' ');

  const data = { source: 'nfl_2025', weeks: json.weeks };
  SCHEDULES.set(guildId, data);
  await saveSchedule(guildId);

  console.log(`📦 Preloaded 2025 → guild=${guildId} weeks=${weekKeys.length} gamesByWeek=${summary}`);
  return { ok: true, msg: `Preloaded ${weekKeys.length} weeks (${summary}).` };
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
  },
  {
    name: 'upgrade',
    description: 'Open checkout to unlock Pro features for this server.'
  },
  {
    name: 'complete',
    description: 'Mark THIS channel complete (adds ✅ to the channel name).',
  },
  {
    name: 'uncomplete',
    description: 'Remove the ✅ from THIS channel name.',
  },
  {
    name: 'help',
    description: 'How to use GameDay Channels'
  },
  {
    name: 'team-assign',
    description: 'Assign a user to a team (they will be pinged on match channels)',
    options: [
      { type: 3, name: 'team', description: 'Team name or abbrev', required: true },
      { type: 6, name: 'user', description: 'User to assign', required: true }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'team-unassign',
    description: 'Remove a user from a team',
    options: [
      { type: 3, name: 'team', description: 'Team name or abbrev', required: true },
      { type: 6, name: 'user', description: 'User to remove', required: true }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'team-list',
    description: 'Show assigned users for a team (or all teams)',
    options: [
      { type: 3, name: 'team', description: 'Optional: specific team', required: false }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  { name: 'check-pro', description: 'Check if Pro is active for this server' },
  {
    name: 'debug-week',
    description: 'Show how many games the bot sees for a week',
    options: [{ type: 4, name: 'week', description: 'Week number', required: true }],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'set-category-prefix',
    description: 'Customize week category names (e.g., "NFL Week X").',
    options: [
      { type: 3, name: 'prefix', description: 'Prefix for category names (default: "Week")', required: true }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  },
  {
    name: 'ping-fans',
    description: 'Ping assigned fans for a specific week.',
    options: [
      { type: 4, name: 'week', description: 'Week number', required: true }
    ],
    default_member_permissions: PermissionFlagsBits.ManageChannels.toString()
  }
];

// Prefix we use for completed channels
const COMPLETE_PREFIX = '✅-';

function isCompletedName(name) {
  return name?.startsWith(COMPLETE_PREFIX) || name?.startsWith('✅');
}

function makeCompletedName(name) {
  if (isCompletedName(name)) return name;
  return `${COMPLETE_PREFIX}${name}`.slice(0, 100);
}

function makeUncompletedName(name) {
  return name.replace(/^✅-?/, '').slice(0, 100);
}

async function purgeAllWeekCategories(guild) {
  let deleted = 0, errors = 0;
  const config = await loadConfig(guild.id);
  const prefix = config.categoryPrefix || 'Week';
  const categories = guild.channels.cache.filter(c => 
    c.type === ChannelType.GuildCategory && 
    c.name.toLowerCase().includes(`${prefix.toLowerCase()} `)
  );
  for (const [, cat] of categories) {
    const children = guild.channels.cache.filter(c => c.parentId === cat.id);
    for (const [, ch] of children) {
      try { await ch.delete('Purge by /setup-season'); } catch { errors++; }
    }
    try { await cat.delete('Purge by /setup-season'); deleted++; } catch { errors++; }
  }
  return { deleted, errors };
}

async function registerCommandsAuto(appId, token, commands, devGuildId, attempt = 1) {
  const rest = new REST({ version: '10' }).setToken(token);

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

client.on('guildCreate', async (guild) => {
  try {
    const target =
      guild.systemChannel ??
      guild.channels.cache.find(
        c => c.type === ChannelType.GuildText &&
             c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
      );

    if (!target) return;

    await target.send(buildWelcomeCard(guild));
  } catch (e) {
    console.error('guildCreate welcome failed:', e);
  }
});

client.once('clientReady', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  for (const [guildId] of client.guilds.cache) {
    await loadSchedule(guildId);
    await loadTeamAssign(guildId);
    await loadConfig(guildId);

    const loaded = SCHEDULES.get(guildId);
    if (!loaded || !loaded.source) {
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
    process.env.GUILD_ID
  );
});

// ===================== Interactions =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isModalSubmit() && !interaction.isButton()) return;

  const guildId = interaction.guildId;
  await loadSchedule(guildId);
  await loadTeamAssign(guildId);
  await loadConfig(guildId);

  // ---------- Button Interactions (for /help) ----------
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('help-')) {
      await interaction.deferUpdate();
      const sub = interaction.customId.replace('help-', '');
      let embed;
      switch (sub) {
        case 'setup':
          embed = buildInfoEmbed(
            'Setup Guide',
            [
              '• `/setup-season` → choose **nfl_2025** (preloaded) or **manual**',
              '• `/make-week` → create channels for all games in a week',
              '• `/add-match` or `/manual-add` → add a game if needed',
              '• `/set-category-prefix` → customize category names (Pro)'
            ].join('\n')
          );
          break;
        case 'teams':
          embed = buildInfoEmbed(
            'Teams & Tagging',
            [
              '• `/team-assign team:<Team> user:@User` → tag fans when weeks are created',
              '• `/team-unassign` → remove assignment',
              '• `/team-list` → see assignments',
              '• `/ping-fans` → remind fans for a week (Pro)'
            ].join('\n')
          );
          break;
        case 'pro':
          embed = buildInfoEmbed(
            'Pro Features',
            [
              '💎 Unlock with `/upgrade`:',
              '• Unlimited weeks beyond free limit',
              '• Bulk import/export',
              '• Cleanup tools',
              '• Customization (e.g., category prefixes)',
              '• Fan pings & more'
            ].join('\n')
          );
          break;
        default:
          return;
      }
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral, ephemeral: true });
      return;
    }
  }

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
          await interaction.editReply({ embeds: [buildSuccessEmbed('Season Setup', `📅 Source set to **nfl_2025**. ${res.msg}`)] });
          return;
        }

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
        await interaction.editReply({ embeds: [buildInfoEmbed('Season Setup', msg)] });
      } catch (e) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`Error: ${e?.message || e}`)] });
      }
      return;
    }

    if (interaction.commandName === 'help') {
      const embed = buildInfoEmbed(
        '📖 GameDay Channels — Quick Guide',
        [
          '**Setup**',
          '• `/setup-season` → choose **nfl_2025** (preloaded) or **manual**',
          '• `/make-week` → create channels for all games in a week',
          '• `/add-match` or `/manual-add` → add a game if needed',
          '',
          '**Teams & Tagging**',
          '• `/team-assign team:<Team> user:@User` → tag fans when weeks are created',
          '• `/team-list` to see assignments',
          '',
          '**Finishing Games**',
          '• `/complete` / `/uncomplete` → mark channels done',
          '',
          '**Bulk / Admin (Pro)**',
          '• `/bulk-import` or `/import-schedule` → paste many games',
          '• `/cleanup-week` → remove a full week category',
          '',
          '💎 `/upgrade` to unlock Pro features.'
        ].join('\n')
      );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help-setup').setLabel('Setup').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help-teams').setLabel('Teams').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help-pro').setLabel('Pro').setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Upgrade to Pro').setStyle(ButtonStyle.Link).setURL(APP_DIR_URL),
        new ButtonBuilder().setLabel('Invite the Bot').setStyle(ButtonStyle.Link).setURL(INVITE_URL)
      );

      await interaction.reply({ embeds: [embed], components: [row1, row2], flags: MessageFlags.Ephemeral });
      return;
    }

    // /team-assign
    if (interaction.commandName === 'team-assign') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const teamIn = interaction.options.getString('team', true);
      const user = interaction.options.getUser('user', true);

      const team = normalizeTeam(teamIn).canonical;
      const set = getAssignedSet(guildId, team);
      set.add(user.id);
      await saveTeamAssign(guildId);

      await interaction.editReply({ embeds: [buildSuccessEmbed('Team Assignment', `✅ Assigned <@${user.id}> to **${team}**.`)] });
      return;
    }

    // /team-unassign
    if (interaction.commandName === 'team-unassign') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const teamIn = interaction.options.getString('team', true);
      const user = interaction.options.getUser('user', true);

      const team = normalizeTeam(teamIn).canonical;
      const set = getAssignedSet(guildId, team);
      const had = set.delete(user.id);
      await saveTeamAssign(guildId);

      const msg = had
        ? `🗑️ Removed <@${user.id}> from **${team}**.`
        : `⚠️ <@${user.id}> was not assigned to **${team}**.`;
      await interaction.editReply({ embeds: [buildInfoEmbed('Team Unassignment', msg)] });
      return;
    }

    // /team-list
    if (interaction.commandName === 'team-list') {
      const teamIn = interaction.options.getString('team');
      const map = TEAM_ASSIGN.get(guildId) || {};

      if (teamIn) {
        const team = normalizeTeam(teamIn).canonical;
        const set = map[team] || new Set();
        const mentions = Array.from(set).map(id => `<@${id}>`).join(' ') || '_none_';
        await interaction.reply({ embeds: [buildInfoEmbed(`Team: ${team}`, mentions)], flags: MessageFlags.Ephemeral });
        return;
      }

      const lines = Object.entries(map).length
        ? Object.entries(map)
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([t, s]) => `• **${t}** (${s.size}): ${Array.from(s).map(id=>`<@${id}>`).join(' ') || '_none_'}`)
            .join('\n')
        : '_no assignments_';

      await interaction.reply({ embeds: [buildInfoEmbed('Team Assignments', lines)], flags: MessageFlags.Ephemeral });
      return;
    }

    // /complete
    if (interaction.commandName === 'complete') {
      const isPro = await guildHasPro(client, guildId);
      if (!isPro) {
        await sendBuyButton(
          interaction,
          `🔒 **Pro required** to use /complete. Unlock GameDay Channels Pro to enable this feature.`
        );
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply({ embeds: [buildErrorEmbed('⚠️ Could not resolve this channel.')] });
          return;
        }

        const newName = channel.name.includes('✅')
          ? channel.name
          : `${channel.name} ✅`;

        await channel.setName(newName, 'Marked complete by /complete');
        await interaction.editReply({ embeds: [buildSuccessEmbed('Channel Complete', `✅ Channel marked complete: **${newName}**`)] });
      } catch (e) {
        console.error('Error in /complete:', e);
        await interaction.editReply({ embeds: [buildErrorEmbed('❌ Failed to mark channel complete.')] });
      }
      return;
    }

    // /uncomplete
    if (interaction.commandName === 'uncomplete') {
      if (!(await requireProGuild(interaction, 'Uncomplete Channel'))) return;

      const ch = interaction.channel;
      if (!ch || !interaction.guild) {
        await interaction.reply({ embeds: [buildErrorEmbed('Use this inside a server channel.')], flags: MessageFlags.Ephemeral });
        return;
      }

      const canManage = interaction.guild.members.me?.permissionsIn(ch)?.has(PermissionFlagsBits.ManageChannels);
      if (!canManage) {
        await interaction.reply({ embeds: [buildErrorEmbed('I need **Manage Channels** in this channel to rename it.')], flags: MessageFlags.Ephemeral });
        return;
      }

      const oldName = ch.name;
      if (!isCompletedName(oldName)) {
        await interaction.reply({ embeds: [buildErrorEmbed(`No ✅ to remove on **#${oldName}**.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      const newName = makeUncompletedName(oldName);
      await ch.setName(newName, 'Unmarked by /uncomplete').catch(()=>{});
      await interaction.reply({ embeds: [buildSuccessEmbed('Channel Uncomplete', `🧹 Unmarked → **#${newName}**`)], flags: MessageFlags.Ephemeral });
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
        const wk = String(Number(parts[0]));
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
      await interaction.editReply({ embeds: [buildSuccessEmbed('Import Complete', `✅ Imported. Added ${added} match(es). Skipped ${bad} malformed line(s).`)] });
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

    if (interaction.commandName === 'check-pro') {
      const isPro = await guildHasPro(client, interaction.guildId);
      await interaction.reply({
        embeds: [buildInfoEmbed('Pro Status', isPro ? '✅ Pro is active for this server!' : '❌ No Pro subscription found.')],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // /add-match
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

    // /manual-add
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
        await interaction.editReply({ embeds: [buildErrorEmbed('❌ Deletion not confirmed.')] });
        return;
      }

      const config = await loadConfig(guildId);
      const prefix = config.categoryPrefix || 'Week';
      const catName = `${prefix} ${week}`;
      const cat = interaction.guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory &&
             c.name.toLowerCase() === catName.toLowerCase()
      );

      if (!cat) {
        await interaction.editReply({ embeds: [buildErrorEmbed('⚠️ No category found for that week.')] });
        return;
      }

      const children = interaction.guild.channels.cache.filter(c => c.parentId === cat.id);
      for (const [, ch] of children) {
        try { await ch.delete('Cleanup by /cleanup-week'); } catch {}
      }
      try { await cat.delete('Cleanup by /cleanup-week'); } catch {}
      await interaction.editReply({ embeds: [buildSuccessEmbed('Cleanup Complete', `🗑️ Deleted ${catName}.`)] });
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
      const desc =
        `Guild: \`${guildId}\`\n` +
        `Weeks present: [${Object.keys(data.weeks || {}).join(', ')}]\n` +
        `Week ${wk}: I see **${games.length}** game(s).\n` +
        (games.slice(0, 10).map(g => `• ${g.home} vs ${g.away}`).join('\n') || '');
      await interaction.reply({ embeds: [buildInfoEmbed('Debug Week', desc)], flags: MessageFlags.Ephemeral });
      return;
    }

    // /set-category-prefix
    if (interaction.commandName === 'set-category-prefix') {
      if (!(await requireProGuild(interaction, 'Set Category Prefix'))) return;

      const prefix = interaction.options.getString('prefix', true).trim() || 'Week';
      const config = await loadConfig(guildId);
      config.categoryPrefix = prefix;
      CONFIGS.set(guildId, config);
      await saveConfig(guildId);

      await interaction.reply({ embeds: [buildSuccessEmbed('Category Prefix Updated', `✅ Categories will now use prefix: **${prefix}** (e.g., "${prefix} 1")`)] });
      return;
    }

    // /ping-fans
    if (interaction.commandName === 'ping-fans') {
      if (!(await requireProGuild(interaction, 'Ping Fans'))) return;

      const week = interaction.options.getInteger('week', true);
      const data = SCHEDULES.get(guildId) || { weeks: {} };
      const games = data.weeks[week] || [];
      if (!games.length) {
        await interaction.reply({ embeds: [buildErrorEmbed(`⚠️ No games in Week ${week}.`)] });
        return;
      }

      // Collect unique users
      const assignMap = TEAM_ASSIGN.get(guildId) || {};
      const allUsers = new Set();
      for (const { home, away } of games) {
        const homeSet = assignMap[home] || new Set();
        const awaySet = assignMap[away] || new Set();
        [...homeSet, ...awaySet].forEach(id => allUsers.add(id));
      }

      if (allUsers.size === 0) {
        await interaction.reply({ embeds: [buildErrorEmbed('No fans assigned to teams in this week.')], flags: MessageFlags.Ephemeral });
        return;
      }

      // Find summary channel: first channel in week category
      const config = await loadConfig(guildId);
      const prefix = config.categoryPrefix || 'Week';
      const catName = `${prefix} ${week}`;
      const cat = interaction.guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === catName.toLowerCase()
      );
      const summaryChannel = cat ? interaction.guild.channels.cache.find(c => c.parentId === cat.id && c.type === ChannelType.GuildText) : null;

      if (!summaryChannel) {
        await interaction.reply({ embeds: [buildErrorEmbed('Week category not found. Create it with /make-week first.')], flags: MessageFlags.Ephemeral });
        return;
      }

      const mentions = Array.from(allUsers).map(id => `<@${id}>`).join(' ');
      const message = `🏈 **Game Day Hype for Week ${week}!** ${mentions} – Get ready for kickoff!`;

      try {
        await summaryChannel.send(message);
        await interaction.reply({ embeds: [buildSuccessEmbed('Fans Pinged', `✅ Pinged ${allUsers.size} fans in #${summaryChannel.name}`)] });
      } catch (e) {
        await interaction.reply({ embeds: [buildErrorEmbed('Failed to send ping message. Check permissions.')], flags: MessageFlags.Ephemeral });
      }
      return;
    }
  }

  // ---------- Modal submit ----------
  if (interaction.isModalSubmit() && interaction.customId === 'bulkImportModal') {
    if (!(await requireProGuild(interaction, 'Bulk Import'))) return;

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

    const desc = `✅ Bulk import complete.\n• Added: **${added}**   • Skipped (bad/dup): **${bad}**\n${touched ? `Weeks now: ${touched}` : ''}`;
    await interaction.reply({ embeds: [buildSuccessEmbed('Bulk Import', desc)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'manualAddModal') {
    const wk   = String(Number(interaction.fields.getTextInputValue('week')));
    const away = interaction.fields.getTextInputValue('away');
    const home = interaction.fields.getTextInputValue('home');

    if (!wk || wk === 'NaN') {
      await interaction.reply({ embeds: [buildErrorEmbed('Week must be a positive number.')], flags: MessageFlags.Ephemeral });
      return;
    }

    addMatch(guildId, wk, home, away);
    await saveSchedule(guildId);
    await interaction.reply({
      embeds: [buildSuccessEmbed('Match Added', `✅ Added to Week ${wk}: ${titleCase(away)} @ ${titleCase(home)}. Use /make-week to build channels.`)]
    });
    return;
  }
});

// keep this as the last line
client.login(token);
