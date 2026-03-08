import { Bot, InlineKeyboard, Keyboard, session, type Context, type SessionFlavor } from "grammy";
import {
  conversations,
  createConversation,
  type Conversation,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import {
  parseNetwork,
  NETWORK_CONFIG,
  NETWORKS,
  extractRoundNumber,
  type Network,
} from "./networks.js";
import {
  addSubscription,
  removeSubscription,
  removeAllSubscriptions,
  getSubscriptions,
} from "./db.js";
import {
  getValidatorInfo,
  findAllValidators,
  getNetworkStats,
  startMonitor,
  lastPollOk,
} from "./monitor.js";
import {
  getUniqueUsersCount,
  getSubscriptionsCount,
  getSubscriptionsByNetwork,
  getAlertCount24h,
} from "./db.js";

const BOT_TOKEN = process.env["BOT_TOKEN"];
if (!BOT_TOKEN) {
  console.error("[bot] BOT_TOKEN env variable is required");
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env["ADMIN_CHAT_ID"] ? Number(process.env["ADMIN_CHAT_ID"]) : null;

type SessionData = Record<string, never>;
type MyContext = Context &
  SessionFlavor<SessionData> &
  ConversationFlavor<Context & SessionFlavor<SessionData>>;
type MyConversation = Conversation<MyContext, MyContext>;

export const bot = new Bot<MyContext>(BOT_TOKEN);

bot.use(session<SessionData, MyContext>({ initial: () => ({}) }));
bot.use(conversations());

function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text("🟢 Status")
    .text("📋 My List")
    .row()
    .text("➕ Subscribe")
    .text("🗑 Unsubscribe")
    .row()
    .text("📊 Network Stats")
    .resized()
    .persistent();
}

function networkKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("MainNet", "net:mainnet")
    .text("TestNet", "net:testnet")
    .text("DevNet", "net:devnet")
    .row()
    .text("❌ Cancel", "net:cancel");
}

const callbackCache = new Map<string, string>();
let callbackCounter = 0;

function storeCallback(value: string): string {
  const key = String(callbackCounter++);
  callbackCache.set(key, value);
  return key;
}

function loadCallback(key: string): string | undefined {
  return callbackCache.get(key);
}

