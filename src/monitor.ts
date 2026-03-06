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
  getLastAlertType,
} from "./db.js";

const ADMIN_CHAT_ID = process.env["ADMIN_CHAT_ID"] ? Number(process.env["ADMIN_CHAT_ID"]) : null;

async function notifyAdmin(bot: Bot, msg: string): Promise<void> {
  if (!ADMIN_CHAT_ID) return;
  await bot.api.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" }).catch(() => {});
}

const POLL_INTERVAL_MS = 5 * 60_000;
const OFFLINE_THRESHOLD_MS = 25 * 60 * 1000;
const POLL_NETWORK_TIMEOUT_MS = 30_000;

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

/** Canonical ID: use party_id if present, otherwise id */
function canonicalId(v: Validator): string {
  return v.party_id ?? v.id;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function pollNetwork(bot: Bot, network: Network): Promise<void> {
  const cfg = NETWORK_CONFIG[network];
  console.log(`[monitor] polling ${network}...`);

  const result = await fetchWithFallback<ValidatorsResponse>(
    "/api/validators?page_size=5000",
    network,
  );
  if (!result) {
    console.warn(`[monitor] ${network}: no data from indexer/lighthouse`);
    return;
  }

  const validators = result.data.data ?? result.data.validators ?? [];
  if (validators.length === 0) {
    console.warn(`[monitor] ${network}: empty validators list`);
    return;
  }

  const dominant = getDominantVersion(validators);
  if (dominant) dominantVersionCache[network] = dominant;

  // Build lookup map by both party_id and id
  const validatorMap = new Map<string, Validator>();
  for (const v of validators) {
    validatorMap.set(v.id, v);
    if (v.party_id) validatorMap.set(v.party_id, v);
  }

  const tracked = getTrackedValidators().filter((t) => t.network === network);
  let alertsSent = 0;

  for (const { party_id } of tracked) {
    const v = validatorMap.get(party_id);
    if (!v) {
      console.log(
        `[monitor] ${network}: tracked validator not found in API: ${party_id.slice(0, 40)}...`,
      );
      continue;
    }

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
    const name = v.name ?? v.id.split("::")[0] ?? party_id.slice(0, 20) + "…";

    // ── Offline alert: transition 1→0 OR first seen as offline ──
    const wentOffline = prevState && prevState.is_active === 1 && !effectivelyActive;
    const firstSeenOffline = !prevState && !effectivelyActive;

    if (wentOffline || firstSeenOffline) {
      const reason = !isActive
        ? "is_active = false"
        : stale
          ? `not seen for ${formatLastSeen(lastSeenAt)}`
          : "offline";
      const msg =
        `🔴 *[${label}] Validator offline*\n` +
        `*${name}*\n` +
        `Reason: ${reason}\n` +
        `Party: \`${party_id}\``;
      console.log(
        `[monitor] ALERT offline: ${name} on ${network} (${firstSeenOffline ? "first-seen" : "transition"})`,
      );
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch((err) => {
          console.error(`[monitor] failed to send offline alert to ${chat_id}:`, err);
        });
        logAlert(chat_id, party_id, network, "offline");
        alertsSent++;
      }
    }

    // ── Back online alert: transition 0→1 ──
    if (prevState && prevState.is_active === 0 && effectivelyActive) {
      const msg =
        `🟢 *[${label}] Validator back online*\n` + `*${name}*\n` + `Party: \`${party_id}\``;
      console.log(`[monitor] ALERT online: ${name} on ${network}`);
      for (const chat_id of subscribers) {
        const lastAlert = getLastAlertType(chat_id, party_id, network);
        if (lastAlert === "online") {
          console.log(`[monitor] skip duplicate online alert for ${name} (${chat_id})`);
          continue;
        }
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch((err) => {
          console.error(`[monitor] failed to send online alert to ${chat_id}:`, err);
        });
        logAlert(chat_id, party_id, network, "online");
        alertsSent++;
      }
    }

    // ── Version alert ──
    const dom = dominantVersionCache[network];
    if (dom && v.version && v.version !== dom) {
      const prevVersion = prevState?.version;
      if (prevVersion === v.version) continue;
      const msg =
        `⚠️ *[${label}] Outdated version*\n` +
        `*${name}*\n` +
        `Version: \`${v.version}\` (network: \`${dom}\`)\n` +
        `Party: \`${party_id}\``;
      console.log(`[monitor] ALERT version: ${name} on ${network}: ${v.version} vs ${dom}`);
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch((err) => {
          console.error(`[monitor] failed to send version alert to ${chat_id}:`, err);
        });
        logAlert(chat_id, party_id, network, "version");
        alertsSent++;
      }
    }
  }

  console.log(
    `[monitor] ${network} done: ${validators.length} validators, ${tracked.length} tracked, ${alertsSent} alerts sent`,
  );
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
  console.log(
    `[monitor] poll interval: ${POLL_INTERVAL_MS / 1000}s, offline threshold: ${OFFLINE_THRESHOLD_MS / 1000}s, poll timeout: ${POLL_NETWORK_TIMEOUT_MS / 1000}s`,
  );

  const poll = async () => {
    console.log(`[monitor] === poll cycle start ===`);
    for (const network of NETWORKS) {
      try {
        await withTimeout(
          pollNetwork(bot, network),
          POLL_NETWORK_TIMEOUT_MS,
          `pollNetwork(${network})`,
        );
        lastPollOk[network] = new Date();
      } catch (err) {
        console.error(`[monitor] error polling ${network}:`, err);
        const msg =
          `⚠️ *[Monitor] Poll error — ${network}*\n` +
          `\`${err instanceof Error ? err.message : String(err)}\``;
        await notifyAdmin(bot, msg);
      }
    }
    console.log(`[monitor] === poll cycle end ===`);
  };

  setTimeout(() => {
    void poll();
    setInterval(() => void poll(), POLL_INTERVAL_MS);
  }, 10_000);
}
