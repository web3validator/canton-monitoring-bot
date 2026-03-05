import { Bot, InlineKeyboard } from "grammy";
import {
  parseNetwork,
  NETWORK_CONFIG,
  NETWORKS,
  extractRoundNumber,
  type Network,
} from "./networks.js";
import { addSubscription, removeSubscription, getSubscriptions } from "./db.js";
import { getValidatorInfo, findAllValidators, getNetworkStats, startMonitor } from "./monitor.js";

const BOT_TOKEN = process.env["BOT_TOKEN"];
if (!BOT_TOKEN) {
  console.error("[bot] BOT_TOKEN env variable is required");
  process.exit(1);
}

export const bot = new Bot(BOT_TOKEN);

// ── Register bot commands menu ────────────────────────────────────────────────
await bot.api.setMyCommands([
  { command: "start", description: "Welcome message & quick buttons" },
  { command: "help", description: "Show all commands" },
  { command: "track", description: "Subscribe to validator alerts" },
  { command: "untrack", description: "Unsubscribe from validator" },
  { command: "status", description: "Get current validator status" },
  { command: "list", description: "List all your subscriptions" },
  { command: "network", description: "Network stats (mainnet/testnet/devnet)" },
]);

// ── Keyboards ─────────────────────────────────────────────────────────────────

function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 MainNet Stats", "net:mainnet")
    .text("📊 TestNet Stats", "net:testnet")
    .row()
    .text("📊 DevNet Stats", "net:devnet")
    .text("📋 My List", "cmd:list");
}

async function sendStartMessage(ctx: { reply: Function }): Promise<void> {
  await ctx.reply(
    `👋 *Canton Network Alert Bot*\n` +
      `Monitor validators across MainNet, TestNet and DevNet.\n` +
      `Built on web34ever indexer infrastructure.\n\n` +
      `*Commands:*\n` +
      `/track <name> [network] — subscribe to alerts\n` +
      `/untrack <name> [network] — unsubscribe\n` +
      `/status <name> [network] — current status\n` +
      `/list — your subscriptions\n` +
      `/network [mainnet|testnet|devnet] — network stats\n\n` +
      `*Networks:* mainnet · testnet · devnet\n` +
      `*Alerts:* 🔴 offline · 🟢 back online · ⚠️ outdated version\n\n` +
      `*Examples:*\n` +
      `/status web34ever mainnet\n` +
      `/track web34ever mainnet\n` +
      `/network mainnet\n\n` +
      `Default network: *mainnet*`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() },
  );
}

// ── /start & /help ────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await sendStartMessage(ctx);
});

bot.command("help", async (ctx) => {
  await sendStartMessage(ctx);
});

// ── Callback queries ──────────────────────────────────────────────────────────

bot.callbackQuery(/^net:(mainnet|testnet|devnet)$/, async (ctx) => {
  const network = ctx.match[1] as Network;
  const label = NETWORK_CONFIG[network].label;
  await ctx.answerCallbackQuery();
  await ctx.reply(`🔍 Fetching ${label} stats...`);

  const result = await getNetworkStats(network);
  if (!result || !result.stats) {
    await ctx.reply(`❌ Could not fetch stats for ${label}.`);
    return;
  }
  const { stats, source } = result;
  const price = stats.cc_price !== undefined ? Number(stats.cc_price).toFixed(4) : "unknown";
  const validators = stats.total_validator ?? stats.total_validators ?? "unknown";
  const rounds = extractRoundNumber(stats);
  await ctx.reply(
    `📊 *${label} Network Stats*\n\n` +
      `*Validators:* ${validators}\n` +
      `*Latest round:* ${rounds}\n` +
      `*CC Price:* $${price}\n` +
      `*Version:* \`${stats.version ?? "unknown"}\`\n` +
      (stats.total_parties ? `*Parties:* ${stats.total_parties}\n` : "") +
      (stats.total_transaction ? `*Transactions:* ${stats.total_transaction}\n` : "") +
      `\n_Source: ${source}_`,
    { parse_mode: "Markdown" },
  );
});