async function fetchUptime(party_id: string, network: Network): Promise<string> {
  const cfg = NETWORK_CONFIG[network];
  try {
    const lhRes = await fetch(
      `${cfg.lighthouseUrl}/api/validators/${encodeURIComponent(party_id)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (lhRes.ok) {
      const lhData = (await lhRes.json()) as {
        validator?: { first_round?: number; last_round?: number; miss_round?: number };
      };
      const v = lhData.validator;
      if (v && v.first_round != null && v.last_round != null && v.miss_round != null) {
        const total = v.last_round - v.first_round;
        if (total > 0) {
          const pct = (((total - v.miss_round) / total) * 100).toFixed(1);
          const missed = v.miss_round;
          return `\n*Uptime (all-time):* ${pct}% _(${missed} rounds missed)_`;
        }
      }
    }
  } catch {}

  try {
    const res = await fetch(
      `${cfg.indexerUrl}/api/validators/${encodeURIComponent(party_id)}/uptime?limit=500`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return "";
    const data = (await res.json()) as {
      uptime_pct?: number | string;
      data?: { is_active: boolean; captured_at: string }[];
    };
    if (data.uptime_pct == null) return "";

    const uptime7d = Number(data.uptime_pct).toFixed(1);

    let uptime24h = "";
    if (data.data && data.data.length > 0) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = data.data.filter((s) => new Date(s.captured_at).getTime() >= cutoff);
      if (recent.length > 0) {
        const activeCnt = recent.filter((s) => s.is_active).length;
        const pct = ((activeCnt / recent.length) * 100).toFixed(1);
        uptime24h = `\n*Uptime 24h:* ${pct}%`;
      }
    }

    return `${uptime24h}\n*Uptime 7d:* ${uptime7d}%`;
  } catch {
    return "";
  }
}

async function sendValidatorStatus(ctx: MyContext, query: string, network: Network): Promise<void> {
  const label = NETWORK_CONFIG[network].label;
  const matches = await findAllValidators(query, network);

  if (matches.length === 0) {
    await ctx.reply(`❌ Validator not found on ${label}.`);
    return;
  }

  if (matches.length > 1) {
    const kb = new InlineKeyboard();
    for (const v of matches.slice(0, 8)) {
      const name = v.name ?? v.id.split("::")[0];
      const key = storeCallback(`${network}:${v.party_id ?? v.id}`);
      kb.text(name!, `sv:${key}`).row();
    }
    await ctx.reply(`🔎 Found ${matches.length} validators on ${label}. Pick one:`, {
      reply_markup: kb,
    });
    return;
  }

  const v = matches[0]!;
  const canonical_id = v.party_id ?? v.id;
  const name = v.name ?? v.id.split("::")[0];
  const status = v.is_active ? "🟢 Online" : "🔴 Offline";
  const lastUpdated = v.last_seen_at ? new Date(v.last_seen_at).toUTCString() : "unknown";
  const firstSeen = v.first_seen_at ? new Date(v.first_seen_at).toUTCString() : "unknown";
  const uptime = await fetchUptime(canonical_id, network);

  await ctx.reply(
    `*[${label}] Validator Status*\n\n` +
      `*Name:* ${name}\n` +
      `*Status:* ${status}\n` +
      `*Version:* \`${v.version ?? "unknown"}\`\n` +
      `*Last updated:* ${lastUpdated}\n` +
      `*First seen:* ${firstSeen}\n` +
      uptime +
      `\n*ID:* \`${canonical_id}\``,
    { parse_mode: "Markdown" },
  );
}

async function askValidatorName(
  conversation: MyConversation,
  ctx: MyContext,
): Promise<string | null> {
  const buttonTexts = [
    "🟢 Status",
    "➕ Subscribe",
    "🗑 Unsubscribe",
    "📋 My List",
    "📊 Network Stats",
  ];
  await ctx.reply("Enter validator name or ID:", { reply_markup: mainKeyboard() });
  while (true) {
    const msg = await conversation.waitFor("message:text", {
      maxMilliseconds: 120 * 1000,
      otherwise: async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      },
    });
    if (!msg) {
      await ctx.reply("❌ Cancelled (timed out).", { reply_markup: mainKeyboard() });
      return null;
    }
    const text = msg.message.text.trim();
    if (text === "/cancel") {
      await ctx.reply("❌ Cancelled.", { reply_markup: mainKeyboard() });
      return null;
    }
    if (buttonTexts.includes(text)) {
      await ctx.reply("❌ Cancelled. Press the button again.", { reply_markup: mainKeyboard() });
      return null;
    }
    return text || null;
  }
}

async function pickNetwork(conversation: MyConversation, ctx: MyContext): Promise<Network | null> {
  const sent = await ctx.reply("Select network:", { reply_markup: networkKeyboard() });
  const editSent = async (text: string) => {
    await ctx.api.editMessageText(sent.chat.id, sent.message_id, text).catch(() => {});
  };
  while (true) {
    const upd = await conversation.wait({
      maxMilliseconds: 120 * 1000,
    });
    if (!upd) {
      await editSent("Select network: ❌ Cancelled (timed out).");
      await ctx.reply("❌ Cancelled (timed out).", { reply_markup: mainKeyboard() });
      return null;
    }
    const menuButtons = [
      "🟢 Status",
      "➕ Subscribe",
      "🗑 Unsubscribe",
      "📋 My List",
      "📊 Network Stats",
    ];
    if (
      upd.message?.text === "/cancel" ||
      (upd.message?.text && menuButtons.includes(upd.message.text))
    ) {
      await editSent("Select network: ❌ Cancelled.");
      await upd.reply("❌ Cancelled. Press the button again.", { reply_markup: mainKeyboard() });
      return null;
    }
    const data = upd.callbackQuery?.data;
    if (!data) continue;
    await upd.answerCallbackQuery().catch(() => {});
    if (data === "net:cancel") {
      await editSent("Select network: ❌ Cancelled.");
      await upd.reply("❌ Cancelled.", { reply_markup: mainKeyboard() });
      return null;
    }
    const match = data.match(/^net:(mainnet|testnet|devnet)$/);
    if (match) {
      const label = NETWORK_CONFIG[match[1] as Network].label;
      await editSent(`Network: ✅ ${label}`);
      return match[1] as Network;
    }
  }
}

