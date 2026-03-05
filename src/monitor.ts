import type { Bot } from "grammy";
import {
  fetchWithFallback,
  parseNetwork,
  NETWORKS,
  type Network,
  type Validator,
  type ValidatorsResponse,
  type NetworkStats,
  NETWORK_CONFIG,
} from "./networks.js";
import {
  getTrackedValidators,
  getSubscribersForValidator,
  getValidatorState,
  upsertValidatorState,
  logAlert,
} from "./db.js";

const ADMIN_CHAT_ID = process.env["ADMIN_CHAT_ID"] ? Number(process.env["ADMIN_CHAT_ID"]) : null;

async function notifyAdmin(bot: Bot, msg: string): Promise<void> {
  if (!ADMIN_CHAT_ID) return;
  await bot.api.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" }).catch(() => {});
}

const POLL_INTERVAL_MS = 5 * 60_000;
const OFFLINE_THRESHOLD_MS = 25 * 60 * 1000;

const dominantVersionCache: Partial<Record<Network, string>> = {};

function formatLastSeen(last_seen_at: string | null): string {
  if (!last_seen_at) return "unknown";
  const diff = Date.now() - new Date(last_seen_at).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getDominantVersion(validators: Validator[]): string | null {
  const counts: Record<string, number> = {};
  for (const v of validators) {
    if (v.version) counts[v.version] = (counts[v.version] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

async function pollNetwork(bot: Bot, network: Network): Promise<void> {
  const cfg = NETWORK_CONFIG[network];

  const result = await fetchWithFallback<ValidatorsResponse>(
    "/api/validators?page_size=5000",
    network,
  );
  if (!result) return;

  const validators = result.data.data ?? result.data.validators ?? [];
  if (validators.length === 0) return;

  const dominant = getDominantVersion(validators);
  if (dominant) dominantVersionCache[network] = dominant;

  const validatorMap = new Map<string, Validator>();
  for (const v of validators) {
    if (v.party_id) validatorMap.set(v.party_id, v);
    validatorMap.set(v.id, v);
  }

  const tracked = getTrackedValidators().filter((t) => t.network === network);

  for (const { party_id } of tracked) {
    const v = validatorMap.get(party_id);
    if (!v) continue;

    const prevState = getValidatorState(party_id, network);
    const isActive = v.is_active ?? false;
    const lastSeenAt = v.last_seen_at ?? null;

    const lastSeenMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : null;
    const stale = lastSeenMs !== null && lastSeenMs > OFFLINE_THRESHOLD_MS;
    const effectivelyActive = isActive && !stale;

    upsertValidatorState(party_id, network, effectivelyActive, v.version ?? null, lastSeenAt);

    const subscribers = getSubscribersForValidator(party_id, network);
    if (subscribers.length === 0) continue;

    const label = cfg.label;
    const name = v.name ?? party_id.slice(0, 20) + "…";

    if (prevState && prevState.is_active === 1 && !effectivelyActive) {
      const reason = !isActive ? "is_active = false" : `not seen for ${formatLastSeen(lastSeenAt)}`;
      const msg =
        `🔴 *[${label}] Validator offline*\n` +
        `*${name}*\n` +
        `Reason: ${reason}\n` +
        `Party: \`${party_id}\``;
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
        logAlert(chat_id, party_id, network, "offline");
      }
    }

    if (prevState && prevState.is_active === 0 && effectivelyActive) {
      const msg =
        `🟢 *[${label}] Validator back online*\n` + `*${name}*\n` + `Party: \`${party_id}\``;
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
        logAlert(chat_id, party_id, network, "online");
      }
    }

    const dom = dominantVersionCache[network];
    if (dom && v.version && v.version !== dom) {
      const prevVersion = prevState?.version;
      if (prevVersion === v.version) continue;
      const msg =
        `⚠️ *[${label}] Outdated version*\n` +
        `*${name}*\n` +
        `Version: \`${v.version}\` (network: \`${dom}\`)\n` +
        `Party: \`${party_id}\``;
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
        logAlert(chat_id, party_id, network, "version");
      }
    }
  }
}

export async function getValidatorInfo(query: string, network: Network): Promise<Validator | null> {
  const results = await findAllValidators(query, network);
  return results[0] ?? null;
}

export async function findAllValidators(query: string, network: Network): Promise<Validator[]> {
  const encoded = encodeURIComponent(query);
  const result = await fetchWithFallback<ValidatorsResponse>(
    `/api/validators?page_size=100&search=${encoded}`,
    network,
  );
  if (!result) return [];
  const validators = result.data.data ?? result.data.validators ?? [];
  const q = query.toLowerCase();

  const exact = validators.filter((v) => v.party_id === query || v.id === query);
  if (exact.length > 0) return exact;

  const byName = validators.filter((v) => v.name?.toLowerCase() === q);
  if (byName.length > 0) return byName;

  const byNamePartial = validators.filter((v) => v.name?.toLowerCase().includes(q));
  if (byNamePartial.length > 0) return byNamePartial;

  return validators.filter((v) => v.id.toLowerCase().startsWith(q));
}

export async function getNetworkStats(network: Network): Promise<{
  stats: NetworkStats | null;
  source: string;
} | null> {
  const result = await fetchWithFallback<NetworkStats>("/api/stats", network);
  if (!result) return null;
  return { stats: result.data, source: result.source };
}

export const lastPollOk: Partial<Record<Network, Date>> = {};

export function startMonitor(bot: Bot): void {
  console.log("[monitor] starting polling for networks:", NETWORKS.join(", "));

  const poll = async () => {
    for (const network of NETWORKS) {
      try {
        await pollNetwork(bot, network);
        lastPollOk[network] = new Date();
      } catch (err) {
        console.error(`[monitor] error polling ${network}:`, err);
        const msg =
          `⚠️ *[Monitor] Poll error — ${network}*\n` +
          `\`${err instanceof Error ? err.message : String(err)}\``;
        await notifyAdmin(bot, msg);
      }
    }
  };

  setTimeout(() => {
    void poll();
    setInterval(() => void poll(), POLL_INTERVAL_MS);
  }, 10_000);
}