bot.callbackQuery("cmd:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const subs = getSubscriptions(ctx.chat!.id);
  if (subs.length === 0) {
    await ctx.reply(`📋 No subscriptions yet.\n\nUse /track <name> to start monitoring.`);
    return;
  }
  const byNetwork = new Map<Network, typeof subs>();
  for (const s of subs) {
    const list = byNetwork.get(s.network) ?? [];
    list.push(s);
    byNetwork.set(s.network, list);
  }
  let msg = `📋 *Your subscriptions (${subs.length}):*\n`;
  for (const net of NETWORKS) {
    const list = byNetwork.get(net);
    if (!list || list.length === 0) continue;
    msg += `\n*${NETWORK_CONFIG[net].label}:*\n`;
    for (const s of list) {
      msg += `  • \`${s.party_id}\`\n`;
    }
  }
  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// ── /track ────────────────────────────────────────────────────────────────────

bot.command("track", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  const party_id = args[0];
  const network: Network = parseNetwork(args[1]);

  if (!party_id) {
    await ctx.reply("Usage: /track <party_id> [mainnet|testnet|devnet]");
    return;
  }

  const label = NETWORK_CONFIG[network].label;
  await ctx.reply(`🔍 Looking up validator on ${label}...`);

  const v = await getValidatorInfo(party_id, network);
  if (!v) {
    await ctx.reply(`❌ Validator not found on ${label}.\n` + `Check the party_id and network.`);
    return;
  }

  // Use v.id as the canonical subscription key
  const canonical_id = v.party_id ?? v.id;
  const chat_id = ctx.chat.id;
  const added = addSubscription(chat_id, canonical_id, network);
  const name = v.name ?? v.id.split("::")[0];
  const status = v.is_active ? "🟢 online" : "🔴 offline";

  if (added) {
    await ctx.reply(
      `✅ *Subscribed* to validator on ${label}\n\n` +
        `*Name:* ${name}\n` +
        `*Status:* ${status}\n` +
        `*Version:* \`${v.version ?? "unknown"}\`\n` +
        `*ID:* \`${canonical_id}\`\n\n` +
        `You'll get alerts when status changes.`,
      { parse_mode: "Markdown" },
    );
  } else {
    await ctx.reply(
      `ℹ️ Already tracking this validator on ${label}.\n\n` +
        `*Name:* ${name}\n` +
        `*Status:* ${status}\n` +
        `*Version:* \`${v.version ?? "unknown"}\`\n` +
        `*ID:* \`${canonical_id}\``,
      { parse_mode: "Markdown" },
    );
  }
});

// ── /untrack ──────────────────────────────────────────────────────────────────

bot.command("untrack", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  const party_id = args[0];
  const network: Network = parseNetwork(args[1]);

  if (!party_id) {
    await ctx.reply("Usage: /untrack <party_id> [mainnet|testnet|devnet]");
    return;
  }

  const removed = removeSubscription(ctx.chat.id, party_id, network);
  const label = NETWORK_CONFIG[network].label;

  if (removed) {
    await ctx.reply(`✅ Unsubscribed from \`${party_id}\` on ${label}`, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx.reply(`ℹ️ No subscription found for \`${party_id}\` on ${label}`, {
      parse_mode: "Markdown",
    });
  }
});

// ── /status ───────────────────────────────────────────────────────────────────