async function statusConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const network = await pickNetwork(conversation, ctx);
  if (!network) return;

  while (true) {
    const query = await askValidatorName(conversation, ctx);
    if (!query) return;

    const label = NETWORK_CONFIG[network].label;
    const matches = await findAllValidators(query, network);

    if (matches.length === 0) {
      await ctx.reply(`❌ Validator not found on ${label}. Try again:`);
      continue;
    }

    await ctx.reply(`🔍 Fetching status from ${label}...`);
    await sendValidatorStatus(ctx, query, network);
    return;
  }
}

async function subscribeConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const network = await pickNetwork(conversation, ctx);
  if (!network) return;

  const query = await askValidatorName(conversation, ctx);
  if (!query) return;

  const label = NETWORK_CONFIG[network].label;
  await ctx.reply(`🔍 Looking up validator on ${label}...`);

  const matches = await findAllValidators(query, network);
  if (matches.length === 0) {
    await ctx.reply(`❌ Validator not found on ${label}.`, { reply_markup: mainKeyboard() });
    return;
  }

  let v = matches[0]!;

  if (matches.length > 1) {
    const kb = new InlineKeyboard();
    for (const m of matches.slice(0, 8)) {
      const name = m.name ?? m.id.split("::")[0];
      const key = storeCallback(m.party_id ?? m.id);
      kb.text(name!, `pick:${key}`).row();
    }
    const sentPick = await ctx.reply(`🔎 Found ${matches.length} validators. Pick one:`, {
      reply_markup: kb,
    });
    const cb = await conversation.waitFor("callback_query:data");
    await cb.answerCallbackQuery();
    const rawKey = cb.callbackQuery.data.replace("pick:", "");
    const pickedId = loadCallback(rawKey) ?? rawKey;
    const found = matches.find((m) => (m.party_id ?? m.id) === pickedId);
    if (!found) {
      await ctx.api
        .editMessageText(sentPick.chat.id, sentPick.message_id, "🔎 Pick validator: ❌ Cancelled.")
        .catch(() => {});
      await ctx.reply("Cancelled.", { reply_markup: mainKeyboard() });
      return;
    }
    const pickedName = found.name ?? found.id.split("::")[0];
    await ctx.api
      .editMessageText(sentPick.chat.id, sentPick.message_id, `🔎 Pick validator: ✅ ${pickedName}`)
      .catch(() => {});
    v = found;
  }

  const canonical_id = v.party_id ?? v.id;
  const name = v.name ?? v.id.split("::")[0];
  const added = addSubscription(ctx.chat!.id, canonical_id, network);
  const status = v.is_active ? "🟢 online" : "🔴 offline";

  if (added) {
    await ctx.reply(
      `✅ *Subscribed* to validator on ${label}\n\n` +
        `*Name:* ${name}\n*Status:* ${status}\n*Version:* \`${v.version ?? "unknown"}\`\n` +
        `*ID:* \`${canonical_id}\`\n\nYou'll get alerts when status changes.\n_Note: detection delay is ~50 min (4 Canton rounds × 10 min + 2 poll cycles)._`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() },
    );
  } else {
    await ctx.reply(`ℹ️ Already tracking *${name}* on ${label}.`, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
  }
}

async function unsubscribeConversation(
  conversation: MyConversation,
  ctx: MyContext,
): Promise<void> {
  const network = await pickNetwork(conversation, ctx);
  if (!network) return;

  const allSubs = getSubscriptions(ctx.chat!.id);
  const subs = allSubs.filter((s) => s.network === network);
  const label = NETWORK_CONFIG[network].label;

  if (subs.length === 0) {
    await ctx.reply(`📋 No subscriptions on ${label}.`, { reply_markup: mainKeyboard() });
    return;
  }

  const kb = new InlineKeyboard();
  kb.text(`🗑 Unsubscribe All on ${label} (${subs.length})`, "unsub:all").row();
  for (const s of subs) {
    const short = s.party_id.split("::")[0];
    const key = storeCallback(s.party_id);
    kb.text(short!, `unsub:${key}`).row();
  }
  kb.text("Cancel", "unsub:cancel");

  const sentUnsub = await ctx.reply(`Select subscription to remove on ${label}:`, {
    reply_markup: kb,
  });
  const cb = await conversation.waitFor("callback_query:data");
  await cb.answerCallbackQuery();

  if (cb.callbackQuery.data === "unsub:cancel") {
    await ctx.api
      .editMessageText(
        sentUnsub.chat.id,
        sentUnsub.message_id,
        `Select subscription to remove on ${label}: ❌ Cancelled.`,
      )
      .catch(() => {});
    await ctx.reply("❌ Cancelled.", { reply_markup: mainKeyboard() });
    return;
  }

  if (cb.callbackQuery.data === "unsub:all") {
    const count = removeAllSubscriptions(ctx.chat!.id, network);
    await ctx.api
      .editMessageText(
        sentUnsub.chat.id,
        sentUnsub.message_id,
        `Select subscription to remove on ${label}: 🗑 All removed.`,
      )
      .catch(() => {});
    await ctx.reply(`✅ Unsubscribed from all ${count} validators on ${label}.`, {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  const rawKey = cb.callbackQuery.data.replace("unsub:", "");
  const party_id = loadCallback(rawKey);
  if (!party_id) {
    await ctx.reply("Something went wrong.", { reply_markup: mainKeyboard() });
    return;
  }
  const removed = removeSubscription(ctx.chat!.id, party_id, network);
  const shortName = party_id.split("::")[0];
  await ctx.api
    .editMessageText(
      sentUnsub.chat.id,
      sentUnsub.message_id,
      `Select subscription to remove on ${label}: ✅ ${shortName}`,
    )
    .catch(() => {});

  await ctx.reply(
    removed ? `✅ Unsubscribed from \`${shortName}\` on ${label}` : `ℹ️ Subscription not found.`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() },
  );
}

const CONV_TIMEOUT = { maxMillisecondsToWait: 120 * 1000 };
bot.use(createConversation(statusConversation, { id: "conv_status", ...CONV_TIMEOUT }));
bot.use(createConversation(subscribeConversation, { id: "conv_subscribe", ...CONV_TIMEOUT }));
bot.use(createConversation(unsubscribeConversation, { id: "conv_unsubscribe", ...CONV_TIMEOUT }));

await bot.api.setMyCommands([
  { command: "start", description: "Welcome message" },
  { command: "help", description: "Show all commands" },
  { command: "status", description: "Get validator status" },
  { command: "track", description: "Subscribe to validator alerts" },
  { command: "untrack", description: "Unsubscribe from validator" },
  { command: "list", description: "List your subscriptions" },
  { command: "network", description: "Network stats" },
  { command: "cancel", description: "Cancel current action" },
]);

async function sendWelcome(ctx: MyContext): Promise<void> {
  await ctx.reply(
    `👋 *Canton Network Alert Bot*\n` +
      `Monitor validators across MainNet, TestNet and DevNet.\n\n` +
      `Use the buttons below or type commands directly.\n\n` +
      `*Networks:* mainnet · testnet · devnet\n` +
      `*Alerts:* 🔴 offline · 🟢 back online · ⚠️ outdated version`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() },
  );
}

bot.command("start", sendWelcome);
bot.command("help", sendWelcome);

async function exitAllConversations(ctx: MyContext): Promise<void> {
  await ctx.conversation.exit("conv_status");
  await ctx.conversation.exit("conv_subscribe");
  await ctx.conversation.exit("conv_unsubscribe");
}

bot.command("cancel", async (ctx) => {
  await exitAllConversations(ctx);
  await ctx.reply("❌ Cancelled.", { reply_markup: mainKeyboard() });
});

bot.hears("🟢 Status", async (ctx) => {
  await exitAllConversations(ctx);
  await ctx.conversation.enter("conv_status");
});
bot.hears("➕ Subscribe", async (ctx) => {
  await exitAllConversations(ctx);
  await ctx.conversation.enter("conv_subscribe");
});
bot.hears("🗑 Unsubscribe", async (ctx) => {
  await exitAllConversations(ctx);
  await ctx.conversation.enter("conv_unsubscribe");
});

bot.hears("📋 My List", async (ctx) => {
  const subs = getSubscriptions(ctx.chat.id);
  if (subs.length === 0) {
    await ctx.reply("📋 No subscriptions yet.\n\nUse ➕ Subscribe to start monitoring.");
    return;
  }
  const byNetwork = new Map<Network, typeof subs>();
  for (const s of subs) {
    const list = byNetwork.get(s.network) ?? [];
    list.push(s);
    byNetwork.set(s.network, list);
  }

  const lines: string[] = [`📋 *Your subscriptions (${subs.length}):*`];
  for (const net of NETWORKS) {
    const list = byNetwork.get(net);
    if (!list?.length) continue;
    lines.push(`\n*${NETWORK_CONFIG[net].label}:*`);
    for (const s of list) lines.push(`  • \`${s.party_id.split("::")[0]}\``);
  }

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > 3800) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "Markdown" });
  }
});