bot.command("status", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  const query = args[0];
  const network: Network = parseNetwork(args[1]);

  if (!query) {
    await ctx.reply("Usage: /status <name or id> [mainnet|testnet|devnet]");
    return;
  }

  const label = NETWORK_CONFIG[network].label;
  await ctx.reply(`🔍 Fetching status from ${label}...`);

  const matches = await findAllValidators(query, network);

  if (matches.length === 0) {
    await ctx.reply(
      `❌ Validator not found on ${label}.\n\nTry searching by name or partial ID, e.g.:\n\`/status web34ever mainnet\``,
    );
    return;
  }

  // Multiple matches — show list to pick from
  if (matches.length > 1) {
    let msg = `🔎 *Found ${matches.length} validators on ${label}:*\n\n`;
    for (const v of matches.slice(0, 10)) {
      const name = v.name ?? v.id.split("::")[0];
      const status = v.is_active ? "🟢" : "🔴";
      msg += `${status} *${name}* — v\`${v.version ?? "?"}\`\n`;
      msg += `  \`${v.id.split("::")[0]}\`\n\n`;
    }
    msg += `Use the full name for exact match, e.g.:\n\`/status ${matches[0].id.split("::")[0]} ${network}\``;
    await ctx.reply(msg, { parse_mode: "Markdown" });
    return;
  }

  const v = matches[0]!;
  const canonical_id = v.party_id ?? v.id;
  const name = v.name ?? v.id.split("::")[0];
  const status = v.is_active ? "🟢 Online" : "🔴 Offline";
  const lastSeen = v.last_seen_at ? new Date(v.last_seen_at).toUTCString() : "unknown";
  const firstSeen = v.first_seen_at ? new Date(v.first_seen_at).toUTCString() : "unknown";

  await ctx.reply(
    `*[${label}] Validator Status*\n\n` +
      `*Name:* ${name}\n` +
      `*Status:* ${status}\n` +
      `*Version:* \`${v.version ?? "unknown"}\`\n` +
      `*Last seen:* ${lastSeen}\n` +
      `*First seen:* ${firstSeen}\n` +
      `*ID:* \`${canonical_id}\``,
    { parse_mode: "Markdown" },
  );
});

// ── /list ─────────────────────────────────────────────────────────────────────

bot.command("list", async (ctx) => {
  const subs = getSubscriptions(ctx.chat.id);

  if (subs.length === 0) {
    await ctx.reply(
      `📋 No subscriptions yet.\n\nUse /track <party_id> to start monitoring a validator.`,
    );
    return;
  }

  const byNetwork = new Map<Network, typeof subs>();
  for (const s of subs) {
    const list = byNetwork.get(s.network) ?? [];
    list.push(s);
    byNetwork.set(s.network, list);
  }

  let msg = `📋 *Your subscriptions (${subs.length}):*\n`;
  for (const net of NETWORKS) {
    const list = byNetwork.get(net);
    if (!list || list.length === 0) continue;
    msg += `\n*${NETWORK_CONFIG[net].label}:*\n`;
    for (const s of list) {
      msg += `  • \`${s.party_id}\`\n`;
    }
  }
  msg += `\nUse /status <party\\_id> [network] to check current status.`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// ── /network ──────────────────────────────────────────────────────────────────

bot.command("network", async (ctx) => {
  const network: Network = parseNetwork(ctx.match.trim() || undefined);
  const label = NETWORK_CONFIG[network].label;

  await ctx.reply(`🔍 Fetching ${label} stats...`);

  const result = await getNetworkStats(network);
  if (!result || !result.stats) {
    await ctx.reply(`❌ Could not fetch stats for ${label}.`);
    return;
  }

  const { stats, source } = result;
  const price = stats.cc_price !== undefined ? Number(stats.cc_price).toFixed(4) : "unknown";
  const validators = stats.total_validator ?? stats.total_validators ?? "unknown";
  const rounds = extractRoundNumber(stats);

  await ctx.reply(
    `📊 *${label} Network Stats*\n\n` +
      `*Validators:* ${validators}\n` +
      `*Latest round:* ${rounds}\n` +
      `*CC Price:* $${price}\n` +
      `*Version:* \`${stats.version ?? "unknown"}\`\n` +
      (stats.total_parties ? `*Parties:* ${stats.total_parties}\n` : "") +
      (stats.total_transaction ? `*Transactions:* ${stats.total_transaction}\n` : "") +
      `\n_Source: ${source}_`,
    { parse_mode: "Markdown" },
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("[bot] error:", err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────

startMonitor(bot);

bot.start({
  onStart: () => console.log("[bot] started and polling"),
});