bot.hears("📊 Network Stats", async (ctx) => {
  await ctx.reply("Select network:", { reply_markup: networkKeyboard() });
});

bot.callbackQuery("net:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("❌ Cancelled.", { reply_markup: mainKeyboard() });
});

bot.callbackQuery(/^net:(mainnet|testnet|devnet)$/, async (ctx) => {
  const network = ctx.match[1] as Network;
  const label = NETWORK_CONFIG[network].label;
  await ctx.answerCallbackQuery();
  await ctx.reply(`🔍 Fetching ${label} stats...`);

  const result = await getNetworkStats(network);
  if (!result?.stats) {
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

bot.callbackQuery(/^sv:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const stored = loadCallback(ctx.match[1]!);
  if (!stored) {
    await ctx.reply("Session expired, please try again.");
    return;
  }
  const idx = stored.indexOf(":");
  const network = stored.slice(0, idx) as Network;
  const party_id = stored.slice(idx + 1);
  await sendValidatorStatus(ctx, party_id, network);
});

bot.command("status", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  const query = args[0];
  const network: Network = parseNetwork(args[1]);
  if (!query) {
    await ctx.reply("Usage: /status <name> [mainnet|testnet|devnet]");
    return;
  }
  await ctx.reply(`🔍 Fetching status from ${NETWORK_CONFIG[network].label}...`);
  await sendValidatorStatus(ctx, query, network);
});

bot.command("track", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  const party_id = args[0];
  const network: Network = parseNetwork(args[1]);
  if (!party_id) {
    await ctx.reply("Usage: /track <name> [mainnet|testnet|devnet]");
    return;
  }
  const label = NETWORK_CONFIG[network].label;
  await ctx.reply(`🔍 Looking up validator on ${label}...`);
  const v = await getValidatorInfo(party_id, network);
  if (!v) {
    await ctx.reply(`❌ Validator not found on ${label}.`);
    return;
  }
  const canonical_id = v.party_id ?? v.id;
  const added = addSubscription(ctx.chat.id, canonical_id, network);
  const name = v.name ?? v.id.split("::")[0];
  const status = v.is_active ? "🟢 online" : "🔴 offline";
  if (added) {
    await ctx.reply(
      `✅ *Subscribed* to validator on ${label}\n\n*Name:* ${name}\n*Status:* ${status}\n*ID:* \`${canonical_id}\`\n\nYou'll get alerts when status changes.\n_Note: detection delay is ~50 min (4 Canton rounds × 10 min + 2 poll cycles)._`,
      { parse_mode: "Markdown" },
    );
  } else {
    await ctx.reply(`ℹ️ Already tracking *${name}* on ${label}.`, { parse_mode: "Markdown" });
  }
});

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
  await ctx.reply(
    removed ? `✅ Unsubscribed from \`${party_id}\` on ${label}` : `ℹ️ No subscription found.`,
    { parse_mode: "Markdown" },
  );
});

bot.command("list", async (ctx) => {
  const subs = getSubscriptions(ctx.chat.id);
  if (subs.length === 0) {
    await ctx.reply("📋 No subscriptions yet.\n\nUse /track <party_id> to start monitoring.");
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
    if (!list?.length) continue;
    msg += `\n*${NETWORK_CONFIG[net].label}:*\n`;
    for (const s of list) msg += `  • \`${s.party_id}\`\n`;
  }
  await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("network", async (ctx) => {
  const network: Network = parseNetwork(ctx.match.trim() || undefined);
  const label = NETWORK_CONFIG[network].label;
  await ctx.reply(`🔍 Fetching ${label} stats...`);
  const result = await getNetworkStats(network);
  if (!result?.stats) {
    await ctx.reply(`❌ Could not fetch stats for ${label}.`);
    return;
  }
  const { stats, source } = result;
  const price = stats.cc_price !== undefined ? Number(stats.cc_price).toFixed(4) : "unknown";
  const validators = stats.total_validator ?? stats.total_validators ?? "unknown";
  const rounds = extractRoundNumber(stats);
  await ctx.reply(
    `📊 *${label} Network Stats*\n\n` +
      `*Validators:* ${validators}\n*Latest round:* ${rounds}\n*CC Price:* $${price}\n` +
      `*Version:* \`${stats.version ?? "unknown"}\`\n` +
      (stats.total_parties ? `*Parties:* ${stats.total_parties}\n` : "") +
      (stats.total_transaction ? `*Transactions:* ${stats.total_transaction}\n` : "") +
      `\n_Source: ${source}_`,
    { parse_mode: "Markdown" },
  );
});

bot.command("admin", async (ctx) => {
  if (!ADMIN_CHAT_ID || ctx.chat.id !== ADMIN_CHAT_ID) {
    await ctx.reply("⛔ Not authorized.");
    return;
  }
  const users = getUniqueUsersCount();
  const subs = getSubscriptionsCount();
  const byNetwork = getSubscriptionsByNetwork();
  const alerts24h = getAlertCount24h();
  const pollStatus = NETWORKS.map((net) => {
    const last = lastPollOk[net];
    const ago = last ? `${Math.floor((Date.now() - last.getTime()) / 60000)}m ago` : "never";
    return `  ${NETWORK_CONFIG[net].label}: ${ago}`;
  }).join("\n");
  await ctx.reply(
    `🛠 *Bot Admin Stats*\n\n` +
      `*Users:* ${users}\n*Subscriptions:* ${subs}\n` +
      `  mainnet: ${byNetwork["mainnet"] ?? 0}\n` +
      `  testnet: ${byNetwork["testnet"] ?? 0}\n` +
      `  devnet: ${byNetwork["devnet"] ?? 0}\n\n` +
      `*Alerts sent (24h):* ${alerts24h}\n\n` +
      `*Last poll:*\n${pollStatus}`,
    { parse_mode: "Markdown" },
  );
});

bot.catch((err) => {
  console.error("[bot] error:", err.message, err.error);
  if (ADMIN_CHAT_ID) {
    bot.api
      .sendMessage(ADMIN_CHAT_ID, `⚠️ *[Bot] Error*\n\`${err.message}\``, {
        parse_mode: "Markdown",
      })
      .catch(() => {});
  }
});

startMonitor(bot as unknown as Bot);

bot.start({
  onStart: () => console.log("[bot] started and polling"),
});
